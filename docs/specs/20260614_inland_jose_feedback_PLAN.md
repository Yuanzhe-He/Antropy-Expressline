# 陆运 / 报价 — José 反馈全量调查 + 实施计划（投资级清单）

> 类型：调查 + 方案 + 待决问题清单。**本轮未改任何业务代码**，仅产出本计划 md。
> 日期：2026-06-14。来源：José（港中旅 CTS）微信反馈（昨日文字 4 条 + 今早语音 5 条）。
> 适用模块：主要 `inland (陆运 / Transporte)`，部分外溢到 `quote (报价 / Cotización)` PDF。
> 前置事实：`inland` 与 `quote` 均**已上线生产**（`docs/specs/20260611_inland_handover_to_jose.md`，commit `66ccf37`）。本计划属「改动已上线、跨模块、影响费用口径、对客文档」→ **spec-first 必走**（`docs/AI_AGENT_PROJECT_RULES.md` Spec-First）。

---

## 0. José 原话 → 需求拆解（去歧义）

| # | José 原话（微信） | 我的解读 | 状态 |
|---|---|---|---|
| R1 | 「目的地可以加上其他的**港口**吗」 | 加**出发地港口**（不止 Manzanillo）。Chandler 已追问「还是出发地？」，José 语音确认「现在里边我是没有加入…但这个情况是有的」。 | 需求成立，**最大结构改动**，且**卡在数据**（见 R1） |
| R2 | 「一个**短倒**的点」+语音详解 | 加 **BURREO / 短驳（drayage）** 费用项：柜子从港口拉出先落车队堆场，周末不卸货，周日晚再上路、周一送达，这段产生短驳费。 | 需求成立，**数据已在 CSV，未surface** |
| R3 | 「增加一些**车型**和**村照片**的选项」 | (a) 车型选项更多/可视化；(b) 给目的地/收货点配**照片**。Chandler 追问「村=目的地吗？」**未明确回答** → 真歧义。 | **需产品决策**（含图片存储新能力） |
| R4 | 「运输费默认当地汇率；美金含 16% IVA、比索不含；有加 IVA 选项」+语音「显示两个价格：比索不含税、美金含 16%」 | **双币种双口径展示**：MXN（sin IVA）+ USD（con IVA 16%），可切换加/不加税。 | 需求清晰，**与现状『固定 MXN、不走汇率』直接冲突，等于改口径** |
| R5 | 「帮我加上路上的**时间**和大约的**公里数**」 | 路线时长 + 里程展示。 | **前台已基本实现**，缺口在 PDF + 路线缓存覆盖 |

> 会议背景：José 提议「本周中线上对一版」。本计划据此分期：先低风险快赢（R4/R5），再 R2，再 R3（待决策），最后 R1（卡数据）。

---

## 1. 现状证据（逐项落到 file:line）

### 1.1 出发地（R1）
- `src/lib/inland-catalog.js:11-13` — `INLAND_ORIGINS` 只有 `manzanillo` 一个。
- 数据模型**部分支持多出发地**：`origins[]` 已规范化（`store.js:1974-1983`），`rateEntry.originId`（`store.js:1909-1911`）、`routeCache.originId`（`store.js:1934-1935`）都已带 origin 维度。
- 但**全链路实际只用 `origins[0]`**：
  - CSV 导入**强制** manzanillo：`src/lib/inland-csv.js:188` `const originId = DEFAULT_INLAND_ORIGIN_ID;`（非 Manzanillo 的 ORIGEN 只丢进 `extras.ORIGEN_RAW`，`inland-csv.js:185-186`）。
  - 前台地图、起点 marker、`fitAll` 全用 `data.origin`（单值）：`server.js:1203` `origins[0]`、`public/inland-map.js:223-232`。
  - 路线刷新只用 `origins[0]`：`server.js:2007`。
  - 前台路线查找**忽略 originId**：`public/inland-map.js:67` `routeForDestination = key(`${id}|destination|`)`。
  - 计算器不按 origin 过滤 rateEntries：`calculate.js:1013-1015`（只按 `destinationId`）。
- **关键阻塞**：tarifario CSV **只有 Manzanillo 的费率**（`PROVEEDOR` 15 家、248 行全部 ORIGEN=Manzanillo）。新增其他港口若无费率数据 → 报价为空。

### 1.2 短倒 / BURREO（R2）
- CSV 有 `BURREO / LOCAL` 列；profile 结果：**3 个取值** — 空 117 行、`SENCILLO $4800 FULL $7800` 72 行、`SENCILLO $4800 FULL $7000` 59 行。→ **按行（供应商/路线）变化，不是全局常量**。
- 同场景相关列：`SOBRE PESO`≈全局 `POR CONTENEDOR $4500 MXN`；`ESTADIAS X CTN $4,500`、`PERNOCTA $5,000`、`ALMACENAJES X CTN X DIA Sencillo $660 Full $750`（127 行成组出现）。
- 现状：`inland-csv.js:11-22` 的 `FIELD_BY_HEADER` **只映射** ORIGEN/DESTINO/PROVEEDOR/SENCILLO/FULL/CONSIGNATARIO/CODIGO CW/COMODITY；**其余全部进 `extras`**（原始字符串），`rateEntry` 不解析、admin/前台/计算器都**不读** `extras`。
- 结论：短倒数据**已在仓库**（在 `extras["BURREO / LOCAL"]`），但**未结构化、未展示、未计入**。

### 1.3 车型 + 照片（R3）
- 「车型」= `sencillo`/`full`，已是前台 toggle（`workbench-inland.ejs:45-49`）。CSV 另有 `TIPO DE SERVICIO=CHASIS/PLATAFORMA`、`CONTENEDOR=20"/40"`、`MAXIMO DE CARGA=SENCILLO 23T FULL 55T`（均全局单值）。
- 「照片」：**全 App 无任何图片上传/存储/展示能力**。当前存储是单条 `app_state(key,payload jsonb)`（`db.js:120-144`、`store.js`），**不适合存二进制图**。`public/` 只有 logo 类静态资源。
- 结论：R3 是**新增媒体能力**，且语义未定（车型示意图？目的地/堆场实景？收货点照片？放工作台还是放对客 PDF？）。

### 1.4 币种 + IVA 口径（R4）
- `computeInlandCalculator` **硬编码 `quoteCurrency="MXN"`**（`calculate.js:1005`）；总价只出单一 MXN 值（`calculate.js:1070-1077`）。
- 前台已有 IVA 0/16 toggle（`workbench-inland.ejs:60-67`、`inland-map.js:464-471`），但**只对单一 MXN 价加/不加税**，**无 USD、无双价**（`inland-map.js:376-380` 全部 `i18n.mxn`）。
- 汇率可用：`exchangeRates.pairs` 有 `USD→MXN 17.459` 与 `MXN→USD 0.057277`（`data/shipping-lines.json`，Frankfurter，`asOfDate 2026-05-05`）。
- **直接冲突**：交付说明白纸黑字写「**币种固定 MXN**、**陆运报价不走汇率换算**」（`20260611_inland_handover_to_jose.md:73,77`）。R4 等于**推翻该口径** → 落地后必须同步改交付说明。

### 1.5 路线时间 + 里程（R5）
- 前台**已渲染** `distanceKm km · ≈X 小时 · via 城市`（`inland-map.js:348-364`），i18n 键 `distance/duration/km/hours/via` 已就位（`workbench-inland.ejs:111-126`）。
- 数据源 `routeCache.distanceKm/durationMin/viaCities`（`store.js:1940-1944`），由 `scripts/refresh-inland-routes.js` / admin「刷新路线」生成。
- 缺口：(a) **只在有缓存路线时显示**，无缓存显示 `routeNotCached`（`inland-map.js:358-360`）；(b) **报价 PDF (`quote-document.ejs`) 不含**时间/里程；(c) José 可能没看到最新版或想要更显眼/进对客单。
- 结论：R5 **前台已 80% 完成**，真实工作量在 **PDF 透出 + 路线缓存全覆盖**。

---

## 2. 逐项方案 + 我的判断 + 文件级改动

### R4 双币种 / 双 IVA 口径 —【优先级 1，低风险快赢，建议先做】
**我的判断**：需求最清晰、纯展示层、可不动放单/清关。先落这个能在周中会上直接给 José 看效果。
**推荐口径**（待 José 确认细节，见 Q4）：
- 同时展示两价：**MXN 不含税（sin IVA）** 与 **USD 含 16% IVA（con IVA）**。
- USD 含税值 = `MXN税前 × (1+0.16) ÷ rate(USD→MXN=17.459)`；汇率取 App 内 `exchangeRates`（即「当地汇率」）。
- 保留「加 IVA」开关：开关控制是否对**两个币种都按含税显示**（或仅切 MXN 的税，USD 恒含税——需 Q4 定）。
**改动**：
- `src/lib/calculate.js:1002-1102` `computeInlandCalculator`：去掉 MXN 硬编码，输出 `{ mxnPretax, mxnAfterTax, usdAfterTax, fxRate, fxAsOf }`；用注入的 `exchangeRates`（仿 `quote.js:273-286 convertAmount`）。
- `public/inland-map.js:332-387 renderQuote`：渲染双价卡（MXN sin IVA / USD con IVA），公式各一行；`i18n` 增 `usd/sinIva/conIva/fxAsOf`。
- `views/workbench-inland.ejs:74-86`：结果区由单 total 卡 → 双价卡布局；注入 `exchangeRates.pairs` 到 `inland-map-data`（改 `server.js:1202 buildInlandMapData` 带上 fx）。
- `src/lib/i18n.js`：`inland.*` 增 zh/es 串（USD、含税/不含税、汇率日期）。
- **外溢**：若 José 要 PDF 也双价 → `quote.js` inland 行 + `quote-document.ejs`（见 Q4d）。

### R5 路线时间 + 里程 —【优先级 1，低风险，多数已完成】
**我的判断**：前台已实现，先确认 José 看到的是不是旧版/无缓存目的地；真正要补的是 **PDF + 缓存覆盖**。
**改动**：
- 数据巡检：跑 `node scripts/refresh-inland-routes.js`，确保所有启用目的地都有 `routeCache`（消除 `routeNotCached`）。
- PDF 透出：`src/lib/quote.js` 在 inland 行附 `route:{distanceKm,durationMin,viaCities}`；`views/quote-document.ejs` TRANSPORTATION 段展示「约 N km / ≈H 小时」。
- 可选：无缓存时前台用直线估算兜底里程（`inland-routes.js:59 equirectKm` 已有），标注「估算」。

### R2 短倒 / BURREO —【优先级 2，中等，数据已在仓库】
**我的判断**：把 `extras["BURREO / LOCAL"]` 结构化为可计费字段，做成**可选 add-on**（默认不含，勾选才计入），按柜数计，按 sencillo/full 取对应值。顺带可一并 surface `PERNOCTA/ESTADIAS`（同属周末滞留场景）。
**改动**：
- `src/lib/inland-csv.js:11-22`：`FIELD_BY_HEADER` 增 `"BURREO / LOCAL": "burreo"`（+可选 SOBRE PESO/ESTADIAS/PERNOCTA）；新增 `parseSencilloFull("SENCILLO $4800 FULL $7800") → {sencillo:4800,full:7800}`。
- `inland-csv.js:212-226` rateEntry 形状增 `burreoSencillo/burreoFull`（兼容旧 extras）。
- `src/lib/store.js:1906-1929 normalizeInlandRateEntry`：增 `burreoSencillo/burreoFull`（`parseNullableNumber`）。
- `src/lib/calculate.js computeInlandCalculator`：入参 `includeBurreo`；为 true 时加 `burreo[serviceType] × quantity` 到 total，单列说明。
- `views/workbench-inland.ejs` + `inland-map.js`：加「含短倒 / Burreo」勾选，结果区单列短倒金额。
- `views/admin-inland.ejs:147-158`：费率表增短倒两列（可编辑）。
- 重新 seed：`scripts/seed-inland-from-csv.js` 走新解析（**不可对 prod 直接 seed，先备份**，见 §4）。

### R3 车型 + 照片 —【优先级 3，需产品决策，不建议本期硬上】
**我的判断**：先在会上敲定语义与落点，再决定是否做；图片存储是**新基础设施**，不宜仓促。最小可行：
- 「车型」：先用**静态示意图**（sencillo 单拖 / full 双拖各一张图，放 `public/inland/`），toggle 旁显示，**零存储成本**。
- 「照片」：若指目的地/收货点实景 → 需「图片上传 + 存储」。当前单 JSON blob 不适合 → 方案：(i) 存外链 URL（最轻，José 贴图床/Drive 链接，仿精确点贴链接模式）；(ii) Railway Volume 存文件；(iii) 对象存储。**推荐先做 (i) 存 URL**。
**改动（若采 URL 方案）**：`store.js` destination/precisePoint 增 `photoUrl[]`；admin 增 URL 输入；前台/可选 PDF 展示。**SSRF/越权**：仅白名单图床域名（仿 `inland-link-resolver.js`）。

### R1 其他出发地港口 —【优先级 4，最大结构改动 + 卡数据】
**我的判断**：**先要数据**。没有其他港口的 tarifario，加端口只是空壳。技术上数据模型已半通（origins[]/originId），但 UX/计算/导入/路线全要打通多 origin，属大改 + 影响已上线模块。**建议：本期只做『可加 origin 的后台骨架 + 单 origin 行为不回归』，待 José 给数据再开第二档费率与路线。**
**改动（分两步）**：
- 步骤 A（结构，可本期）：admin 增「出发地」增删（写 `origins[]`）；`buildInlandMapData`/前台支持多 origin marker 与 origin 选择；`routeForDestination` 改为按 `originId|destinationId` 查；路线刷新遍历所有 origin。
- 步骤 B（数据，待 José）：导入其他港口费率（改 `inland-csv.js:188` 不再强制 manzanillo，按 ORIGEN 列映射 originId）；按 (origin,destination) 出价。

---

## 3. 分期实施建议（按风险/依赖排序，不含工期）

1. **第一档（会前/会上可演示，低风险，纯展示）**：R4 双币种双 IVA + R5 PDF/缓存补全。不动放单/清关，不改存储。
2. **第二档（数据已在仓库，中等）**：R2 短倒结构化 + add-on + admin 列。需重新 seed（先备份 prod）。
3. **第三档（需会上决策）**：R3 — 先定语义（车型示意图 vs 收货点实景）与落点（工作台/PDF），再选存储方案。
4. **第四档（卡 José 数据）**：R1 多出发地——先后台骨架，数据到位再开费率/路线。

---

## 4. 风险 / 回归 / 回滚

- **R-A（高）口径回退冲突**：R4 推翻「固定 MXN/不走汇率」。落地须同步改 `20260611_inland_handover_to_jose.md:73,77`，并向 José 书面确认新口径，避免对账分歧。
- **R-B（高）生产数据**：inland 已在 prod。R2 重新 seed 前**必须备份**（参照 `docs/specs/20260611_prod_inland_backup.json` 模式），`db:seed` **禁止**未确认直跑 prod（`DATABASE_SCHEMA.md:26`）。
- **R-C（中）热文件 blast radius**：`server.js`/`store.js`/`calculate.js`/`i18n.js`/`public/styles.css` 均热文件。每次改动 Task Summary 必列：受影响页面（/workbench/inland、/admin/inland、/workbench/quote、PDF）、路由、数据模型（modules.inland.rateEntries 增字段）、测试、回归项。
- **R-D（中）业务不回归**：放单/清关/quote 三模块计算**不得变**；inland 单 origin、单价行为对未勾短倒/未开 USD 时**逐位一致**。回归：`npm test`（smoke）+ `node scripts/quote-test.js` + 手动浏览器核对。
- **R-E（中）汇率时效**：USD 价依赖 `exchangeRates.asOfDate`（当前 2026-05-05，偏旧）。展示需带「汇率日 / 按开票日结算」字样（quote NOTES 已有类似条款 `quote.js:169-178`）。
- **R-F（中）图片存储**（R3）：若走上传，单 JSON blob 不适配 → 选 URL/Volume/对象存储；走 URL 必做域名白名单防 SSRF。
- **R-G（低）权限**：登录当前关闭、全员可改规则（`AI_AGENT_PROJECT_RULES.md` Auth）。对客 PDF + 上传能力上线前应纳入鉴权（auth 改动 spec-first）。
- **回滚**：每档独立小 PR；prod 配置变更前留 backup json；R4 可用 feature 开关（默认旧单价）灰度。

---

## 5. 验证

- `npm test`（smoke：inland/quote 路由 200）。
- `node scripts/quote-test.js`（quote 计算 + PDF 字节）。
- 新增：inland 计算单测（双币种数值、短倒计入/不计入、单 origin 不回归）。
- 手动：浏览器核对 `/workbench/inland`（双价、短倒勾选、路线时长里程）、出一份 PDF（中文不乱码、TRANSPORTATION 段含里程/双价）。
- 数据：`refresh-inland-routes.js` 跑完无 `routeNotCached`。

---

## 6. 待决问题清单（给 José / 待确认；每条含**我的判断与建议默认值**）

> 用途：周中会议逐条对齐。括号内是**我推荐的默认答案**，José 不反对即按此落地。

**关于 R1 其他港口**
- **Q1.** 具体要加哪些出发港？（我判断：墨西哥常用集装箱港 = Lázaro Cárdenas / Veracruz / Altamira / Ensenada；**建议先确认 1–2 个真有业务量的**）
- **Q2.** 这些港口的 **tarifario 费率表** José 能否提供？（**我的判断：这是硬阻塞**——没有费率，加港口只是空壳。建议「先给数据再开第二档」）
- **Q3.** 同一目的地、不同出发港，是否**各自独立报价**（而非合并取最高）？（建议：按 (港口,目的地) 独立）

**关于 R2 短倒 / Burreo**
- **Q4.** 短倒是**可选 add-on**（默认不含、勾选才加）还是默认included？（**建议：可选 add-on**，按柜数、按 sencillo/full 取 CSV 里的 4800/7000~7800）
- **Q5.** 是否一并展示 **PERNOCTA（过夜 $5000）/ ESTADIAS（滞留 $4500）/ 堆存（$660-750/天）** 等周末滞留相关费？（建议：作为「滞留费说明」一并 surface，默认不计入总价、仅展示口径）

**关于 R3 车型 + 照片（歧义最大，务必当面敲定）**
- **Q6.** 「**村**」到底指什么？目的地城市/工业区？还是**精确收货点（厂区）**？（**我的判断：指目的地/收货点实景照片**，Chandler 此前已追问未果）
- **Q7.** 「车型」是想要**更多车型选项**，还是要**车型示意图/照片**？（**我的判断：要示意图**——单拖/双拖各一张图作可视化；车型本身 sencillo/full 已够）
- **Q8.** 照片**放哪**：内部工作台、对客报价 PDF、还是都要？（建议：先工作台，PDF 视需要）
- **Q9.** 照片**怎么来**：José 贴图床/Google Drive 链接（轻），还是要做后台**上传**（重，需新存储）？（**我的判断/建议：先存 URL 链接**，仿现有「贴 Google Maps 链接」模式，零新基础设施）

**关于 R4 币种 + IVA**
- **Q10.** 两价的**确切口径**：MXN 恒「不含税」、USD 恒「含 16%」对吗？（按语音=对）「加 IVA 选项」是**同时给两币种切税**，还是**只切 MXN、USD 永远含税**？（**我的判断：USD 恒含税、MXN 默认不含、开关只补 MXN 的税**——更贴语音）
- **Q11.** USD 用**哪个汇率**：App 内自动刷新的 Frankfurter 即期（=「当地汇率」），还是 José 给固定牌价？（建议：用 App 内即期 + 展示「汇率日」+「按开票日结算」声明）
- **Q12.** 这套双价**只在前台工作台**，还是**对客 PDF 报价单**也要双价？（**我的判断：PDF 也要**——对客单才是 José 最初问的「报价单」；但 PDF 现为「价格不含税，开票加 16%」单口径，需协调）

**关于 R5 时间 / 里程**
- **Q13.** José 现在**看到过**前台已有的「里程 + 约 X 小时」吗？还是想要更显眼/或主要想放进**对客 PDF**？（**我的判断：他想要进对客 PDF**——前台其实已有，确认后我补 PDF + 把无缓存目的地路线补齐）

**关于范围 / 优先级**
- **Q14.** 是否同意分期：**先上 R4 双价 + R5（低风险快赢）→ 再 R2 短倒 → R3 待定 → R1 等数据**？（建议：同意，周中会上先看 R4/R5 demo）

---

## Post-task routing

- Project fact updated: 已写入本计划 `docs/specs/20260614_inland_jose_feedback_PLAN.md`。关键事实：inland 数据模型已半支持多出发地（origins[]/originId/routeCache.originId），但导入/计算/前台/路线全链路仍只用 origins[0]；CSV `BURREO / LOCAL`（短倒）等列已采集进 `rateEntry.extras` 但未结构化/未展示；inland 计算器硬编码 MXN 且交付说明明示「不走汇率」，与 José 新双币种口径冲突；路线时长/里程前台已渲染、PDF 未透出；全 App 无图片存储能力。
- Project lesson: 调查「新需求」前先确认数据是否已在仓库——本次发现短倒(R2)、车型规格、滞留费数据其实已在 source CSV 的未映射列里，避免误判为「从零新增」。
- User feedback captured: 用户要求「全量调查 + 尽可能详细 plan + 带自己判断的问题列表」；José 反馈通过微信文字+语音转写获取。已严格按「先调查出方案、不臆造、歧义点列待决并给推荐默认值」。
- UI/UX note updated: none（本轮未改 UI；双价卡/短倒勾选/照片位的 UI 细节留待会上定 + 实现阶段）。
- Brand note updated: 待补——若 R4 双价进 PDF，`docs/BRAND_NOTES.md` 的 Quote Document 口径（现「价格不含税，开票加 16%」）需与双币种协调，实现阶段更新。
- Self-correction: 初看以为「路上时间/里程」是全新需求，核 `inland-map.js:348-364` 后确认前台已实现，更正为「PDF 透出 + 缓存补全」缺口。
- Global candidate: none（本项目特定）。
- Skill/playbook candidate: 可考虑「客户口语反馈 → 去歧义 → 落 file:line 证据 → 带判断的待决清单」的调查 playbook，暂列候选。
- Durable lesson captured: 是（上述 Project lesson + Self-correction）。
- If none, reason: —
