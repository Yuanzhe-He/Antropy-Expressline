# Spec — `app_state` 大 blob → 关系表 最彻底重构方案（v2）

> 状态：**方案设计文档（plan-only / 提案）**。本文档只设计，**不执行**。建表/迁移须等 ① Chandler + Claude 评审通过 ② 拿到一次性非生产 DB。
> v1 作者：Claude Code · 2026-06-21（commit `90bc784`，divergent line「design blob→relational redesign」；该提交未进 `feature/refactor-godfiles`）。
> v2 修订：Claude Code · 2026-06-22 — 从 `90bc784` 恢复，并依据**重构后** `src/lib/store/normalize-*` 的真实数据形状 + `docs/specs/20260505_*_IMPLEMENTATION_SPEC.md` + `docs/specs/20260610_editable_container_types_IMPLEMENTATION_SPEC.md` 对齐；新增 per-deep-structure「拆表 vs 留 JSONB」决策表、反向迁移（表→blob）、`STORAGE_MODE=blob|dual|relational` + dual-write/shadow-read/parity 闸、子阶段 2a/2b。
> 硬约束：迁移时 **José 手改数据零丢失**（yards=28 含自建 2、carriers=21 含 7 新空壳、CMA doc fee 50、KMTC ISD 15、ZIM 改名、COSCO 改价…）。

---

## 0. v2 修订说明（先讲清 v2 与 v1 的差异）

1. **代码基线变了**：`store.js` 已拆成 `src/lib/store/index.js`（facade）+ `normalize-{shipping-data,customs,handover,inland,quote}.js` + `shared.js`（PR #22，未合并，stack 在 `feature/refactor-godfiles`）。迁移建在 **`index.js` facade 背后**；facade public API（`getShippingData`/`saveShippingData`/`saveExchangeRates`/`getUsers`/`saveUsers`/`RATE_GROUP_NAMES`/…）逐字节不变 → routes/lib 0 改、路由 67 不变。
2. **范围变了**：本轮按 Chandler「长期最好、不计 token 成本」做 **FULL Phase 2（全实体关系化）+ per-entity 写**。v1 把 per-entity 写列为 follow-up；v2 纳入，作为**子阶段 2b**（见 §D）。
3. **保真度修正**：v1 的 §B 若干深层结构与真实 normalizer 不符，v2 §B′ 按代码 ground-truth 修正——最重要的四处：
   - `inland_route_cache` 主键不是 `destination_id`（一个目的地可有多条：destination + 各 precisePoint target），且几何是 `encoded_polyline`（text）不是 `geometry jsonb`；
   - customs charge（terminal `fixedCharges` / yard `dropoffCharges`+`customsCharges`）形状 ≠ handover line `localCharges`，不能塞进同一张 `carrier_charges`；
   - terminal 的存储配置是「`storageRuleSets[]` + 两套 assignment 矩阵（按柜型 / 按 line×柜型）+ unassigned 列表」，不是单个 `storage_rules jsonb`；
   - `inland_rate_entries` 远不止 `vehicle_prices`（proveedor/dupIndex/burreo/cliente/codigoCw/commodity/extras…）。
4. **诚实边界**：§A、§F 的生产实测数字是 **2026-06-21 原始测量**，v2 **未复测**（本次无任何生产/非生产 DB 访问）。迁移与建表均**未执行**。

---

## TL;DR（大白话 + 真实数字，2026-06-21 实测）

- **现状**：所有业务数据塞进 `expressline.app_state` 表**唯一一行**（key=`shipping-data`）的一个 JSONB 字段 = **1.83 MB**。读任何东西都 `select payload`（整块搬 1.83 MB）。"查一个汇率数字也要搬整个信封"。
- **最离谱**：`exchangeRates` 只有 **299 字节**、一天才变一次，却每次坐着 1.83 MB 信封一起搬 —— **放大 ~6,100×**。每 2s 打的幽灵就是汇率刷新路由。
- **最重**：`inland` 占 **1.42 MB = 全 blob 77%**，主体是 44 条路线的几何缓存（~32 KB/条）——冷数据却跟每次读一起搬。
- **目标**：拆成"文件柜"——每类实体一张表、热/冷分开。查哪儿调哪儿、改哪儿改哪儿（行级 `update`，不打架）。
- **v2 范围（本轮 = FULL）**：全实体关系化（2a）+ per-entity 写（2b），facade 透明、parity=0、行为可验证后**停在生产切换前**。

---

## A. 现状分析（v1 原文，2026-06-21 生产实测，v2 未复测）

### A.1 物理现状
- DB 三张表：`app_state`、`audit_logs`、`quote_snapshots`（见 `src/lib/db.js` `migrateDatabase`）。业务数据 100% 在 `app_state` 一行里。
- `app_state` 当前两行：`shipping-data`（1.83 MB blob，revision 214,845）、`users`（小）。
- 读：`db.getAppState(key)` = `select payload … where key=$1` → 整块拉。
- 写：`db.saveAppState` = 整块覆盖；`db.patchAppStateField` = `jsonb_set` 局部写（写省，读仍整块）。
- 应用层有内存读缓存（`store/index.js`，PR#16/17，默认 1h TTL）——"信封方案"的补丁，不是根治。

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

### A.3 实体结构（v2 已按 `src/lib/store/normalize-*` ground-truth 校准 → 详见 §B′）
- **shippingLine / carrier**（21）：`id,name,notes{sourceSheet,code,rfc},active,invoiceToConsigneeOnly,demurrageCutoffHandledBy,containerGroups[],localCharges[],guarantee{ratesByGroup,fallbackRatesByGroup,blRate,…},terminalMix[],demurrage{freeDays,rulesByGroup,ruleSets,assignmentsByContainerType},quoteDefaults{priceMode,quoteCurrency}`。
- **containerType**（20，handover master = 权威，customs 共享）：`key,label,rateGroup`（+ 派生 `rateGroupKeys/shippingLines…`）。
- **customs.port**（2）→ **terminal**：`fixedCharges[]` + `storageRuleSets[]` + `storageAssignmentsByContainerType{}` + `storageAssignmentsByLineContainer{}` + `storageUnassignedLineContainers[]`。
- **customs.yard**（28）：`portIds[],shippingLineIds[],dropoffCharges[],customsCharges[]`（CONTENTO 26 + José 自建 2；method B = `shippingLineIds` 空时成本侧 inert）。
- **inland.origin**（1）/**destination**（44，`nameZh/nameEs/state/imageUrls/coordSource/needsReview/precisePoints[]/enabled`）/**rateEntry**（300）/**routeCache**（44+，`encodedPolyline/距离/时长/viaCities/manualOverride/targetType`）。
- **quote.draft / note / templateRow / settings**。
- **exchangeRates**：`provider,docsUrl,asOfDate,lastCheckedAt,lastError,defaultQuoteCurrency,pairs[{base,quote,rate}]`。

### A.4 读放大：59+ 路由全走 `loadShippingData()` → 整块 1.83 MB（v1 原文）

| 路由 / 场景 | 真正需要 | 实际搬 | 放大 |
|---|---|---|---|
| `POST …/exchange-rates/refresh`（幽灵打的） | exchangeRates 299 B | 1.83 MB | **~6,100×** |
| 报价页 `workbench-quote` | quote 10.7 KB + FX 299 B | 1.83 MB | ~170× |
| 换单页（handover） | handover 107 KB | 1.83 MB | ~17× |
| 清关页（customs） | customs 285 KB | 1.83 MB | ~6× |
| 陆运页（不开地图） | dests+rates ~小 | 1.83 MB（含 1.42 MB geometry） | 很大 |
| 任意 admin CRUD | 改的那一小块 | 读 1.83 MB + 写 1.83 MB | 双向放大 |

---

## B′. 目标关系表设计（v2，对齐真实 normalizer + 规范化到实体级）

设计原则：①每类实体一张表，一行一实体；②热数据（FX）单独小表；③冷大数据（inland route cache）单独表，业务读默认不碰；④消除 handover/customs 船司**镜像**（→ 单一 `carriers` + 关联表）；⑤**深层、按实体整取的小结构**（某船司的免箱规则集/担保/柜组、某 terminal 的存储规则集与分配矩阵）**作为该行的 `jsonb` 列保留**——规范化到"实体级"，不强拆到每个字段（每行 KB 级、总按父实体整取，拆子表 join 成本 > 收益，且 per-entity 写的目标行就是父实体）；⑥**会被独立查询/独立编辑/有 O3「必要费用」语义的费用**（line `localCharges`、terminal/yard charges）拆成**子表一行一费用**（便于按费用增删 + `required/basis` 语义）。

> DDL 用 `expressline` schema。所有表带 `created_at/updated_at`。金额 `numeric(14,4)`，币种 `text check in ('MXN','USD')`。`*_config jsonb` 列存"按父实体整取"的深层结构。下方计数（21/20/28/44/300/44）= 迁移校验锚点（§C.3）。

### B′.1 热数据：`exchange_rates`（单例行，299 B）
```sql
create table expressline.exchange_rates (
  id            smallint primary key default 1 check (id = 1),
  provider      text, docs_url text,
  as_of_date    date, last_checked_at timestamptz, last_error text,
  default_quote_currency text not null default 'MXN',
  pairs         jsonb not null default '[]'::jsonb,   -- [{base,quote,rate}]
  updated_at    timestamptz not null default now()
);
```
- FX 刷新：`update … set pairs=$1,last_checked_at=now() where id=1`（写 ~200 B）。
- 读：`select … where id=1`（~200 B）。幽灵每 2s 打也只搬 ~200 B（叠节流后近零）。

### B′.2 船司（消除 handover/customs 镜像）：`carriers`
```sql
create table expressline.carriers (
  id          text primary key,            -- 'kmtc','cma-cgm',… (21 行，含 7 空壳)
  name        text not null,
  code        text,                         -- notes.code = CODIGO DE NAVIERA
  rfc         text,                         -- notes.rfc = 墨西哥税号
  notes_extra jsonb not null default '{}'::jsonb,  -- handover notes 其余键（sourceSheet…）
  customs_note text,                          -- Q4(2026-06-22): customs 侧 per-line 自由文本备注
                                              -- (admin-customs customs_line_note_<id>，与 handover 结构化 notes 独立)
  active      boolean not null default true,
  invoice_to_consignee_only boolean not null default false,
  demurrage_cutoff_handled_by text,
  sort_order  integer not null default 0,
  -- 按船司整取的深层结构（实体级 JSONB）：
  container_groups jsonb not null default '[]'::jsonb,
  demurrage   jsonb not null default '{}'::jsonb,   -- {freeDays,rulesByGroup,ruleSets,assignmentsByContainerType}
  guarantee   jsonb not null default '{}'::jsonb,   -- {ratesByGroup,fallbackRatesByGroup,blRate,taxRate,benefit*}
  terminal_mix jsonb not null default '[]'::jsonb,  -- [{id,port,terminal,ratio}]
  quote_defaults jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```

`localCharges` 拆子表（O3 必要费用语义 + 可按费用增删）：
```sql
create table expressline.carrier_local_charges (
  id            text primary key,           -- 业务 charge.id
  carrier_id    text not null references expressline.carriers(id) on delete cascade,
  concept       text not null,
  note          text,
  tax_rate      numeric(8,4) not null default 0,
  group_rates   jsonb not null default '{}'::jsonb,  -- {containerKey:{label,qtyHint,currency,rate}}
  bl_rate       jsonb,                       -- {qtyHint,currency,rate} | null
  sort_order    integer not null default 0
);
create index on expressline.carrier_local_charges (carrier_id);
```

### B′.3 柜型（handover master = 权威，customs 共享）：`container_types`
```sql
create table expressline.container_types (
  key         text primary key,            -- 20 行（STANDARD_HANDOVER_CONTAINER_TYPES）
  label       text not null,
  rate_group  text not null,               -- 命名 rate group（rateGroupKeys 由代码常量派生，不入库）
  sort_order  integer not null default 0
);
```
> `rateGroupKeys`、`shippingLineCount`、`shippingLines` 等是 normalizer 的**派生**字段（来自 `RATE_GROUPS` 常量 + 当前 carriers），**不持久化**，组装时算。

### B′.4 港口 / 码头 / 堆场
```sql
create table expressline.customs_ports (
  id text primary key, name text not null, note text, sort_order int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table expressline.customs_terminals (
  id text primary key,
  port_id text not null references expressline.customs_ports(id) on delete cascade,
  name text not null, note text, sort_order int default 0,
  -- terminal 存储配置：按 terminal 整取整写的深层结构 → 实体级 JSONB
  storage_config jsonb not null default '{}'::jsonb,
    -- {storageRuleSets:[{id,name,sourceContainerKey,sourceContainerKeys,rules:[…]}],
    --  storageAssignmentsByContainerType:{typeKey:setId},
    --  storageAssignmentsByLineContainer:{lineId:{typeKey:setId}},
    --  storageUnassignedLineContainers:[...],
    --  storageRulesByContainer:{typeKey:[…]}  ← 派生，可不存、组装时由 sync 重算}
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index on expressline.customs_terminals (port_id);

-- terminal 固定费用（fixedCharges）拆子表
create table expressline.terminal_charges (
  id text primary key,
  terminal_id text not null references expressline.customs_terminals(id) on delete cascade,
  concept text not null, note text,
  tax_rate numeric(8,4) not null default 0,
  group_rates jsonb not null default '{}'::jsonb,
  basis text not null default 'per_occurrence' check (basis in ('per_day','per_occurrence')),
  required boolean not null default false,
  amount numeric(14,4), amount_currency text default 'MXN',
  sort_order int default 0
);
create index on expressline.terminal_charges (terminal_id);

create table expressline.customs_yards (
  id text primary key,                      -- 28 行（含 José 自建 2）
  name text not null, note text, sort_order int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
-- yard 费用（dropoffCharges + customsCharges），kind 区分
create table expressline.yard_charges (
  id text primary key,
  yard_id text not null references expressline.customs_yards(id) on delete cascade,
  kind text not null check (kind in ('dropoff','customs')),
  concept text not null, note text,
  tax_rate numeric(8,4) not null default 0,
  group_rates jsonb not null default '{}'::jsonb,
  basis text not null default 'per_occurrence' check (basis in ('per_day','per_occurrence')),
  required boolean not null default false,
  amount numeric(14,4), amount_currency text default 'MXN',
  sort_order int default 0
);
create index on expressline.yard_charges (yard_id);

-- 关联：堆场↔港口、堆场↔船司（method B：空=成本侧 inert）
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
> customs 模块原本还镜像一份 `shippingLines`（`normalizeSimpleShippingLine`：id/name/active/notes/yardIds）。该镜像**消失**：yard↔carrier 关系迁到 `yard_carriers`（`shippingLineIds`/`yardIds` 互为反向）。

### B′.5 陆运（冷大块单独表）
```sql
create table expressline.inland_origins (
  id text primary key, name text not null,
  lat double precision, lng double precision
);

create table expressline.inland_destinations (
  id text primary key,                      -- 44 行
  name text not null, name_zh text, name_es text, state text,
  lat double precision, lng double precision,
  coord_source text, needs_review boolean default false,
  image_urls jsonb not null default '[]'::jsonb,        -- 只存 http(s) URL（XSS 已在 normalizer 过滤）
  precise_points jsonb not null default '[]'::jsonb,    -- [{id,name,lat,lng,flatPrice,note,source,link}]
  enabled boolean not null default true, note text, sort_order int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table expressline.inland_rate_entries (
  id text primary key,                      -- 300 行
  origin_id text references expressline.inland_origins(id),
  destination_id text not null references expressline.inland_destinations(id) on delete cascade,
  proveedor text, dup_index int not null default 1,
  cliente text, codigo_cw text, commodity text,
  sencillo numeric(14,4), full numeric(14,4),
  burreo jsonb,                              -- {sencillo,full} | null
  vehicle_prices jsonb not null default '{}'::jsonb,    -- 7 车型价（EXTRA_VEHICLE_KEYS）
  currency text not null default 'MXN',
  enabled boolean not null default true, note text,
  extras jsonb not null default '{}'::jsonb
);
create index on expressline.inland_rate_entries (destination_id);

-- ⭐ 冷大块：路线几何（~32 KB/条 = 1.42 MB 主体），业务读默认不碰
create table expressline.inland_route_cache (
  id text primary key,                      -- 44+ 行（一目的地可有多条 target）
  origin_id text references expressline.inland_origins(id),
  destination_id text not null references expressline.inland_destinations(id) on delete cascade,
  target_type text not null default 'destination' check (target_type in ('destination','precisePoint')),
  target_id text,
  encoded_polyline text,                     -- 编码折线（大）
  distance_km numeric, duration_min numeric,
  via_cities jsonb not null default '[]'::jsonb,
  engine text default 'osrm', fetched_at timestamptz,
  stale boolean default false, has_ferry boolean default false,
  manual_override jsonb,                      -- {distanceKm,durationMin,viaCities} | null
  unique (origin_id, destination_id, target_type, target_id)
);
create index on expressline.inland_route_cache (destination_id);
```
> 地图只在打开陆运地图时按 target 取：`select encoded_polyline,… where destination_id=$1`。**77% 体积不再随每次读搬动。**

### B′.6 报价 / 模块设置
```sql
create table expressline.quote_drafts (
  id text primary key, number text, date text,
  header jsonb not null default '{}'::jsonb, quote_mode text,
  line_items jsonb not null default '[]'::jsonb, note_ids jsonb not null default '[]'::jsonb,
  language text, created_at timestamptz, updated_at timestamptz
);
create table expressline.quote_notes (
  id text primary key, en text, es text, zh text, sort_order int default 0
);
create table expressline.module_settings (
  module_key text primary key,              -- handover/customs/inland/quote
  settings jsonb not null default '{}'::jsonb,       -- 含 quote 编号配置 / headerDefaults / 各 version 标记
  tax_rate_presets jsonb not null default '[]'::jsonb
);
```
> `templateRows` 与 `QUOTE_TEMPLATE_ROWS`/`QUOTE_NOTES` 一样由代码常量 seed（`templateVersion` 控制），**建议仍以代码常量为种子**，仅当后台编辑过才入 `quote_notes`/未来的 `quote_template_rows`（评审待决，见 §G）。

### B′.7 per-deep-structure「拆表 vs 留 JSONB」决策表（用户明确要求）

| 深层结构 | 现形状（normalizer） | v2 决策 | 理由 / 写粒度影响 |
|---|---|---|---|
| `exchangeRates.pairs` | 数组 ~200 B | **JSONB**（`exchange_rates.pairs`） | 单例、整取整写；拆子表无收益。FX 写 = 1 行 update。 |
| carrier `demurrage`（freeDays/rulesByGroup/ruleSets/assignmentsByContainerType） | 嵌套 obj，KB 级 | **JSONB**（`carriers.demurrage`） | 永远按船司整取；按柜型组/规则集拆子表 join 爆炸。2b 写目标 = carrier 行。 |
| carrier `guarantee` / `terminalMix` / `containerGroups` / `quoteDefaults` | obj/数组 | **JSONB**（carriers 列） | 同上，实体级整取。 |
| carrier `localCharges` | 数组，每条有 O3 `required`/`basis`、可增删 | **子表**`carrier_local_charges` | 按费用独立增删、可查询；`group_rates` 仍 JSONB（按柜型 map）。 |
| terminal `storageRuleSets` + 两套 assignment 矩阵 + unassigned | 深嵌、互相一致、由 `syncNormalizedTerminalStorageRulesByContainer` 重算 | **JSONB**（`customs_terminals.storage_config`） | 整取整写、内部派生一致性强；拆子表要在 DB 复刻 sync 逻辑，风险高。2b 写目标 = terminal 行（编辑 terminal A 不碰 B）。**备选**：拆 `terminal_storage_rule_sets`+`terminal_storage_assignments`（见 §G）。 |
| terminal `fixedCharges` / yard `dropoffCharges`+`customsCharges` | 数组，O3 语义 | **子表**`terminal_charges`/`yard_charges` | 同 localCharges：可增删/查询；`group_rates` JSONB。 |
| terminal `storageRulesByContainer` | 派生（= 选中规则集的 rules 拷贝） | **不持久化** | normalizer 组装时由 `storage_config` + sync 重算，存了会与规则集打架。 |
| inland `precisePoints` | 数组，每点价/坐标/链接 | **JSONB**（`inland_destinations.precise_points`） | 按目的地整取；点数少。**备选**：拆 `inland_precise_points`（若要按点查/独立编辑，见 §G）。 |
| inland `vehiclePrices` / `burreo` / `extras` | 小 obj | **JSONB**（rate entry 列） | 7 车型固定 map，整取；`sencillo`/`full` 已平铺成列（热查询字段）。 |
| inland `routeCache.encodedPolyline` + geometry | 大字符串（冷） | **独立表**`inland_route_cache` | §A.2 的 77%；热冷分离的核心收益。 |
| quote `lineItems` / `header` / `noteIds` | 草稿内数组/obj | **JSONB**（`quote_drafts` 列） | 草稿按整取整写；拆 line item 子表对报价无查询收益。 |
| `container_types.rateGroupKeys` / `shippingLines*` | 派生 | **不持久化** | 由 `RATE_GROUPS` 常量 + carriers 组装。 |

---

## C. 迁移 + 反向迁移（José 数据零丢失 = 硬约束）

### C.1 正向 `scripts/migrate-blob-to-relational.js`（dry-run 默认 / `--apply` 才写）
1. **备份**：`getAppState('shipping-data')` 整存到 `backups/prod-shipping-data-<ts>.json` + sha256（沿用既有 patch 纪律，`backups/` 已 gitignore）。
2. **读**：拿整块（迁移时搬一次整块可接受）。
3. **拆解 + upsert**（单事务）：`exchange_rates ← exchangeRates`；`carriers(+carrier_local_charges) ← handover.shippingLines`（21；customs 镜像丢弃，handover 权威，但 **`carriers.customs_note ← customs.shippingLines[id].notes`** 保留 Q4 的 customs 侧备注）；`container_types ← handover.containerTypes`（20）；`customs_ports/terminals(+terminal_charges)/yards(+yard_charges)/yard_ports/yard_carriers ← customs.*`（28 堆场）；`inland_origins/destinations/rate_entries/route_cache ← inland.*`（44/300/44+）；`quote_drafts/quote_notes ← quote.*`；`module_settings ← 各模块 settings/taxRatePresets`。
4. **幂等**：全部 `insert … on conflict (id) do update`，重跑安全。`--verify-only` 只跑 §C.3 校验不写。
5. **不删 blob**：`app_state.shipping-data` 保留为只读 fallback。

### C.2 反向 `scripts/migrate-relational-to-blob.js`（表→blob 回滚，§2 铁律要求）
- 从所有实体表读回，**用同一套 `normalizeShippingData` 组装** → 与原 blob 同形状的对象 → 写回 `app_state.shipping-data`（或导出文件）。
- 用途：① cutover 出问题一键回 blob；② parity 闸的"反向投影"基准。
- 验收：`reverse(forward(blob)) === normalizeShippingData(blob)`（逐字段，§C.3）。

### C.3 parity 闸（行数 + 字段级 diff = 0）
- **计数**：carriers=21、container_types=20、customs_yards=28、inland_destinations=44、inland_rate_entries=300、inland_route_cache=44+。
- **José 手改抽查**：CMA doc fee=50、KMTC ISD=15、ZIM 改名、COSCO 改价、自建 2 堆场在、7 空壳在。
- **逐字段**：`blob-projection`（从表 `assembleShippingData()` 组装）vs 原 blob，`JSON.stringify` 深比 = 0。
- **mirror orphan gate（Q4）**：每个 `yard.shippingLineIds` ∈ carriers、每个 customs `shippingLines[].id` ∈ handover、每个 customs `line.yardIds` ∈ yards；有 orphan → **停**，先和解再迁（否则 `yard_carriers` FK 静默丢链接）。本地 data 已过（0 orphan），**prod blob 必须重跑**（José 的 method-B yard↔line 映射只在 prod）。
- **币种 gate（Q5）**：扫 prod blob 全部 currency/amountCurrency/quoteCurrency/pairs 字段 ∈ {MXN,USD}（`check (currency in ('MXN','USD'))` 会 fail-loud）；任何越界值 → **停**（不靠 `normalizeCurrencyCode` 静默 coerce 成 MXN）。本地 raw data 已过（0 越界）。
- **端到端**：固定报价输入，blob 路径 vs 表路径报价结果逐字段一致（复用 `quote-test` 样例）。任何不符 → 回滚。

---

## D. facade 内部改造 + STORAGE_MODE + 子阶段 2a/2b

### D.1 `STORAGE_MODE = blob | dual | relational`（facade 内部开关，env 读取）
- `blob`（现状/默认）：facade 走 `app_state` blob（今天的行为）。
- `dual`：**写** blob + 表（双写）；**读** blob，同时**影子读**表并 diff（出 parity 报告，不影响返回值）。
- `relational`：读写都走实体表；blob 保留只读 fallback。
- 任意模式 facade public API 不变（`getShippingData` 仍返回整块形状，内部由 `assembleShippingData()` 从表组装）。

### D.2 子阶段 2a — 数据表示变化（facade 不变、行为 byte-exact）
- 建表（迁入 `db-migrate.js`）+ 正向/反向迁移脚本。
- facade 内部：`getShippingData` 在 `relational` 下用 `assembleShippingData()` 从表组装（不读整 blob）；`saveShippingData` 内部拆 per-entity upsert（**签名不变**）。
- 闸：`STORAGE_MODE=relational` 跑 `test:all`（14 套）+ `quote-test` 全绿 + 报价 diff=0；`dual` 影子 diff=0。
- **2a 全绿 = 行为-exact 检查点** → commit，再进 2b。routes/lib 0 改、路由 67 不变 = facade 透明证明。

### D.3 子阶段 2b — per-entity 写（行为改进，根治并发 clobber）
- facade 加 per-entity 写方法：`saveCarrier(id,…)`/`saveCarrierLocalCharge`/`saveCustomsPort`/`saveCustomsTerminal`/`saveTerminalCharge`/`saveCustomsYard`/`saveYardCharge`/`saveInlandDestination`/`saveInlandRateEntry`/`saveInlandRouteCache`/`saveQuoteDraft`/`saveQuoteNote`/`saveModuleSettings`/…，各自只 upsert 自己那行/那组。
- admin 写路由调用点从 `saveShippingData(整坨)` 改成对应 per-entity 写。
- 测试：每个改过的写路由断言「只动目标实体、其他不变」；加并发测试（两实体并发写不互相 clobber）。
- 保留 `saveShippingData` 兼容入口（cross-section / 冷缓存回落整写），路由默认走 per-entity。
- **诚实**：2b 是写行为**改变**（更好，但变了），靠测试网兜；生产收益要等 cutover。

### D.4 dual-write + shadow-read + parity 报告
- `dual` 模式下每次写后跑一次轻量 parity（目标实体的 blob-projection vs 表）；积累 parity 报告。
- cutover 观察窗用 `dual`：José 编辑双写、影子 diff 持续监控，=0 才切 `relational`。

---

## E. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 迁移漏数据 / José 手改丢失 | 迁移前备份 + 单事务 + §C.3 计数/抽查/报价对比，不符即回滚；blob 保留只读 |
| 深层 JSONB 结构迁移走形 | parity 逐字段 = 0；`reverse(forward(blob))===normalizeShippingData(blob)` 双向验证 |
| 漏改某写路由 / 报价变化 | `assembleShippingData` 兼容层兜底；2a 行为-exact 闸；`quote-test`/审计套件回归；固定输入前后 diff |
| 多表写一致性 | per-entity 写包事务；FK + on delete cascade 保关系完整 |
| 切换期双路径不一致 | `STORAGE_MODE=blob\|dual\|relational`；先 dual 影子校验再切；可秒切回 blob |
| terminal `storage_config` 大 JSONB 仍偏大 | 写目标是 terminal 行（非全 blob），已天然隔离；若单 terminal 过大再评估拆子表（§G） |

**回滚**：blob 行始终保留；`STORAGE_MODE=blob` 一键切回；反向脚本（§C.2）可把表写回 blob；新表可 `drop`。

---

## F. 收益量化（v1 原文，2026-06-21 实测，v2 未复测）

| 路径 | 现状/次 | 重构后/次 | 降幅 |
|---|---|---|---|
| 汇率刷新（幽灵打的） | 1.83 MB | ~200 B | **~9,000×** |
| 报价页加载 | 1.83 MB | quote+FX ~11 KB | ~170× |
| 陆运页（不开地图） | 1.83 MB | dests+rates ~几十 KB | ~30–50× |
| admin 改一个费率 | 读 1.83 MB + 写 1.83 MB | 读+写该费率行 ~几百 B | ~数千× |

- **整体 egress**：现靠 1h 缓存压到 ~1.8 GB/天（0 人也烧）。重构后单次查询本质几 KB、**不依赖缓存**，正常使用每天几 MB 量级。
- **并发安全**：行级写 → 改船司 A 与改堆场 B 物理不碰同一行，round-r3 撞过的「全量覆盖回滚并发改」从根消失（= 2b 的目标）。

---

## G. 评审待决问题（给 Chandler / Claude，建表前定）

1. **terminal `storage_config`**：留单 JSONB（实现简单、写目标=terminal 行）vs 拆 `terminal_storage_rule_sets` + `terminal_storage_assignments`（更规范、但要在 DB/组装层复刻 `syncNormalizedTerminalStorageRulesByContainer`）？默认 JSONB。
2. **inland `precise_points`**：留 JSONB（按目的地整取）vs 拆 `inland_precise_points`（若要按点查询/独立编辑/精确点路线）？默认 JSONB。
3. **`templateRows`**：维持代码常量 seed（不入库、版本可控）vs 入 `quote_template_rows`（允许后台改模板行）？默认代码常量。
4. **carriers 镜像合并** — [Q4 已核查 2026-06-22 → 已解决]：customs `shippingLines` 镜像消费字段 = `id`（→carriers，同 id 空间，add/delete 路由强制同步）+ `yardIds`↔`yard.shippingLineIds`（→`yard_carriers`）+ **`notes`（customs 侧自由文本，admin-customs.js:696 写、admin-customs.ejs:105 显示 → 已加 `carriers.customs_note` 保留）**。`active`/`name` 无独立消费（name=handover name；active 默认 true、无过滤逻辑读它）。本地 `data/shipping-lines.json`：14 carriers、镜像 id 全 ⊆ handover、0 orphan。⚠ **生产 gate**：prod 有 José 的 yard↔line 映射，迁移前必跑 §C.3 mirror orphan gate。
5. **金额精度/币种** — [Q5 已核查 2026-06-22 → 已确认]：全部币种字段经 `normalizeCurrencyCode` → `CURRENCY_OPTIONS`={MXN,USD}；本地 raw data 0 越界值。`numeric(14,4)` + `MXN|USD` check 采纳（用户批准）。⚠ prod blob 迁移前跑 §C.3 币种 gate（fail-loud，不静默 coerce）。
6. **PR 切分**：建议 A=DDL+迁移脚本（不切读写）→ B=facade relational + assemble 兼容层（flag 默认 blob）→ C=2a 切 relational/dual + parity 闸 → D=2b per-entity 写。每步独立 PR + 全回归 + 抽查。

---

## 附：与既有锚点的关系
- 不改"生产=Supabase、改数据走 patch 不 db:seed"纪律；迁移脚本本身是一次受控 patch（备份+事务+校验）。
- `usage-guard`/`refresh-monitor`/`/healthz` 保留（护栏 + 幽灵陷阱仍有价值）。
- 本方案**不在本轮执行**；评审通过 + 拿到非生产 DB 后，按 §C/§D 分步执行，生产切换硬停等 Chandler 逐项批准。
