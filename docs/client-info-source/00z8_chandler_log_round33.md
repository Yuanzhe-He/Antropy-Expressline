# 00z8 — 第N+33轮执行（实证幽灵=登入 Railway 拉真日志 + 架构体检 + 架构重构方案）

> 00z7(round32 CC) 续篇。CC执行轮。最新轮次。分支 `feature/ghost-proof-and-arch-plan`（从 main=58cd443 切）。PR-only，不改业务代码/不改 DB（纯查日志+只读调查+写文档）。

## 2026-06-21 第N+33轮执行 — 实证幽灵 + 架构体检 + 架构方案

═══════════════════════════════════════════
## 第一部分 — 实证幽灵（成功登入 Railway，拉了真实 HTTP 日志）
═══════════════════════════════════════════
**不再推断，全是真日志：**
- **登录成功**：`railway login --browserless` 出 device code（VBBX-XQCN），Chandler 浏览器授权后 `railway whoami` = heyuanzhe76@gmail.com。CLI 已 link 正确项目 `courteous-courage` → service `Antropy-Expressline`（非 MXQ）。
- **`railway logs --http` 可用，且 JSON 含 `srcIp` + `clientUa`**（指纹字段齐全）。
- **关键发现（实证，非推断）**：
  1. **6/13-20 日志已过保留期，取不到**。`--since 9d`/`--since 30d` 返回的**最早一行只到今天 08:14**（共 26 行）；显式 `--since 2026-06-13 --until 2026-06-20` 直接 `Problem processing request`。→ Railway HTTP 日志保留期不够 8 天，幽灵的历史请求**已被清除、不可恢复**。
  2. **整个保留窗口（今天）内 0 次 /exchange-rates/refresh**。→ 幽灵当前**不活跃**（与 /healthz.refreshRoute=0 一致）。
  3. 今天的真实流量（26 行）= 我的 curl 探针（UA curl/8.7.1）+ **一个真人**（srcIp 187.188.9.6 / 189.203.187.188 = 墨西哥 Telmex，UA iPhone Safari iOS18.7 + Mac Safari）一次性浏览 `/workbench/customs` + favicon。**稀疏、人工、无轮询**。
- **结论（实证）**：幽灵是谁——**Railway 日志里查不到了**（6/13-20 已过保留期，这是硬事实不是推断）；**现在确认它已停**（保留窗口 0 次 /refresh）。**放弃上一轮"本地 .env 是元凶"的推断**——没有日志证据支持任何具体身份，诚实结论=历史不可考。
- **going-forward 能实证**：若幽灵再来，`railway logs --http --json` 的 `srcIp`+`clientUa`（或 /healthz.refreshRoute 陷阱）当场给真实 IP+UA。捕获机制已就位；只是"事后取证"被保留期堵死，"当场捕获"才是可靠路径。

═══════════════════════════════════════════
## 第二部分 — 架构体检（READ-ONLY，带 file:line）
═══════════════════════════════════════════
报告：`docs/specs/20260621_architecture_health_check_REPORT.md`（A-G）。要点：
- **两个 god-file**：`server.js` **4707 行**（75 路由 + 77 内联业务函数 + 持久化 loadShippingData 三混）、`store.js` **2606 行**（46 个 normalizer + 读写 + 缓存）。`i18n.js` 1526 = **大但内聚，不用拆**。
- **耦合**：store.js 是 hub（被 17 文件 require）；server.js import 14 lib（spider）；跨模块"取整个 shippingData 自己翻"，无按实体 API；边界 convention-only。
- **单 blob**（★同时是架构耦合 + DB egress 问题）：app_state 一行 1.83MB，热(FX 299B)冷(inland 1.42MB)混装；读一字段拉整块（db.js:120）、写 RMW（db.js:130/169）；handover↔customs shippingLines 镜像要手动同步（server.js:416/4658）。
- **爆炸半径**：加一个船司字段要改 ≥5 处分散点；LESSONS 实证多次 parse/store parity + 镜像漏同步 bug。
- **结论**：需结构性重构。优先级：①单 blob（数据层，见数据方案）②server.js 拆分（代码层）③store.js（随 blob→表 repository 化）。

═══════════════════════════════════════════
## 第三部分 — 架构重构方案（代码结构，plan-only）
═══════════════════════════════════════════
文档：`docs/specs/20260621_architecture_redesign_PLAN.md`（A-F，对标数据方案详细度）。
- **专注代码结构，不重复数据方案**：数据层解耦（blob→表）见 `20260621_blob_to_relational_redesign.md`；本方案管 server.js 拆分 + src/lib 边界；**交汇点=store repository 化**（表设计以数据方案为单一来源）。
- **server.js → 组合根 + routes/{workbench,admin-handover,admin-customs,admin-inland,admin-quote,exchange-rates,health} + middleware/{auth,i18n,locals} + 业务下沉 lib/{customs-rules,handover-forms,rule-engine}**。每个 routes 导出 register(app,deps)，server.js 只 wire-up。**纯搬移+改 import，业务逻辑不动、报价结果前后一致。**
- **store.js → 按模块拆 normalizer（接口不变）**；数据迁表后变各表 repository。
- **i18n 不拆**（大但内聚）；calculate/quote 低优先。
- **改造顺序**：阶段1 抽中间件+health+fx → 阶段2 workbench → 阶段3 逐模块抽 admin（一模块一 PR）→ 阶段4 store 拆 normalizer。**每阶段独立 PR + 全回归 + 可 revert**。与数据方案 **可并行**，store repository 化处汇合。
- **收益=可维护性/改动安全/可测试性**；**诚实：代码解耦不降 egress**（egress 是数据层收益，别混）。
- José 手改数据零丢失是数据方案迁移的硬约束（本方案纯搬代码不碰数据）。

## 验收
- 第一部分：✅ 真实 Railway 日志（登录成功+拉到+IP/UA 字段确认）；幽灵=历史日志过期不可考(实证)+当前已停(实证)；放弃旧推断。
- 第二部分：✅ 体检报告 A-G + file:line。
- 第三部分：✅ 架构方案 A-F，引用不重复数据方案，plan-only。
- 不改业务代码/不改 DB ✅（git status：仅新增 docs/specs 文档）。

## 爆炸半径
- 本轮**零业务代码改动、零 DB 改动**。只新增 3 个文档（health-check REPORT、architecture PLAN、本日志）+ roadmap/LESSONS。
- 副作用：Railway CLI 现已登录（heyuanzhe76@gmail.com，link courteous-courage/Antropy-Expressline）——后续可直接 `railway logs --http` 查日志。

## 剩余留尾（later）
- 架构重构执行（先 server.js 拆分，Chandler 拍板后立项；可与数据方案 Phase 1 并行）。
- 数据方案执行（blob→关系表，见 `20260621_blob_to_relational_redesign.md`）。
- 幽灵：历史不可考；若再来用 `railway logs --http --json` 或 /healthz 陷阱当场抓。

**项目状态**：main=58cd443。egress 事件早已闭环。本轮：实证幽灵（日志过保留期不可考+当前已停）、架构体检（两 god-file+单 blob）、出代码结构重构方案（plan-only）。分支 `feature/ghost-proof-and-arch-plan` 待开 PR。

**本轮防compact写入**：00z8_chandler_log_round33.md（本文件）+ `_ROADMAP_anti_compact.md` 定位区 + `docs/specs/20260621_architecture_health_check_REPORT.md` + `docs/specs/20260621_architecture_redesign_PLAN.md`。
