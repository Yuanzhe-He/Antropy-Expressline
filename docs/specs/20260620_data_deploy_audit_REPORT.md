# 数据上生产 + 全面落地审计报告 — 2026-06-20 (round-r3-data)

> 承接 PR#11 混合批的两个缺口：① CONTENTO 真价补全 ② B/C/E 数据进 Supabase。
> Chandler 要"多检测别再出问题"。本报告含 5 项审计 + 生产诊断 + patch 方案。

## 0. TL;DR
- **Part 1 ✅**：26 个 CONTENTO 场站全部填入真价（3800–5850 MXN，来自 PDF ANEXO A），无占位、无编造。
- **Part 2 ⏸ 待 Chandler 拍板**：诊断发现**生产有 José 手改**（CMA doc fee 50、ZIM 改名、COSCO 改价、KMTC ISD 已 15、José 自建 2 个场站）→ **db:seed 会清掉这些，必须用外科式 patch**。已备份、已写 patch 脚本、dry-run 验证 19 处改动且保留 José 全部手改。**唯一停下点：等 Chandler 批准执行 `--apply`。**
- **Part 3 审计 1–5 ✅**：全部通过，发现 2 个低危项（见 §3）。

---

## 1. Part 1 — CONTENTO 真价（已完成）
[src/lib/contento-yards.js](../../src/lib/contento-yards.js) 26 场站 maniobra 从占位填成真价：
Servimaniobras 3800 / Contecon 4100 / Fali 4300 / SICE·Hadron 4500 / Emilu·Hazesa·Aflex 4800 / (Container Care·SLTC·Mepacsa·Express Port·Hazesa KMCT·SSA·Ocupa) 5300 / Impala Terminals 5350 / (ISL·Consignataria·Damco) 5400 / (Alman·Shanghai) 5500 / Impala Containers 5600 / (Alsecont·CIMA) 5800 / (PTD·TEP) 5850。
洗箱 limpieza 标准 550（冷柜 750 / open top 1150 in note）。验证：26/26 真价、0 占位、0 pendiente note。

---

## 2. Part 2 — 数据上生产（诊断 + 备份 + patch，待批准写入）

### 2.1 备份（已完成，回滚锚点）
`backups/prod-shipping-data-2026-06-20T21-26-51-678Z.json`（2.18 MB，sha256 `773788975641e865…`）。
（backups/ 已 gitignore，全量生产快照留本地，不进仓库。）**没备份不写生产 — 已满足。**

### 2.2 生产诊断（关键发现：生产有 José 手改）
对比 prod Supabase app_state vs 基线 30be381（去归一化噪音后）：

| 类别 | 发现 | 处置 |
|---|---|---|
| **José 手改的费率** | CMA-CGM "Documentation Fee at Destination" BL 45→**50**；ZIM 改名 "Import Container"/"Borrar"；COSCO "Container Release"/"International Ship" 改价 | **必须保留** |
| **José 已自己改的** | KMTC ISD Discharge 已是 **15**（= 我们 B1 目标，他在后台改过了） | patch 幂等（已 15） |
| **José 自建的场站** | `customs-yard-1778049481142`("新场站 4")、`customs-yard-1781136630412`("新场站 5") | **必须保留** |
| **本批要落地的(B/C/E)** | KMTC 两改名、14 家 rfc、HAPAG/ONE code、26 CONTENTO 场站 | patch 写入 |

**结论：生产不是纯 seed，有 José 后台手改 → `db:seed` 全量覆盖会清掉这些 → 必须外科式 patch。**

### 2.3 落地方式建议
| 方式 | 安全性 | 结论 |
|---|---|---|
| **A. 外科式 patch（推荐）** | 只改 B/C/E 字段，保留 José 全部手改 | ✅ **采用** |
| B. db:seed 全量覆盖 | 清掉 José 手改（CMA50/ZIM/COSCO/自建场站） | ❌ **不可用**（诊断证明有手改） |

### 2.4 patch 脚本（dry-run 已验证，待 --apply）
[scripts/patch-prod-data.js](../../scripts/patch-prod-data.js)：dry-run 默认，`--apply` 才写，写前再备份；`saveAppState` 原样写（不全量归一化）保 José 数据形状。
**dry-run 19 处改动**：E 14 rfc + HAPAG code + ONE code；B KMTC 2 改名（ISD 幂等）；C 删 3 假场站、加 26 CONTENTO、**保留 José 2 个自建场站**。
可选 `--with-shells`：另建 7 家空壳（ESL/SINOKOR/SL/SEA LEAD/TS LINES/HMM/SINOTRANS，仅 name，待 José 给费率）。

### 2.5 写入后抽查清单（待 apply 后执行）
- prod `/admin/handover/shipping-lines/kmtc` 显示 Doc Fee at Destination / Container Release Fee + ISD 15。
- prod KMTC rfc 字段有值（KMA250220IJ8）、HAPAG code=HAPLLOMEX。
- prod `/admin/customs/shipping-lines` 场站列表含 26 CONTENTO（有真价）+ José 的"新场站 4/5" 仍在。
- José 手改未丢：CMA doc fee 仍 50、ZIM/COSCO 改动仍在。

---

## 3. Part 3 — 全面审计（1–5 全过）

### 审计 1 — 代码 vs 数据落地（最重要）
**机制**：生产 Supabase。改代码→部署自动生效；改 module 实例数据(JSON)→需 db:seed/patch/后台手改。

| 改动项 | 类型 | 落地状态 | 证据/补法 |
|---|---|---|---|
| 报价模板行（墨 11 + 非墨 12=23） | **代码常量** quote.js | ✅ 已生效 | prod ocean_mexico 渲染 OCEAN FREIGHT/PORT OF ORIGIN |
| 报价模式 quoteMode/QUOTE_MODES | 代码+normalizer | ✅ 已生效 | prod 有模式选择器 |
| 车型 7 档（box_53 等） | 代码 inland-vehicles | ✅ 已生效 | prod inland 显示 box_53/lowboy/short_8t… |
| 柜型 master（20）/集装箱税号字段 | 代码 normalizer | ✅ 已生效 | prod handover master=20 |
| 双语名 nameZh/nameEs | 代码 normalizer + 数据 | ✅ 字段生效；值已在 | prod 44 目的地有 nameZh/Es |
| fee codes（345）/i18n/inland catalog | 代码/CSV | ✅ 已生效 | bundled with deploy |
| O3 fixedCharges basis/required/amount | 代码 normalizer | ✅ 字段生效 | 随读归一化 |
| **14 家费率值/charges** | **Supabase 数据** | José 手改活在生产 | 本批不动（除 B KMTC） |
| **B KMTC 改名 / E rfc·code** | **Supabase 数据** | ❌ 未生效 | **patch 补** |
| **C CONTENTO 场站** | **Supabase 数据** | ❌ 未生效 | **patch 补** |
| 备注库/headerDefaults 值 | Supabase 数据 | José 版活在生产（notes=5） | 不动 |
| 新车型各目的地费率 | Supabase 数据 | 新档=0 待 José | 已知，待数据 |

**结论：历批多为代码（功能/模板/类型/normalizer）→ 部署即生效（已逐一在生产核实）。唯一未生效的数据值=本批 B/C/E，patch 补。** 没有发现"以为上线其实没上"的历史功能缺口（模板/车型/模式都在生产验证存在）。

### 审计 2 — CONTENTO 填价后回归 ✅ 3/3
[audit-contento-test.js](../../scripts/audit-contento-test.js)：26 场站真价 round-trip（20 柜型键、MXN+IVA、无 0）；maniobra+limpieza 进 dropoff 成本（2×40GP=8700）；空 shippingLineIds 在选中船司时被排除（inert）。

### 审计 3 — 新增船司深测 ✅ 6/6
[audit-new-carrier-test.js](../../scripts/audit-new-carrier-test.js)：只填 name（code/rfc=null）建成合法空壳；重名→去重 id `ts-lines-2` 不覆盖；空名拒绝；删除带费率+场站引用的船司→级联干净(handover+customs 镜像+yard.shippingLineIds)且兄弟不动；customs 镜像同步；7 家空壳幂等。

### 审计 4 — 全局 CRUD 回归 ✅
smoke + quote 9/9 + r2-o3 + r2-batch3 + d-add(12/12) + audit-contento(3/3) + audit-new-carrier(6/6) 全绿。新增 name/code/rfc 输入未破坏既有船司编辑（smoke+d-test 覆盖费率/押金/滞期保存）。

### 审计 5 — XSS 回归 ✅
全仓无裸 `<%- JSON.stringify`；script 内 JSON 全走 safeJson（5 视图）；新 UI（创建表单/删除按钮）全用转义 `<%=`，无新增注入点。

### 发现的问题（低危）
| # | 严重度 | 位置 | 说明 | 建议 |
|---|---|---|---|---|
| F1 | 低 | server.js 新增船司 add | 允许重名船司（去重 id，不覆盖） | 可选：建前查重名给提示。当前安全。 |
| F2 | 低 | 数据机制 | 改数据需 patch/seed 才进生产，易被忽略 | 已写 LESSONS + 本报告；后续数据轮先诊断。 |

---

## 4. 回归汇总
smoke ✅ · quote 9/9 ✅ · r2-o3 ✅ · r2-batch3 ✅ · d-add 12/12 ✅ · audit-contento 3/3 ✅ · audit-new-carrier 6/6 ✅。

## 5. 爆炸半径
- 代码：仅 contento-yards.js（值）+ 2 个新脚本（patch/shells，不在请求路径）+ 2 个审计脚本。**无 server/store/view 逻辑改动**（除 Part 1 的数据值）。
- 数据：本地 JSON 仅 yards 值区块。**生产写入待批准**（patch 外科式，保 José 手改）。
