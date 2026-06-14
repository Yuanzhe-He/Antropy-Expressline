# 报价单模板规格（Express Line × De Well）— Cotización / Quotation Template Spec

> 来源：Jose 提供的 `报价.pdf`（QUOTATION NUMBER 示例 `ELCMEX-SI-004E`，DATE `2026/1/19`）。
> 本文件是「报价 section」实现的**版式与字段权威参考**；像素级还原请同时参考原始 `报价.pdf`（建议放在本目录）。
> 设计原则：报价单是**独立的中英对照文档**，与 app 的 中/西(ZH/ES) i18n **解耦**。

---

## 1. 页眉 Header
- 左：**Express Line Corporation** logo（含 "Service Guaranteed" 副标条）
- 右：**DE WELL GROUP** logo
- 字段行：`DATE` ｜ `QUOTATION NUMBER`

## 2. GENERAL DATA 区
| 字段 | 示例值 |
|---|---|
| OPERATION | IMPORT |
| DEPARTMENT | OCEAN |
| INCOTERM | CIF |
| POL | CHINA |
| POD | MANZANILLO |
| COMMODITY | Equipment and raw materials / General container cargo |
| CARGO TYPE | FCL |
| DELIVERY | 目的地地址（示例：Lote 18, Avenida Aero Industrial, OMA VYNMSA Aero Industrial Park, Apodaca, Nuevo León, C.P. 66600） |

> OPERATION 应支持 IMPORT/EXPORT；DEPARTMENT 支持 OCEAN/AIR；INCOTERM、POL、POD、COMMODITY、CARGO TYPE(FCL/LCL)、DELIVERY 均为可填字段。

## 3. MEXICO LOCAL CHARGES 表
列顺序：`CHARGE CATEGORY` | `CONCEPT`(英文/中文双行) | `UNIT` | `UNIT PRICE` | `TOTAL PRICE` | `CURRENCY` | `REMARKS`

| CATEGORY | CONCEPT (EN) | CONCEPT (中文) | UNIT | UNIT PRICE | CURRENCY | REMARKS |
|---|---|---|---|---|---|---|
| SHIPPING LINE | DELIVERY ORDER FEE | 换单费 | 1 | AT COST | MXN | Unreasonable shipping charges will be reimbursed. |
| SHIPPING LINE | DESTINATION HANDLING FEE | 换单服务费 | 1 | 1000 | MXN | per container |
| SHIPPING LINE | DESTINATION CONTAINER DETENTION | 目的港集装箱超期费 | 1 | AT COST | USD | The default free time for container usage is 21 days |
| PORT FEES | DESTINATION PORT CHARGES | 目的港码头操作费 | 1 | AT COST | MXN | per container |
| PORT FEES | DESTINATION YARD STORAGE FEE | 目的港堆存费 | 1 | AT COST | MXN | 7 days free storage included. Charges apply beyond free time |
| CUSTOMS CLEARANCE | IMPORT CUSTOMS CLEARANCE | 进口清关服务费 | 1 | 6000 | MXN | Each customs declaration / commercial invoice |
| TRANSPORTATION | SINGLE | 单拖 | 1 | 68000 | MXN | Weight ≤ 25 tons |
| TRANSPORTATION | FULL | 双拖 | 1 | 96000 | MXN | Weight ≤ 45 tons |
| TRANSPORTATION | DESTINATION OVER WEIGHT CHARGE | 超重费 | 1 | 5000 | MXN | Per ton / Up to 5 tons |
| TRANSPORTATION | DESTINATION DETENTION | 压车费 | 1 | 6000 | MXN | 12 hours of free loading/unloading time per container per day |
| DUTY | PEDIMENTO | 进口税金 | — | Payment to the customs broker / PECE | — | — |

实现注记：
- 原模板里 `TOTAL PRICE` 多为 `0` 或 `AT COST`（报价阶段未填数量）。实现时 `TOTAL = UNIT × UNIT PRICE`；`AT COST` 行不参与计算、原样显示。
- 分组顺序固定：SHIPPING LINE → PORT FEES → CUSTOMS CLEARANCE → TRANSPORTATION → DUTY。
- 每个 CONCEPT 单元格是「英文 + 中文」双行。

## 4. NOTES（固定条款，中英对照）
1. The above prices are exclusive of VAT. A 16% VAT will be added at the time of invoicing and settlement.
2. Any costs not caused by our company will be charged based on actual expenses.
3. The transport fee excludes cargo insurance. If insurance is required, it will be 0.25% of the insured value plus 16% VAT.
4. Any exchange rate differences will be settled based on the exchange rate on the invoicing date.
5. This quotation is valid for 90 days.

## 5. 页脚 Footer
- `Express Line Corporation` 字样 + **IATA** logo + **C-TPAT** logo

---

## 6. 实现要点（已锁定的决策）
1. **数据来源 = 混合**：能对接现有 `换单/清关` 计算器的行项取计算值；其余手填或标 `AT COST`。
2. **PDF 路线 = HTML(EJS)→PDF via headless Chromium (Puppeteer)**：`page.pdf()` 输出 A4、`printBackground:true`、页眉/页脚走 Puppeteer header/footer template 或纯 CSS。需嵌入中英文字体（Noto Sans + Noto Sans CJK 或等价），确保中文 CONCEPT 不乱码。
3. **独立中英对照文档**：与 app 的 中/西 i18n 解耦，报价单自带 EN+中文。
4. **品牌资产**：Express Line / De Well / IATA / C-TPAT logo 需确认是否在 `public/`；缺则补齐（SVG/PNG）。
5. **CONCEPT 受控词表**：来自 `fee.docx` 费用代码字典（需先转写为 `code,description` CSV，见 `docs/reference/` 下的费用字典 CSV）。
