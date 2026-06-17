# 大批次1 — Bug 修复全集 SPEC（Jose 第二轮反馈）

- **分支**：`feature/jose-r2-batch1-fixes`（从合并后的 main `9a16771` 切出）
- **日期**：2026-06-17
- **作者**：Claude Code（深度模式调查）
- **状态**：📋 SPEC 待 Chandler 复核 — **本文写完即停，确认后才写代码**
- **前置**：batch1/2 已合并上生产（main `9a16771`，Railway 部署 success，生产页抽查全过）

---

## 0. 上下文与当前真实状态

合并后 main = `9a16771` = 原 01c988e 内容（双价/短驳/车型6档/照片/override）已上生产。本批在此基础上修 Jose 第二轮反馈里的 **bug + 小展示功能**，数据模型改动只有 **O3 一处**。

### 0.1 ⚠️ 调查中发现的「计划前提已过时」修正（重要，影响范围比原计划小）

原 prompt 的部分 file:line 与判断写于 batch2 合并前，调查实测后有 4 处需修正：

| # | 原计划假设 | 实测（main `9a16771`） | 影响 |
|---|---|---|---|
| C1 | O6.7：`VEHICLE_LABEL_KEYS` 只映射 sencillo/full，新车型误标 Sencillo | **batch2 已修**：[calculate.js:15-22](src/lib/calculate.js#L15-L22) 已映射全 6 档（light_1_5t/light_3_5t/short_8t/sencillo/full/lowboy） | O6.7 在 1a 基本是 **no-op**；仅剩 fallback 兜底（:24）可选加固。box_53（第7档）是大批次2 范围 |
| C2 | `admin-module.ejs` 换单+港口共享，改动注意两边 | **不共享**：[server.js:1400-1421](src/server.js#L1400-L1421) `renderAdminRules` 给 customs 渲染 `admin-customs.ejs`，给 handover 渲染 `admin-module.ejs` | **H1–H4 只影响换单(handover)，完全不碰 customs UI** → 爆炸半径更小 |
| C3 | H4：Agregar set 可能种不出可用首 tramo；0 套规则集加不了 | **add-set 已种首 tramo**：[server.js:3594](src/server.js#L3594) `appendProgressiveRule` | H4 多半不是「加不了 set」，需先 **实测复现 RCL 的确切失败点** 再定修法 |
| C4 | H2/H3：空格不可编辑是通用问题 | **仅 handover**：customs 的 fixedCharges 单元格 [admin-customs.ejs:256-265](views/admin-customs.ejs#L256-L265) 已经 `value="<%= rate?.rate ?? 0 %>"` 始终可编辑 | H2/H3 只改 `admin-module.ejs`（换单）+ 其 save handler |

### 0.2 全局约束（本批必守）
- spec-first：本 SPEC 确认后才写代码。
- O3（唯一数据模型改动）走 `store.js` normalizer + back-compat 默认 + seed builder 同步 + **单独 commit**。
- 不改放单/清关/已验证双价 math（除 H/O/Q 明确要改）。
- 无生产 `db:seed`（新字段后台录入不需 seed）。
- PR-only、不直推 main、不 force push。
- 验收：每项 file:line 改前改后 + 实测复现 + `npm test` 全绿 + 逐页渲染 + 详细报告后停下复核。

---

## 1a — 快修 / 纯展示（零数据模型改动）

### O6.6 陆运状态 预留→已启用
- **现状**：[i18n.js:52-59](src/lib/i18n.js#L52-L59)（zh）inland 模块 `state:"预留"`、`description:"预留模块…"`、`placeholderTitle:"陆运模块预留中"`、`placeholderDescription`；[i18n.js:679-688](src/lib/i18n.js#L679-L688)（es）`state:"Reservado"`、`title:"Transporte"`、placeholder 同。其他三模块（handover/customs/quote）均已是「已启用」/「Activo」。`stateLabel` 显示在侧栏导航 [header.ejs:49](views/partials/header.ejs#L49)。
- **改动**：
  - zh `state` `"预留"→"已启用"`（:56）；`placeholderTitle` `"陆运模块预留中"→"陆运模块已上线"`（:57）；`description`/`placeholderDescription`（:55,:58）改为「已接入路线/即时报价/车型」措辞。
  - es `state` `"Reservado"→"Activo"`（:684）；placeholder 同步（:685,:683,:686-687）。
- **不改**：其他位置的通用 "预留中"/"功能结构已预留"（i18n.js:158/168/226/560 等）——那是别的占位文案，与 inland 无关。
- **数据/API 影响**：无（纯文案）。**爆炸半径**：侧栏导航 state 标签 + inland 占位页文案。

### O4 logo 换新（侧栏 De Well 品牌 logo）
- **现状**：侧栏 [header.ejs:33](views/partials/header.ejs#L33) `<img src="/dewell-logo.svg" class="brand-logo" />`（变形的手画 SVG）。CSS `.brand-logo` 在 [styles.css:219](public/styles.css#L219)（已 `object-fit:contain`，待确认）。真 logo 已移入 `public/dewell-logo.png`（654×354，前置0 已放）。
- **改动**：
  - [header.ejs:33](views/partials/header.ejs#L33) `src="/dewell-logo.svg"→"/dewell-logo.png"`。
  - `git add public/dewell-logo.png`（当前 untracked）。
  - 确认 `.brand-logo` 有 `object-fit:contain` + 高度约束不变形；必要时微调（PNG 654×354 宽高比 ≈1.85:1）。
  - 旧 `public/dewell-logo.svg`：停用（不再被引用）。是否物理删除见 §6 开放问题。
- **爆炸半径**：所有带侧栏的工作台/后台页面顶部品牌区。
- **注**：`quote-pdf.js:44` 也引用 `dewell-logo.svg`，但其唯一使用点是报价文档右上 De Well 框，会被 **Q1 删除** → 见 Q1。

### Q1 报价右上 De Well logo 拿掉
- **现状**：[quote-document.ejs:91-98](views/quote-document.ejs#L91-L98) doc-header 有两个 logo 框：左 Express Line（:92-94）、右 De Well（:95-97）。
- **改动**：删除 [quote-document.ejs:95-97](views/quote-document.ejs#L95-L97) 右侧 De Well `.logo-box`，只留左侧 Express Line。`.doc-header` 是 `justify-content:space-between`，单 logo 会左对齐（可接受）。
- **连带**：删后 `assets.logoDewell`（[quote-pdf.js:44](src/lib/quote-pdf.js#L44)）在报价文档不再使用 → 可保留（无害）或一并移除该 asset 行。建议保留以最小化改动。
- **爆炸半径**：报价 PDF 表头。回归：PDF 渲染不报错、左 logo 正常。

### Q3 报价部门加「陆运」
- **现状**：[workbench-quote.ejs:51-55](views/workbench-quote.ejs#L51-L55) `department` select 只有 `OCEAN`/`AIR`。PDF 侧 [quote-document.ejs:108](views/quote-document.ejs#L108) 原样打印 `header.department`。
- **改动**：select 加 `INLAND`（i18n `quote.departmentInland` = 陆运/Transporte terrestre）。`department` 存于 `formData.header.department`（已有字段，无模型改动）。
- **i18n**：加 `quote.departmentInland`（zh/es）。**爆炸半径**：报价 builder + PDF 表头。

### Q4 Incoterm 改下拉
- **现状**：[workbench-quote.ejs:56-57](views/workbench-quote.ejs#L56-L57) `incoterm` 是自由文本 `<input>`，存 `header.incoterm`。
- **改动**：改 `<select>`，选项常量 `INCOTERM_OPTIONS = [EXW,FCA,FAS,FOB,CFR,CIF,CPT,CIP,DAP,DPU,DDP,DAT]`（定义在 `src/lib/quote.js` 或 `src/lib/options.js`，passed to view）。**兼容旧值**：若 `header.incoterm` 不在列表（历史自由文本），额外渲染一个当前值 option 选中，避免丢数据。
- **数据/API**：同字段、无模型改动。**爆炸半径**：报价 builder 表单。

### Q5 运输方式字段（新增 header 字段，轻量模型触点）
- **现状**：无 `transportMode` 字段。
- **改动**：
  - workbench-quote.ejs general data 区加 `transportMode` `<select>`，常量 `TRANSPORT_MODE_OPTIONS = [AIR,SEA,FSA,FAS,ROA,RAI,COU]`。
  - **quote header model**：在 quote.js 的 header 规范化处加 `transportMode`（默认 `""`），在 [server.js](src/server.js) 报价 POST 解析处读 `body.transportMode`。
  - PDF [quote-document.ejs](views/quote-document.ejs) general data 表加一行/格显示 `header.transportMode`。
- **back-compat**：旧报价 draft 无该字段 → 默认 `""`，不崩。
- **数据/API**：quote header 加 1 字段（非 store 模型，是 quote 文档/草稿结构）。**爆炸半径**：报价 builder + header model + POST 解析 + PDF。这是 1a 里唯一触及「持久结构」的项（quote 草稿层，非 shipping-data），需在实现报告里专门说明 round-trip 验证。

### Q6 装箱类型改下拉
- **现状**：[workbench-quote.ejs:62-66](views/workbench-quote.ejs#L62-L66) `cargoType` select 只有 `FCL`/`LCL`，存 `header.cargoType`。
- **改动**：扩 `CARGO_TYPE_OPTIONS = [FCL,LCL,BLK,LQD,BBK,BCN,SCN,ROR]`。旧值 FCL/LCL 仍有效，兼容旧值同 Q4。
- **爆炸半径**：报价 builder + PDF 表头（[quote-document.ejs:109](views/quote-document.ejs#L109)）。

### O6.7 车型标签 [INCIDENTAL_FIX] — **基本已由 batch2 修复**
- **现状**：[calculate.js:15-24](src/lib/calculate.js#L15-L24) `VEHICLE_LABEL_KEYS` 已映射全 6 档；`vehicleLabel` fallback（:24）未知类型→`inland.serviceSencillo`。
- **改动（最小）**：确认无误；可选把 fallback 从硬编码 "Sencillo" 改为更中性（如返回原 `type` 或 `inland.vehicleUnknown`），避免未来新车型（box_53）在标签未补全时误标。**完整 7 档 + box_53 = 大批次2**。
- **建议**：本批 O6.7 标为「已由 batch2 解决，仅加固 fallback」，不做实质枚举扩展。

---

## 1b — 换单可编辑（handover 模块；admin-module.ejs + 通用 save handler）

> **范围澄清**（见 C2）：以下全部仅作用于 **换单(handover)** 模块。customs 走 admin-customs.ejs，POST save handler [server.js:3892-3894](src/server.js#L3892-L3894) 对 customs 直接 bounce，add-set/add-rule [server.js:3560/3616](src/server.js#L3560) 对 customs 返回 404。Jose 抱怨的 ZIM/COSCO/OOCL/WANHAI/RCL 都是换单的船公司。

### H1 本地费用删除（ZIM「Borrar 85」删不掉）
- **现状**：Local Charges 区 [admin-module.ejs:233-307](views/admin-module.ejs#L233-L307) 有「添加」按钮（:239-244 `formaction=…/local-charges/add`），但**每行无删除按钮**。对照：terminal-mix 行有删除（[:164-172](views/admin-module.ejs#L164-L172) `formaction=…/terminal-mix/:mixId/delete`），demurrage rule 有删除（[:421-428](views/admin-module.ejs#L421-L428)）。
- **改动**：
  1. EJS：localCharges 行（:258-303）加一列「操作」+ 删除 `<button type="submit" formaction="/admin/<%= currentModuleKey %>/shipping-lines/<%= selectedLine.id %>/local-charges/<%= charge.id %>/delete" formmethod="post" data-confirm-submit>`（镜像 terminal-mix 删除）。表头（:247-255）加操作列 th。
  2. **server.js 新路由** `POST /admin/:moduleKey/shipping-lines/:id/local-charges/:chargeId/delete`（紧邻现有 `local-charges/add` [server.js:3509](src/server.js#L3509)，复制其 customs-guard + load + 定位 line + 保存模式）：`updated.localCharges = updated.localCharges.filter(c => c.id !== chargeId)`，`saveShippingData`，redirectWithFlash。
- **数据/API**：删除现有 localCharge，无模型改动。**爆炸半径**：换单船公司 admin 页。回归：删后保存、再加载不残留。

### H2/H3 空格可编辑 + 保存能创建（COSCO/OOCL/WANHAI 改不了）
- **现状（双重 bug）**：
  - EJS 只在已有 rate 时渲染输入框：BL 格 [admin-module.ejs:273](views/admin-module.ejs#L273) `<% if (charge.blRate) %>`、组费率格 [:289](views/admin-module.ejs#L289) `<% if (rate) %>`、Garantía 格 [:214](views/admin-module.ejs#L214) `<% if (rate) %>`。无种子的(费用×柜型)格子空白、不可输入。
  - 即使渲染了输入，save 也不创建：[applyRateCellUpdates:774-780](src/server.js#L774-L780) `if (!rateConfig) return;`（rate 对象不存在直接 no-op）。调用点在 localCharges 循环 [server.js:3933-3942](src/server.js#L3933-L3942) 与 guarantee [:3945-3951](src/server.js#L3945-L3951)。
- **改动**：
  1. **EJS**：把 :214 / :273 / :289 的 `<% if (rate) %>` 守卫去掉，**每个 (费用×柜型) 与 BL 格都始终渲染** number input + 币种 select；无 rate 时 `value=""`（或 0）、币种默认 MXN。
  2. **server**：rate 创建逻辑。两种实现，二选一（实现时定，倾向 b）：
     - (a) 改 `applyRateCellUpdates` 签名为 `(parentObj, key, body, prefix)`，当 `body[prefix+'_rate']` 有非空值且 `parentObj[key]` 不存在时，`parentObj[key] = { rate, currency }`。
     - (b) 在调用点（3933-3942 / 3945-3951）判断：若 `body[prefix+'_rate']` 有值且目标 rate 对象不存在 → 先建 `{ rate:0, currency:'MXN' }` 再 `applyRateCellUpdates`。
  3. **加全新 concept 行**（COSCO 特殊柜 50-150 USD）：localCharges/add [server.js:3509](src/server.js#L3509) 已能加新 charge 行；新 charge 默认 groupRates 需对所有柜型可编辑（靠 EJS 改动 1 即得）。确认 add 出来的新行所有列可填可存。
- **数据/API**：可能新建 rate 子对象（blRate/groupRates[key]）——属现有结构内，无 schema 变更，但需确认 normalizer 接受新建的 rate 形状。**爆炸半径**：换单船公司 admin 页 + save handler。**回归**：空格输入→保存→重载存在；已有费率改值不回归；双价/demoras 计算不受影响。

### H4 demoras 加项健壮性（RCL 加不了 demoras）
- **现状**：
  - 「Agregar set」按钮 [admin-module.ejs:315-320](views/admin-module.ejs#L315-L320) 在 ruleSet 循环**外**，恒可见；其 handler [server.js:3556-3608](src/server.js#L3556-L3608) **已种首 tramo**（:3594 `appendProgressiveRule`）。
  - 「Agregar tramo」(add rule) 按钮 [:370-375](views/admin-module.ejs#L370-L375) 在 ruleSet 循环**内**（:359）→ 0 套规则集时无此按钮（但可先加 set）。
  - 删除 rule 按钮 `rules.length <= 1` 时 disabled [:427](views/admin-module.ejs#L427)。
- **改动（先复现再定）**：
  1. **本地复现 RCL 的确切失败**（RCL 当前 demurrage 结构：是 0 套规则集？还是加 tramo 报错？还是 assignments 崩？）——这是 H4 的第一步，不假设。
  2. 健壮性兜底（无论复现结果都值得做）：`updated.demurrage.ruleSets` 为 undefined/0 时，save handler [server.js:3977-3998](src/server.js#L3977-L3998) 与 add 路由不崩；0 套时 UI 给明确「先添加规则集」提示（或自动建默认集——倾向给提示，因 add-set 已可用）。
  3. 确认 add-rule（tramo）到已有 set 持久化 [server.js:3611-3679](src/server.js#L3611-L3679) 正常。
- **数据/API**：无模型改动。**爆炸半径**：换单 demoras 区。**回归**：现有多套规则集船公司不受影响。
- **⚠️ 注**：H4 修法待复现确认；若复现不出「加不了」，在报告中如实说明并请 Chandler 提供 RCL 复现步骤。

---

## 1c — 港口码头（含唯一数据模型改动 O3）

### O1 加港口 404
- **现状**：无 `GET /admin/customs/terminals/:id`（只有一堆 POST 子路由，见 [server.js:2637-3054](src/server.js#L2637)）。Jose image11 的 URL 形如 `/admin/customs/terminals/customs-port-…`（注意是 **port** id 落在 terminals 路径），疑似某表单 action / 链接拼错 + GET 落到不存在的路由 → 404。
- **改动**：
  1. **先本地复现**：抓出生成 `/admin/customs/terminals/customs-port-…` 的确切前端来源（grep 视图里 `customs/terminals/` 拼接 + 实际点击加港口/加码头流程），定位是 add-port 后的 redirect、还是 add-terminal 表单 action 拼错。
  2. **修正根因**：改正那个错误 URL（应为 `/admin/customs/ports/:portId/terminals/add` 或正确 anchor）。
  3. **防御性兜底**：加 `GET /admin/customs/terminals/:id` → 302 到 `/admin/customs/shipping-lines#customs-terminal-:id`（GET 误访问不再 404）。
  4. 端到端验证 add-port → add-terminal happy path（[server.js:2619](src/server.js#L2619)/[:2637](src/server.js#L2637)）。
- **数据/API**：加 1 个 GET 路由（只重定向）。**爆炸半径**：customs 港口/码头管理页。

### O2 拿掉业务性质（UI 隐藏，enum 保留）
- **现状**：选择器在 **workbench-customs.ejs**（清关前台计算页）[:56-62](views/workbench-customs.ejs#L56-L62) `<select name="businessNature">`，结果区显示 [:271-272](views/workbench-customs.ejs#L271-L272)。`workbench.ejs:82` 已有 `<input type="hidden" name="businessNature" value="handover_only" />` 的模式可借鉴。enum 在 [options.js:12-16](src/lib/options.js#L12-L16)，被 server/calculate/quote 多处引用（[server.js:732/935/967/1142](src/server.js#L732)、calculate.js:602/969、quote.js:426/477），**保留不动**。customs 默认已是 `customs_only`（[server.js:895/937](src/server.js#L895)）。
- **改动**：
  - workbench-customs.ejs [:56-62](views/workbench-customs.ejs#L56-L62) 选择器 → 改为 `<input type="hidden" name="businessNature" value="customs_only" />`（隐藏、固定 customs_only）。结果区 [:271-272](views/workbench-customs.ejs#L271-L272) 业务性质显示按需保留或隐藏（倾向隐藏，因已固定）。
  - 不动 enum、不动 server 解析（`normalizeBusinessNature` 收到 customs_only 正常）。
- **数据/API**：无模型改动。**爆炸半径**：清关前台计算页。**回归**：清关计算结果在 customs_only 下与之前一致。

### O3 每费用配置模块 [数据模型改动 — 单独 commit]
- **现状模型**：terminal.fixedCharges 项 = `{ id, concept, note, taxRate, groupRates }`（normalizer [store.js:988-999](src/lib/store.js#L988-L999)；调用 [store.js:1399](src/lib/store.js#L1399)）。UI [admin-customs.ejs:228-271](views/admin-customs.ejs#L228-L271)（concept/note/tax + 每柜型 rate）。计算 [calculate.js:730-766](src/lib/calculate.js#L730-L766)：按柜型 groupRates 出 parts，`if (!parts.length) continue`（无费率的费用项被跳过、不显示）。seed 在 [store.js:1525/1570/1622](src/lib/store.js#L1525)。
- **改动（数据模型）**：fixedCharge 加 3 字段：
  - `basis: 'per_day' | 'per_occurrence'`（默认 `per_occurrence`）
  - `required: boolean`（默认 `false`）
  - （`amount`：见 §6 开放问题 — 现模型是 groupRates 按柜型，不是单一 amount；需 Chandler 确认 `amount` 是「替代 groupRates 的统一金额」还是「与 groupRates 并存」。**实现前必须定**。）
  1. **normalizer** [store.js:988](src/lib/store.js#L988) `normalizeCustomsCharge` 加 `basis`（白名单校验，默认 per_occurrence）、`required`（Boolean 默认 false）；**back-compat**：老 terminal 的 charge 无这些字段 → 取默认，不崩。
  2. **seed builder** [store.js:1525/1570/1622](src/lib/store.js#L1525) 同步加 `basis`/`required`，保证 seed-shape == normalize-shape（batch2 教训）。
  3. **UI** [admin-customs.ejs:228-271](views/admin-customs.ejs#L228-L271) 加列：basis `<select>`（per_day/per_occurrence）+ required `<checkbox>`；表头同步。customs terminal 费用 save handler（实现时定位，解析 `terminal_charge_*` 的那个 POST）加 basis/required 解析。
  4. **计算/报价 honor** [calculate.js:730-766](src/lib/calculate.js#L730-L766)：
     - `required=true` → 即使金额 0 / 无 parts 也产出该项并显示选中（去掉对 required 项的 `if(!parts.length) continue` 跳过）。
     - `required=false` → 仅产生时显示（现行为）。
     - `basis='per_day'` → 金额按天数（storageDays/相应天数）乘算；`per_occurrence` → 按次（现行为）。
  - **接口点**：此条与大批次2 报价工作有接口（报价侧如何渲染 required/basis）——本批只做 customs 计算侧 honor + admin 配置，报价 builder 的呈现留大批次2，spec 里标清。
- **数据/API**：fixedCharge 加 2-3 字段。**爆炸半径**：customs admin UI + normalizer + seed + customs 计算 + （间接）报价 pull。**单独 commit** + normalizer back-compat 专项验证（老数据加载、首次 re-seed 不变 shape）。

### O3b 港口删除
- **现状**：无 `POST /admin/customs/ports/:portId/delete`（只有 terminals/:id/delete [server.js:2672](src/server.js#L2672)、yards/:id/delete [:2729](src/server.js#L2729)）。
- **改动**：
  1. server.js 新路由 `POST /admin/customs/ports/:portId/delete`（紧邻 ports/add [server.js:2619](src/server.js#L2619)）：删除该 port，**级联删除其 terminals**（filter ports；其 terminals 随 port 对象一并移除），`saveShippingData`，redirect。
  2. admin-customs.ejs 港口区加删除按钮（带 `data-confirm-submit`）。
- **数据/API**：删 port + 级联 terminals，无 schema 变更。**爆炸半径**：customs 港口管理 + 引用该 port 的 terminalMix/报价 pull（删后需确认引用不崩——port 在别处按 id 引用时的兜底）。**回归**：删港口后该港相关计算/选择器不报错。

---

## 2. 实现顺序（commit 计划）

1. `1a` 展示快修（O6.6 / O4+logo / Q1 / Q3 / Q4 / Q5 / Q6 / O6.7 fallback）— 1~2 commit。
2. `1b` 换单可编辑（H1 / H2-H3 / H4）— 按 H 分 commit。
3. `1c-O1`（404 修根因 + 防御路由）、`1c-O2`（隐藏业务性质）、`1c-O3b`（港口删除）。
4. `1c-O3`（数据模型）— **单独 commit**，含 normalizer + seed + UI + 计算 honor。

---

## 3. 验收计划（深度模式）

- **逐项 file:line 改前改后**：1a/1b/1c 每项列出。
- **实测复现**（json driver 本地起服务）：
  - H1：换单某船公司删一条 local charge → 保存 → 重载不残留（复现 ZIM「Borrar 85」）。
  - H2/H3：空 (费用×柜型) 格输入金额 → 保存 → 重载存在（复现 COSCO/OOCL/WANHAI）；已有费率改值正常。
  - H4：复现 RCL 加 demoras 的失败，记录确切触发，再验证修复（或如实报告复现不出）。
  - O1：复现加港口/加码头 404 场景 → 修复后 happy path 通；防御 GET 302 生效。
  - O2：清关前台不再显示业务性质选择器；计算走 customs_only 结果不变。
  - O3：admin 设 basis/required → 计算时 required=true 即使 0 也显示、per_day 按天乘；O3b 港口能删（级联 terminals）。
- **O3 数据模型专项**：normalizer 老数据（无 basis/required）加载不崩；seed builder 重建 shape == normalize shape；首次 re-seed 不改对象形状。
- **回归**：`npm test`（smoke）全绿；逐页渲染（workbench/admin handover+customs+inland+quote）；双价 MXN/USD math 不变。
- **报告**：非「done」——改了什么 file:line、改前改后、实测结果、回归结果、爆炸半径、待确认 → 停下复核 → PR → Chandler 确认后合并部署 → 大批次2。

---

## 4. 风险与回滚

- **风险**：
  - O3 数据模型改动若 normalizer back-compat 漏 → 老 terminal 加载崩。**缓解**：默认值 + 单独 commit + 老数据加载测试。
  - Q5 transportMode 加 header 字段若 quote 草稿/PDF 漏接 → 旧草稿打开报错。**缓解**：默认 `""` + round-trip 测试。
  - H2/H3 rate 创建逻辑若误把空格当 0 写入 → 制造一堆 0 费率行污染。**缓解**：仅当 `_rate` 字段**非空**才创建对象。
  - O3b 删港口若有别处按 id 强引用 → 引用方崩。**缓解**：删前/渲染处对缺失 port 兜底。
- **回滚**：本批走 PR；合并后若生产异常，main 回退到合并前 commit（`9a16771`）即恢复（Railway 自动重部署）。代码级回滚，不涉 DB 写。

## 5. 文档影响
- 更新 `docs/client-info-source/_ROADMAP_anti_compact.md` 大批次1 状态。
- 路由/教训写 `docs/LESSONS.md`（尤其 stale-premise 修正 C1-C4、rebase-stacked-PR 恢复教训）。

---

## 6. 开放问题（实现前需 Chandler 定）

1. **O3 `amount` 语义**：现模型是 `groupRates`（按柜型金额）。`amount` 是要「替代 groupRates 的单一统一金额」，还是「与 groupRates 并存的另一种计费」？这决定 O3 的模型与 UI 形态。**实现前必须定**。
2. **O4 旧 svg**：`public/dewell-logo.svg` 停用后是否物理删除？（删=干净；留=零风险。倾向先停用不删，PR 里说明。）
3. **O6.7 范围**：确认 1a 只做「确认+fallback 加固」，box_53 第7档放大批次2？（我的判断：是。）
4. **H4 RCL**：若我本地复现不出「RCL 加不了 demoras」，请 Chandler 提供 RCL 的确切复现步骤/截图。
5. **Q4/Q6 旧值兼容**：incoterm/cargoType 历史自由文本值，确认「渲染为当前选中 option 保留」的兼容策略 OK。
