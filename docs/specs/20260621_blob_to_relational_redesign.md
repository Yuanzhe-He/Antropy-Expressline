# Spec — `app_state` 大 blob → 关系表 最彻底重构方案

> 状态：**方案设计文档（plan-only）**。本文档只设计，不执行。Chandler review 后单独立项分步执行。
> 作者：Claude Code · 日期：2026-06-21 · 关联：`00z6_chandler_log_round31.md`（病根=大 blob）、`docs/DATABASE_SCHEMA.md`
> 硬约束：迁移时 **José 手改数据零丢失**（yards=28 含自建 2、carriers=21 含 7 新空壳、CMA doc fee 50、KMTC ISD 15、ZIM 改名、COSCO 改价…）。

---

## TL;DR（大白话 + 真实数字）

- **现状**：所有业务数据塞进 `expressline.app_state` 表**唯一一行**（key=`shipping-data`）的一个 JSONB 字段 = **1.83 MB**。读任何东西都 `select payload`（整块搬 1.83 MB）。这就是"查一个汇率数字也要搬整个信封"。
- **最离谱的一处**：汇率 `exchangeRates` 只有 **299 字节**、一天才变一次，却每次都坐着 1.83 MB 的"信封"一起被搬 —— **放大约 6,100 倍**。那个每 2 秒打的幽灵打的就是汇率刷新路由，每次逼着搬 1.83 MB。
- **最重的一处**：陆运 `inland` 占 **1.42 MB = 全 blob 的 77%**，其中绝大部分是 44 条路线的地图几何缓存（routeCache，~32 KB/条）——冷数据（极少变），却跟着每次读一起搬。
- **目标**：拆成"文件柜"——每类实体一张表、热/冷分开。查哪儿调哪儿（`select where`，只搬几 KB），改哪儿改哪儿（`update` 一行，不打架）。
- **收益**：单次查询从 1.83 MB → **几百字节到几 KB**；汇率路由从 1.83 MB → 299 B；egress 从"靠缓存压到 ~1.8 GB/天"→ **正常使用每天几 MB 甚至更低**，且不再依赖缓存。
- **建议**：**分两阶段**。**Phase 1（高性价比）**= 只把 `exchangeRates`（299 B 热）和 `inland_route_cache`（1.42 MB 冷）拆出去 → 拿到 **~95% 的 egress 收益**，工作量约占整体 20%，风险低。**Phase 2（彻底）**= 全实体关系化。详见 §F。

---

## A. 现状分析（亲测，2026-06-21 生产实测）

### A.1 物理现状
- DB 三张表：`app_state`、`audit_logs`、`quote_snapshots`（见 `src/lib/db.js` `migrateDatabase`）。业务数据 100% 在 `app_state` 一行里。
- `app_state` 当前两行：`shipping-data`（1.83 MB blob，revision 214,845）、`users`（小）。
- 读路径：`db.getAppState(key)` = `select payload from app_state where key=$1` → 整块拉。
- 写路径：`db.saveAppState` = 整块覆盖；`db.patchAppStateField` = `jsonb_set` 局部写（只写时省，读仍整块）。
- 应用层有 1h 内存读缓存（`store.js`，PR#16/17）——这是"信封方案"的补丁，不是根治。

### A.2 blob 实测结构与大小（`octet_length(section::text)`）

| 顶层 / 模块 | 字节 | 占比 | 冷/热 | 实体数 |
|---|---|---|---|---|
| `modules.inland` | 1,417,440 | **77%** | 冷（geometry 极少变） | 44 目的地 / 300 费率 / 44 路线缓存 / 1 出发地 |
| `modules.customs` | 292,028 | 16% | 温（admin 偶改） | 2 港口 / 28 堆场 / 21 船司镜像 / 20 柜型 |
| `modules.handover` | 109,693 | 6% | 温（admin 偶改） | 21 船司 / 20 柜型 |
| `modules.quote` | 10,755 | 0.6% | 温（报价草稿/备注） | drafts / notes / templateRows / settings |
| `exchangeRates` | **299** | **0.016%** | **热（每天 1 变 + 幽灵每 2s 戳）** | 1 组 USD/MXN pair |
| `generatedFrom` | ~小 | — | — | 元数据 |
| **总计** | **1,830,461 (~1.83 MB)** | 100% | | |

> 关键洞察：**热数据最小（299 B），冷数据最大（1.42 MB），却焊在同一个 blob**。任何读都按最大的算。

### A.3 实体结构（来自 `store.js` normalizer + 实测 key）
- **shippingLine**（21 行）：`id, name, code?, rfc?, notes, active, demurrage{tiers/rulesByGroup}, guarantee{ratesByGroup}, invoiceNote, terminalMix[], localCharges[], quoteDefaults, containerGroups[], invoiceToConsigneeOnly, demurrageCutoffHandledBy`。嵌套深（费率/免箱规则/担保按柜型组）。
- **containerType**（20）：`key, label, rateGroup`。
- **customs.yard**（28）：`id, name, rates/maniobra, currency, portIds[], shippingLineIds[]`（CONTENTO 26 + José 自建 2；method B = shippingLineIds 空时成本侧 inert）。
- **customs.port**（2）/**terminal**：`id, name, fixedFee, storageRules…`。
- **inland.destination**（44）：`id, name, nameZh, nameEs, lat, lng, precisePoints[]…`。
- **inland.rateEntry**（300）：`id, destinationId, vehiclePrices{…7 车型}, …`。
- **inland.routeCache**（44，~32 KB/条 = 1.42 MB 主体）：`destinationId, 路线 geometry(polyline 坐标), distance, duration…`。
- **quote.draft / note / templateRow**：报价草稿、备注库、模板行。
- **exchangeRates**：`provider, asOfDate, lastCheckedAt, lastError, defaultQuoteCurrency, pairs[{base,quote,rate}]`。

### A.4 读放大现状：59 个路由全走 `loadShippingData()` → 整块 1.83 MB
每个路由不管只需要哪一小块，都 `getShippingData()` 拉满 1.83 MB（缓存命中时省 DB egress，但首次/过期/多实例仍整块）。典型放大：

| 路由 / 场景 | 真正需要 | 实际搬 | 放大 |
|---|---|---|---|
| `POST /admin/:m/exchange-rates/refresh`（幽灵打的） | exchangeRates 299 B | 1.83 MB | **~6,100×** |
| 报价页 `workbench-quote` | quote 10.7 KB + FX 299 B | 1.83 MB | ~170× |
| 换单页 `workbench`（handover） | handover 107 KB | 1.83 MB | ~17× |
| 清关页 `workbench-customs` | customs 285 KB | 1.83 MB | ~6× |
| 陆运页 `workbench-inland`（不开地图时） | dests+rates ~小 | 1.83 MB（含 1.42 MB geometry） | 很大 |
| 任意 admin CRUD | 改的那一小块 | 读 1.83 MB + 写 1.83 MB | 双向放大 |

---

## B. 目标关系表设计（规范化 + 热冷分离）

设计原则：①每类实体一张表，一行一实体；②热数据（FX）单独小表；③冷大数据（inland geometry）单独表，默认不随业务读取一起搬；④消除 handover/customs 船司**镜像**（改成单一 `carriers` + 关联表）；⑤深层、按实体整取的小结构（某船司的免箱规则集/担保/柜组）作为该行的 `jsonb` 列保留（每行很小、总是按船司整取，拆成子表收益小、join 成本大）——**规范化到"实体级"，不强行拆到每个字段**。

> 注：DDL 用 `expressline` schema，与现有一致。所有表带 `created_at/updated_at`，`updated_at` 由触发器或应用维护。金额用 `numeric(14,4)`，币种 `text check in ('MXN','USD')`。

### B.1 热数据：`exchange_rates`（299 B → 自己一行/一表）
```sql
create table expressline.exchange_rates (
  id            smallint primary key default 1 check (id = 1), -- 单例行
  provider      text,
  as_of_date    date,
  last_checked_at timestamptz,
  last_error    text,
  default_quote_currency text not null default 'MXN',
  pairs         jsonb not null default '[]'::jsonb,  -- [{base,quote,rate}]，~200 B
  updated_at    timestamptz not null default now()
);
```
- 汇率刷新：`update exchange_rates set pairs=$1, last_checked_at=now() where id=1`（写 ~200 B）。
- 报价/计算读汇率：`select pairs from exchange_rates where id=1`（读 ~200 B）。
- 幽灵就算每 2s 打，每次也只搬 ~200 B（再叠节流后基本归零）。

### B.2 船司（消除镜像）：`carriers` + `carrier_charges`
```sql
create table expressline.carriers (
  id          text primary key,           -- 'kmtc','cma-cgm',...
  name        text not null,
  code        text,                        -- HAPLLOMEX / ONE_MEX...
  rfc         text,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  -- 按船司整取的深层配置（每行 ~KB 级，规范化到实体级即可）：
  demurrage   jsonb not null default '{}'::jsonb,  -- tiers / rulesByGroup
  guarantee   jsonb not null default '{}'::jsonb,  -- ratesByGroup
  terminal_mix jsonb not null default '[]'::jsonb,
  container_groups jsonb not null default '[]'::jsonb,
  quote_defaults jsonb not null default '{}'::jsonb,
  invoice_note text,
  invoice_to_consignee_only boolean default false,
  demurrage_cutoff_handled_by text,
  notes       jsonb not null default '{}'::jsonb,  -- {zh,es,...}
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 费率（prompt 点名的 ship_line_charges）：本地费用/分组费率，一条一行，FK 船司
create table expressline.carrier_charges (
  id            bigserial primary key,
  carrier_id    text not null references expressline.carriers(id) on delete cascade,
  charge_id     text not null,             -- 业务码：'release-fee','isd',...
  label         text,
  container_group text,                    -- 柜型组 key（null=通用）
  rate          numeric(14,4),
  currency      text check (currency in ('MXN','USD')),
  basis         text,                      -- per_bl / per_container / per_day...
  required      boolean default false,     -- O3 语义：必要即使 0 也显示
  sort_order    integer not null default 0,
  unique (carrier_id, charge_id, container_group)
);
create index on expressline.carrier_charges (carrier_id);
```
> handover/customs 的 21+21 船司镜像 → 合成**一张** `carriers`（21 行）。customs 侧只是用船司做堆场关联，见 B.3 join 表，**镜像彻底消失**（少一类同步 bug）。

### B.3 港口 / 码头 / 堆场：`customs_ports` / `customs_terminals` / `customs_yards`
```sql
create table expressline.customs_ports (
  id text primary key, name text not null, sort_order int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table expressline.customs_terminals (
  id text primary key,
  port_id text references expressline.customs_ports(id) on delete cascade,
  name text not null,
  fixed_fee numeric(14,4), currency text check (currency in ('MXN','USD')),
  storage_rules jsonb not null default '{}'::jsonb,  -- 按柜型分层存储规则
  sort_order int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index on expressline.customs_terminals (port_id);

create table expressline.customs_yards (
  id text primary key,                     -- 28 行（含 José 自建 2）
  name text not null,
  maniobra jsonb not null default '{}'::jsonb,   -- 还箱/洗箱等价目
  currency text check (currency in ('MXN','USD')),
  sort_order int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
-- 堆场 ↔ 港口、堆场 ↔ 船司（method B：空=成本侧 inert）
create table expressline.yard_ports (
  yard_id text references expressline.customs_yards(id) on delete cascade,
  port_id text references expressline.customs_ports(id) on delete cascade,
  primary key (yard_id, port_id)
);
create table expressline.yard_carriers (
  yard_id text references expressline.customs_yards(id) on delete cascade,
  carrier_id text references expressline.carriers(id) on delete cascade,
  primary key (yard_id, carrier_id)
);
```

### B.4 柜型（handover/customs 共享）：`container_types`
```sql
create table expressline.container_types (
  key text primary key,                    -- 20 行
  label text not null,
  rate_group text not null,
  sort_order int default 0
);
```

### B.5 陆运：`inland_origins` / `inland_destinations` / `inland_rate_entries` / **`inland_route_cache`（冷大块单独表）**
```sql
create table expressline.inland_origins (
  id text primary key, name text not null,
  lat double precision, lng double precision
);
create table expressline.inland_destinations (
  id text primary key,                     -- 44 行
  origin_id text references expressline.inland_origins(id),
  name text not null, name_zh text, name_es text,
  lat double precision, lng double precision,
  precise_points jsonb not null default '[]'::jsonb,
  sort_order int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index on expressline.inland_destinations (origin_id);

create table expressline.inland_rate_entries (
  id text primary key,                     -- 300 行
  destination_id text references expressline.inland_destinations(id) on delete cascade,
  vehicle_prices jsonb not null default '{}'::jsonb,  -- 7 车型价
  meta jsonb not null default '{}'::jsonb
);
create index on expressline.inland_rate_entries (destination_id);

-- ⭐ 冷大块：44 条路线 geometry（~32 KB/条 = 1.42 MB），单独表，业务读默认不碰
create table expressline.inland_route_cache (
  destination_id text primary key references expressline.inland_destinations(id) on delete cascade,
  geometry jsonb not null,                 -- polyline 坐标（大）
  distance_m integer, duration_s integer,
  provider text, refreshed_at timestamptz
);
```
> 地图只在打开陆运地图时按目的地取 geometry：`select geometry from inland_route_cache where destination_id=$1`。**77% 的体积从此不再随每次读搬动。**

### B.6 报价：`quote_drafts` / `quote_notes`（templateRows 建议回归代码常量）
```sql
create table expressline.quote_drafts (
  id text primary key, payload jsonb not null,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table expressline.quote_notes (
  id text primary key, label text, body jsonb, sort_order int default 0
);
```

### B.7 模块设置：`module_settings`（小）
```sql
create table expressline.module_settings (
  module_key text primary key,             -- handover/customs/inland/quote
  settings jsonb not null default '{}'::jsonb,
  tax_rate_presets jsonb not null default '[]'::jsonb
);
```

> 索引小结：所有 FK 列建索引（`carrier_charges.carrier_id`、`customs_terminals.port_id`、`inland_*.destination_id/origin_id`、join 表主键即索引）。按 name/code 查的加二级索引。300 条费率 + 44 路线规模极小，索引主要为整洁与未来增长。

---

## C. 迁移方案（一次性 blob → 表；José 数据零丢失是硬约束）

### C.1 迁移脚本 `scripts/migrate-blob-to-relational.js`（dry-run 默认 / --apply 才写）
1. **备份**：先把当前 blob 整存到 `backups/prod-shipping-data-<ts>.json` + sha256（与既有 patch 流程一致，backups/ 已 gitignore）。
2. **读**：`getAppState('shipping-data')` 拿整块（迁移时搬一次整块是可接受的一次性成本）。
3. **拆解 + 插入**（单事务 `begin…commit`）：
   - `exchange_rates` ← `payload.exchangeRates`
   - `carriers` ← `payload.modules.handover.shippingLines`（21 行，customs 镜像丢弃，用 handover 为权威）
   - `carrier_charges` ← 每船司 `localCharges`/`groupRates` 展开
   - `container_types` ← `handover.containerTypes`（20）
   - `customs_ports`/`customs_terminals`/`customs_yards` + `yard_ports`/`yard_carriers` ← `customs.ports/terminals/yards`（28 堆场含 José 自建 2）
   - `inland_origins`/`inland_destinations`/`inland_rate_entries`/`inland_route_cache` ← `inland.*`
   - `quote_drafts`/`quote_notes` ← `quote.*`
   - `module_settings` ← 各模块 `settings`/`taxRatePresets`
4. **校验（迁移后逐项核对，任何不符则回滚）**：
   - 计数：carriers=21、container_types=20、customs_yards=28、inland_destinations=44、inland_rate_entries=300、inland_route_cache=44。
   - José 手改逐项抽查：CMA doc fee=50、KMTC ISD=15、ZIM 改名、COSCO 改价、自建 2 堆场在、7 新空壳在。
   - 端到端：对一组固定报价输入，迁移前（blob 路径）vs 迁移后（表路径）**报价结果逐字段一致**（用现有 quote-test 的样例）。
5. **不删 blob**：`app_state.shipping-data` 行保留为**只读备份**（fallback）；迁移成功并稳定运行 N 周后再考虑归档。

### C.2 迁移是幂等 + 可重跑
- 用 `insert … on conflict (id) do update`，重跑安全。
- 提供 `--verify-only` 模式：只跑 §C.1.4 校验，不写。

---

## D. 代码改造范围

### D.1 数据访问层（`src/lib/store.js` 重写为 repository 风格）
- 现：`getShippingData()` 返回整个 blob 对象；`saveShippingData(data)` 整块写。
- 新：按实体的查询函数，例如：
  - `getExchangeRates()` → `select … exchange_rates`（~200 B）
  - `getCarriers()` / `getCarrier(id)` / `getCarrierCharges(carrierId)`
  - `getCustomsYards({portId, carrierId})`（join 表过滤）
  - `getInlandDestinations()` / `getInlandRateEntries(destId)` / `getInlandRouteGeometry(destId)`（**地图专用，独立调用**）
  - `getQuoteDrafts()` / `getQuoteNotes()`
  - 写：`upsertCarrier()`, `upsertCarrierCharge()`, `deleteYard()`… 每个改自己那张表的行。
- 兼容层（过渡期）：保留一个 `assembleShippingData()` 把多表拼回旧 blob 形状，给尚未改造的路由/`calculate.js`/`quote.js` 用 —— 这样可**分路由灰度迁移**，不必一次改 59 个。

### D.2 路由（`src/server.js`，59 处）
- 逐个把 `loadShippingData()`（整块）换成只查所需实体的函数。
- 高价值优先：FX 刷新路由（只读写 exchange_rates）、报价页（quote+FX）、陆运页（dests+rates，地图按需取 geometry）。
- 过渡期未改的路由走 `assembleShippingData()`（仍整块，但只是过渡）。

### D.3 计算 / 报价 / PDF
- `calculate.js`、`quote.js`、`quote-pdf.js` 目前吃整个 `shippingData`。两种路径：
  - 过渡：继续喂 `assembleShippingData()` 拼出的对象（行为不变，先保正确）。
  - 彻底：改成只接收它真正用到的子集（如某船司+柜型+FX），进一步降内存/CPU。
- **报价数字必须前后一致**（§C.1.4 + §E 验证）。

### D.4 缓存
- 规范化后**绝大多数读本身就小且带索引**，不再需要 1.83 MB 大缓存。
- 可保留一个**极小**的 exchange_rates 内存缓存（200 B，热）或干脆不缓存（查询已极廉）。
- `usage-guard` / `refresh-monitor` 保留（护栏+幽灵陷阱仍有价值）。

### D.5 改造规模量级（估）
- 新增：~12 张表 DDL（迁入 `db-migrate.js`）、1 迁移脚本、`store.js` 重写（~实体数×CRUD）。
- 改：`server.js` 59 路由（可灰度，靠 `assembleShippingData` 过渡）、`calculate/quote/quote-pdf` 接口。
- 量级：大（多 PR、数百处触点），但靠兼容层可**分步、可回滚**地推进。

---

## E. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 迁移漏数据 / José 手改丢失 | 迁移前备份 + 单事务 + §C.1.4 逐项计数与抽查 + 报价结果前后对比，不符即回滚；blob 保留只读 |
| 漏改某路由 / 报价结果变化 | 兼容层 `assembleShippingData` 兜底；灰度逐路由切；quote-test/审计套件回归；固定输入前后 diff |
| 多表写一致性 | 同一业务操作用事务包；FK + on delete cascade 保关系完整 |
| 切换期双路径不一致 | feature flag `STORAGE_MODE=blob\|relational`；先 relational 只读校验，再写切换；可秒切回 blob |
| 大改引入回归 | 分阶段（见 §F），每阶段独立 PR + 全回归 + 生产抽查 + 观察期 |

**回滚**：blob 行始终保留；`STORAGE_MODE=blob` 一键切回旧路径；新表可 `drop`（数据源仍在 blob）。

**建议执行步骤**：
1. PR-A：建表 DDL（`db-migrate`）+ 迁移脚本（dry-run/verify-only），**不切读写**。
2. PR-B：`store.js` 加 relational repository + `assembleShippingData` 兼容层，flag 默认 blob。
3. PR-C：把 **exchange_rates** 与 **inland_route_cache** 两条路径切到表（Phase 1 收益在此）。
4. PR-D…：逐模块/逐路由切，每步回归 + 抽查。
5. 稳定 N 周后：blob 归档为只读备份。

---

## F. 收益量化 + 值不值得做

### F.1 egress / 数据搬运（真实数字）
| 路径 | 现状/次 | 重构后/次 | 降幅 |
|---|---|---|---|
| 汇率刷新（幽灵打的） | 1.83 MB | ~200 B（exchange_rates 行） | **~9,000×** |
| 报价页加载 | 1.83 MB | quote+FX ~11 KB | ~170× |
| 陆运页（不开地图） | 1.83 MB（含 1.42 MB geometry） | dests+rates ~几十 KB | ~30–50× |
| 地图开某目的地 | （已在 1.83 MB 里） | 单条 geometry ~32 KB | 只取需要的 1 条 |
| admin 改一个费率 | 读 1.83 MB + 写 1.83 MB | 读+写该费率行 ~几百 B | ~数千× |

- **整体 egress**：现在靠 1h 缓存压到 ~1.8 GB/天（且 0 人也烧，因幽灵+大箱子）。重构后单次查询本质就是几 KB，**正常使用每天几 MB 量级**，且**不依赖缓存**、**与缓存是否命中无关**。

### F.2 速度
- 索引点查 + 不再每请求 `JSON.parse` 1.83 MB（解析整块的 CPU 也省了）。
- 内存：不再每请求在进程里持 1.83 MB 对象。

### F.3 并发安全
- 行级写：改船司 A 与改堆场 B 物理上不碰同一行，天然不打架（现状全量覆盖会回滚并发改动——round r3 撞过的 bug 从根上消失）。

### F.4 Phase 1（强烈推荐先做）= 20% 工作量拿 ~95% 收益
- 只拆 **exchange_rates（299 B 热）** + **inland_route_cache（1.42 MB 冷）** 两张表：
  - 汇率路径 1.83 MB → 200 B（杀掉 6,100× 放大、幽灵彻底无害）。
  - 其余读不再背 1.42 MB geometry（blob 余下 ~410 KB，已降 77%）。
  - 其它实体暂留 blob（用兼容层），**风险小、改动少**。
- Phase 2（全实体关系化）= 拿剩余 5% + 并发安全 + 可维护性 + 彻底去缓存，工作量大，可从容分 PR 推进。

### F.5 结论（给 Chandler）
- **值得做**：现状是教科书级反模式（单行大 blob 混合热冷数据），重构后 egress、速度、并发、可维护性全面改善，且根治"查一个数搬整个信封"。
- **但是大手术**：建议**先做 Phase 1**（exchange_rates + inland_route_cache 拆表）—— 性价比极高、风险低、立刻拿到绝大部分收益；**Phase 2 全关系化**作为后续从容推进的工程项目，靠兼容层灰度、每步可回滚。
- **不阻塞业务**：当前 egress 已被读缓存+节流压住（~1.8 GB/天、不再击穿），重构是"根治 + 优雅"，不是"救火"。可按 Chandler 节奏排期。

---

## 附：与既有锚点的关系
- 不改变"生产=Supabase、改数据走 patch 不 db:seed"的纪律；迁移脚本本身就是一次受控 patch（备份+事务+校验）。
- `usage-guard`/`refresh-monitor`/`/healthz` 保留（护栏与幽灵陷阱）。
- 本方案**不在本轮执行**；Chandler review 后按 §E 步骤单独立项。
