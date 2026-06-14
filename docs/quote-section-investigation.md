# 报价 / Cotización Section — 深度调查 + 实现方案（投资级清单）

> 类型：调查 + 方案 + 费用字典 CSV。**本轮未写任何报价功能 app 业务代码**（只创建本报告 md 与 `docs/reference/fee-codes.csv`）。
> 已锁定决策 D1（混合数据源）/ D2（HTML→PDF via Puppeteer）/ D3（报价单中英对照、与 app i18n 解耦）按原样落实，未再做选型。
> 日期：2026-06-13。权威版式参考：[`docs/reference/quote-template-spec.md`](reference/quote-template-spec.md) + 原始 `报价.pdf`（`QUOTATION NUMBER ELCMEX-SI-004E`）。

---

## 0. 现状速览（证据）

| 维度 | 事实 | 证据 |
|---|---|---|
| 框架 | Node + Express 5 + EJS，会话 express-session，`pg`（Postgres 可选） | `package.json` deps |
| 模块注册表 | `BUSINESS_MODULES = [handover, customs, inland]`，全部 `implemented:true`，`DEFAULT_MODULE_KEY=handover` | `src/lib/modules.js:1-16` |
| 语言 | `SUPPORTED_LANGUAGES = [zh, es]`，默认 `zh`（app UI 中/西） | `src/lib/i18n.js:3-8` |
| 存储 | 单一 `app_state(key,payload jsonb)`，键 `shipping-data`/`users`；JSON fallback 写 `data/shipping-lines.json` | `src/lib/db.js:120-144`、`src/lib/store.js:2068-2124` |
| 数据形状 | `{exchangeRates, generatedFrom, modules:{handover,customs,inland}}` | `data/shipping-lines.json`（1.9MB）|
| **`quote_snapshots` 表** | **已在 migration 里定义但全仓库零引用（未使用）**：列 `id, module_key, business_nature, input_payload jsonb, result_payload jsonb, created_at` | `src/lib/db.js:94-103`，grep 无 insert/select |
| `audit_logs` 表 | 已定义但同样未被写入 | `src/lib/db.js:83-93` |
| 导航 | `module-rail.ejs` 直接遍历 `modules`（来自 `buildModuleLinks`→`getModulePresentations`），**新增模块会自动出现在导航** | `views/partials/module-rail.ejs`、`src/server.js:762-769` |
| FX | `exchangeRates.pairs` 双向 USD↔MXN（Frankfurter），随 `loadShippingData` 懒刷新 | `data/shipping-lines.json`、`src/server.js:737-752` |
| PDF 依赖 | **未安装** puppeteer/chromium/playwright/weasyprint | `node_modules` 检索 |
| 品牌资产 | `public/` 仅 `dewell-logo.svg` + `favicon.svg`。**缺 Express Line / IATA / C-TPAT logo** | `ls public/` |
| 打印样式 | `public/styles.css` **无** `@media print` / `@page` | grep |
| 部署 | Railway 读 `package.json`→`npm start`；**无** railway.json/nixpacks.toml/Procfile/Dockerfile/.nvmrc；长驻 Express（非 serverless） | `README.md:127-142`、`docs/env-setup.md:102` |

> 结论性约束：(a) 新模块只要进 `BUSINESS_MODULES` 即自动获得导航 + workbench 路由骨架；(b) `normalizeModules()` 对未显式处理的模块走 `normalizeGenericModuleData`，报价需要自定义 normalizer（见 B）；(c) Railway 上 Chromium 安装与 CJK 字体是本功能最大风险点（见 D）。

---

## A. 新增第 4 个 section 的逐文件最小清单（diff 级）

### A.1 必改（现有文件）

1. **`src/lib/modules.js`** — 注册模块。
   - 在 `BUSINESS_MODULES` 数组追加 `{ key: "quote", implemented: true }`（放在 inland 之后，保证导航顺序）。
   - 影响：`getModulePresentations` 自动包含 quote → 导航 rail 自动出现「报价」按钮；`GET /workbench/:moduleKey` 的 `getBusinessModule("quote")` 不再 404。

2. **`src/lib/i18n.js`** — 模块展示文案 + 报价 UI 串（**app 中/西**，与 PDF 文档解耦）。
   - 在 `MESSAGES.zh.modules` 与 `MESSAGES.es.modules` 各加 `quote: { title, subtitle, description, state, placeholderTitle, placeholderDescription }`（`getModulePresentation` 读这 6 个 key，见 `i18n.js:1140-1148`）。
   - 追加 `quote.*` UI 串（构建器界面：字段标签、按钮、表头、行项操作、校验提示）zh+es。
   - **不要**把报价单 PDF 的 EN+中文固定文案塞进这里（D3：PDF 文案另存于 `src/lib/quote.js` 常量）。

3. **`src/lib/store.js`** — 自定义 normalizer + 持久化。
   - 在 `normalizeModules()`（`store.js:2024-2058`）handover/customs/inland 之后，显式加 `normalizedModules.quote = normalizeQuoteModuleData(sourceModules.quote || {})`，**避免落到 generic**。
   - 新增 `normalizeQuoteModuleData(moduleData)`：规范化 `settings`（含 `defaultQuoteCurrency`、`lastQuoteSeq`、`templateVersion`）、`templateRows`（11 行模板，见 B.2）、`drafts[]`（已存报价草稿）、`notes`（中英固定条款，可覆盖）。
   - 复用现有 `parseNumber/slugifyId/normalizeCurrencyCode`；新增 `normalizeQuoteDraft` / `normalizeQuoteLineItem`。
   - `module.exports` 视需要导出 `getQuoteDrafts/saveQuoteDraft`（也可直接走 `getShippingData/saveShippingData` 的 `modules.quote.drafts`）。

4. **`src/server.js`** — 路由 + 渲染分发。
   - `renderWorkbench()`（`server.js:1286-1294`）switch 增加 `if (payload.moduleKey === "quote") return renderQuoteWorkbench(...)`。
   - 新增 `renderQuoteWorkbench(req,res,payload)`（仿 `renderInlandWorkbench` `server.js:1266-1284`）。
   - 新增 `buildDefaultQuoteFormData` / `buildQuoteFormData`（仿 inland 的 `server.js:1166-1188`）。
   - `GET /workbench/quote` 分支：在 `app.get("/workbench/:moduleKey")`（`server.js:1456`）内，于 inland 分支后加 quote 分支（载入 quote 模块数据 + 草稿）。
   - 新增 `POST /workbench/quote`（重算总额 / 拉计算器取值 / 存草稿，仿 `server.js:1652` inland POST）。
   - 新增 `POST /workbench/quote/pdf`（或 `GET /workbench/quote/:id/pdf`）：调 `quote-pdf.js` 生成并 `res.type("application/pdf").send(buffer)`。
   - 可选 admin：`GET/POST /admin/quote/settings`（仿 `server.js:1993-2057`）编辑固定价/编号前缀/模板。

5. **`package.json`** — 依赖与脚本。
   - `dependencies` 加 `puppeteer`（推荐，见 D；或 `puppeteer-core` 方案）。
   - 可加 `"engines": { "node": ">=20" }` 固定 Railway Node。
   - 可加 `"smoke"` 覆盖（在 `scripts/smoke-test.js` 增加 quote 路由 + PDF 字节断言）。

### A.2 新建文件

| 文件 | 职责 |
|---|---|
| `src/lib/quote.js` | 报价领域逻辑：`QUOTE_TEMPLATE_ROWS`（11 行，含 `category/code/conceptEn/conceptZh/unit/unitPrice/currency/remark/isAtCost/source/calcRef`）、`QUOTE_NOTES`（中英 5 条固定条款）、`generateQuoteNumber(seq)`、`mapRowToCalculator()`、`buildQuoteFromCalculators()`（D1 合并取数） |
| `src/lib/quote-pdf.js` | Puppeteer：`renderQuoteHtml(quote, deps)`（EJS→HTML）+ `htmlToPdf(html)`（`page.pdf()`），浏览器单例 launch/复用 |
| `views/workbench-quote.ejs` | 构建器 UI：GENERAL DATA 表单 + 可编辑行项表 + 「生成 PDF」按钮（仿 `workbench-inland.ejs`） |
| `views/quote-document.ejs` | **独立 A4 中英对照报价单**（Puppeteer 渲染目标）：页眉双 logo、GENERAL DATA、MEXICO LOCAL CHARGES 表、NOTES、页脚 IATA/C-TPAT。内联 CSS + `@page` + `@font-face` |
| `public/quote.js`（可选） | 行项增删、币种、`TOTAL=UNIT×UNIT PRICE` 实时计算、AT COST 行只读 |
| `public/express-line-logo.svg`、`public/iata-logo.svg`、`public/ctpat-logo.svg` | **缺失品牌资产**（见 D.4 待补清单） |
| `public/fonts/NotoSans-Regular.woff2`、`NotoSans-Bold.woff2`、`NotoSansSC-Regular.woff2`、`NotoSansSC-Bold.woff2` | PDF 内嵌字体（防 CJK 乱码，见 D.3） |
| `views/admin-quote.ejs`（可选） | 报价默认值/固定价/编号前缀后台编辑 |
| `nixpacks.toml`（新建，见 D） | Railway 安装 Chromium 运行库 + CJK 字体 |
| `docs/specs/20260613_quote_section_IMPLEMENTATION_SPEC.md` | **实施前必写的 spec**（项目硬规则要求，见 §7） |

### A.3 无需改动
- `views/partials/module-rail.ejs` / `header.ejs` / `footer.ejs`：导航自动渲染，无需手改。
- `src/lib/calculate.js`：报价复用其导出函数（`computeHandoverCalculator`/`computeCustomsCalculator`/`computeInlandCalculator`），**只读**。

---

## B. 报价数据模型（头部 + 行项 + 分组 + 编号 + 草稿持久化）

### B.1 顶层（存于 `modules.quote`，复用现有 JSON↔DB 通道）
```jsonc
"quote": {
  "settings": {
    "defaultQuoteCurrency": "MXN",
    "quoteNumberPrefix": "ELCMEX-SI-",   // 待决：SI / 末位 E 含义（§E 待决问题）
    "quoteNumberSuffix": "E",
    "lastQuoteSeq": 4,                    // 自增计数，ELCMEX-SI-004E → 4
    "templateVersion": 1
  },
  "templateRows": [ /* 见 B.2，11 行受控模板 */ ],
  "notes": [ /* 见 B.4，中英 5 条 */ ],
  "drafts": [ /* QuoteDraft[]，见 B.3 */ ]
}
```

### B.2 行项（line item）形状
```jsonc
{
  "id": "li-…",
  "code": "DESTINATION HANDLING FEE | 1000",   // 受控词表来自 docs/reference/fee-codes.csv（选码自动带英文说明）
  "category": "SHIPPING LINE",                 // 固定 5 组之一
  "conceptEn": "DESTINATION HANDLING FEE",
  "conceptZh": "换单服务费",                    // CONCEPT 单元格 = 英文 + 中文双行
  "unit": 1,                                   // 数量；AT COST 行可为 null
  "unitPrice": 1000,                           // 数字 或 字符串 "AT COST"
  "currency": "MXN",                           // MXN | USD
  "remark": "per container",
  "isAtCost": false,
  "source": "manual",                          // calc | manual | atcost
  "calcRef": null                              // source=calc 时 {module:"customs", field:"terminalStorage"}
}
```
- `TOTAL = unit × unitPrice`；`isAtCost`（或 `unitPrice==="AT COST"`）行不计算、原样显示。
- 分组固定顺序：`SHIPPING LINE → PORT FEES → CUSTOMS CLEARANCE → TRANSPORTATION → DUTY`。

### B.3 报价草稿（QuoteDraft）
```jsonc
{
  "id": "q-…",
  "number": "ELCMEX-SI-004E",
  "date": "2026-01-19",
  "header": {
    "operation": "IMPORT",      // IMPORT | EXPORT
    "department": "OCEAN",      // OCEAN | AIR
    "incoterm": "CIF",
    "pol": "CHINA",
    "pod": "MANZANILLO",
    "commodity": "Equipment and raw materials / General container cargo",
    "cargoType": "FCL",         // FCL | LCL
    "delivery": "Lote 18, Avenida Aero Industrial, …, Apodaca, N.L. 66600"
  },
  "lineItems": [ /* B.2[] */ ],
  "createdAt": "…", "updatedAt": "…"
}
```

### B.4 NOTES（固定条款，中英对照，存 `modules.quote.notes`，可覆盖）
对应 spec §4 五条：① 价格不含税，开票加 16% VAT ② 非我方原因费用按实结算 ③ 运费不含货物保险，需则按保额 0.25% + 16% VAT ④ 汇率差按开票日汇率结算 ⑤ 报价有效期 90 天。每条 `{ en, zh }`。

### B.5 编号生成
- 形态 `ELCMEX-SI-004E`：建议 `${prefix}${String(lastQuoteSeq+1).padStart(3,"0")}${suffix}`，生成时自增 `settings.lastQuoteSeq` 并持久化。
- `SI` 与末位 `E` 的语义未知 → 列入待决（让 Jose 确认是否随 operation/部门变化）。

### B.6 持久化路线（建议）
| 方案 | 用途 | 评价 |
|---|---|---|
| **A（推荐）`modules.quote`** 内 `templateRows/notes/settings/drafts` | 模板默认值 + 编辑中草稿 | 与 handover/customs/inland 完全同构，免费获得 JSON↔DB fallback、normalize、admin 写回；**首选** |
| B 复用 `quote_snapshots` 表（当前未用） | 生成 PDF 时落一条不可变快照（`input_payload`=draft, `result_payload`=算定行项），做历史/审计 | **仅 DB 模式可用**（无 JSON fallback）；建议在 DB 启用时附加写入，JSON 模式下跳过；需在 `db.js` 加 `insertQuoteSnapshot/listQuoteSnapshots`（表已存在，零迁移） |
| C 新建独立 `data/quotes.json` / 新 `app_state` 键 | 草稿量大时隔离 | 增加一套读写路径，非必要不引入 |

> 建议：**A 为主**（模板/默认/草稿），**B 为可选审计**（生成时落快照，DB-only）。

---

## C. D1 落实 — 行项 → 计算器 / 手填 / AT COST 逐条映射

计算器输出形状（证据）：
- **handover** `computeHandoverCalculator` 返回 `{ localCharges, guarantee, demurrage(三个 category), pretaxTotal, afterTaxTotal, total, quoteCurrency, … }`（`calculate.js:585-614`）。
- **customs** `computeCustomsCalculator` 返回 `{ terminalFixed, terminalStorage, yardDropoff, yardCustoms(四个 category), pretax/afterTax/total, … }`（`calculate.js:952-994`）。
- **inland** `computeInlandCalculator` 返回 `{ maxRate, maxProvider, serviceType, quantity, pretaxTotal, afterTaxTotal, total, … }`（`calculate.js:1079-1101`）。
- 每个 category = `finalizeCategory` → `{ items[], pretaxTotal, afterTaxTotal, displayTotal }`，每个 item = `buildDisplayItem` → `{ concept, displayAmount, pretaxAmount, afterTaxAmount, quoteCurrency, … }`（`calculate.js:187-282`）。

| # | 模板行（EN / 中） | 组 | 模板默认 | **分类** | 取数来源 / 字段 |
|---|---|---|---|---|---|
| 1 | DELIVERY ORDER FEE / 换单费 | SHIPPING LINE | AT COST · MXN | **AT COST** | 船公司 D/O 实报实销；可选关联 handover `localCharges` 中 D/O 项（`fee-codes.csv: D/O FEE`） |
| 2 | DESTINATION HANDLING FEE / 换单服务费 | SHIPPING LINE | 1000 · MXN | **手填**（默认 1000） | 可选关联 handover `localCharges` 某项 `displayAmount` |
| 3 | DESTINATION CONTAINER DETENTION / 目的港集装箱超期费 | SHIPPING LINE | AT COST · USD | **计算器可算 / 否则 AT COST** | handover `demurrage` category（`result.demurrage.displayTotal`），需 `demurrageDays`；天数未知时 AT COST |
| 4 | DESTINATION PORT CHARGES / 目的港码头操作费 | PORT FEES | AT COST · MXN | **计算器可算 / 否则 AT COST** | customs `terminalFixed.displayTotal`（`calcRef:{customs,terminalFixed}`） |
| 5 | DESTINATION YARD STORAGE FEE / 目的港堆存费 | PORT FEES | AT COST · MXN | **计算器可算 / 否则 AT COST** | customs `terminalStorage.displayTotal`，需 `storageDays`（按箱型阶梯） |
| 6 | IMPORT CUSTOMS CLEARANCE / 进口清关服务费 | CUSTOMS CLEARANCE | 6000 · MXN | **手填**（默认 6000） | 无对应计算器字段（customs 模块算的是码头/堆场/落柜，非清关服务费）→ 手填 |
| 7 | SINGLE / 单拖 | TRANSPORTATION | 68000 · MXN | **计算器可算 / 否则手填** | inland `computeInlandCalculator(serviceType="sencillo").maxRate`（来源 tarifario CSV 的 `SENCILLO` 列） |
| 8 | FULL / 双拖 | TRANSPORTATION | 96000 · MXN | **计算器可算 / 否则手填** | inland `serviceType="full".maxRate`（tarifario `FULL` 列） |
| 9 | DESTINATION OVER WEIGHT CHARGE / 超重费 | TRANSPORTATION | 5000 · MXN | **手填** | tarifario 有 `SOBRE PESO` 列但 inland 计算器未输出 → 手填（数据可见、计算器未暴露） |
| 10 | DESTINATION DETENTION / 压车费 | TRANSPORTATION | 6000 · MXN | **手填** | tarifario `ESTADIAS/PERNOCTA` 有，但计算器未输出 → 手填 |
| 11 | PEDIMENTO / 进口税金 | DUTY | "Payment to the customs broker/PECE" | **AT COST**（无单价） | 税金代付，透传文字，不计算 |

**合并数据流（取数 + 手填）**
```
GET /workbench/quote
  └─ 载入 modules.quote.templateRows 作为初始行项（含默认固定价 / AT COST 标记）
POST /workbench/quote（用户填 General Data + 共享输入：shippingLineId, port/terminal, destinationId, 箱量, demurrageDays, storageDays）
  ├─ 对 source=calc 行：按 calcRef 调对应计算器（复用 calculate.js），取 category.displayTotal/maxRate → 回填 unitPrice、currency
  │     · #3 handover.demurrage  · #4 customs.terminalFixed  · #5 customs.terminalStorage  · #7/#8 inland.sencillo/full
  ├─ 用户可在表格中手动覆盖任意行 → 该行 source 置 manual（覆盖计算值）
  ├─ AT COST 行（#1/#11）不计算，原样显示
  └─ TOTAL=unit×unitPrice 逐行；分组小计；混合币种总额见 §E 待决
POST /workbench/quote/pdf → quote-document.ejs → Puppeteer → A4 PDF
```

---

## D. D2 落实 — Puppeteer 在本项目 + Railway 的接法

### D.1 引擎选择结论（不再比选，给依据）
- **不要用 `@sparticuz/chromium`**：它是为 AWS Lambda 等 serverless（50MB 解包上限、只读 FS）裁剪的 Chromium。本项目 Railway 是**长驻容器**（`docs/env-setup.md:102` 明确「长期运行的 Express 服务，不是 serverless function」），无该约束，引入它只增脆弱性。
- **推荐：full `puppeteer`（自带 Chromium）+ `nixpacks.toml` 补运行库与字体**。本地 `npm i` 即下载匹配 Chromium，开箱即用；Railway 用 nixpacks 补 Chromium 依赖的共享库 + CJK 字体即可。moving parts 最少、本地/线上一致。
- **备选：`puppeteer-core` + Nix 提供的 chromium**（`nixpacks.toml` 装 `chromium`，`PUPPETEER_EXECUTABLE_PATH` 指向它）。镜像更小、无 postinstall 下载，但本地需另指 Chrome 路径。镜像体积/冷启动敏感时再换。

### D.2 `page.pdf()` 参数
```js
await page.pdf({
  format: "A4",
  printBackground: true,        // 渲染底色/表头色块
  preferCSSPageSize: true,      // 用 quote-document.ejs 里的 @page
  margin: { top: "12mm", right: "10mm", bottom: "14mm", left: "10mm" },
  displayHeaderFooter: false    // 页眉/页脚直接写进 HTML（Puppeteer header/footer 模板不吃外部 CSS、字号默认极小、放 logo 麻烦）
});
```
- 浏览器生命周期：**单例 launch + 跨请求复用**（懒初始化），容器内加 `args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]`。低频内部工具也可每请求 launch（更简单、稍慢）。
- 渲染：`page.setContent(html,{waitUntil:"networkidle0"})`；logo/字体走内联 data-URI 或本地静态，避免外网依赖。

### D.3 中英文字体（防乱码）方案
- **首选：HTML 内 `@font-face` 内嵌 wo, f2**，把 Noto Sans（拉丁）+ Noto Sans SC（中文）打进仓库（`public/fonts/*.woff2`），`quote-document.ejs` 里 `@font-face` 引用 + `font-family:"Noto Sans","Noto Sans SC",sans-serif`。这样 PDF 渲染**完全不依赖宿主机字体**，本地/Railway 像素一致，从根上消除 CJK 豆腐块。
- **兜底：** `nixpacks.toml` 同时装 `noto-fonts` + `noto-fonts-cjk`，当系统字体回退时仍有中文。
- 注意中文标点/全角与英文混排时设置合适 `line-height`，CONCEPT 双行单元格用 `<div>EN</div><div lang="zh">中</div>`。

`nixpacks.toml` 草案（A 方案，补 Chromium 运行库 + 字体）：
```toml
[phases.setup]
nixPkgs = ["...", "noto-fonts", "noto-fonts-cjk"]
# full puppeteer 自带 chromium，仍需其依赖的共享库：
aptPkgs = ["libnss3","libatk1.0-0","libatk-bridge2.0-0","libcups2","libdrm2","libxkbcommon0","libxcomposite1","libxdamage1","libxfixes3","libxrandr2","libgbm1","libasound2","libpango-1.0-0","libcairo2","fonts-noto-cjk"]
```
> 线上 Chromium 启动是本功能**最高风险**，需在 Railway 实测（见 §E 风险）。

### D.4 缺失品牌资产 / 可复用打印资产清单
- 已有：`public/dewell-logo.svg`（De Well）、`public/favicon.svg`。
- **缺，必须补**（建议向量 SVG，或从 `报价.pdf` 提取高清 PNG）：
  1. `public/express-line-logo.svg` — Express Line Corporation（含 "Service Guaranteed" 副标条，页眉左）。
  2. `public/iata-logo.svg` — IATA（页脚）。
  3. `public/ctpat-logo.svg` — C-TPAT（页脚）。
- 无现成打印 CSS（`styles.css` 无 `@media print`）→ `quote-document.ejs` 自带独立内联打印样式。

### D.5 无浏览器降级备选（仅记录，不实现）
- **WeasyPrint**（Python）：项目已用 `python3`（`templates:excel`，`package.json:16`）。`pip install weasyprint`，依赖 Pango/cairo/gdk-pixbuf 系统库。渲染同一份 HTML/CSS→PDF，无需 headless 浏览器；静态表格/中文（配 Noto CJK）足够；弱在复杂 JS/Flex/Grid。作为 Chromium 在 Railway 装不通时的退路记录，本轮不实现。

---

## E. 完整实现步骤（按依赖排序）+ 风险 + 待决

### E.1 步骤（依赖序）
0. **写 spec**：`docs/specs/20260613_quote_section_IMPLEMENTATION_SPEC.md`（项目硬规则要求，§7）。**Jose 批准本报告后再开工。**
1. **资产先行**：补 `express-line-logo` / `iata-logo` / `ctpat-logo` + Noto woff2 字体 → `public/`、`public/fonts/`。
2. **注册模块**：`modules.js` 加 `quote` + `i18n.js` 加 `modules.quote.*`（zh/es）→ 导航/路由骨架到位（可先看到占位页）。
3. **数据层**：`store.js` 加 `normalizeQuoteModuleData` + 在 `normalizeModules` 显式接入 + 草稿读写。
4. **领域逻辑**：`src/lib/quote.js`（模板 11 行、中英 NOTES、编号、D1 取数映射）。
5. **构建器**：`views/workbench-quote.ejs` + `public/quote.js` + `server.js` 的 `GET/POST /workbench/quote` + 渲染分发。
6. **报价单文档**：`views/quote-document.ejs`（A4 中英 + `@page` + `@font-face` + 双 logo 页眉 + IATA/C-TPAT 页脚）。
7. **PDF 管道**：`src/lib/quote-pdf.js`（puppeteer 单例 + `page.pdf()`）+ `POST /workbench/quote/pdf` + `package.json` 加 `puppeteer` + 新建 `nixpacks.toml`。
8. **（可选）**：`admin-quote.ejs` 编辑默认价/编号；DB 模式下 `quote_snapshots` 落快照（`db.js` 加 helper）。
9. **验证**：扩 `scripts/smoke-test.js`（quote 路由 200 + PDF 字节 `%PDF` 头）；本地浏览器 + 真出一份 PDF（中文不乱码）；**Railway 部署后实测 Chromium 启动 + 中文渲染**。

### E.2 风险
- **R1（高）Railway Chromium**：Nixpacks 基镜像缺共享库 / CJK 字体导致 launch 失败或中文豆腐。缓解：D.3 内嵌字体 + D 的 `nixpacks.toml`，**部署后必测**。
- **R2（中）镜像体积/冷启动**：full puppeteer + Chromium ~150–300MB；首次冷启动慢。缓解：浏览器单例复用；体积敏感转 puppeteer-core+Nix chromium。
- **R3（中）混合币种总额**：模板 #3 为 USD、其余 MXN。逐行 `TOTAL` 不冲突，但「合计」跨币种需用 `exchangeRates.pairs`（USD↔MXN）折算或分币种小计 → 见待决 Q4。
- **R4（中）热文件 blast radius**：`server.js`/`store.js`/`i18n.js` 均为热文件（`docs/AI_AGENT_PROJECT_RULES.md` Hot File Policy），改动须在 Task Summary 列受影响页面/路由/数据/测试，并跑回归（handover/customs/inland workbench 不回归）。
- **R5（中）受控词表准确度**：`fee-codes.csv` 系低清晰度截图 OCR，含 ~28 条低置信（见 F）。作为「选码自动带说明」前应让 Jose 校一遍低置信清单。
- **R6（低）权限**：当前登录关闭、全员可访问（`AI_AGENT_PROJECT_RULES.md` Auth），报价能导出对外文档，上线前应纳入鉴权（auth 改动需 spec-first）。

### E.3 待决问题（需 Jose / 源码确认）
- **Q1** 报价编号 `ELCMEX-SI-004E`：`SI`、末位 `E` 含义？是否随 operation（IMPORT/EXPORT）、OCEAN/AIR 变化？
- **Q2** #1 DELIVERY ORDER FEE / #2 HANDLING FEE：是否要对接 handover `localCharges`，还是永远模板固定值 / AT COST？
- **Q3** 当前线上是 JSON 还是 Postgres 存储模式（`AI_AGENT_PROJECT_RULES.md` 标注「unresolved」）？决定 `quote_snapshots` 审计是否可用。
- **Q4** 跨币种合计：分币种小计 vs 按开票日汇率折算为单一币种？
- **Q5** Logo 矢量源：谁提供？可否从 `报价.pdf` 提取足够清晰的 Express Line / IATA / C-TPAT 图？
- **Q6** EXPORT / AIR 变体是否改变行项集合与默认价？模板现为 IMPORT/OCEAN。

---

## F. `docs/reference/fee-codes.csv` 产出说明

- **总行数：345**（不含表头），列 `code,description`；无重复 code、无空描述、格式校验通过。
- 含任务点名的 CargoWise 家族：`CWAFEE` / `D-CWAF`（DESTINATION）/ `DOM-CWAF`（DOMESTIC）/ `O-CWAF`（ORIGIN）。
- 来源：`fee.docx` 内嵌 8 张 PNG（419–489 px 宽、无文本层），逐张升采样到 1080px 视觉读出；对 3 处易混区域（image1 底部、image2 中部、image7 底部）再做 3× 高清裁切复核。
- **高清复核已修正**（现高置信）：`CRF`=Container Releasing Fee（非 Damage）、`CTN DMG`=Container Damage Fee、`DCTF`=Destination Clean Truck Fee、`DCTRF`=Destination Customs Transfer Fee、`D-CWAF`=DESTINATION CARGOWISE AUTOMATION FEE、`TLX`=TELEX Release、`TRSL`=Trans Loading。
- 页边界去重：`ULD` / `UNSTK`（image7 尾与 image8 首重复）已各保留 1 条。

### F.1 低置信码清单（建议人工核对约 28 条）
> 原件截图分辨率有限，以下条目的 code 或 description 存在 O↔0 / I↔l / 连字符空格 / 截断 / 拼写 等不确定；CSV 已按最佳判读写入，使用前请对照原图复核。

| code | 写入 description | 不确定点 |
|---|---|---|
| `BAC` | BURNASIA FREIGHT | 描述拼写（疑 "BUR N ASIA"）|
| `BCOFEE` | BCO ISA MANAGEMENT FEE | "ISA" 存疑 |
| `CARP` | Carp fee | 描述存疑 |
| `CCLR-VAT3` | Import Customs Clearance (VAT) | code 后缀 `VAT3` 与描述是否带 3 |
| `CENG` | Censoring Charge | 描述存疑 |
| `DCART-VAT` | Delivery Cartage/Drayage (VAT9%) | 原图 code 截断为 `DCART-V…`，已重建 |
| `DOFE-NON` | DUTY OUTLAY FEE - external | code/描述与 `DOFE` 重复，存疑 |
| `DRESTIG` | Destination Restuffing | code 拼写存疑 |
| `DRPOS` | Destination Chassis Repositioning | code 存疑 |
| `ECCLR-VAT3` | Export Customs Clearance (VAT1%) | "(VAT1%)" 存疑 |
| `FISHWILD` | Fish and Wild Lift | 描述存疑（疑 Wildlife）|
| `GBP` | General Bunk Floating | 描述存疑（疑 Bunker）|
| `MCART-VAT` | Delivery Cartage/Drayage (VAT9%) | 原图 code 截断 `MCART-V…` |
| `MDJO FEE` | Delivery Order | code 存疑（疑 `MDO FEE`）|
| `MDESTN` | Destination Storage Fee | code 存疑 |
| `MECCLR-VAT` | Export Customs Clearance (VAT) | 原图 code 截断 |
| `MENSF-VAT` | Import Service Fee (VAT) | code/描述存疑 |
| `MIN` | Mining Fees Error | 描述存疑 |
| `MPP` | Mechandise Processing Fee | 原文拼写 "Mechandise"（应为 Merchandise）|
| `MSC` | MSK Chassis | 描述存疑 |
| `MSRT` | API- MSRATING | 描述存疑 |
| `OCART-VAT` | Origin Cartage (VAT6%) | 原图 code 截断 `OCART-V…` |
| `OHDL-NON` | Origin Handling fee | code/描述与 `OHDL` 重复，存疑 |
| `ORELD` | Origin Restuffing | code 存疑 |
| `PRM-DCBU` | Promotion Service Fee-ICBU | code(`DCBU`)与描述(`ICBU`)不一致 |
| `TEC-ICBU` | Techenical Service fee-ICBU | 原文拼写 "Techenical"（应为 Technical）|
| `WHCOMCR` | Warehouse other Fee | code/描述存疑（描述与 `WHOTHERS` 同）|
| `YSPB` | Yangshan PB | 原图作 "Yanqshan"，已订正为 Yangshan |

> 整体说明：CSV 为低清截图的尽力转写，**code 优先保真**（已对最易混区复核），描述可能含个别小误；上线作为受控词表前建议 Jose 过一遍上表。

---

## 7. 项目规则与约束（影响本功能的硬规则）

- **Spec-first（必须）**：报价属「large / cross-module / data-affecting / user-facing」→ 实施前写 `docs/specs/20260613_quote_section_IMPLEMENTATION_SPEC.md`（`AI_AGENT_PROJECT_RULES.md` Spec-First Policy）。
- **热文件**：`src/server.js`、`src/lib/store.js`、`public/styles.css`、`data/shipping-lines.json` 等为热文件；改动 Task Summary 必带 blast radius（受影响页面/路由/数据/auth/flags/tests/回归项）。
- **读写边界**：`docs/` 放 plan/spec/review，强制 `YYYYMMDD_` 前缀；项目事实进 repo-local docs；不得提交密钥/真实 DB URL/token；`data/users.json` 视为敏感。
- **数据源规则**：JSON (`data/shipping-lines.json`) 与 Supabase Postgres（schema `expressline`）双轨，`STORAGE_DRIVER` 控制；Excel 仅模板工具、非运行时数据源；不要把 Railway 绑定文件等纳入提交。
- **业务不回归**：UI 改动须保持 handover/customs/inland 费用计算不变（`product-uiux-audit.md`）。
- **Git**：禁 force push、不直接改 `main`（成熟/生产/共享走 PR/branch）。
- **命名**：模块内部键用英文（`quote`），与 handover/customs/inland 一致；用户可见走 i18n（中/西）；报价单 PDF 文案独立中英（D3）。

---

## Post-task routing

- Project fact updated: 已写入本报告 `docs/quote-section-investigation.md` 与 `docs/reference/fee-codes.csv`（345 行受控费用词表）。关键事实：`BUSINESS_MODULES` 单点注册即获导航+路由；`quote_snapshots`/`audit_logs` 表已建但未用；存储为单一 `app_state` jsonb（JSON↔DB fallback）；缺 Express Line/IATA/C-TPAT logo 与打印 CSS；Railway 为长驻容器（非 serverless）。
- Project lesson: 新模块接入路径 = `modules.js` + `i18n.js`(modules.*) + `store.js`(normalize* 接入) + `server.js`(render 分发/路由)；导航与 generic normalizer 会自动兜底，但有结构的模块必须加专属 normalizer（参照 inland）。
- User feedback captured: 用户要求「先调查出方案、批准后再写业务代码」「只允许写报告 md + fee-codes.csv」「不确定写 Unknown / 列待决，不臆造」「OCR 重点防 O↔0/I↔l/连字符」——本轮已严格遵守。
- UI/UX note updated: none（本轮未做 UI 评审；报价构建器 UI 细节留待 spec/实现阶段）。
- Brand note updated: 待补——`docs/BRAND_NOTES.md` 宜记录缺失的 Express Line/IATA/C-TPAT logo 与报价单双 logo 页眉规范（实现阶段补，本轮只读不改）。
- Self-correction: OCR 初判将 `CRF`/`DCTF`/`D-CWAF`/`TLX` 等读错，经 3× 高清裁切复核订正；已纳入 CSV 与 F 节，并保留低置信清单。
- Global candidate: 「docx 内嵌图表字典 → 升采样 + 局部高清裁切复核 → CSV + 低置信清单」的 OCR 工作法，可作为跨项目可复用做法候选（`_AI_WORKFLOW/memory/LESSON_CANDIDATES.md`），本轮未提升。
- Skill/playbook candidate: 可考虑「为本项目新增业务模块」的 playbook（modules→i18n→store→server 四步 + 导航/normalizer 自动行为），暂列候选。
- Durable lesson captured: 是（上述 Project lesson + Self-correction）。
- If none, reason: —
