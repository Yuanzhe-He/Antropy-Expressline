# CODEX/CC PROMPT — Express Line 架构重构【收尾全量｜Phase 3→5 一口气做完，不许中途停】

> 接 PR #22（Phase 0-2 已完成）。日期 2026-06-22。依据 docs/specs/20260621_architecture_redesign_PLAN.md §C 阶段 3-5 + 本 prompt。
> 前轮已落：测试网 13 套（含 ~47 admin CRUD，JSON-mode）、middleware/{auth,i18n,locals}、routes/{health,exchange-rates,workbench}，server.js 4707→~4150。

## 0. 总目标 + 这次为什么不许分批停
**一口气做完剩下全部代码结构重构**：Phase 3（admin 路由全拆 + 内联 helper 下沉 lib/）+ Phase 4（store.js 拆）+ Phase 5（组合根收尾 + 文档）。
终态：server.js 只剩 createApp wire-up（~120 行）+ listen + scheduler；store.js 拆成 6 个模块。
口径（Chandler 明确）：不考虑 token 成本；不为短期牺牲长期；把耦合降到底；大改动配最全测试。

## 0.1 【硬规则：不许 defer —— 本轮第一铁律】
- **不许**以"安全 / 收尾 / 这一轮先到这 / context 紧 / 留给下一个 pass"为由停下或 defer 任何 Phase。
- admin 段是最大最纠缠的块（markRouteStale 闭包、sub-route 测试薄）——**正因为它最危险，本轮做法是先把它的测试补到最全（§4），再一次性拆完**，不是因为危险就推后。
- **唯一允许停的两种情况**：① test:all 变红且修不动 → 停下报告；② 真 blocker（缺凭证 / 环境缺工具）→ 停下报告。除此之外一路做到 Phase 5 完。
- **context / compact 不是停的理由**：维护 _ROADMAP_anti_compact.md + TodoWrite；compact 来了读它 + git log 接着做（§6），不要把 compact 当收工信号。
- 上一轮 defer Phase 3-4，一半是上个 prompt 写了"每阶段独立 PR + Chandler review"误导——**本轮取消阶段间 review gate**：一条分支、顺序 commit（每模块一 commit 保可回滚）、跑完全部再交一个 PR。

## 1. 必读（真读不靠记忆）
1) ../_AI_WORKFLOW/core/AGENTS.md、docs/AI_AGENT_PROJECT_RULES.md、.ai/PROJECT_SCALE_OVERRIDES.md。
2) docs/specs/20260621_architecture_redesign_PLAN.md（权威设计 §C 阶段 3-5）+ 20260621_blob_to_relational_redesign.md（store 拆法前向兼容其实体划分）。
3) docs/LESSONS.md（normalizer parity / PARALLEL LIST MIRRORS 两坑）+ docs/client-info-source/00z9 上轮日志（ctx 模式、splice 边界 assert 手法）。
4) 已落的 src/routes/workbench.js —— **复刻它建立的 ctx 模式**（createApp 里组装一次 helper 集 ctx 传给各 route 模块），本轮所有新 route 模块照此办。

## 2. 测试环境（沿用 Option A，不变）
- JSON-mode in-process（STORAGE_DRIVER=json + 起 createApp 打真 HTTP + 隔离 temp DATA_DIR）。零生产接触、零云端依赖、不需要本地 Postgres。
- 全程禁止碰生产：不连生产库、不改生产 .env、不跑 db:seed/patch-prod-data 对生产。

## 3. 安全护栏（每个 commit 都守）
- 纯搬移：业务逻辑一行不改（含不"顺手优化"）。镜像同步（customs.shippingLines 镜像 handover，原 server.js:416/:4658 两处）集中成一个 lib 函数消除重复，但行为/数据结果不变。
- 路由守恒：`grep -cE "app\.(get|post|use)\("`（含各 routes 模块）拆前后总数一致；逐路由路径字符串不变。
- 单向依赖 routes → lib → store → db；helper 下沉不反向 import routes；无循环依赖。
- 每个 commit 后：test:all 全绿 + 路由计数守恒 + load OK + 报价/计算固定输入 diff=0（quote-test 9/9）+ /healthz 实测。任一不过 → 修到过或回滚该 commit，不带病往下。

## 4. Phase 3a：先补全 admin 测试（动 admin 代码之前，把网补到最密）
- 在现有 13 套基础上，补齐 admin 段**仍薄**的 sub-route 测试（route 级 CRUD + 读回断言 + no-500 sweep，JSON-mode temp DATA_DIR）：
  shipping-line sub-resources（local-charges / terminal-mix / demurrage-rule-sets）、customs storage-rules 累进规则增删改序、handover form 各子操作、quote 备注库 CRUD、以及所有 markRouteStale 触发路径。
- 目标：admin 段**每个写操作路由**都有测试，搬错必变红。补完 test:all 全绿 = 新基线。单独 commit。

## 5. Phase 3b→5：顺序拆（每模块一 commit，连续做完）
- **Phase 3b**（admin 路由按模块拆，一模块一 commit）：
  routes/admin-inland.js → routes/admin-customs.js → routes/admin-handover.js + routes/admin-shipping-lines.js → routes/admin-quote.js；
  内联 helper 同步下沉 lib/：rule-engine.js（buildRuleId/appendProgressiveRule/resequence/remove/applySequentialRuleUpdates 等累进规则引擎）、customs-rules.js（storage-rule/terminal-mix/yard draft & sync）、handover-forms.js（shippingLineDraft/mirror 集中化/localCharge/handoverFormData）。
  每模块搬完即 test:all 全绿 + 路由计数守恒 + 报价 diff=0。
- **Phase 4**（store.js 拆，~2606 行）：lib/store/{index, normalize-handover, normalize-customs, normalize-inland, normalize-quote, normalize-shipping-data}；
  index 保留对外 API（getShippingData/saveShippingData/缓存/saveExchangeRates/getUsers/RATE_GROUP_NAMES 等）签名不变 → 调用方 0 改动；
  模块/实体划分对齐 blob_to_relational_redesign.md §B/§D 前向兼容未来 repository 化。test:all 全绿（尤其 rmw-cache/usage-guard round-trip）。
- **Phase 5**（收尾）：createApp 只剩 wire-up（~120 行）+ listen + scheduler；docs/ARCHITECTURE.md 加"模块边界"节（各 lib/<module> + routes/<module> public API + 单向依赖图）；回写 PLAN 实际落地差异。

## 6. 防 compact（CC 自保，必做 —— compact 不是停工信号）
- 维护 _ROADMAP_anti_compact.md：写 Phase 3a→5 计划 + 每步验收；每完成一 commit 更新（哪个 commit、test:all 结果、路由计数、报价 diff、下一步）。
- TodoWrite 跟踪 Phase 3a→5 全部子项。
- 识别 compact（prompt 重发 / 上下文断片）→ 读 _ROADMAP_anti_compact.md 顶部 + git log 最近 commit 确认进度 → **继续做到 Phase 5 完**，不重复劳动、不当收工。

## 7. 报告 + 收尾
- 总结：before/after 文件树、server.js/store.js 行数变化（目标 server.js→~120、store.js→6 个模块）、测试覆盖前后（admin 全覆盖）、各 commit + 一个 PR 链接、报价 diff 结果。
- 诚实声明：代码解耦不降 egress（数据层才降）；本轮零生产、零数据结构改动；blob→关系表数据迁移是独立的下一个任务。
- 结尾用 docs/AI_AGENT_PROJECT_RULES.md 的 Post-task routing 块（Cursor 格式）。
- **只有 test:all 变红修不动 / 真 blocker 才停**；否则一路做到 Phase 5 完再交。
