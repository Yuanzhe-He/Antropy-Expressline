# José 反馈归档 — 2026-06-19（船公司费率更新 + 新增船公司需求）

> 来源：José（XG 港中旅 CTS）邮件，随附 Excel `TARIFARIO 15.06.26.xlsx`。
> 本文档由 Claude 在**读取 Excel + 比对仓库当前数据**后整理。
> **状态：已分析，2 处费率改动 + 若干元数据/标签问题待 José 确认后写入。**
> Excel 原件已归档到本目录：[`TARIFARIO 15.06.26.xlsx`](./TARIFARIO%2015.06.26.xlsx)（15 个 sheet，每船司一个 + 一张 `ALL NAV` 汇总表）。

---

## 0. 一句话结论（TL;DR）

- José 说更新了 4 家（MSC / KMTC / RCL / Hapag），但比对仓库当前数据后，**真正有费率变化的只有 2 家**：
  1. **MSC – Conteiner Protection Fee**：25 → **50（GP/HQ/DC 组）/ 60（其余 5 组）** ⚠️ 与同一份 Excel 的 `ALL NAV` 汇总页（仍是 25）**自相矛盾**，必须先和 José 确认。
  2. **KMTC – ISD Discharge**：45 → **15**（高置信，KMTC 页无歧义）。
- **RCL、HAPAG 费率与我们现有数据完全一致，无需改动**（说明这两家我们的数据本来就是最新的）。
- Excel 的 `ALL NAV` 汇总页透露了 José 的真实意图：**底部列了 7 家「新供应商」占位**（ESL/SINOKOR/SL/SEA LEAD/TS LINES/HMM/SINOTRANS），目前没填代码/费率——这就是他说的「公司增长带来的新船司」。
- **系统目前没有「新增船公司」功能**（已在代码层核实），新增只能改 JSON。这是 José「将来如何新增船司」问题的核心答案，需要单独立项。

---

## 1. José 原话（逐条）

1. 随附 Excel，对 **MSC、KMTC、RCL、Hapag** 四家船公司的 local 费率做了**小幅更新**。
2. Excel 里的费率是**当前最新**口径。
3. 因公司业务增长、有了**新的供应商（船公司）**，后续**还需要新增更多船公司**。
4. 想了解**将来如何新增船公司**。

---

## 2. 数据落点（仓库事实，非凭记忆）

- **唯一数据源**：`data/shipping-lines.json`（后台保存直接写回此文件；不需要单独的数据库）。
- 船公司费率结构：`modules.handover.shippingLines[]`。共 **14 家**：cma-cgm, maersk, zim, msc, one, pil, whan-hai, hapag, evergreen, cosco, oocl, yang-ming, kmtc, rcl。
- 这 14 家与 Excel 的 14 个船司 sheet 一一对应；Excel 第 15 个 sheet 是 `ALL NAV`（汇总/索引页）。
- `modules.customs.shippingLines[]` 里这些船司的 `localCharges` **全部为空**；customs 副本只承载场站/港口映射（yardIds 等），**不承载 local 费率**。→ 本次费率更新**只落 handover 模块**，customs 不动。
- 单条 local charge 结构：
  ```
  { id, concept, note, taxRate,
    blRate:    { qtyHint, currency, rate },          // 按提单计的费用
    groupRates:{ <containerGroupKey>: { label, qtyHint, currency, rate } } }  // 按柜型组计的费用
  ```
  要改的「价格」= `groupRates[<group>].rate` 或 `blRate.rate`。
- 现有 JSON 由 `TARIFARIO 120426.xlsx`（4 月 12 日版）一次性转换而来（见 `generatedFrom` 字段）。**没有**自动「Excel → JSON」脚本；当前 Excel 仅作批量上传模板/人工参照，不作数据源（见 `docs/bulk-upload-design.md`）。

---

## 3. 实际 DIFF（Excel 15.06.26 vs 仓库当前 JSON）

> 比对方法：逐家读 Excel 船司 sheet 的「Cargos Locales」区，对照 `data/shipping-lines.json` 现值。下表「现值」是写入前快照。

### 3.1 MSC（6 个柜型组：gp-hq-dc / imo-dry / special-45 / imo-special-45 / reefer / imo-reefer）

| 费用项 concept | 计费 | 现值(JSON) | Excel 新值 | 结论 |
|---|---|---|---|---|
| Limpieza Básica de Contenedor | 每组 | 35（全组） | 35（全组） | 不变 |
| Merchant Haulage Admin Fee | 每组 | 20（全组） | 20（全组） | 不变 |
| **Conteiner Protection Fee** | 每组 | **25（全组）** | **GP/HQ/DC = 50；其余 5 组 = 60** | ⚠️ **改动**（且首次出现按组差异化定价） |
| Release Fee | 按提单 BL | 70 | 70 | 不变 |

- 税率 tax=0.16，柜型组结构、概念项均不变。
- ⚠️ **文件内部矛盾**：同一份 Excel 的 `ALL NAV` 汇总页第 23 行 Conteiner Protection Fee 仍显示 **28.99（= 25 × 1.16，即旧值 25）**，而 MSC 详情页是 50/60。**两页不一致** → 必须问 José：50/60（详情页）还是 25（汇总页）才是最终值？

### 3.2 KMTC（2 个柜型组：gp-hc-sd / ot-fr-rf）

| 费用项 concept（JSON 现名） | 计费 | 现值 | Excel 新值 | 结论 |
|---|---|---|---|---|
| Release Fee | 按提单 BL | 80 | 80 | 价不变；⚠️ Excel 改名 **Doc Fee at Destination** |
| Container Handling | 每组 | 35（两组） | 35（两组） | 价不变；⚠️ Excel 改名 **Container Release Fee** |
| **ISD Discharge** | 每组（免税 EX） | **45（两组）** | **15（两组）** | ✅ **改动**（高置信） |

- 「Release Fee → Doc Fee at Destination」「Container Handling → Container Release Fee」是 1:1 位置对应，金额未变，**疑似 José 改了标签**。需确认是否采纳新名称（采纳=同时改 `concept` 字符串）。

### 3.3 RCL（gp-hc-sd / ot-fr-rf）— **整体无变化**

| 费用项 | 计费 | 现值 | Excel | 结论 |
|---|---|---|---|---|
| Release Fee | BL | 90 | 90 | 不变 |
| Container Handling | 每组 | 45 | 45 | 不变 |
| ISD Discharge | 每组(EX) | 15 | 15 | 不变 |

### 3.4 HAPAG（gp-hq-dc / ot-fr-rf）— **整体无变化**

| 费用项 | 计费 | 现值 | Excel | 结论 |
|---|---|---|---|---|
| Charge Release Fee | BL(EX) | 60 | 60 | 不变 |
| Container Premium Mangement | 每组(EX) | 47 | 47 | 不变 |
| Inspection Fee at Destination | 每组(EX) | 29 | 29 | 不变 |
| Equipment Transfer at Destination | 每组(EX) | 30 | 30 | 不变 |

### 3.5 净改动汇总（确认后要写的全部内容）

| # | 船司 | 费用项 | 改动 | 置信度 |
|---|---|---|---|---|
| 1 | MSC | Conteiner Protection Fee | gp-hq-dc 25→**50**；imo-dry/special-45/imo-special-45/reefer/imo-reefer 25→**60** | ⚠️ 待确认（与 ALL NAV 矛盾） |
| 2 | KMTC | ISD Discharge | 两组 45→**15** | ✅ 高置信 |
| 3 | KMTC | Release Fee / Container Handling | 仅标签可能改名（金额不变） | ⚠️ 待确认是否采纳新名 |

---

## 4. 需 José 确认的问题（写入前必须解决）

1. **MSC Conteiner Protection Fee 到底是 50/60 还是 25？** MSC 详情页与 ALL NAV 汇总页打架。
2. **KMTC 两个标签是否改名**（Doc Fee at Destination / Container Release Fee）？还是只改 ISD Discharge 价格、保留原标签？
3. **José 说更新了 4 家，但 RCL / HAPAG 与我们数据一致**——是「确认无误」还是他以为改了但我们已是最新？告知他这一点，避免双方对「基线」理解不一致。
4. **本次只比对了 local charges**：Demoras（滞期）和 Garantia（押金）未逐项比对。Excel 里这两块也有数据（如 HAPAG 押金 25000 MXN、WAN HAI 备注「SI HASTA JULIO」、ALL NAV 押金按 `20/40 SD HC` 与 `Especial` 两档分列，而我们 JSON 的 `guarantee.ratesByGroup` 目前每组同价）。**是否需要一并核对滞期/押金？** 建议作为独立一轮。

---

## 5. `ALL NAV` 汇总页的两个关键发现

### 5.1 元数据（船司代码 / 税号 / 码头）—— 我们目前没存全

`ALL NAV` 给出每家船司的权威元数据：`CODIGO DE NAVIERA`（船司代码）、`RFC / TAX ID`（墨西哥税号）、`TERMINAL`、`GARANTIA`（按柜型分档）。

| 船司 | CODIGO | RFC / TAX ID | TERMINAL | 全称补充 |
|---|---|---|---|---|
| CMA CGM | VD-CMACGMMRS | FR72562024422 | TIMSA | |
| MAERSK | VD-MAEU_MX | DK53139655 | ICAVE / SSA | |
| ZIM | ZIM_MEX | 520015041 | | |
| MSC | MEDSHIACA | MSM980902IM6 | OCUPA | |
| ONE | ONE_MEX | 201708450C | SSA | |
| PIL | VD-PILSHI_MX | PSM231215QG9 | SSA | |
| WAN HAI | WANHAI_MX | WHL2209281Q2 | OCUPA | |
| HAPAG | **HAPLLOMEX** | **HME980911KW7** | OCUPA | HAPAG LLOYD |
| EVERGREEN | EVER_MEX | ESA1805216L9 | CONTECON | |
| COSCO | COSCO_MEX | CSM150218UV0 | CONTECON | |
| OOCL | OOLU_US | 8502583000 | | |
| YANG MING | VD-REPMARATA | RMA500422PT2 | SSA | |
| KMTC | KORMARACA | KMA250220IJ8 | OCUPA / SSA | Korea Marine Transport Co. Ltd. |
| RCL | AGENAVMEX | ANT250220BU2 | OCUPA / SSA | Regional Container Lines |

**仓库现状（核实）**：JSON 只在 `notes.code` 存了部分船司代码（MSC=MEDSHIACA、KMTC=KORMARACA、RCL=AGENAVMEX），**HAPAG 是 `"NO ASIGNADO"`**，**RFC/税号一个都没存**。
→ 顺手可补：HAPAG 代码填 `HAPLLOMEX`；并新增一个 `rfc`/`taxId` 字段把税号全部存进去（开发票要用）。属增量优化，可与本次一起做或单列。

### 5.2 7 家「新供应商」占位（= José 的新增需求）

`ALL NAV` 底部列出 7 家**只有名字、没有代码/费率**的船司：

> **ESL (Emirates Shipping Line)、SINOKOR、SL、SEA LEAD、TS LINES、HMM、SINOTRANS**

这正是 José 说的「业务增长带来的新供应商」。目前是占位，**等 José 给这 7 家的 local 费率 / 押金 / 滞期 / 码头**后才能入库。

---

## 6. 系统能力缺口（已在 `src/server.js` 核实）

| 能力 | 现状 | 证据 |
|---|---|---|
| 编辑已有船司费率（改 rate/concept） | ✅ 有 | `POST /admin/:moduleKey/shipping-lines/:id`（save handler 已支持改 `concept` / `blRate` / `groupRates`） |
| 给已有船司加子项 | ✅ 有 | `.../local-charges/add`、`.../demurrage-rule-sets/add`、`.../terminal-mix/add` |
| **新建一家船公司** | ❌ **没有** | handover 模块**没有** `POST /admin/handover/shipping-lines`（无 `:id` 的创建路由）；代码里没有任何「创建 shippingLine」逻辑。对比之下港口/场站都有 `/add` |
| **Excel → JSON 批量导入** | ❌ **没有** | `docs/bulk-upload-design.md` 设计了「下载模板→填写→上传→校验→预览 diff→确认写入」，但 server 里没有 multer/workbook 解析/上传路由；当前只有模板**生成**（`npm run templates:excel`） |

> 结论：本次 2 处费率改动，**可在后台 UI 直接改**（前提是生产部署的分支已含 2026-06-16 的 H1–H4 编辑修复）；但**新增船司 UI 做不到**，必须改 JSON。

---

## 7. 如何把「本次更新」落地（两条路，二选一）

### 路 A（推荐，立即可做）：直接改 `data/shipping-lines.json`

确认第 4 节问题后，按第 3.5 节改这几处（只动 handover 模块）：

```
modules.handover.shippingLines[id=msc].localCharges[concept="Conteiner Protection Fee"].groupRates:
    gp-hq-dc.rate            : 25 -> 50
    imo-dry.rate             : 25 -> 60
    special-45.rate          : 25 -> 60
    imo-special-45.rate      : 25 -> 60
    reefer.rate              : 25 -> 60
    imo-reefer.rate          : 25 -> 60   （★ 以 José 确认 50/60 为准；若他说维持 25 则本条作废）

modules.handover.shippingLines[id=kmtc].localCharges[concept="ISD Discharge"].groupRates:
    gp-hc-sd.rate            : 45 -> 15
    ot-fr-rf.rate            : 45 -> 15

（可选，若 José 确认采纳新标签）
    kmtc … concept "Release Fee"        -> "Doc Fee at Destination"
    kmtc … concept "Container Handling" -> "Container Release Fee"
```

- 改完跑 `npm run smoke`（或现有 smoke-test）验证报价不崩。
- 生产生效方式按现有部署流程（JSON 即数据源）。

### 路 B：后台 UI 手改

进 handover 模块 → 对应船司编辑页 → 改 MSC Conteiner Protection Fee 各组、KMTC ISD Discharge → 保存。
**前提**：先核实生产分支是否已含 H1–H4 编辑修复（否则可能存在「改不了/保存丢失」的旧 bug）。

> 本次改动小、风险低（概念项/柜型组/税率结构都已存在，只换数字），但因第 4 节有 2 个未决问题，**建议 José 确认后再写**，不要先斩后奏。

---

## 8. 如何「新增船公司」（José 的长期问题）—— 三条路径

| 路径 | 现状 | 适合 | 工作量 |
|---|---|---|---|
| **A. 手改 `shipping-lines.json`** | 立即可用 | 一次性、少量、技术人员操作 | 低 |
| **B. 新建「新增船公司」后台 UI** | ❌ 未实现 | José 运营自助、长期主线 | 中 |
| **C. 打通 Excel 批量导入** | 设计完成、代码未做 | 一次性导入多家 / 批量维护 | 中-高 |

**建议**：短期用 A 兜底（这 7 家新供应商等 José 给齐费率后手工入库）；中期做 B（运营自助，一劳永逸）；C 视新供应商规模再定。

### 新增一家船司所需字段清单（从 `ALL NAV` 列推导，作为 onboarding checklist）

无论走 A/B/C，新增一家船司需要 José 提供：

1. **基本信息**：`name`、`code`（CODIGO DE NAVIERA）、`rfc`（税号，开发票用）。
2. **码头 / terminal mix**：挂靠哪个码头（OCUPA/SSA/CONTECON/ICAVE/TIMSA…），多码头时各自占比 `ratio`。
3. **柜型组 containerGroups**：如 `GP HC SD` / `OT FR RF`，或 MSC 那种 6 组。
4. **Local charges**：每条 = 概念名 + 计费基准（按提单 BL / 按柜 CNTR）+ 金额 + 币种 + 是否含 IVA(+IVA)。
5. **Garantia 押金**：按柜型档（`20/40 SD HC` vs `Especial`）+ 币种 + 是否有 garantía 减免（BENEFICIO）。
6. **Demoras 滞期**：免费天数（Corte de demoras）+ 分档费率（按天数区间、按柜型组）。
7. **Arrival Notice / 备注**。

---

## 9. 待办（按顺序）

- [ ] **Chandler/José**：确认第 4 节 4 个问题（尤其 MSC 50/60 vs 25）。
- [ ] **Claude**：José 确认后，按第 7 节路 A 改 `data/shipping-lines.json`（只动 handover）→ 跑 smoke → 出改后 diff 复核。
- [ ] **核实生产分支**：确认 H1–H4 编辑修复是否已上线；若已上线，告知 José 这两家可后台自助改。
- [ ] **元数据增量**（可选）：补 HAPAG code=HAPLLOMEX、新增 `rfc` 字段存全部税号。
- [ ] **立项「新增船公司」功能**（路径 B）：UI 新增船司（local charges / 押金 / 滞期 / 柜型组 / 码头 mix）。这是 José 业务增长刚需，且 7 家新供应商已在排队。
- [ ] **等 José 提供 7 家新供应商费率**（ESL/SINOKOR/SL/SEA LEAD/TS LINES/HMM/SINOTRANS）后入库。

---

## 10. 归档位置

- Excel 原件：[`docs/client-info-source/TARIFARIO 15.06.26.xlsx`](./TARIFARIO%2015.06.26.xlsx)（已纳入版本控制，本目录 `.gitignore-note.md` 明确客户原始 xlsx 应随仓库管理）。
- 本分析报告：`docs/client-info-source/20260619_jose_shipping_line_rate_update.md`（即本文件）。
