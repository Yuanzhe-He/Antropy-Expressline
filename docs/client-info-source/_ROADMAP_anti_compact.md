# ROADMAP — Jose Expressline 顾问项目（防 compact 锚点）

> **这是什么**：Chandler 给 Jose（XG 港中旅 CTS 货代）做的 Express Line 物流报价系统顾问项目的进度锚点。Claude 在 claude.ai 网页端做「架构/审查/出 Codex prompt」，Claude Code（CC）做仓库内执行。
> **开工先读**：① `~/Desktop/Codex Project/Claude Chat/CLAUDE.md`（通用方法论）→ ② 本文件（项目到哪了）→ ③ `docs/client-info-source/`（Jose 需求归档：README + 20260616 会议纪要 + 00日志）。
> **注**：本应放 `Claude Chat/Jose-Expressline-顾问/`，但网页端 Filesystem 无 mkdir，暂放仓库 docs（也更适合版本控制）。

═══════════════════════════════════════════
## 定位区（compact 后先读这块）
═══════════════════════════════════════════

**【最新 r21，2026-06-21】掐FX写风暴 + 全面检测上线，PR#14 合并部署 main=ffa0429。**
- **A FX写风暴掐掉 ✅**：真凶=某已登录外部源每~2秒打 `POST /admin/:moduleKey/exchange-rates/refresh`(force:true)→成功强制刷→每次只改 lastCheckedAt→**~47520/天写**。修：`exchange-rates.js` 加节流(即使force，15分内已刷过就跳过不写)+删 /refresh route 冗余 saveShippingData(clobber隐患)。**实测部署后生产60秒0写**(从11写/20秒)→~96/天封顶。FX仍正常。测试 audit-fx-throttle 5/5。
- **B 全面检测上线 ✅**：B1 生产数据 13/13(B/C/E+7空壳+José手改CMA50/ZIM/COSCO/2场站全在,yards=28) · B2 报价模式 4/4(段/三语/双价IVA/6 PDF) · B3 新增船司(6/6+12/12) · B4 CRUD(8套件绿) · B5 XSS净 · B6 双价math+CONTENTO成本(9/9+3/3)。
- **留尾 F1**：FX风暴**源头**(外部每2秒打/refresh的已登录源)已节流无害化(写≈0)，但HTTP请求仍在打→建议查 Railway access log/José挂着的后台页，从源头掐。
- 锚点不变：生产=Supabase；改数据走patch(jsonb_set)永不db:seed；FX只jsonb_set+节流。详见 `00t_chandler_log_round21.md`。

**【r3-data，2026-06-20，第N+18轮】补 CONTENTO 真价 + 数据上生产 + 5 审计。分支 `feature/jose-r3-data-deploy`（从 main=4846b8f 切）。⏸ 停在生产写入前等 Chandler。**
- Part 1 ✅ CONTENTO 26 场站全真价(3800–5850，commit 62bcda3)，无占位无编造。
- Part 2 ⏸ **诊断发现生产有 José 手改**(CMA doc fee 50/ZIM 改名/COSCO 改价/KMTC ISD 已15/José 自建"新场站4·5")→ **db:seed 会清掉，必须外科 patch**。
  - 备份 ✅ `backups/prod-shipping-data-2026-06-20T21-26-51-678Z.json`(sha256 773788975641e865，backups/ 已 gitignore)。
  - patch 脚本 `scripts/patch-prod-data.js`(dry-run 默认/--apply 才写/写前再备份/saveAppState 原样保 José 形状) + `scripts/seed-new-carriers.js`(7 空壳)。commit 54de2b2。
  - **dry-run 19 处改动**(E 14rfc+HAPAG/ONE code、B KMTC 2 改名、C 删 3 假场站+加 26 CONTENTO+保留 José 2 场站)。**待 Chandler 批 → `node scripts/patch-prod-data.js --apply` → 生产抽查。**
- Part 3 审计 1–5 全过(commit fb410fe，报告 `docs/specs/20260620_data_deploy_audit_REPORT.md`)：①代码vs数据(模板/车型/master/normalizer=已生效，仅 B/C/E 数据未生效，无历史功能缺口) ②CONTENTO 3/3 ③新增船司深测 6/6 ④全回归 7 套件绿 ⑤XSS 干净。低危 F1(允许重名船司) F2(数据机制易忽略)。
- **部署机制锚点(记牢)**：生产=Supabase；改代码部署即生效；改数据需 patch/seed/后台手改；**生产有 José 手改→只能 patch 不能 db:seed**。

**【r3-data 执行完成，2026-06-21】数据已安全上生产（PR#12 合并，main=c0ddf19，部署 success）：**
- **撞上并修掉一个生产数据完整性 bug**：FX 汇率刷新走 `saveShippingData` 全量覆盖整个 blob，FX fetch 慢→基于旧读的全量写**回滚任何并发数据改动**（patch 落不住，且 **José 后台手改也可能被 FX 写悄悄冲掉**）。修复：`db.patchAppStateField`(jsonb_set 单字段)+`store.saveExchangeRates`，FX 只 jsonb_set 写 exchangeRates，永不碰模块数据。patch 脚本升级 CAS+verify-persist。
- 顺序被迫 **先合并(含FX修复)后patch**（patch 必须等 FX 修复部署后才落得住）。重跑 patch [stable] 落住。
- **生产抽查 19/19**：B/C/E 全生效(KMTC 新名+ISD15、HAPAG/ONE code、14 rfc、26 CONTENTO 真价、7 空壳) + **José 手改零损失**(CMA 50/ZIM 改名/COSCO 20/自建 2 场站；customs yards=28=26+2)。
- **未决锚点**：生产有个 **FX 写风暴**(每~3s 写 exchangeRates，疑似外部每 3s 强制刷)。已 jsonb_set 无害化(不碰数据)，但写仍频繁——建议后续查来源掐掉(省 DB 写)。
- 备份：`backups/prod-shipping-data-2026-06-20T21-26-51-678Z.json`(sha 773788…) + pre-patch snapshot。


**【最新 r3，2026-06-20】混合批 A/B/C/D/E 全部代码完成 + 本地验证全绿，分支 `feature/jose-r3-mixed`（从 main=30be381 切）。5 个独立 commit：**
- A 字体：`9474b8c` workbench-quote 行项编辑区紧凑（0.82→0.72rem，padding/三语行收紧，仅 CSS）。
- B 费率：`3ff1536` KMTC ISD 45→15 两组 + 两标签改名（Release Fee→Doc Fee at Destination / Container Handling→Container Release Fee）。MSC 未改（Excel 内部矛盾→问题清单）。
- C 场站：`670166c` 删 3 假 yard，录 26 个真实 CONTENTO Manzanillo patio（`src/lib/contento-yards.js` 单一来源 + `scripts/seed-contento-yards.js` + store.js seed）。还箱 maniobra + 洗箱 550/750/1150，MXN+IVA，portIds=manzanillo，**shippingLineIds 空（método B）**，成本侧 inert。
- E 元数据：`c361490` HAPAG code=HAPLLOMEX、ONE code=ONE_MEX[INCIDENTAL]、14 家 rfc 税号、`normalizeShippingLineNotes` back-compat。
- D 新增船司：`a8c0306` POST `/admin/handover/shipping-lines/add`+`/:id/delete`（handover only），customs 镜像同步+级联，编辑页 name/code/rfc 可改+删除按钮，i18n zh/es，spec `docs/specs/20260620_add_shipping_line_SPEC.md`，D2 测试 `scripts/d-add-shipping-line-test.js` 12/12。
- 回归：smoke + quote 9/9 + r2-o3 + r2-batch3 + d-test 全绿。
- **⚠️ 数据落地真相（关键）**：生产=Supabase（DATABASE_URL）。merge 部署只上 **代码**（A 字体/D 功能/normalizer）；**B/C/E 的 JSON 数据不会自动进 Supabase**，需 `npm run db:seed`（会覆盖 José 后台手改，须先备份）。安全路径：José 用已上线的后台 UI 改那 3 处 KMTC，或备份后 db:seed。
- **CONTENTO PDF 缺失**：prompt 指的 `Presentacion_de_Servicios_para_Yisel_Guzman.pdf` 不在仓库。只确认 2 个 maniobra 价（Servimaniobras 3800/Contecon 4100）+ 洗箱 550；其余 24 个 maniobra=0+「pendiente PDF」标注，完整 ~35 列表待 PDF。已入问题清单第 8 条。
- 给 José 问题清单：`docs/client-info-source/20260620_jose_question_list.md`（8 条）。
- **待办**：push 分支 → 开 PR → merge 部署代码 → deployments API 盯成功 → 抽查生产；数据落地按上面安全路径与 Chandler/José 确认。


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
- 大批次3（收尾+真bug）：✅ **代码完成，分支 feature/jose-r2-batch3-polish，待 PR**。
  - P0 真bug：store.js normalizeQuoteHeader 与 parseQuoteHeader 对齐（INLAND/新装箱/transportMode/extraFields 存draft读回不丢；附带修 normalizeQuoteLineItem 漏 section/uom/conceptEs）
  - S1 精确点 flatPrice 一口价(覆盖车型档)[模型] / S2 备注前台拖动排序+draft存有序选择/语言 / S3 行项 conceptEs 真ES concept[模型] / S4 fee译名扩到~98码(长尾en兜底待审) / S5 报价后台默认表头预填
  - 回归：smoke + r2-batch3-test + r2-o3-test + quote 9/9 全绿；ES+conceptEs PDF 渲染验证。
  - 待确认：S5 fee默认单价(低价值,deferred)；S4 长尾~247码译名(en兜底,待Jose审)。
- QA轮：✅ 全量只读QA出bug报告(B1 XSS/B2 fixedCharges/B3精确点编辑/B4死路由)。
- QA修复批：✅ **代码完成,分支 feature/qa-fixes,待PR**。
  - B1[P1安全] 存储型XSS：safeJson(res.locals)转义`<`→`<`,全15处`<%- JSON.stringify`入`<script>`改用safeJson;实测payload不逃逸+JSON原样解析。
  - B2 customs码头fixedCharges加add/delete路由+按钮(实测1→2→1)。
  - B3 精确点save扩name/coords/link(改坐标重抓路线)。B4 删死路由demurrage/:groupKey。
  - 回归:smoke(+B1/B2新guard)+quote9/9+o3+batch3全绿。
- 报价模式批（quote-modes）：✅ **代码完成,分支 feature/quote-modes,待PR/合并部署**（2026-06-17 第N+11轮）。
  - 块1 非墨段(NO MEXICO)预设：QUOTE_TEMPLATE_ROWS 加 12 行 foreign(section="foreign")=海运段2项(海运费2700/AMS30 USD)+起运港10项(订舱400/THC1020/EIR30/文件450/安保30/封50/VGM50/舱单100/报关100/电放450,全USD,起运港行remarks标注"待José确认汇率/USD")；QUOTE_GROUP_ORDER 加 OCEAN FREIGHT/PORT OF ORIGIN(排墨西哥段前);三语 conceptEn/Zh/Es 全列;费用代码复用字典(FRT/AMS/BKG/OTHC/ODOC/OSECU/SEAL/VGM/MANI/ECCLR/TLX,EIR无码留空+译名待审)。
  - 块2 报价模式开关：quoteMode 字段("mexico_only"|"ocean_mexico")=draft+normalizer+headerDefaults(S5默认);workbench顶部模式选择器(change自动submit重载);reconcileLineItemsForMode(模式一删foreign/模式二缺则前置foreign块,幂等);PDF按sections渲染(模式一无foreign行→自动不显示NO MEXICO段)。
  - 数据兼容:老draft无quoteMode→mexico_only(=现有行为);老报价无foreign行→只渲染mexico段;墨西哥段11项数字未改。
  - 回归:quote-test 9/9 + smoke(加mode×currency断言)+deep HTML render 30/30(4组合×三语,USD含16%VAT/MXN不含税沿用)全绿。
  - 待José:起运港USD最终价/汇率;EIR译名审。
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
