三件事：①实证幽灵——别再推断"本地.env是元凶"，去 railway login 拉真实 access log 看 /exchange-rates/refresh 的来源 IP/UA（6/13-20）②跑架构体检（READ-ONLY）③把架构改动方案详细写到本地（同 blob→relational 那份的详细度）。Chandler 明确：要实证不要推断；CC 能连 railway CLI（OAuth 只是要刷新）。token 不计成本。

# 任务：实证幽灵 + 架构体检 + 架构改动方案（写到本地）

仓库当前目录。先 git pull 同步 main。本任务分支 feature/ghost-proof-and-arch-plan。PR-only、不直推、不 force-push。**本任务不改业务代码、不改数据库**——①是查日志，②③是只读调查+写方案文档。

## 背景 + Chandler 的纠正
- **纠正：要实证幽灵，不要推断。** 上一轮把"本地 .env 直连生产库 + 本地 dev/agent 点刷新"当成最可能解释——但那是推断。Chandler 不认同"本地 .env 有问题"（"没有人会一直在那调 api"）。**放弃这个推断，去拿真凭实据。**
- **CC 能连 railway CLI**：OAuth token 失效只是需要 `railway login` 刷新（正常 CLI 步骤，不是 user-only）。先认真试着登录 + 拉日志；只有真的无法 headless 登录时才明说卡在哪。
- 数据改动方案已在本地（docs/specs/20260621_blob_to_relational_redesign.md）。本轮补**架构**改动方案。

═══════════════════════════════════════════════
## 第一部分 — 实证幽灵（拉 Railway access log，看真实来源）
═══════════════════════════════════════════════
目标：用**真实日志**回答"那个每 2s 打 /exchange-rates/refresh 的是谁"，不要再靠推断。

1. **登录 Railway CLI**：`railway login`（或 `railway login --browserless` 若支持；token 刷新是正常步骤）。登录后 `railway whoami` 确认。若 link 丢了，`railway link` 到正确的 project（生产服务 = 服务 antropy-expressline，域名 antropy-expressline-production.up.railway.app；注意别 link 错到 MXQ Dashboard）。
2. **拉 access log / deploy log**：`railway logs`（按需加 service/部署筛选）。重点捞 **6/13 到 6/20** 窗口内所有命中 `/exchange-rates/refresh` 或 `/admin/.../exchange-rates/refresh` 的请求行。
3. **看每条命中的来源指纹**：客户端 IP、User-Agent、Referer、频率（是不是真每 ~2s 一次）。判断：
   - UA = HeadlessChrome / Playwright / puppeteer / curl / python-requests → 自动化脚本 / AI agent。
   - UA = 某监控服务名（UptimeRobot / Pingdom 等）→ 监控。
   - UA = 普通浏览器 + IP 是住宅/办公 → 真人开着某个标签在轮询。
   - IP 是 Railway 内部 / localhost → 来自部署内部。
4. **如果 Railway 只保留近 N 天日志、捞不到 6/13-20**：明说日志保留期限制，改为：① 看现在还有没有（近期日志里 /refresh 的来源）② 把"一旦再出现就抓"的 /healthz.refreshRoute 陷阱留着 ③ 给 Chandler 明确说"历史日志不可得，只能等它再来或从 Railway 控制台看更长留存"。
5. **结论**：基于真实日志说幽灵是谁（或"日志保留期内无此请求/已停"），**标注这是实证（来自日志）还是仍是推断**。别再把推断当结论。

═══════════════════════════════════════════════
## 第二部分 — 跑架构体检（READ-ONLY，已有 prompt）
═══════════════════════════════════════════════
按 docs/specs/CODEX_PROMPT_architecture_health_check.md 跑架构体检（A-G，只读不改），产出 docs/specs/YYYYMMDD_architecture_health_check_REPORT.md。
- 重点已知（Claude 实测文件大小，体检去核实+给 file:line）：server.js 160KB(~4672行)、store.js 82KB、i18n.js 71KB、calculate.js 34KB、quote.js 30KB = 疑似 god-file。
- 体检要点：server.js 混了哪些职责（路由注册/各模块 handler/业务逻辑/持久化？）、store.js 混了什么、谁 import 谁、单 blob 的耦合（与数据侧交叉）、爆炸半径。
- READ ONLY，每个结论 file:line。

═══════════════════════════════════════════════
## 第三部分 — 写架构改动方案到本地（同 blob→relational 的详细度，plan-only）
═══════════════════════════════════════════════
基于第二部分体检结果，写 **docs/specs/20260621_architecture_redesign_PLAN.md**，详细度对标 20260621_blob_to_relational_redesign.md。**只写方案，不执行。** Chandler review 后单独立项。

**重要——避免和数据方案重复（单一来源）**：
- blob→关系表（数据层解耦）已在 20260621_blob_to_relational_redesign.md 详述。架构方案**引用它、不重复**——只说"数据层解耦见那份"。
- 架构方案专注数据方案**不碰**的部分：**server.js 4672 行的拆分** + **src/lib 的模块边界**（i18n.js/store.js/calculate.js/quote.js 等大文件 + 整体代码组织）。

方案文档包含：

**A. 现状分析（基于体检，带 file:line + 真实行数）**
- server.js 4672 行到底混了哪些职责？按职责块标出行数区间（如：中间件/会话 X 行、handover 路由 Y 行、customs 路由、inland 路由、quote 路由、admin 路由、FX 路由、PDF 触发…）。
- store.js 82KB 混了什么（读写/normalizer/缓存/各模块数据塑形）？i18n.js 71KB（是不是纯翻译字典，大但内聚？大≠一定要拆，给判断）。calculate.js / quote.js。
- 现有 src/lib 模块边界：哪些清晰、哪些是 hub（被到处 import）、哪些 reach 进别人内部。有没有 thin ownership 问题（逻辑散落）。
- ⚠️判断"大但内聚" vs "大且混杂"：i18n 这种纯字典大文件可能不需要拆；server.js 这种混多职责的才是真问题。逐个给判断，别一刀切按行数。

**B. 目标结构设计**
- server.js → 拆成什么（如 routes/ 下按模块分文件：routes/handover.js、routes/customs.js、routes/inland.js、routes/quote.js、routes/admin.js、routes/exchange-rates.js；中间件 middleware/；组合根 server.js 只留 wire-up）。给目标文件树 + 每个文件职责 + 大概行数。
- store.js → 若数据还没拆表（blob 仍在），store 怎么按模块拆（store/handover.js 等）同时保持现有 blob 接口；若数据拆表了，store 变成各表 repository（与 blob→relational 方案衔接，说明两者的接口边界，不重复表设计）。
- src/lib 其它大文件的处理建议（calculate/quote 按模块或按职责拆；i18n 若纯字典可不拆或按模块分文件）。
- 模块边界建议：小项目至少给"文档化的模块边界"（哪些是 public、跨模块怎么调），不必上 ESLint boundaries（参考 Cursor Project Master/architecture：UtopiAI 是大型 TS 才上 lint，小项目轻量）。

**C. 改造顺序（分阶段，每阶段独立可验证）**
- 建议先后：通常先拆 server.js（路由分文件，行为不变、风险低、收益直观），再按需拆 store/calculate/quote。
- 每阶段：改什么、怎么保证行为不变（路由拆分是纯搬移 + 改 import，报价/计算逻辑不动）、怎么验证（全回归 12 套 + 冒烟）。
- 和数据方案(blob→relational)的时序关系：哪个先做更好/能否并行/有无依赖。给建议。

**D. 风险与回滚**
- 拆 server.js 的风险（漏搬路由、中间件顺序变了、import 循环）+ 缓解（一次一个模块、每步全回归、保持中间件注册顺序）。
- 回滚：每阶段独立 PR，出问题 revert 单个 PR。
- 报价结果/业务行为必须前后一致（固定输入对比）。

**E. 收益**
- 可维护性（4672 行 → 一组几百行的模块，AI/人都好改）、改动安全（改一个模块不碰别的）、可测试性。
- 注意：架构解耦主要收益是**可维护性/改动安全**，不是 egress（egress 是数据侧 blob→表 的收益）——别混淆两者的收益。诚实说明架构解耦不直接降 egress。

**F. 与数据方案的关系（明确边界，不重复）**
- 一句话说清：数据层解耦（blob→表）见 20260621_blob_to_relational_redesign.md；本方案是代码结构解耦（server.js + src/lib）。两者互补：一个治"数据怎么存"，一个治"代码怎么组织"。blob→表里的 store.js repository 化是两个方案的衔接点。

**不在本轮执行**，只出方案。

## 验收
- 第一部分：真实 Railway 日志结果（幽灵来源 IP/UA，或"日志保留期内无/已停"），标注实证 vs 推断。
- 第二部分：架构体检报告（A-G + file:line）。
- 第三部分：架构改动方案文档（A-F，对标 blob→relational 详细度，引用不重复数据方案，plan-only）。
- 不改业务代码、不改 DB、回归无需跑（本轮纯查日志+调查+写文档）；但若 CC 顺手验证了文件行数/import 关系，附上。

## 全局约束
- 实证优先：幽灵结论必须基于真实日志，推断要标注为推断。
- 架构方案 plan-only，不执行；不重复数据方案（单一来源）。
- 区分"大但内聚"vs"大且混杂"，别一刀切按行数拆。
- 区分架构解耦收益(可维护性)vs数据解耦收益(egress)。
- 防 compact：进度写 _ROADMAP + 00z8；compact 从那恢复。
- Task Summary + Post-task routing。

## 报告（大白话）
- 幽灵：Railway 日志显示是谁？（IP/UA + 是不是真 2s 一次）实证还是推断？还是日志捞不到？
- 架构体检：server.js/store.js 等到底健不健康，最该先拆什么。
- 架构方案：写在哪个文件、覆盖什么、建议先拆什么、和数据方案怎么配合、要不要做（Chandler 拍板）。

## 开始
git pull → 切 feature/ghost-proof-and-arch-plan → 第一部分(railway login + 拉 /refresh 日志 6/13-20 + 看 IP/UA) → 第二部分(跑架构体检 READ-ONLY) → 第三部分(写 20260621_architecture_redesign_PLAN.md) → 报告。连续做完。
