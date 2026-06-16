# 陆运 v2 第一批 — 实施 Spec（实现级）

> 分支：`feature/inland-v2-batch1`（已切，从 `main@66ccf37`）。PR-only。
> 来源任务书：`docs/specs/20260614_inland_v2_batch1_TASK_PROMPT.md`。
> 本 Spec 对应 Step 1。**写完即停，等 Chandler 确认口径后再做 Step 2。**
> 范围：R5(里程进PDF) / R2(短驳) / R4(双币种双IVA) / R1(多港后台口子)。**R3 车型本批不做。**

---

## 0. 请先确认的口径（确认后我才动代码）

> 这几条是会影响数值/对客单的关键口径；任务书已拍板的我按拍板写，但仍逐条列出请你点头。

- **K1（R2 短驳取值）**：同一目的地多条费率时，短驳费 = 该目的地**所有启用条目里 `burreo[serviceType]` 的最高值**（与主费率「跨供应商取最高」一致）。短驳的「最高」**独立于**主费率的最高供应商，可能来自不同条目。→ 任务书已定，确认即可。
- **K2（R2 计入方式）**：短驳是**可选附加项**，`includeBurreo` 默认 **false**；不勾 = 总价不含、显示 0；勾选 = `pretax += burreoRate × 柜数`，并单列拆分行。→ 确认。
- **K3（R4 双价口径）**：报价单层并列两价——
  - **MXN 价 = MXN基准 ×(1 + ivaMxn)**，`ivaMxn` 默认 **0（不含税）**。
  - **USD 价 = MXN基准 ÷ 即期(USD→MXN)汇率 ×(1 + ivaUsd)**，`ivaUsd` 默认 **0.16（含税）**。
  - 两个 IVA 开关**各自独立、均可手切**（四种组合）。
  - 「MXN基准」= 把所有计价行折算到 MXN 的税前合计（USD 原生行用汇率折回 MXN；AT COST 行不计）。→ 任务书已定，确认即可。
- **K4（汇率源）**：USD 用系统 `exchangeRates`（`exchange-rates.js` 自动抓，含 `asOfDate`）的即期 `USD→MXN`（当前 17.459，asOf 2026-05-05）。PDF/界面**标注汇率日**。汇率缺失时**降级**：USD 价显示「—（汇率不可用）」，不阻塞 MXN 价。→ 确认。
- **K5（R4 与 NOTES 冲突）**：现 NOTE#1「价格均不含税，开票加 16% VAT」与「USD 默认含税」并列会矛盾。**建议**：双价模式下把 NOTE#1 改为「**MXN 价不含税；USD 价已含 16% VAT；最终以开票日汇率结算**」，并更新 `BRAND_NOTES.md` 对应条款。→ **需你确认改写口径**（这条最值得拍一下）。
- **K6（R1 借港口）**：从清关 `customs.ports[]` 引入时**只有 `name`（无坐标）**——清关港口结构是 `{id,name,note,terminals[]}`，不存 lat/lng（`store.js:1419-1438`）。故引入后**坐标需手填或给默认**（Lázaro Cárdenas 默认 `17.96,-102.20`；Manzanillo 已有 `19.0522,-104.3158`）。→ 确认默认坐标可接受，或上线时人工补。
- **K7（R4 落点范围）**：双价**本批落在报价单/PDF 层**（任务书明确「报价单层」）。前台陆运工作台 `inland-map.js` 的单 MXN 价**本批不动**（除 Step 4 加短驳勾选）。→ 确认：双价只进 PDF/报价单，不进陆运即时面板。

---

## 1. 现状锚点（实现依据，全部已核到 file:line）

| 主题 | 关键事实 | 锚点 |
|---|---|---|
| 报价模板 | 11 行；TRANSPORTATION 组 `SINGLE`/`FULL` 的 `calcRef={module:"inland",field:"sencillo"/"full"}` | `quote.js:99-123` |
| 报价取数 | `pullCalculatorValues` 对 inland 两 serviceType 调 `computeInlandCalculator`，回填 `unitPrice=maxRate, unit=柜数` | `quote.js:459-490` |
| 合计 | `computeQuoteTotals` 出 `rows / subtotals(按币种) / indicative(跨币种折算)` | `quote.js:288-341` |
| 视图装配 | `assembleQuoteView` 调 `computeQuoteTotals`，产 `{number,date,header,rows,groups,subtotals,indicative,notes}` | `server.js:1450-1466` |
| PDF | `renderQuotePdf(quoteView)`→EJS→Puppeteer；HTML 自包含（内联字体/logo）；`renderQuoteHtml` 可单独出 HTML | `quote-pdf.js:70-94` |
| PDF 模板 | `MEXICO LOCAL CHARGES` 表 + `subtotals` + `indicative` + `NOTES` | `quote-document.ejs:101-149` |
| 短驳数据 | CSV `BURREO / LOCAL` → 进 `rateEntry.extras["BURREO / LOCAL"]`，未解析 | `inland-csv.js:170-181` / 取值：空117·`$4800/$7000`59·`$4800/$7800`72 |
| inland 计算器 | 硬编码 `quoteCurrency="MXN"`；`maxRate=跨供应商最高`；无短驳、无汇率 | `calculate.js:1002-1102` |
| 路线缓存 | `routeCache[]` 含 `originId,destinationId,targetType,distanceKm,durationMin,viaCities,hasFerry,stale` | `store.js:1931-1950` |
| origins | `origins[]` 已规范化 `{id,name,lat,lng}`；seed 仅 manzanillo；全链路只用 `origins[0]` | `store.js:1974-1983` / `inland-catalog.js:11-13` |
| rateEntry | 已带 `originId`（默认 manzanillo）+ `extras` | `store.js:1906-1929` |
| 清关港口 | `{id,name,note,terminals[]}`，**无 lat/lng** | `store.js:1419-1438` / 种子 Manzanillo+Lazaro `store.js:1515-1716` |

---

## 2. 数据模型变更

### 2.1 `rateEntry.burreo`（R2）
新增字段（**附加，旧数据兼容**）：
```jsonc
"burreo": { "sencillo": 4800, "full": 7800 }   // 或 null（无短驳）；单档缺失则该键为 null
```
- `inland-csv.js`：新增 `parseSencilloFull(raw)`——正则 `/SENCILLO\s*\$?\s*([\d.,]+)[\s\S]*?FULL\s*\$?\s*([\d.,]+)/i`，复用 `parseAmount`；解析失败 → `null`。在 `cleanInlandCsv` 构造 rateEntry 时，从 `extras["BURREO / LOCAL"]` 解析出 `burreo`，**`extras` 原值保留不删**（满足任务书「保留 extras 原值」）。**不**把 `BURREO / LOCAL` 加进 `FIELD_BY_HEADER`（加了反而会从 extras 移除）。
- `store.js normalizeInlandRateEntry`（`1906-1929`）：增 `burreo` 规范化——对象则 `{sencillo:parseNullableNumber, full:parseNullableNumber}`，否则 `null`。
- `admin-inland.ejs` 费率表：增「短驳 S / 短驳 F」两列可编辑（`re_burreoS_<id>` / `re_burreoF_<id>`）；保存路由 `/admin/inland/rate-entries/save` 解析写回。

### 2.2 `origins[]` 后台 CRUD（R1）
扩展 origin 形状（**附加**）：
```jsonc
{ "id":"manzanillo", "name":"Manzanillo", "lat":19.0522, "lng":-104.3158, "enabled":true, "note":"" }
```
- `store.js` origin 规范化（`1974-1983`）：增 `enabled`(默认 true)、`note`。
- 新增三条 admin 路由：`POST /admin/inland/origins/add`（手输 name+lat+lng）、`/save`、`/:id/delete`。删除时若该 origin 仍有 rateEntries → 拒绝 + flash 提示（防孤儿费率）。
- 「从清关引入」：admin 提供下拉/按钮列出 `customs.ports[].{id,name}`，选中 → 预填 `name`（**坐标空，按 K6 给默认或留空待填**）。
- `precisePoint` **不变**。

### 2.3 不变项
- `computeInlandCalculator` 的 **MXN 基准与 maxRate 取数不变**（R4 在报价单层做换算）。
- 放单/清关全部数据模型与计算 **零改动**。

---

## 3. R4 双价换算与套税逻辑（报价单层）

在 `quote.js computeQuoteTotals(lineItems, options)` **附加**输出 `dualTotals`（不破坏现有 `rows/subtotals/indicative`）：

**输入 options 增**：`dualCurrency:true`、`ivaMxn`(默认0)、`ivaUsd`(默认0.16)、`baseCurrency:"MXN"`、`exchangeRates`。

**算法**：
```
mxnBase = Σ 计价行折算到 MXN 的税前金额        // USD 原生行 × rate(USD→MXN)；AT COST 不计
fx      = rate(USD→MXN)  (来自 exchangeRates.pairs；缺失→usd 不可用)
mxnShown = round(mxnBase × (1 + ivaMxn))
usdShown = fx ? round(mxnBase / fx × (1 + ivaUsd)) : null
dualTotals = {
  mxn: { base: mxnBase, iva: ivaMxn, shown: mxnShown },
  usd: { iva: ivaUsd, shown: usdShown },
  fxRate: fx, fxAsOf: exchangeRates.asOfDate
}
```
- 四组合（ivaMxn∈{0,.16} × ivaUsd∈{0,.16}）均成立；汇率缺失时 `usd.shown=null`，PDF 显示「—（FX unavailable）」。
- `assembleQuoteView`（`server.js:1450`）传 `dualCurrency` + 两 iva（来自 quote 设置或表单），把 `dualTotals` 带进 `quoteView`。
- `workbench-quote.ejs`（Step 5）加两个 IVA 开关；Step 2 样张用默认值即可。

> 与 `indicative` 的关系：`indicative` 是「单值参考折算」，`dualTotals` 是「双价正式展示」。本批**保留** `indicative`（不回归），新增 `dualTotals` 并在 PDF 用后者做主展示块。

---

## 4. R5 路线信息进 PDF（透出字段）

- `assembleQuoteView`：用 `formData.pullInputs.destinationId` + 默认 origin（`inland.origins[0].id`=manzanillo）在 `inland.routeCache` 找 `targetType="destination"` 条目，组 `route`：
```jsonc
"route": { "originName":"Manzanillo", "destName":"Apodaca",
  "distanceKm":1050, "durationMin":720, "viaCities":["..."], "hasFerry":false, "stale":false }
```
无缓存 → `route=null`。
- `quote-document.ejs`：在 `MEXICO LOCAL CHARGES` 的 TRANSPORTATION 段下（或表后）加一行 route meta：
  `RUTA / ROUTE: Manzanillo → Apodaca · ~1,050 km · ≈12 h · vía: …`，`hasFerry` 时加「con ferry / 含轮渡」标记；`route=null` 时该行显示「—」。
- 文案：`quote-document` 是独立 EN+中文体系（非 app i18n），按其约定写 EN+中文（`distanceKm`/`durationMin` 纯数字无需翻译）。

---

## 5. Step 2 报价单样张（确认 spec 后最先做）

- 路径：`buildQuoteFormData`(默认行) → `pullCalculatorValues`(注入三计算器+真实 `shippingData`) → `assembleQuoteView` → `renderQuoteHtml/renderQuotePdf`。
- 目的地选 **Apodaca**（多供应商 + 有短驳 `$4800/$7800` + 有路线缓存）。
- 数据源：本地读 `data/shipping-lines.json`（或 store 读生产，**只读不写**）。
- Puppeteer/Chromium 不可用 → 先出 `renderQuoteHtml` 的 **HTML 样张**，注明 PDF 待环境补齐。
- 产出：`docs/specs/sample-quote-apodaca.{pdf,html}`。**不改 quote 业务逻辑，仅调用产出。**

---

## 6. 测试清单（逐步）

- **Step 2**：脚本跑通出 HTML/PDF；人工核对中文不乱码、双 logo、TRANSPORTATION 段、双价块。
- **Step 3**：`assembleQuoteView` route 查找单测（命中/未命中/La Paz hasFerry）；PDF 该行渲染。
- **Step 4**：`parseSencilloFull`（两档/单档/空/脏值）单测；`computeInlandCalculator` 含/不含短驳、多档取最高、`burreo=null` 安全；CSV 清洗后 `burreo` 计数与 source 对账（期望 131/248 有值）。
- **Step 5**：`computeQuoteTotals` dualTotals 四组合数值 + 汇率缺失降级单测。
- **Step 6**：origins CRUD（add/save/delete + 删除带费率拒绝）；引入清关港口名单；**Manzanillo 现有费率与报价回归不变**。
- **全局回归**：`npm test`（含放单/清关 smoke 全绿）；`node scripts/quote-test.js`。

---

## 7. Blast radius（热文件）

| 文件 | 改动 | 受影响面 |
|---|---|---|
| `src/lib/inland-csv.js` | 短驳解析 | seed 输入；不影响运行时直到重新 seed |
| `src/lib/store.js` | rateEntry.burreo / origin.enabled+note 规范化 | `modules.inland` 数据形状（附加，向后兼容） |
| `src/lib/calculate.js` | `computeInlandCalculator` 增 `includeBurreo` | `/workbench/inland`、报价取数；**默认 false → 不回归** |
| `src/lib/quote.js` | `computeQuoteTotals` 增 `dualTotals` | 报价单合计（附加） |
| `views/quote-document.ejs` | route meta 行 + 双价块 | 对客 PDF 版式 |
| `server.js` | `assembleQuoteView` 带 route+dualTotals；origins admin 路由 | `/workbench/quote`、`/workbench/quote/pdf`、`/admin/inland/*` |
| `public/inland-map.js` + `workbench-inland.ejs` | 短驳勾选 | 陆运即时面板 |
| `views/admin-inland.ejs` | 短驳两列 + 出发港管理 | 后台 |
| `i18n.js` | 短驳/出发港 zh/es 串 | UI 文案 |
| `docs/BRAND_NOTES.md` | K5 NOTE 口径 | 对客文档口径 |
| **生产 `modules.inland` 数据** | Step 4 重新 seed（短驳） | **先备份 `20260614_prod_inland_backup_pre_burreo.json`，--replace 灌前打印 diff** |

**不触碰**：放单/清关计算逻辑、`data/users.json`、`.git` 配置、密钥；不 force push、不直推 main。

---

## 8. 执行顺序（确认口径后）

Step 2 样张 → Step 3 PDF 路线 → Step 4 短驳（先备份 prod 再 seed）→ Step 5 双价双IVA → Step 6 多港后台口子 → 收尾(Task Summary + Post-task routing + LESSONS + PR)。任一步验收不符 → 停下报告，不猜不续。

---

> **当前停在此（Step 1 完成）。请确认 §0 的 K1–K7 口径（尤其 K5 NOTE 改写、K6 借港口坐标、K7 双价只进 PDF）。确认后我从 Step 2 开始。**
