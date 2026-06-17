# 00k — 第N+11轮（厘清3模式真实状态 + 非墨段全列决策 + 出prompt）

> 00j 续篇。最新轮次。

## 2026-06-17 第N+11轮 — 3模式澄清纠正 + Chandler决策

**Chandler关键纠正（我之前两次把3模式说重了，纠正记录）**：
- Chandler点出："不是说就分成两个——墨西哥的花费和非墨西哥的花费吗？海运、其他国家头程的等，都是墨西哥外的。"
- **这是对的。José说的"3种模式"本质=两段框架(墨西哥/非墨西哥) + 模式开关 + 币种**，不是三种不同报价单结构。

**Claude重新核实后的真实状态（read quote.js确认，比之前乐观得多）**：
| 项 | 状态 |
|---|---|
| 两段框架(MEXICO LOCAL / NO MEXICO) | ✅ 批次2 Q7.3已做(section字段 server.js:1547) |
| 墨西哥段费用项预填 | ✅ **已做**(QUOTE_TEMPLATE_ROWS含换单费/换单服务费/集装箱超期/码头操作费/堆存费/进口清关/单拖/双拖/超重费/压车费/进口税金=José墨西哥段11项) |
| USD/MXN币种+含税口径 | ✅ 双价做了(MXN不含税/USD含16%) |
| 费用代码字典+autofill | ✅ Q8/Q10做了 |
| 单位列/备注选择器/四块 | ✅ 都做了 |
| **非墨西哥段(NO MEXICO)预设费用项** | ❌ **这才是真正没做的小块**——海运费/AMS/起运港费用目前要手填，没做成预设 |

**纠正我之前的错误说法**：
- 错说1"模式切换逻辑没做"→实际两段框架+墨西哥段预设+币种口径都做了，只差非墨段预设项。
- 错说2"卡在缺费率表"→费率不缺，墨西哥段José给了且已预填；非墨段价格José模板也给了。

**Chandler决策**：
1. 非墨西哥段费用项→**按José模板全列**(海运段+起运港段全做成预设)
2. CNY确认不用→非墨段全用USD(起运港那些原CNY价折USD或按模板USD等价)
3. 不计CC的token成本

**José模板非墨西哥段内容（来自README归档，全列）**：
- 海运段：海运费 2700 USD/柜、AMS 30 USD
- 起运港段(原CNY，现折USD)：订舱费400 / THC1020 / EIR30 / 文件费450 / 安保费30 / 封子50 / VGM50 / 舱单100 / 报关费100 / 电放450（原CNY单位，折USD或按等价USD预设）

**本轮要做（下一批）**：
- 给NO MEXICO段加预设费用项(海运段+起运港段全列，USD)
- 加"报价模式"开关：模式一(仅墨西哥段) / 模式二(墨西哥+非墨西哥段)。选模式一→NO MEXICO段空/隐藏；选模式二→两段都预填
- 模式×币种(USD/MXN)组合：USD含VAT、MXN不含VAT(已有口径沿用)
- 非墨段起运港原CNY→按Chandler决策折USD(或固定USD等价，prompt里让CC用模板USD值，CNY项给合理USD预设并标注待Jose确认汇率)

**本轮防compact写入**：00k_chandler_log_round11.md（本文件）+ README待会议补充章节更新（3模式落地结论）

---

## 2026-06-17 第N+11轮 — 落地完成（feature/quote-modes）

**两块都做完，分支 feature/quote-modes：**

**块1 非墨段(NO MEXICO)预设**——QUOTE_TEMPLATE_ROWS 加 12 行 section="foreign"（排在墨西哥段前）：
- 海运段(OCEAN FREIGHT)：海运费 FRT 2700 USD/柜、AMS 30 USD/票
- 起运港段(PORT OF ORIGIN，原CNY→USD，每行remarks标注"待José确认汇率/USD"）：订舱费BKG 400 / THC OTHC 1020 / EIR(无码,译名待审) 30 / 文件费ODOC 450 / 安保费OSECU 30 / 封子SEAL 50 / VGM 50 / 舱单MANI 100 / 报关费ECCLR 100 / 电放TLX 450（全USD）
- 三语 conceptEn/Zh/Es 全列；QUOTE_GROUP_ORDER 加 OCEAN FREIGHT/PORT OF ORIGIN；workbench 行项 category 下拉与 public/quote.js 改为 data-driven（含 7 类）。

**块2 报价模式开关**——quoteMode 字段："mexico_only"(模式一,仅墨西哥段) | "ocean_mexico"(模式二,海运+墨西哥段)：
- 存 draft + normalizeQuoteDraft（老draft无→默认mexico_only=现有行为，向后兼容）。
- headerDefaults 加 quoteMode（admin 设默认，S5）。
- workbench 顶部模式选择器，change 自动 submit 重载；reconcileLineItemsForMode 幂等（模式一删 foreign 行；模式二 foreign 缺则前置整块）。
- PDF：复用现有 groupRowsBySection（空段自动不渲染）→ 模式一无 foreign 行→自动不显示 NO MEXICO 段，无需改模板。
- 模式 × 币种正交：USD 含 16% VAT / MXN 不含税（沿用 R4 双价口径，未动）。

**验收**：quote-test 9/9 ✅ + smoke（加 mode×currency + 切换 + back-compat 断言）✅ + 深度 HTML 渲染 30/30（模式一/二 × EN/ZH/ES/双语，段显示/隐藏 + 价格 + 含税口径）✅。墨西哥段 11 项数字未变。

**待 José**：起运港 10 项最终 USD 价/汇率；EIR 西/中译名审。
