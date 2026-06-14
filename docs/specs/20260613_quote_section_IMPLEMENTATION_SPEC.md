# 报价 / Cotización Section — 实施 Spec（v1）

> 依据：已批准的 `docs/quote-section-investigation.md`（§A–F）。本 spec 落实其 §A 逐文件改动、§B 数据模型、§C 行项映射、§D PDF/字体/部署、§E.1 步骤。
> 锁定决策（覆盖原 §E.3 待决）已由 Jose 给定，见下「锁定决策」。
> 范围：v1 = 报价构建器 UI + 一键生成带品牌 PDF；EXPORT/AIR 行项变体、报价后台编辑、inland 计算器扩展（超重/压车）均**不在本轮**。

## 锁定决策
- **Q1 编号**：`settings.quoteNumberPrefix`(默认 `ELCMEX-SI-`) + 零填充 `quoteNumberPad`(默认 3) 的 `lastQuoteSeq+1` + `quoteNumberSuffix`(默认 `E`)，如 `ELCMEX-SI-005E`。SI/E 语义不影响实现。
- **Q2**：#1 DELIVERY ORDER FEE = AT COST；#2 DESTINATION HANDLING FEE = 手填默认 1000。均不对接 handover localCharges。
- **Q3 持久化**：模板/草稿存 `modules.quote`（JSON↔DB 通吃）；`quote_snapshots` 审计快照**仅 DB 模式写**、JSON 模式跳过（`db.js` 加 `insertQuoteSnapshot/listQuoteSnapshots`，表已存在零迁移）。
- **Q4 跨币种**：按币种分别小计（MXN / USD），不强制折算单一总额；可选 `settings.showIndicativeConversion`（默认关）输出明确标注 "indicative" 的参考折算。
- **Q5 logo**：用 `public/express-line-logo.png`、`public/iata-logo.png`、`public/ctpat-logo.png`（`dewell-logo.svg` 已有）。任一缺失 → PDF 渲染带标注占位框，不崩。
- **Q6**：v1 仅 IMPORT/OCEAN 行项集；`operation`/`department` 字段可填但不改行项集。
- **#9 超重费 / #10 压车费**：保持手填；**不改 inland 计算器**。

## 文件改动（逐文件）
**改：**
- `src/lib/modules.js` — `BUSINESS_MODULES` 追加 `{key:"quote",implemented:true}`（inland 之后）。
- `src/lib/i18n.js` — zh+es 各加 `modules.quote.*`（6 key）与顶层 `quote.*` UI 串。
- `src/lib/store.js` — `normalizeQuoteModuleData` + 在 `normalizeModules` 显式接入 + 导出 `getQuoteModule/saveQuoteDraft` 辅助（经 `getShippingData/saveShippingData`）。
- `src/lib/db.js` — `insertQuoteSnapshot(snapshot)` / `listQuoteSnapshots(limit)`（DB-only）。
- `src/server.js` — `renderWorkbench` 增 quote 分支 + `renderQuoteWorkbench`/`buildQuoteFormData`；`GET /workbench/quote`、`POST /workbench/quote`（action: recompute|pull|saveDraft）、`POST /workbench/quote/pdf`；`/admin/quote/*` 守卫重定向到工作台。
- `package.json` — deps 加 `puppeteer`；`engines.node>=20`。
- `scripts/smoke-test.js` — 三模块回归断言 + quote 路由 200 + PDF 以 `%PDF` 开头。
- `docs/BRAND_NOTES.md` — 记录报价单双 logo 页眉 + IATA/C-TPAT 页脚规范。

**新建：**
- `src/lib/quote.js` — `QUOTE_TEMPLATE_ROWS`(11)、`QUOTE_NOTES`(中英 5)、`QUOTE_GROUP_ORDER`、`generateQuoteNumber`、`loadFeeCodes`(读 `docs/reference/fee-codes.csv`)、`pullCalculatorValues`、`computeQuoteTotals`、`buildQuoteView`。
- `src/lib/quote-pdf.js` — puppeteer 单例 + `renderQuotePdf(quoteView)`；资产（字体/ logo）base64 内联。
- `views/workbench-quote.ejs` — 构建器 UI（General Data 表单 + 计算器取数输入 + 可编辑行项表 + 分币种小计 + 生成 PDF）。
- `views/quote-document.ejs` — 独立 A4 中英对照报价单（Puppeteer 渲染目标）。
- `public/quote.js` — 行项增删、AT COST 切换、实时分币种小计、fee-code datalist 自动带英文说明。
- `public/fonts/NotoSans-Regular.woff2`、`NotoSans-Bold.woff2`、`NotoSansSC-Regular.woff2` — PDF 内嵌字体。
- `public/express-line-logo.png`、`iata-logo.png`、`ctpat-logo.png` — 品牌资产（Chandler 放入；缺失走占位）。
- `nixpacks.toml` — Railway 装 Chromium 运行库 + `noto-fonts-cjk` 兜底。

## 数据模型
见报告 §B。`modules.quote = { settings, templateRows, notes, drafts }`。行项含 `{id,code,category,conceptEn,conceptZh,unit,unitPrice,currency,remark,isAtCost,source,calcRef}`。草稿含 `{id,number,date,header,lineItems}`。

## 行项映射（D1）
见报告 §C 表。calc 行：#3 handover.demurrage、#4 customs.terminalFixed、#5 customs.terminalStorage、#7 inland.sencillo、#8 inland.full；手填：#2/#6/#9/#10；AT COST：#1/#11。`POST /workbench/quote?action=pull` 用共享输入调既有计算器回填 unitPrice；用户可逐行覆盖（→ source=manual）。

## PDF / 字体 / 部署
- 引擎：full `puppeteer`（自带 Chromium）。`page.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,margin:12/10/14/10mm})`，header/footer 写进 HTML。浏览器单例复用，容器加 `--no-sandbox --disable-dev-shm-usage`。
- 字体：`quote-document.ejs` 用 `@font-face` **base64 内嵌** Noto Sans(拉丁) + Noto Sans SC(中文)，渲染不依赖宿主字体；nixpacks 另装 `noto-fonts-cjk` 兜底。
- 资产内联：字体/ logo 读盘转 data-URI，缓存；logo 缺失→占位框。
- 降级（仅记录不实现）：WeasyPrint。

## 不回归 / 测试
- handover/customs/inland 计算与页面不变；`npm test` 全绿。
- 新增断言：`/workbench/quote` 200 且含构建器标记；`POST /workbench/quote/pdf` 返回体以 `%PDF` 开头；quote 出现在导航。
- 自检：本地真出一份 PDF，确认中文不乱码、双 logo 页眉 + IATA/C-TPAT 页脚 + Notes、分组顺序 SHIPPING LINE→PORT FEES→CUSTOMS CLEARANCE→TRANSPORTATION→DUTY。

## 热文件 blast radius
`server.js`(+路由/渲染分发)、`store.js`(+quote normalizer)、`i18n.js`(+quote 文案)、`package.json`(+puppeteer)。受影响：导航多一项；其余模块路由/计算不变（回归覆盖）。

## 风险
Railway Chromium（最高，部署后单独实测）；镜像体积/冷启动；混合币种合计（按币种小计规避）；fee-codes 低置信（受控词表上线前人工核）。
