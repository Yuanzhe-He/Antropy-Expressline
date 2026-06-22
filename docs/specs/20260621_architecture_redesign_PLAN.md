# Spec — 代码结构重构方案（server.js god-file + src/lib 模块边界）

> 状态：**方案设计文档（plan-only）**。只设计，不执行。Chandler review 后单独立项分阶段做。
> 作者：Claude Code · 日期：2026-06-21 · 依据：`20260621_architecture_health_check_REPORT.md`（体检证据）
> **边界（单一来源，不重复）**：**数据层解耦（blob→关系表）见 `20260621_blob_to_relational_redesign.md`**。本方案只管**代码怎么组织**（server.js 拆分 + src/lib 模块边界），不碰数据怎么存。两者交汇点 = store.js 的 repository 化（见 §F）。

---

## TL;DR（大白话）
- **病**：`server.js` 一个文件 **4707 行**，把三件事焊在一起——①接路由（75 个）②实现业务逻辑（77 个内联函数：customs 存储规则、船司草稿、terminal mix…）③包持久化（loadShippingData）。`store.js` **2606 行**把所有模块的数据塑形（46 个 normalizer）+ 读写 + 缓存焊在一起。
- **后果**：改任何一小块都要在几千行里穿行、容易误伤邻近逻辑；逻辑散落导致反复出"parse/store 不同步、镜像漏同步"这类 bug（LESSONS 实证多次）。
- **治**：把 server.js 按"组合根 / 路由 / 中间件 / 业务逻辑"拆开，每个模块的路由+业务各自成文件；server.js 只留 wire-up。**纯搬移 + 改 import，业务逻辑一行不动，报价/计算结果前后逐字节一致。**
- **收益**：可维护性、改动安全、可测试性。**注意：代码解耦不直接降 egress**——egress 是数据层（blob→表）的收益，两者别混。
- **建议**：**先拆 server.js（风险最低、行为不变、不依赖数据层）**；可与数据方案的 Phase 1 **并行**。分阶段、每阶段独立 PR + 全回归 + 可回滚。

---

## A. 现状分析（基于体检，带 file:line + 真实行数）

### A.1 server.js = 4707 行，三职责混装
按职责块的大致行数区间（`grep` 实测）：
- **基础设施/工具**（~行 1-833）：`requireAuth`（:92）、`ensureArray`/`uniqueIds`/`parseWholeNumber`（:97/107/111）等通用工具，**夹杂大量业务 helper**（见下）。
- **业务逻辑 helper（~77 个内联函数）**，跨模块散落在路由之前：
  - customs：`buildCustomsStorageRuleSetDraft`（:466）、`syncTerminalStorageRulesByContainer`（:526）、`buildCustomsTerminalDraft`（:601）、`buildCustomsPortDraft`（:655）、`buildCustomsYardDraft`（:693）、`countCustomsContainerReferences`（:671）。
  - handover/船司：`buildShippingLineDraft`（:387）、`buildSimpleShippingLineMirror`（:416）、`buildLocalChargeDraft`（:346）、`buildTerminalMixDraft`（:753）、`buildHandoverFormData`（:795）。
  - 规则引擎：`appendProgressiveRule`（:128）、`resequenceRules`（:169）、`removeProgressiveRule`（:189）、`applySequentialRuleUpdates`（:244）。
- **持久化封装**：`loadShippingData`（:834，读整 blob + FX 刷新）。
- **路由注册（75 个）**：root/health/auth（:1849-1908）、workbench（:1908-2210，handover/customs/inland/quote/pdf）、admin/inland（:2266-2792）、admin/settings+exchange-rates（:2797-3072）、admin/customs（:3073-3717）、admin/shipping-lines（:3718-4500+）。
- **组合根**：`createApp()` 包住一切；`app.listen` + 启动日志 + scheduler（文件尾 :4678 区）。
- → **组合根里塞业务逻辑 + 持久化**，是典型 god-file。

### A.2 store.js = 2606 行，全模块数据塑形 + 持久化 + 缓存
- 89 个函数，**46 个 `normalize*`**：`normalizeShippingLine`（:797）、`normalizeCustomsModuleData`（:1705）、`normalizeInlandModuleData`（:2022）、`normalizeQuoteModuleData`（:2222）、`normalizeShippingData`（:2307 区）—— 所有模块的数据形状都在这一个文件。
- 持久化 + 缓存：`shippingDataCache`（:2348）、`getShippingData`（:2435）、`saveShippingData`（:2479）、`saveExchangeRates`、seed 路径。
- → 数据塑形（4 个模块）+ 读写 + 缓存 + seed 混一个文件。

### A.3 模块边界现状
- `store.js` 是 hub（被 17 个文件 require）；`db.js` 被 7 个；`server.js` import 14 个 lib（spider）。
- 跨模块基本"从 store 取整个 `shippingData` 对象，各自翻自己要的"——**没有按实体/模块的清晰 API**，是 convention-only（小项目无 lint，符合栈预期，但边界模糊）。
- 较内聚的小模块（可作为好边界的样板）：`exchange-rates.js`（204）、`inland-routes.js`（322）、`inland-csv.js`（335）、`calculate.js`（1180，单一职责=费用计算）、`quote.js`（943，报价模板/常量+塑形）。
- `i18n.js`（1526）= **大但内聚**（纯三语字典），**判断：不拆**（可选按模块分文件，纯整洁，非问题）。

## B. 目标结构设计

### B.1 server.js → 组合根 + routes/ + middleware/ + 业务下沉到 lib
目标文件树（行数为估算量级）：
```
src/
  server.js                 # 仅组合根：createApp() 装中间件→挂各 routes 模块→listen。~120 行
  middleware/
    auth.js                 # requireAuth + session 用户。~40
    i18n.js                 # 语言协商中间件（现 app.use 块）。~40
    locals.js               # baseView / res.locals 公共注入。~60
  routes/
    workbench.js            # GET /workbench/:m + POST /workbench/{handover,customs,inland,quote,quote/pdf}。~350
    admin-handover.js       # /admin/:m/settings、/admin/:m/shipping-lines*（换单侧）。~500
    admin-customs.js        # /admin/customs/{ports,terminals,yards,shipping-lines,storage-rules}*。~900
    admin-inland.js         # /admin/inland/{resolve-link,routes,origins,destinations,rate-entries}*。~600
    admin-quote.js          # /admin/quote 备注库等。~120
    exchange-rates.js       # POST /admin/:m/exchange-rates/refresh（含 refresh-monitor 接线）。~60
    health.js               # GET /healthz。~20
  lib/
    customs-rules.js        # 从 server.js 下沉：storage-rule/terminal-mix/yard draft & sync 逻辑。~600
    handover-forms.js       # buildShippingLineDraft / mirror / localCharge / handoverFormData。~250
    rule-engine.js          # appendProgressiveRule/resequence/remove/applySequentialRuleUpdates。~200
    load-shipping-data.js   # loadShippingData（读+FX 刷新封装），或并入 store repository（见 §F）。~40
```
- 每个 `routes/*.js` 导出 `register(app, deps)`；`server.js` 依次调用。中间件注册**顺序保持不变**（关键，见 §D）。
- 业务 helper 从 server.js **下沉到 `lib/<concern>`**，路由只做"取输入→调 lib→渲染/重定向"。

### B.2 store.js → 按模块拆 + 与数据方案衔接
- **若数据仍是 blob（未迁表）**：store 按模块拆，但**保持现有 blob 读写接口不变**：
  ```
  lib/store/
    index.js          # getShippingData/saveShippingData/缓存（现有对外接口，门面）
    normalize-handover.js / normalize-customs.js / normalize-inland.js / normalize-quote.js
    normalize-shipping-data.js  # 组合各模块 normalizer
  ```
  纯按模块拆 normalizer，对外 API（`getShippingData` 等）签名不变 → 调用方 0 改动。
- **若数据已迁表（blob→relational 执行后）**：store 变成各表的 **repository**（`getCarriers`/`getCarrierCharges`/`getExchangeRates`/`getInlandRouteGeometry`…），接口边界与表设计衔接——**表设计与 repository 函数清单见 `blob_to_relational_redesign.md` §B/§D，本方案不重复**。

### B.3 其它大文件
- `calculate.js`（1180）：单一职责（费用计算），可保留；若要拆按"换单/清关/陆运"计算分文件。低优先。
- `quote.js`（943）：报价模板常量 + 塑形混装，可拆 `quote-constants.js`（模板行/费用码/枚举）+ `quote-normalize.js`。低优先。
- `i18n.js`（1526）：**不拆**（大但内聚）。可选按模块分文件 `i18n/{handover,customs,inland,quote,common}.js` 纯为可读，非问题。

### B.4 模块边界（文档化，小项目不上 lint）
- 每个 `lib/<module>` 顶部注释声明 public API；跨模块只调 public、不 reach 内部。
- 在 `docs/ARCHITECTURE.md` 增"模块边界"一节（谁是 public、依赖方向：routes → lib → store → db，单向）。
- 不引入 ESLint boundaries/dependency-cruiser（参考 Cursor Project Master/architecture：那是 UtopiAI 大型 TS 才上；小 JS 项目用文档约定即可）。

## C. 改造顺序（分阶段，每阶段独立可验证）

> 总原则：**路由拆分 = 纯搬移 + 改 import，业务逻辑一行不动**。每阶段后跑全 12 套测试 + 冒烟，报价/计算结果固定输入前后对比一致。

- **阶段 1：抽中间件 + health/exchange-rates 路由**（最小、最安全的起步）。把 `requireAuth`/i18n/locals 抽到 `middleware/`，把 `/healthz` 和 FX 刷新路由抽到 `routes/`。验证：全回归 + `/healthz` 实测 + FX 刷新手测。
- **阶段 2：抽 workbench 路由 + 计算入口**。`routes/workbench.js`。验证：quote-test 9/9 + smoke + 报价结果对比。
- **阶段 3：按模块抽 admin 路由**（每个模块一个独立 PR）：admin-inland → admin-customs → admin-handover/shipping-lines → admin-quote。**一次一个模块**，每个 PR 后全回归。期间把对应业务 helper 下沉到 `lib/<module>`。
- **阶段 4：store.js 按模块拆 normalizer**（接口不变）。验证：normalize round-trip 测试（rmw-cache/usage-guard/quote-test 已覆盖大量 round-trip）。
- **阶段 5（可选）**：calculate/quote 内部拆分；i18n 按模块分文件。

**与数据方案（blob→relational）的时序**：
- **可并行**——代码结构（本方案）动的是"文件怎么放"，数据方案动的是"数据怎么存"，触点不同（前者搬路由/helper，后者改 store 读写实现 + 建表）。
- **建议**：先做本方案的阶段 1-3（server.js 拆分，风险低、收益直观），数据方案的 Phase 1（拆 exchange_rates + inland_route_cache）可同期推进；二者在 **store repository 化**（本方案阶段 4 ≈ 数据方案 §D）汇合——届时统一成 repository。
- **依赖**：本方案不依赖数据方案；数据方案的 store 改造若先行，本方案阶段 4 直接对齐其 repository。

## D. 风险与回滚
| 风险 | 缓解 |
|---|---|
| 漏搬路由 / 路由路径变化 | 拆前 `grep -c app\.(get\|post)` 计数，拆后计数一致；逐路由对照清单 |
| **中间件注册顺序变了**（session→i18n→auth 顺序敏感） | 严格保持 `createApp` 里 `app.use` 的原顺序；阶段 1 专门核对 |
| import 循环（routes↔lib↔store） | 单向依赖：routes → lib → store → db；helper 下沉时不反向 import routes |
| 业务行为/报价结果变化 | 纯搬移不改逻辑；每阶段固定输入跑 quote-test/calculate 前后 diff |
| 中途 compact 丢进度 | 一阶段一 PR、TodoWrite、_ROADMAP 锚点 |

**回滚**：每阶段独立 PR，出问题 `git revert` 单个 PR（因纯搬移、无数据变更，回滚干净）。

## E. 收益
- **可维护性**：4707 行 god-file → 一组 ~几百行的模块；改 customs 只看 `routes/admin-customs.js`+`lib/customs-rules.js`，不在 4707 行里穿行。
- **改动安全**：改一个模块不碰别的；减少"误伤邻近逻辑"和 parse/store/mirror 不同步类 bug 的土壤（LESSONS 实证多次）。
- **可测试性**：lib 业务函数可单测，routes 可针对性测。
- **AI 友好**：小文件让 AI/人定位与修改都更准、更安全。
- **⚠️ 诚实说明**：**代码结构解耦不直接降 egress / 不改性能**——egress 是数据层（blob→表）的收益。本方案治"代码怎么组织"，收益是工程可维护性/安全性，不是成本。别把两者收益混为一谈。

## F. 与数据方案的关系（明确边界，不重复）
- **数据层解耦** = `20260621_blob_to_relational_redesign.md`：把 1.83MB 单 blob 拆成 ~12 张关系表（含 DDL/迁移/José 数据保护/egress 收益）。治"数据怎么存"。
- **代码结构解耦** = 本方案：拆 server.js（路由/中间件/业务下沉）+ src/lib 模块边界。治"代码怎么组织"。
- **交汇点 = `store.js` 的 repository 化**：数据方案把 store 从"读整 blob"改成"按表查询的 repository"（其 §D）；本方案把 store 按模块拆文件（其阶段 4）。两者统一为 `lib/store/`（门面 + 各模块/各表 repository）。**表设计与 repository 函数清单以数据方案为单一来源，本方案引用不重复。**
- **互补不重叠**：一个让"查一个数不搬整个信封"（egress），一个让"改一块代码不动整座大楼"（可维护性）。

---

## 给 Chandler 的结论
1. **要不要做**：server.js（4707）和 store.js（2606）是真 god-file，**值得拆**；收益是可维护性/改动安全（不是 egress）。i18n 大但内聚不用动。
2. **先做什么**：**先拆 server.js**（阶段 1-3，纯搬移、行为不变、风险最低、不依赖数据层）；可与数据方案 Phase 1 **并行**。
3. **怎么配合数据方案**：两条线并行，最后在 store repository 化汇合；表设计以数据方案为准。
4. **本轮只出方案未执行**，是否执行/排期由 Chandler 定。
