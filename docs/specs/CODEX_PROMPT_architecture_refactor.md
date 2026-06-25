# CODEX/CC PROMPT — Express Line 代码结构重构（server.js + store.js 两个 god-file 拆分）

> 状态：执行 prompt（Chandler 已批准执行代码结构重构）。日期：2026-06-22。
> 依据：docs/specs/20260621_architecture_redesign_PLAN.md（权威设计）+ 20260621_architecture_health_check_REPORT.md（证据）。
> 范围：仅代码结构。blob→关系表数据迁移是【下一个独立任务】（20260621_blob_to_relational_redesign.md），本轮不做。

## 0. 总目标
把 src/server.js（~4707 行）和 src/lib/store.js（~2606 行）两个 god-file，重构成清晰的模块结构
（组合根 + routes/ + middleware/ + lib/<模块> + lib/store/<模块>），有文档化的单向边界，
让以后“再做功能”时改一块不动整座楼、AI/人定位都准。

硬约束与口径：
- 行为零变化：纯搬移 + 改 import，业务逻辑一行不动；报价/计算固定输入前后【逐字节一致】。
- 优化目标 = 可维护性最高、长期最划算（Chandler 明确：不考虑 token 成本，做到位）。
- 本轮范围 = 仅代码结构。blob→关系表数据迁移是【下一个独立任务】，本轮不做。
- i18n.js（~1526）大但内聚，【不拆】（可选按模块分文件，纯可读，非必须）。
- 代码解耦【不降 egress、不改性能】——egress 是数据层的收益，别混。本轮收益是工程可维护性/改动安全。
- 分阶段：每阶段独立 PR + 跑全量测试 + 可 git revert。人工 checkpoint = Chandler review PR，不是中途停。

## 1. 必读（执行前，按顺序，真读文件，不靠记忆）
1) ../_AI_WORKFLOW/core/AGENTS.md、docs/AI_AGENT_PROJECT_RULES.md、.ai/PROJECT_SCALE_OVERRIDES.md（Cursor 项目规则 + scale）。
2) docs/specs/20260621_architecture_redesign_PLAN.md —— 本任务【权威设计】，按它的 B/C/D 执行；落地与文档有出入就更新文档。
3) docs/specs/20260621_architecture_health_check_REPORT.md（file:line 证据）；
   docs/specs/20260621_blob_to_relational_redesign.md（数据层边界：store 拆法要【前向兼容】其实体/repository 划分，让下一个任务直接继承）。
4) docs/ARCHITECTURE.md、docs/DATABASE_SCHEMA.md、docs/LESSONS.md
   —— 重点看 LESSONS 里 normalizer parity（works live / lost on round-trip）和 PARALLEL LIST MIRRORS 两个反复踩的坑。
5) method substitution 警戒：拆分要可复查（路由计数、中间件顺序、报价 diff），不得“看起来对”的近似。

## 2. 本地 Supabase + 数据快照（前置，最先做，全程不碰生产）
为什么：生产 Supabase 被限流；José 手改生产数据；保护数据。所有重构 + 测试只跑本地库。
步骤：
- 起本地 Postgres（或 `supabase start` 本地栈）；在【本地 .env（不提交，加进 .gitignore 检查）】设本地 DATABASE_URL、DATABASE_SCHEMA=expressline。
- `npm run db:migrate` 建 expressline schema（app_state / audit_logs / quote_snapshots）。
- 用 backups/ 里最新快照 seed 本地 app_state；若 backups/ 不够新，【只读】导出一次生产 app_state（select payload，绝不写生产）再导入本地。
- `npm run db:check` 验证本地库可读。确认 STORAGE_DRIVER 走 postgres（与生产同驱动，保真）。
- 全程禁止：对生产跑 db:seed / patch-prod-data / 任何写；不改生产 .env / DATABASE_URL；不删 backups/。
- 凭证边界：本地库口令/URL 缺失就【停下问 Chandler】，不要扩大搜索、不要去翻生产凭证；不打印任何 secret。

## 3. 安全护栏（强制）
- 纯搬移：业务逻辑不改，包括不“顺手优化”镜像/normalizer。镜像同步（customs.shippingLines 镜像 handover，
  server.js:416 + :4658 两处重复）可【集中成一个 lib 函数消除重复】，但对外行为/数据结果不变。
- 中间件注册顺序（session → i18n/语言 → auth → locals）严格不变；阶段 1 拆前后逐项核对（PLAN §D 头号风险）。
- 路由守恒：拆前 `grep -cE "app\.(get|post|use)\("` 计数，拆后一致；逐路由对照清单，路径字符串不变。
- 单向依赖：routes → lib → store → db。helper 下沉时不反向 import routes；拆后查无循环依赖。
- 每阶段后报价/计算固定输入前后 diff = 0；全量测试绿；/healthz 实测、FX 刷新手测。

## 4. Phase 0：全量测试基线（先于任何 server.js 改动）
现状：scripts/ 有 ~12 个 *-test.js（smoke / quote / audit-contento / audit-fx-throttle / audit-new-carrier /
  audit-quote-modes / audit-refresh-monitor / audit-rmw-cache / audit-usage-guard / d-add-shipping-line /
  r2-batch3 / r2-o3），但只有 smoke + quote 接进 npm，且 admin CRUD 路由覆盖存疑。
做：
- (a) 加 `npm run test:all`：顺序跑全部 *-test.js，汇总 pass/fail，任一失败非零退出。
- (b) 对照 server.js 路由清单做【覆盖审计】：列出每个 admin 路由（customs ports/terminals/yards/storage-rules、
      inland resolve-link/routes/origins/destinations/rate-entries、shipping-lines、quote 备注库、settings/fx）
      有没有测试。输出覆盖表。
- (c) 给未覆盖的每个 admin 路由补 route 级 smoke/CRUD 测试（against 本地库；增删改查 + 读回断言）。
- (d) 全量测试跑绿 = 基线。没有绿色基线，不准动 server.js。这一步单独一个 PR。

## 5. 分阶段重构（按 PLAN §B/§C，每阶段独立 PR + 全量测试 + 可 revert）
- 阶段 1（最小最安全）：抽 middleware/{auth,i18n,locals} + routes/{health,exchange-rates}；
  组合根 createApp 里 app.use 顺序原样保留。验证：test:all 绿 + /healthz + FX 手测 + 中间件顺序核对。
- 阶段 2：抽 routes/workbench（GET /workbench/:m + POST handover/customs/inland/quote/quote/pdf）。
  验证：test:all 绿 + 报价 diff=0。
- 阶段 3：按模块抽 admin 路由，【一模块一 PR】：admin-inland → admin-customs → admin-handover/shipping-lines → admin-quote；
  对应内联业务 helper 下沉 lib/：customs-rules.js（storage-rule/terminal-mix/yard draft & sync）、
  handover-forms.js（shippingLineDraft/mirror/localCharge/handoverFormData，含集中化的镜像同步）、
  rule-engine.js（append/resequence/remove/applySequentialRuleUpdates）。每 PR test:all 绿。
- 阶段 4：store.js 按模块拆 → lib/store/{index, normalize-handover, normalize-customs, normalize-inland,
  normalize-quote, normalize-shipping-data}。index 保留对外 API（getShippingData/saveShippingData/缓存）签名不变
  → 调用方 0 改动。模块/实体划分对齐 blob_to_relational_redesign.md §B/§D，前向兼容未来 repository 化。
  验证：test:all 绿（尤其 audit-rmw-cache / audit-usage-guard / quote round-trip）。
- 阶段 5（可选，低优先）：calculate/quote 内部拆；i18n 按模块分文件。可不做。
- 终态：server.js 只剩 createApp wire-up（~120 行）+ app.listen + scheduler 接线。
- 文档：docs/ARCHITECTURE.md 加“模块边界”一节（各 lib/<module> public API + 单向依赖 routes→lib→store→db）；
  回写 PLAN 文档实际落地与差异。

## 6. 防 compact（CC 长任务自保，必做）
- 开工先在 repo 维护 _ROADMAP_anti_compact.md：写本任务阶段计划（Phase 0→5）+ 每阶段验收标准。
  每完成一阶段更新一次（哪个 PR 合了、test:all 结果、报价 diff、下一步）。
- 用 TodoWrite 跟踪 Phase 0→5 + admin 路由补测试清单 + 每阶段 PR。
- 识别到 compact（同一 prompt 重发 / 上下文断片）→ 先读 _ROADMAP_anti_compact.md 顶部 + git log 最近 PR
  确认进度，再继续，不重复劳动、不丢进度。
- 一阶段一独立 PR 本身就是 compact 锚点（进度落在 git，可 revert）。

## 7. 每阶段校验（写进 PR 描述）
- 路由计数前后一致；中间件顺序一致；报价/计算固定输入 diff=0；test:all 全绿；/healthz + FX 手测；无循环依赖。
- 动了哪些文件 + 为什么是纯搬移（无逻辑改动证明）；回滚点（单 PR revert 即可）。

## 8. 报告 + 收尾
- 总结：before/after 文件树、server.js/store.js 行数变化、测试覆盖前后对比、各阶段 PR 链接、报价 diff 结果。
- 诚实声明：代码解耦不降 egress（数据层才降）；本轮零生产改动、零数据结构改动；blob→关系表是下一个任务。
- 结尾用 docs/AI_AGENT_PROJECT_RULES.md 定义的【Post-task routing】块（Cursor 格式），不要用 Codex 复盘格式。
- 出现 blocker（本地库凭证缺失、中间件顺序对不上、报价 diff≠0、admin 覆盖补不全）→ 停下报告，不绕路。
