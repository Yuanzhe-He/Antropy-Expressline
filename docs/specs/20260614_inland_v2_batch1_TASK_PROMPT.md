# 任务：陆运 v2 第一批 — 报价单样张 + 时间里程进PDF + 短驳费 + 双币种双IVA + 多港后台口子

仓库：当前目录（Jose Expressline Consulting）。分支 feature/inland-v2-batch1，从最新 main 切，PR-only，不直推 main、不 force push。

## 背景与已核实事实（基于 file:line，勿凭印象推翻）
- 报价单系统已建成：quote.js（11行模板，TRANSPORTATION 组单拖/双拖 calcRef 指向 inland.sencillo/full）+ quote-pdf.js（EJS+Puppeteer 渲染，含 logo/双语字体）+ views/quote-document.ejs。
- R5 时间里程：routeCache 已存 distanceKm/durationMin/viaCities（La Paz 含轮渡 3614km/48h），前台 inland-map.js:348-364 已显示。缺口仅在对客 PDF 未透出。
- R2 短驳：CSV 的 BURREO/LOCAL 列已被采进 rateEntry.extras（两档 SENCILLO $4800 FULL $7000~7800，约131行有值，覆盖38/41目的地），从未解析/计算/展示。
- R4 双币种：computeInlandCalculator 硬编码 quoteCurrency="MXN"（calculate.js:1005）、未接汇率；汇率数据现成（exchange-rates.js，USD/MXN 双源自动抓）。
- R1 港口：清关模块已有 ports[]（store.js:1515起，Manzanillo/Lázaro），但绑了码头费/堆存规则，陆运不能整搬。

## 已拍板决策（不要重新发问）
- R1：陆运 origins 体系支持后台加港口（可从清关现有港口名单引入 or 手输新港口：名字+坐标），**本批只做后台能加港口的口子，不灌任何新港费率**。新港留空壳，等 Jose 给费率表再灌。借清关港口"名单"，不借其码头费/堆存包袱。
- R2：短驳做成可勾选附加项，前端显示，默认 0（不勾不计入），CSV 现有两档先填入数据。
- R4：报价单层双价并列（比索价 + 美金价），各带独立 IVA 开关；比索默认关(不含税)、美金默认开(含16%)，两个都可手切；美金价算法 = 基准比索金额 ÷ 即期USD/MXN汇率 ×(1+该币种IVA)，汇率取系统自动抓的，PDF 标注汇率日；不动陆运计算器 MXN 基准，双价在报价单层换算+套税。
- R5：把 routeCache 已有的 distanceKm/durationMin/viaCities 透出到对客 PDF。
- R3 车型：**本批无视，不做**。

## Step 0 — 规则与现状
读 AGENTS.md、docs/AI_AGENT_PROJECT_RULES.md、.ai/PROJECT_SCALE_OVERRIDES.md、上一轮 inland spec、docs/BRAND_NOTES.md，以及现有实现：inland-catalog.js / inland-csv.js / calculate.js(computeInlandCalculator) / quote.js / quote-pdf.js / views/quote-document.ejs / public/inland-map.js / store.js(inland段 + ports结构)。git status 干净、git checkout -b feature/inland-v2-batch1。

## Step 1 — Spec（写完停下给我看）
写 docs/specs/20260614_inland_v2_batch1_SPEC.md：数据模型变更（rateEntry.burreo、origins 后台 CRUD、precisePoint 不变）、双价换算与套税逻辑、PDF 透出字段、各步测试清单、blast radius。spec 写完**停下报告，等我确认口径**再继续 Step 2。

## Step 2 — 报价单样张（会议优先，确认 spec 后最先做）
- 用 quote.js + quote-pdf.js + 真实生产数据跑一份样张 PDF（不改 quote 逻辑，仅调用产出）。
- 选代表性目的地（如 Apodaca 或 CDMX：多供应商 + 有短驳 + 有路线缓存）。
- 若本机 Puppeteer/Chromium 不可用，先产出 renderQuoteHtml 的 HTML 样张并注明 PDF 待环境补齐。
- 输出 docs/specs/sample-quote-<dest>.{pdf,html}。这是会议实物，最先交付。

## Step 3 — R5 时间里程进 PDF（零数据成本）
- routeCache 已有数据、前台已显示。把 distanceKm/durationMin/viaCities（含 La Paz 轮渡标记 hasFerry）透出到 views/quote-document.ejs 的运输/TRANSPORTATION 段。
- 数据取该报价目的地对应 origin→destination 的 routeCache 条目；无缓存的列清单、PDF 该处留空或标"—"，不阻塞。
- i18n：若 PDF 文案走 i18n 则 zh/es 双语；quote-document 若是独立 EN+中文体系则按其约定。

## Step 4 — R2 短驳费结构化 + 可选（涉及生产 seed，先备份）
- inland-csv.js：解析 BURREO/LOCAL extras 值 → 结构化 burreo:{sencillo:Number, full:Number}（解析失败 burreo=null），写进 rateEntry，保留 extras 原值。两档示例：'SENCILLO $4800 FULL $7000' / 'SENCILLO $4800 FULL $7800'。
- 重新 seed 生产：**先经 store 读取导出 modules.inland 当前值备份到 docs/specs/20260614_prod_inland_backup_pre_burreo.json**（不打印 secret），再用 --replace 整段替换灌库。灌前打印 diff 概要核对。本机/生产库身份沿用上次确认（.env DATABASE_URL = 生产 Supabase expressline）。
- computeInlandCalculator：入参加 includeBurreo（默认 false）；为 true 时取该目的地 serviceType 对应短驳费（同目的地多档取最高，与主费率口径一致），在 pretax 基础上加，formula/explanation 体现拆分。
- 前端报价面板（workbench-inland + inland-map.js）：加"短驳费/Burreo"勾选项，默认不勾显示 0，勾选后总价含短驳并显示拆分行。
- smoke：含/不含短驳、两档取值、多档取最高、null 安全。

## Step 5 — R4 双价 + 双 IVA 开关（报价单层）
- 在报价单/PDF 层实现双价并列：比索价 + 美金价。
- 两个独立 IVA 开关：比索默认关（pretax）、美金默认开（+16%），均可手切。
- 美金价 = 基准比索金额 ÷ 即期 USD/MXN 汇率 ×(1 + 该币种IVA率)；汇率取 exchange-rates.js 系统自动抓的（含 asOfDate），PDF/界面标注汇率日。
- 不改 computeInlandCalculator 的 MXN 基准；双价换算+套税在报价单层（quote.js computeQuoteTotals 或其上层）实现。
- BRAND_NOTES 现有"价格不含税、开票加16% VAT"单口径条款，与双价展示冲突处在本步更新，并在 PR 说明协调点。
- smoke：双价换算正确、两开关四种组合（比索关/开 × 美金关/开）、汇率缺失时降级。

## Step 6 — R1 多港后台口子（只做能加，不灌费率）
- inland origins：从单一 Manzanillo 扩展为后台可 CRUD 的 origins[]（id/name/lat/lng/enabled/note）。
- 后台 admin-inland 加"出发港"管理：① 从清关现有港口名单一键引入（只取 name + 代表坐标，不带码头费/堆存）；② 手输新港口（名字+坐标）。
- **本批不灌任何新港费率**：新港建好后 rateEntries 为空，前台该港显示"暂无费率"。Manzanillo 现有 300 费率不动。
- 地图/计算：保持向后兼容——现有 rateEntry 默认 originId=manzanillo；多 origin 的地图分组放射可先做最小可用（新港无费率不画线，仅后台可见）。
- bulk-upload 模板：origins sheet 预留（供未来灌新港费率用），本批不导数据。
- smoke：origins CRUD、引入清关港口名单、Manzanillo 费率回归不受影响。

## 收尾
Task Summary（含 blast radius：触及 calculate.js/quote.js/quote-document.ejs/inland-csv.js/store.js/inland-map.js/admin-inland + i18n + 生产 inland 数据）+ 完整 Post-task routing。lesson 写 docs/LESSONS.md（候选："短驳/滞留费数据本在 CSV extras，v2 提取启用"；"报价单层做双币种双IVA、计算器保持单基准"）。npm test 全绿含放单/清关回归。PR 更新，附样张文件路径。

## 明确不在本批（等 Jose 会议）
- R1 新港**费率灌入**：等 Jose 给港口清单 + 费率表。
- R3 车型：CSV 无车型差异数据，等 Jose 定义后再议。

## 约束复述
不改放单/清关计算行为；Excel/CSV 仅作 seed 输入；本批不灌任何新港费率；生产 seed 前先备份；不 force push、不直推 main、不打印 secrets。spec 写完先停等我确认口径。
