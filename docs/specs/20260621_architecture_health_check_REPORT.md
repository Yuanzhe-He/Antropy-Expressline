# Architecture Health Check — Express Line (READ-ONLY)

> 日期：2026-06-21 · 模式：只读（仅 `wc -l`/`grep`/读文件，未改任何代码/依赖/测试）。
> 每个结论带 file:line 证据。关联：`20260621_blob_to_relational_redesign.md`（数据层）、`20260621_architecture_redesign_PLAN.md`（代码结构层）。

## A. 栈与规模
- 栈：Node + **Express 5**（`package.json` deps: express ^5.1.0）+ **EJS** 视图 + **pg**（Supabase Postgres）。DB 访问层 = `src/lib/db.js`（`new Pool`，原生 SQL）。
- 规模（`wc -l`）：`src/`+`src/lib/` JS = **13,506 行**；`public/` JS = 2,276；`views/` = 20 个 EJS / 8,488 行；`scripts/` = 26 个。
- `docs/ARCHITECTURE.md` 存在，但只描述**业务表面/profile**（surfaces、persistence options、auth、模块名、hot files），**不描述代码内部结构**；并自陈 "exact ownership boundaries should be confirmed against source files"（ARCHITECTURE.md:54,71）、"unresolved: which persistence mode"（:36）。→ 文档没记录真实的 god-file/单 blob 结构，与实际不一致（实际见 B/D）。

## B. 大文件清单（god-file 检查）
最大源文件：

| 文件 | 行数 | 判断 |
|---|---|---|
| `src/server.js` | **4707** | ★god-file（混路由+业务逻辑+持久化） |
| `src/lib/store.js` | **2606** | ★god-file（全模块 normalizer + 读写 + 缓存） |
| `src/lib/i18n.js` | 1526 | 大**但内聚**（翻译字典，不建议拆，见判断） |
| `src/lib/calculate.js` | 1180 | 偏大，单一职责（费用计算），可接受 |
| `src/lib/quote.js` | 943 | 偏大，报价模板/常量+塑形 |
| `public/app.js` / `inland-map.js` / `calculator.js` | 796/709/521 | 前端，可接受 |

- **`server.js`（4707）混三类职责**，同一文件里：
  - 认证中间件：`requireAuth`（server.js:92）。
  - **~77 个内联业务逻辑函数**（`grep -cE '^(async )?function'` = 77），如 customs 存储规则 `buildCustomsStorageRuleSetDraft`（server.js:466）、`syncTerminalStorageRulesByContainer`（server.js:526）、船司草稿 `buildShippingLineDraft`（server.js:387）、`appendProgressiveRule`（server.js:128）、`applySequentialRuleUpdates`（server.js:244）。
  - 持久化封装：`loadShippingData`（server.js:834）。
  - **75 个路由/中间件**（`app.get/post/use` = 11+56+8），跨 handover/customs/inland/quote/admin/fx：workbench（server.js:1908-2210）、admin/inland（2266-2792）、admin/settings+fx（2797-3072）、admin/customs（3073-3717）、admin/shipping-lines（3718-4500+）。
  - → 组合根（wire 路由）**同时**实现业务逻辑**同时**包持久化 = 教科书 god-file。
- **`store.js`（2606）混**：89 个函数、其中 **46 个 `normalize*`**（`normalizeShippingLine` :797、`normalizeCustomsModuleData` :1705、`normalizeInlandModuleData` :2022、`normalizeQuoteModuleData` :2222）= **全模块数据塑形** + 读写（`getShippingData` :2435 / `saveShippingData` :2479）+ **缓存**（`shippingDataCache` :2348）+ seed。一个文件管所有模块的数据形状 + 持久化 + 缓存。
- **`i18n.js`（1526）= 大但内聚**：纯翻译字典（trilingual zh/es/en），单一职责、改动局部。**判断：不需要拆**（按行数一刀切是错的）。可选：按模块切成多文件改善加载/可读，但非问题。

## C. 耦合与边界（谁依赖谁）
- caller-ledger（被多少 src/scripts 文件 require）：**`store.js` ← 17 个文件（中心 hub）**、`db.js` ← 7、`calculate.js` ← 5、`quote.js` ← 4、`i18n.js` ← 4、`exchange-rates.js` ← 4。
- `server.js` import **14 个 lib 模块**（server.js:9-80：calculate/inland-*/exchange-rates/scheduler/usage-guard/refresh-monitor/i18n/modules/options/store/quote/quote-pdf/db）= spider，伸进几乎所有模块。
- **边界 = convention-only**（小项目，无 ESLint boundaries/dependency-cruiser，符合栈预期）。跨模块基本走 `store` 这个 hub 取整个 `shippingData` 对象，再各自从中挑数据——**没有按实体的清晰 API**，而是"拿整包自己翻"。
- 实际结构：逻辑高度集中在 server.js + store.js 两个 god-file，其余 lib 是较内聚的小模块（inland-*、exchange-*、calculate、quote）。

## D. 数据层 cohesion（单 blob）★重点
- 持久数据：`expressline.app_state` **一行**（key=`shipping-data`）的一个 JSONB = **1.83MB**（实测 `octet_length(payload::text)`）。结构：`modules.{handover,customs,inland,quote}` + `exchangeRates` + `generatedFrom`（`store.normalizeShippingData` :2307 区）。
- **读一个小字段要加载整个 blob**：`db.getAppState`（db.js:120）`select payload from app_state where key=$1` —— 整块拉，无字段投影。
- **写一个字段要 RMW 整块**：`db.saveAppState`（db.js:130）整块覆盖；`db.patchAppStateField`（db.js:169）`jsonb_set` 写时局部、但读仍整块。
- **热冷混装（最伤）**：`exchangeRates` 仅 **299 字节**（热，每天变）与 `inland` **1.42MB**（冷，路线 geometry）焊在同一 blob → 汇率刷新搬 1.83MB 只为 299B（**~6,100×** 放大）。
- **并行镜像副本要手动同步**：`modules.customs.shippingLines` 是 handover 的独立镜像（server.js:416 `buildSimpleShippingLineMirror`；server.js:4658-4667 "Keep the customs-side mirror's name/notes in sync"；LESSONS.md:166 "PARALLEL LIST MIRRORS … must be written to BOTH lists"）。
- **★交叉**：单 blob 既是**架构问题**（耦合：所有实体焊一起、镜像要同步）也是**数据库问题**（egress：每读搬 1.83MB）。

## E. 改动爆炸半径探针
- **"给船公司加一个字段"**：要改 ≥5 处分散点 —— `store.normalizeShippingLine`（store.js:797）+ `server.buildShippingLineDraft`（server.js:387）+ `server.buildSimpleShippingLineMirror`（server.js:416）+ 镜像同步（server.js:4658）+ 视图（`views/workbench.ejs`/`admin*.ejs`）+（若计算用到）`calculate.js`。健康架构应少而局部，这里多而分散。
- **"改一个汇率"**：`exchange-rates.js` + `store.saveExchangeRates` + `db.patchAppStateField` + 缓存更新 —— 现在相对局部（egress 那条线已优化）。
- **过去痛点（LESSONS 实证）**：
  - normalizer parity："works live, lost on round-trip"（LESSONS.md:40-41，parse 路径与 store normalizer 不同步导致存草稿丢字段）。
  - 三处 parity（buildQuoteFormData / normalizeQuoteDraft / 默认预设）漏一处就静默丢值（LESSONS.md:152-153）。
  - 并行列表镜像（LESSONS.md:166）。
  - FX 全量覆盖回滚并发改动（已修，根源仍是单 blob）。
  - 这些 bug 类**都源自"逻辑/数据散落 + 单 blob"**。

## F. 结论
**架构当前：需要结构性重构（局部 god-file + 单 blob）。** 不是健康稳态。按"多伤害改动安全性"排序：

1. **单 blob（app_state 一行 1.83MB）** —— 同时伤 egress（每读搬 1.83MB）、并发（全量覆盖回滚他人改动）、改动安全（镜像要手动同步、热冷混装）。**值得修。** 数据层解耦方案见 `20260621_blob_to_relational_redesign.md`（已详述，本报告不重复）。
2. **`server.js` god-file（4707 行，路由+业务+持久化三混）** —— 主要伤**可维护性/改动安全/可测试性**（任何小改要在 4707 行里穿行；AI/人都易误伤邻近逻辑）。**值得修。** 形状见 §G + `architecture_redesign_PLAN.md`。
3. **`store.js` god-file（2606 行，全模块 normalizer+读写+缓存）** —— 与单 blob 解耦绑定：blob→表后，store 自然按实体 repository 化。**随 #1 一起治。**
- `i18n.js`（1526）= 大但内聚，**可接受现状**（不按行数硬拆）。`calculate.js`/`quote.js` 偏大但单一职责，可接受/低优先。

## G. 重构形状（只出形状，不执行）
- **server.js god-file → 拆**（纯搬移 + 改 import，业务逻辑不动）：`routes/{handover,customs,inland,quote,admin,exchange-rates}.js` + `middleware/`（auth/session/i18n/语言）+ 业务 helper 进 `src/lib/<module>/`（如 customs 存储规则逻辑 → `lib/customs-rules.js`）+ 组合根 `server.js` 只留 wire-up。详见 `architecture_redesign_PLAN.md`。
- **单 blob → 规范化表**（实体清单：`exchange_rates` / `carriers` + `carrier_charges` / `customs_ports`/`terminals`/`yards`+join / `container_types` / `inland_origins`/`destinations`/`rate_entries`/**`inland_route_cache`(冷大块单表)** / `quote_drafts`/`notes` / `module_settings`）。字段/主键/外键/DDL 见 `blob_to_relational_redesign.md` §B（本报告不重复）。
- **缺边界 → 文档化模块边界**（小项目不上 lint）：每个 `lib/<module>` 暴露 public API，跨模块只走 API 不进内部；写进 ARCHITECTURE.md。
- **迁移零丢失约束**：José 手改生产数据（yards=28 含自建 2、carriers=21 含 7 新空壳、CMA doc fee 50、KMTC ISD 15、ZIM 改名、COSCO 编辑）—— 备份+单事务+逐项核对+报价结果前后一致。
- **分阶段 + human checkpoint**：每阶段独立 PR、可验证、可回滚（详见 plan）。

---

## 给 Chandler 的明确结论
1. **整体健不健康**：核心两处不健康——**单 blob** 和 **server.js god-file**；其余 lib 大体内聚、可接受。i18n 大但内聚不用动。
2. **最该先动的 1-2 个结构性问题**：① 单 blob（数据层）② server.js 拆分（代码层）。
3. **哪个更紧急**：
   - **server.js 拆分风险最低、最该先做**（纯搬移、行为不变、全回归可证、立刻提升改动安全；不依赖数据层）。
   - **blob→表收益最大但是大手术**（同时治 egress+耦合+并发），建议其 **Phase 1（拆 exchange_rates + inland_route_cache）** 与 server.js 拆分**可并行**（一个动代码组织、一个动数据存储，互不阻塞）。
4. **本次只体检没动代码**；是否执行、先做哪个、何时做 —— 由 Chandler 拍板（两份 plan 文档已就绪）。
