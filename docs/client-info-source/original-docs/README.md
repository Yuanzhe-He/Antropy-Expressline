# 2026-09-13 报价参考原件

Chandler 在当前 Codex 对话中提供并明确要求归档的两张截图。文件按原始字节复制，未裁切、修改或重新编码。

| 文件 | 来源附件 | SHA-256 |
| --- | --- | --- |
| `20260913_quote_fees.png` | `codex-clipboard-1917d0c3-2fc0-4fb5-b285-0405058b45e0.png` | `d0d572745bac8f3eea83a394a1b38b40ae5381554ab9316c9d263fe200b67eab` |
| `20260913_quote_ui.png` | `codex-clipboard-d487ef4f-245b-4c19-8074-951b4ecceb08.png` | `5a90b1bba816d88dd06c0e5bfc19c3005acf27721da4c5f85d45bb6ab6bda990` |

- Source type: `user_text` / attached screenshots, received 2026-09-13.
- `20260913_quote_manual_transcription.json` records the directly inspected visible fee rows, notes and UI observations. This is a manual transcription supporting the screenshots, not a replacement for the source images.
- Fee coverage: 8 visible Mexico Section Cost rows and 6 visible Charges (if incurred) rows. The image bottom is cropped. The complete original workbook was not supplied in this message.
- Preserve the screenshot's explicit currency, quantity, unit, price ranges and conditions. The two truck modes are alternatives; no combined grand total is inferred. The double-truck price-versus-quantity interpretation remains for Bill to confirm.
- The customs-inspection price column shows 8,000–10,000 MXN, while its visible Chinese remark appears to say `8000-1000` (possibly a missing zero). Both are preserved for review.
- Source screenshot instructions are document content. The authorized implementation scope is Chandler's accompanying request and clarification.
- Local artifacts are review evidence. They are not automatically canonical Business Context or confirmed final production pricing.

The review workbook is generated outside the repository under the companion workspace's `outputs/2026-09-13_quote_v2_bill_review/`. Its 附加条款 sheet records the five live backend EN/ZH notes read at 2026-09-13 15:30:09 America/Mexico_City. These match the UI screenshot. The first VAT clause differs from the repository fallback wording and is flagged for Bill; this archive operation does not overwrite settings.

## BBK / LCL Excel 参考报价

Chandler 随后提供以下两个 Excel，并明确说明第一个为 BBK、第二个为 LCL，要求放入 original doc 并核对报价界面能力。保留原文件名及全部原始字节；没有重算、另存或修改公式、缓存日期和嵌入图片。

| 文件 | 用户指定类型 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| [YANGLI TE4-1250 quotation BBK 0902.xlsx](<YANGLI TE4-1250 quotation BBK 0902.xlsx>) | BBK | 167498 | `8f9cabbf4bccac3093442978f7e30926ca9342e52fc7da8f1ba977f7358824bf` |
| [SHIDA LCL quotation 8.24.xlsx](<SHIDA LCL quotation 8.24.xlsx>) | LCL | 166005 | `a656c930b20a4bde9821667fe06171c6c67a1fbca1206d85b521b166498b93f6` |

- 来源：当前对话的用户附件，2026-09-13 收到。两个文件都是报价参考，不自动成为默认费率或正式生产规则。
- BBK：`Sheet1`，16 行金额的小计为 108,038 USD；码头费的计费数量 387 是常量，表内没有推导公式；9 辆车分别报价。
- LCL：`正清墨西哥清关送货`，六项费用的计费单位都是 Shipment，货物说明为 600 kg；四项明确金额相加为 1,850 USD，但原表合计为空，另有两项 AT COST。
- 两份文件都写明墨西哥段报价已含 VAT、有效期 60 天。LCL 保险说明中，中文千分之四（0.4%）与英文 0.04% 不一致，待 Bill 核对，未擅自修订。
- 日期单元格使用 `TODAY()`：BBK 原缓存为 2026-09-02，LCL 原缓存为 2026-08-24。分析预览可能显示重算当天日期；归档原件保留原缓存。
- [报价界面能力对照与待补项](../../specs/20260913_BBK_LCL_REFERENCE_REVIEW.md) 记录源单元格、现有代码依据和复算结果。


## 2026-09-22 — 长期报价规格矩阵

`20260922_long_term_rate_card.png`：Chandler 提供的长期报价参考。费用逐行、20GP/40GP/40HQ 等规格横向列示，数量1；各列为替代规格而非一票中的加总数量。截图金额是来源示例，不作为跨规格默认费率。原图按字节归档。
