# Spec — 新增/删除船公司功能（后台自助 onboarding）

> Task D. 本地调查后产出。目标：让运营在后台自助新建一家船公司（目前只能改 JSON），
> 并补删除功能。配合 José 的 7 家新供应商（ESL/SINOKOR/SL/SEA LEAD/TS LINES/HMM/SINOTRANS）。

## 1. 现状（调查结论，代码已核实）

- 船公司数据 = `data/shipping-lines.json` → `modules.handover.shippingLines[]`（14 家，完整结构）。
- `modules.customs.shippingLines[]` = **独立的轻量镜像**（`{id,name,active,notes,yardIds}`，经 `normalizeSimpleShippingLine`），承载 yard↔line 映射。**不自动从 handover 同步**。
- 报价选择器（`buildQuoteSelectorData`）从 **handover** 取 lines → 新 handover line 自动出现在报价页。✅
- 清关页（admin-customs）的 yard↔line 映射用 **customs.shippingLines** → 新 line 必须**也加进 customs 镜像**才可在清关页关联场站。
- 路由现状：编辑 `POST /admin/:moduleKey/shipping-lines/:id`(4290)；子项 add：`terminal-mix/add`(3892)、`local-charges/add`(3990)、`demurrage-rule-sets/add`(4090)。**无创建路由**（grep 零结果）。港口/码头/场站都有 `/add`（镜像参考：`buildCustomsYardDraft`/`yards/add` 3180）。
- 编辑 UI（`admin-module.ejs`）：左 `admin-list` 列出 lines（链接到 `/:id`）；右 `admin-detail` 是编辑表单。**当前表单没有 name/code/rfc 输入**（只展示，70-71 行）。容器组 `containerGroups` 也**无编辑 UI**（每家 line 出厂即带组）。
- `saveShippingData` 始终先 `normalizeShippingData` 再落盘 → 创建时给最小草稿即可，normalizer 会补全 guarantee/demurrage/quoteDefaults/notes。
- Task E 已让 `normalizeShippingLineNotes` 保证 `notes={sourceSheet,code,rfc}`（back-compat rfc=null）。

## 2. 设计

### 衔接方式
**两步**：创建表单只收 `name`(必填)/`code`/`rfc` → 建一条最小但合法的 line → 跳转到该 line 编辑页，
复用现有 UI 补 local charges / 押金 / 滞期 / 码头 mix（这些 add 子路由已存在）。

### 新 line 初始结构（`buildShippingLineDraft`）
```
{ id: slug(name) 去重, name, active:true,
  containerGroups: [GP HC SD, OT FR RF]   // 默认两组（多数 line 即此，给编辑 UI 锚点；UI 暂不可改组）
  invoiceToConsigneeOnly:false, invoiceNote:null,
  terminalMix:[], localCharges:[],
  notes:{ sourceSheet:null, code, rfc } }
```
其余（guarantee/demurrage/quoteDefaults/demurrageCutoff）交给 `normalizeShippingLine` 补全。

### customs 镜像（`buildSimpleShippingLineMirror`）
`{ id, name, active:true, notes:{code,rfc}, yardIds:[] }` push 进 `customs.shippingLines`。

### 路由（handover only，其余 404）
- `POST /admin/:moduleKey/shipping-lines/add`：建 draft + 镜像 → save → 跳编辑页。name 空 → flash 错误回列表。**必须注册在 `/:id`(4290) 之前**（否则 "add" 被 `:id` 吞）。
- `POST /admin/:moduleKey/shipping-lines/:id/delete`：从 handover 删 line + 从 customs 删镜像 + 级联清除任何 `yard.shippingLineIds` / `customs line.yardIds` 中该 id → save → 回列表。
- 编辑 save(4290) 增解析：`line_name`/`line_code`/`line_rfc` → 更新 handover line.name/notes；同步 customs 镜像 name/notes。

### UI（`admin-module.ejs`）
- 左 `admin-list` 顶部加「+ 新增船公司」内联表单（name 必填 + code + rfc + 创建按钮，post `/add`）。
- 右编辑表单顶部加 name/code/rfc 三个输入（grid-form）。
- 右编辑表单加「删除船公司」按钮（confirm，post `/:id/delete`）。

### i18n（zh + es 两套，admin 段）
addShippingLine / createShippingLineTitle / lineName / lineCode / lineRfc / createShippingLine /
newShippingLineName / shippingLineAdded / lineNameRequired / deleteShippingLine /
confirmDeleteShippingLine / shippingLineDeleted / createShippingLineHint(onboarding checklist) / lineIdentityTitle。

## 3. onboarding checklist（7 类字段，来自 ALL NAV，作表单引导）
①name/code/rfc ②码头 terminal mix ③柜型组 containerGroups ④local charges（概念+基准 BL/CNTR+金额+币种+IVA）
⑤garantía 押金（按柜型档+币种）⑥demoras 滞期（免费天数+分档）⑦arrival notice/备注。
创建表单收 ①；其余在编辑页补（hint 文案列全清单）。

## 4. 验证（D2）
建 SINOKOR：建→跳编辑→加 1 条 local charge→加押金→加滞期→保存→读回完整→报价页+清关页可选→删除测试→老 14 家不受影响。
回归：smoke + quote 9/9 + r2-o3 + r2-batch3。

## 5. 兼容/边界
- 数据模型：新 line 走 `normalizeShippingLine`（空结构兼容，已验证）；customs 镜像走 `normalizeSimpleShippingLine`。
- 不动放单/清关/已验证双价 math/报价模式。
- 容器组编辑 UI 不在本次范围（出厂默认两组，后续可单列）。
