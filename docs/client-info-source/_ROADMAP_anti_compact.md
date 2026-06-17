# ROADMAP — Jose Expressline 顾问项目（防 compact 锚点）

> **这是什么**：Chandler 给 Jose（XG 港中旅 CTS 货代）做的 Express Line 物流报价系统顾问项目的进度锚点。Claude 在 claude.ai 网页端做「架构/审查/出 Codex prompt」，Claude Code（CC）做仓库内执行。
> **开工先读**：① `~/Desktop/Codex Project/Claude Chat/CLAUDE.md`（通用方法论）→ ② 本文件（项目到哪了）→ ③ `docs/client-info-source/`（Jose 需求归档：README + 20260616 会议纪要 + 00日志）。
> **注**：本应放 `Claude Chat/Jose-Expressline-顾问/`，但网页端 Filesystem 无 mkdir，暂放仓库 docs（也更适合版本控制）。

═══════════════════════════════════════════
## 定位区（compact 后先读这块）
═══════════════════════════════════════════

**当前状态（2026-06-16，第N+2轮 / 前置0 执行中）**：
- 陆运 go-live 已部署生产（main 6d107b9，2026-06-13）。
- batch1（短驳/双价/路线PDF/样张）= commit 8088125，PR#3(→main) OPEN+MERGEABLE，**已 push 未合并 未部署**。
- batch2（车型6档/照片/routing/override）= HEAD 01c988e，PR#4(→batch1) OPEN+MERGEABLE，**已 push 未合并 未部署**。
- **【前置0 已查实，git 状态不浑浊】**：main=origin/main=66ccf37，血缘干净线性 main→8088125→59b981a→01c988e。
- **【部署真相，经 GitHub deployments API 自助核实，无需 railway login】**：Railway 自动跟踪 **main**；生产当前部署 = **66ccf37（main HEAD），2026-06-14**；batch1/batch2 **从未部署**（push 分支不触发部署）。
- **【premise 修正】**：原假设"生产已有 batch1+2 / Jose 截图双价在生产" = **错**。生产=66ccf37 有精确点(image15，来自已合并 PR#1)，但 **没有双价**(image14，dualCurrency 仅 batch1 独有，main 零命中)。Jose 看到的双价应来自 demo/preview，非生产。
- **【合并后果】**：方案a 合并 batch1/2→main 会**首次**把 双价+短驳+车型 部署到 Jose 生产（Railway 自动跟 main）。比原计划假设的影响更大 → 合并前需 Chandler 明确确认。
- railway CLI 仍被 RAILWAY_TOKEN(MXQ项目token) 劫持 + 账号 OAuth token 过期；但部署核实已用 GitHub deployments API 绕开，合并后部署验证同法（watch 新 deployment record）。
- **Jose 2026-06-16 会议反馈**：23项，CC已全仓调查确认根因(H/O/Q编号)，写在 docs/specs/20260616_jose_feedback_round2_RESEARCH_AND_PLAN.md。
- **本轮**：计划改为 **2 大批次**（批次1=Bug修复全集 / 批次2=功能重构全集），深度模式 review。

**已定决策（Chandler 2026-06-16 拍板）**：
1. 车型：按会议=short_8t标签改"8吨"、lowboy保留(低平板,第7档)、**新增box_53(53尺厢式货车)** → 共7档
2. fee.doc ZH/ES 翻译：CC先翻一版，Chandler/Jose审
3. 多客户定价(O6.4)：精确点继承城市费率+可选单点改价+各自ETA+可点击marker
4. 出发地(O5)：费率**随origin变**，当前只Manzanillo有费率，新港留空壳口子后台可加
5. 报价语言：（待Chandler最终确认，倾向EN/ZH/ES三选一，英文保留）
6. **【前置0 已查实】桌面 fee 文件**：fee(1).docx == fee.docx（md5 相同），内容=8张PNG截图，2列(代码+英文说明)，与 docs/reference/fee-codes.csv 345码同一份、同序、同结构、无ZH/ES、无新增列/码 → **CSV 仍是 fee 主数据；ZH/ES 仍需 CC 翻一版（两份源都没有）**。
7. 执行策略：2大批次都给(Chandler要彻底)，报价一次做，边修边合并，深度模式report。

**2大批次计划状态**：
- 前置0：✅ 完成 — 部署确认(A自动跟main)✅、fee对比(同CSV)✅、logo移入public/✅、**合并 batch1/2→main 完成**（Chandler选1；PR#3 rebase-merge，PR#4因stacked-rebase冲突→cherry-pick到PR#5合并；main=9a16771=01c988e内容byte-identical）✅、**生产部署 success**（GitHub deployments 9a16771a state=success；生产页抽查 inland/quote/handover/customs 全200，inland出burreo+车型，无崩）✅。
- 大批次1（Bug修复全集）：📋 **SPEC 已写完 `docs/specs/20260616_batch1_fixes_SPEC.md`，分支 feature/jose-r2-batch1-fixes（从9a16771切），停下等 Chandler 复核**。调查发现4处stale-premise修正(C1-C4)：O6.7已被batch2修；admin-module换单专用不与customs共享；H4 add-set已种首tramo;customs格已可编辑。唯一数据模型改动=O3 fixedCharges basis/required(+amount待定)。
- 大批次1：✅ **PR#6 已合并部署生产**（main 1f827dd）。
- 大批次2（功能重构全集）：✅ **代码完成，分支 feature/jose-r2-batch2-features，待开 PR**。
  - 2a 陆运：O6.1/6.2 精确点路线(前端根因修)✅ / O6.5 双语名[模型]✅ / O5 出发地admin CRUD+费率随origin+前台选择器[模型]✅ / O6.4 精确点可点marker✅(per-point价格override=记为follow-on) / O6.3 目的地删除验证✅
  - 2b 报价：Q9去计算器取数✅ / Q8 fee en/zh/es(curated~50译+结构,其余en兜底待审)✅ / Q10代码联动总是设concept✅ / Q7.3 UNIT列+NO MEXICO/MEXICO分段[模型]✅ / Q7.2 general data增删✅ / Q2报价后台(编号+备注库)✅ / Q11备注库admin CRUD+前台勾选✅(拖动排序=库序简化) / Q7单语EN/ZH/ES PDF✅(ES concept回退EN)
  - 回归：smoke + r2-o3-test + quote 9/9 全绿；4语言PDF渲染验证。
- 全部 spec-first、PR-only、边修边合并、深度report

═══════════════════════════════════════════
## Jose 会议反馈分类（2026-06-16）— 详见 client-info-source/20260616_jose_meeting_notes.md + specs/20260616_jose_feedback_round2_RESEARCH_AND_PLAN.md
═══════════════════════════════════════════

### 换单 H（admin-module.ejs 共享）
- H1 本地费用无删除按钮(258-304)+无delete路由 → ZIM"Borrar 85"删不掉
- H2/H3 `<% if(rate) %>`(:289) 没种子的(费用×柜型)格子不渲染输入框→COSCO/OOCL/WANHAI改不了
- H4 RCL Agregar tramo在循环内(:359)+0套规则时无入口

### 港口码头 O
- O1 加港口404：/admin/customs/terminals/:id 无GET路由(POST-only)
- O2 拿掉业务性质(options.js:12-16，UI隐藏非删schema)
- O3 每费用配置(基于天/次+必要费用语义：必要即使0也显示选择,非必要仅产生时显示)[全新]
- O3b 港口无delete路由(只有terminals/yards能删)

### 陆运 O
- O6.6 状态预留→已启用(i18n.js:55-58/683-686，纯i18n)
- O6.7 车型7档(short_8t→8吨、lowboy留、加box_53)+calculate.js:19-20标签映射只有sencillo/full[INCIDENTAL_FIX]
- O6.1/6.2 精确点路线：根因前端inland-map.js:245-259只读目的地级路线，非resolver bug。修：①新增精确点自动刷路线 ②applySelectionLayer用precisePoint路线 ③加精确目的地dropdown
- O6.4 多客户报价：精确点无价(继承城市+可选override)+渲染为可点marker
- O6.5 双语名nameZh/nameEs(填一显示一,填两跟语言)
- O5 出发地可选+费率随origin(当前只Manzanillo,新港空壳)
- O6.3 目的地删除已存在(admin-inland.ejs:100)，验证即可

### 报价 Q（大重构，一次做）
- Q1拿右logo(quote-document.ejs:95-97)/Q2报价独立admin(server.js:2424 bounce)/Q3部门加陆运/Q4 Incoterm下拉/Q5运输方式/Q6装箱类型下拉
- Q7单语EN/ZH/ES整单切换+四块/Q7.2第二块增删/Q7.3 UNIT列(当前是qty,加柜/提单/次/个/车型/天)+no mexico/mexico local分块
- Q8费用从fee.doc选(docs/reference/fee-codes.csv)/Q9去掉计算器取数/Q10费用代码改→明细联动/Q11备注后台配置+前台选择器(勾选+排序)

═══════════════════════════════════════════
## 关键事实锚点（不凭记忆，以此为准）
═══════════════════════════════════════════
- 仓库：`~/Desktop/Cursor Project/Jose Expressline Consulting`
- 线上：antropy-expressline-production.up.railway.app，Railway 自动跟踪 main（但当前部署分支需核实）
- 生产库：Supabase expressline schema，key=shipping-data
- 模块：handover/customs/inland/quote 均 implemented:true
- 共享热文件：server.js、store.js、admin-module.ejs(换单+港口共享)、admin-customs.ejs、quote*.js、inland-map.js、i18n.js
- 车型最终7档：light_1_5t/light_3_5t/short_8t(标签"8吨")/sencillo(单拖)/full(双拖)/lowboy(低平板)/box_53(53尺厢式)
- fee.doc：docs/reference/fee-codes.csv(346行EN)，需ZH/ES译名
- 报价系统：quote.js + quote-pdf.js + views/quote-document.ejs + workbench-quote.ejs
- git：batch1=8088125 / batch2=01c988e（均push未合并）/ origin/main本地ref=66ccf37（需fetch核实生产真实commit）

═══════════════════════════════════════════
## 历史里程碑（最近在前）
═══════════════════════════════════════════
- 2026-06-16 第N+1轮：CC调查确认+决策定+出5波计划（本轮）
- 2026-06-16 第N轮：Jose会议反馈，转录归档+CC调查prompt
- 2026-06-15 batch2完成 / batch1 commit 8088125
- 2026-06-14 batch1(短驳/双价/路线PDF/样张)+Jose报价模板归档
- 2026-06-13 陆运go-live(main 6d107b9)，300费率+43路线
- 2026-06-11 陆运routes map从0实现PR#1
- 更早：invoice pipeline、quote PDF系统建成
