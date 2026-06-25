# CC PROMPT(v2 全量)— 解套+根治「PAGINA TARIFAS 不保存」(MSC / WHAN HAI / OOCL)

> 根因已由 Claude 独立读码核实 + CC 在真实 prod 数据复现。背景证据详见 `docs/specs/20260624_tarifas_save_bug_RESEARCH_AND_PLAN.md`(先读它)。本 prompt 是合并增强版(Claude 在 CC 原 unblock 上加了 Phase 0 排除续费时间线、原子性修正、Phase 1 可独立解套的定性)。
>
> **一句话根因**:船司编辑页保存时,对该船司**所有** demoras 规则集做严格「天数单调递增 + 开口规则必须放最后」校验(`src/lib/rule-engine.js` `applySequentialRuleUpdates` :218-266)。MSC/WHAN HAI/OOCL 的**存量** demoras 不合法 → handler(`src/routes/admin-shipping-lines.js` :614 的大编辑 POST,demoras 循环 :737-769)在唯一保存调用 `await saveModule("handover", ...)`(:788)**之前** `redirectWithFlash('error')` 整单中止 → 同页改的 cargos/terminales/conceptos/主档**全被丢弃** =「nothing saves」。
>
> **与 blob→relational 切换无关**:这是纯表单校验门,blob 模式同样拦。CC 已对手排除所有存储假设(relational 写路径无辜、`carrier_local_charges.concept` NOT NULL / `numeric(8,4)` / CHECK 对真实 prod blob 全量 decompose **0 违规**、DDL 不抛、缓存写后即失效、部署版本与分析版本在保存路径上逐字节相同)。切换只是时间巧合。**恰好 {msc, whan-hai, oocl} 中招、其余 18 家正常保存** —— 与客户反馈逐字吻合。
>
> **坏数据清单**(来自真实冻结 prod blob 经 `normalizeShippingData`):
> - **MSC**(`openEndedRuleMustBeLast`):`imo-dry`/`special-45`/`imo-special-45`/`reefer`/`imo-reefer` 多个规则集带「中间位开口规则」(`endDay=null` 非末位,历次编辑残留);`gp-hq-dc` 合法。
> - **WHAN HAI**(`invalidRuleRange`):`gp-hc-sd` `[0]0-7 free,[1]end=3 < nextStart=8`;`ot-fr-rf` 同。
> - **OOCL**(`invalidRuleRange`):`gp-hq-dc` `[0]0-14 free,[1]end=5 < nextStart=15`;`ot-fr-rf` 合法。
> - 两种坏法:**(A) 中间开口残留**;**(B) 免费层后计费层用「相对天数」从 1 重数**。**importes 都对,错的只是天数序列。**
>
> **铁律**:不写 live `app_state` blob(冻结回滚锚点);relational 写只经 store facade 的 per-entity/`saveModule` 路径;任何 prod 数据写必须 **备份 + dry-run 默认 + `--apply` 才写 + 写后读回校验 + 可回滚**;`STORAGE_MODE` 保持 `relational`;不碰 joyas/punas / 备份 / migrator creds;**不臆测 demoras 天数**(业务值等 José);报价/计算核心不改;每阶段有 gate,不过就停下报告**别强推**;做完交 Claude 审。

---

## Phase 0 — 线上只读确认 + 排除「Supabase 续费时间巧合」(gate,~5 分钟)

Chandler 提了个时间线疑问:**会不会是前天 Supabase 超配额(写被 402 挡)导致存不了、昨天续费后其实已经好了?先把这个排除掉。**

1. 只读 SQL(as postgres, relational):`SELECT id, demurrage->'ruleSets' FROM expressline.carriers WHERE id IN ('msc','whan-hai','oocl');` 确认仍是上面坏数据形态。
2. 查 Railway app 日志,这 3 家的 `POST /admin/handover/shipping-lines/:id`:
   - 返回是 **302 + flash `admin.invalidRuleRange` / `admin.openEndedRuleMustBeLast`**(校验门)——**不是** 5xx、**不是** Supabase 402 / quota / `canceling statement due to ...` / 连接错误。
   - 对照其余 18 家:它们返回 `admin.lineSaved`。**「恰好 3 家失败、18 家成功」本身就排除配额** —— 配额/402 会让全部 21 家的写都失败,不会精确只挑这 3 家。
3. **确认现在还是这样**(回答 Chandler 的「看看现在是否还是这样」):日志里要有**续费后/今天**的失败记录;或安全地在线上对这 3 家之一点一次保存 → 看到的是校验 flash,而非 `lineSaved`、也非 402。
4. 顺手 `railway variables` 确认 `STORAGE_MODE=relational`(排除环境漂移)。

- **【gate】** 坏数据在 + flash 是校验门 + 非 402 + 恰好这 3 家 → 确认根因,继续。若 flash 是 `lineSaved`(已自愈)或出现 402/quota → 停下报告(根因或时间线需复核)。

---

## Phase 1 — 代码加固(durable 根治;**单独就能完全解套,不依赖 José,先上**)

**定性(重要)**:加固后,所有非 demoras 编辑(cargos/terminales/conceptos/主档)立即落库;且因为每个规则集**独立**校验,José 还能**一次修一个** demoras 规则集(把某个改合法就存某个),CC 计划里提到的「必须 6 个规则集一次性全合法」的死锁**就此解除**。所以 Phase 1 不必等 José、可立即上线解套;Phase 2 是把 3 家批量修干净的自动化手段。

改 `src/routes/admin-shipping-lines.js` 大编辑 handler(`app.post("/admin/:moduleKey/shipping-lines/:id", ...)` ~`:614`;若 6 个 demoras 子路由有同构「整单中止」也一并处理):

- demoras 校验从「任一失败即整单 `redirectWithFlash('error')` return」改为**隔离失败**:
  - 先应用所有**非 demoras** 编辑(name/notes/invoice/guarantee/localCharges/terminalMix/`demurrageCutoffHandledBy`)—— 维持现逻辑。
  - demoras 循环:对每个规则集**先在副本上**跑校验+更新(见下「原子性」),**合法 → 提交该副本;不合法 → 保持该规则集库内原样(不丢、不悄改报价),记 `skipped={ruleSetName, motivo}`,`continue`,不 return**。
  - 循环结束后照常 `await saveModule("handover", shippingData)`。
  - flash:`skipped` 空 → 原 `admin.lineSaved`;否则 success 文案 + 新西语 i18n key(如 `admin.lineSavedExceptDemurrage`):`Se guardó todo excepto las reglas de demoras de «<sets>» — revisa los días (<motivos>)`,尽量带锚点/高亮到那几个规则集。
  - 效果:操作员真正在改的 cargos/terminales/conceptos **立即落库**;坏 demoras 规则集不再锁死整页,并明确告诉操作员去修哪一个。

- **【原子性 — 务必】** `applySequentialRuleUpdates` 当前是**就地 mutate** `rules` 数组、失败时**中途 return**(此时 rule.startDay/endDay 已被改一半)。所以「保持原样」必须真是原样:对每个规则集**先 `structuredClone` 它的 rules**,在 clone 上跑 `applySequentialRuleUpdates`;`ok` → 把 clone 写回该规则集;`!ok` → 丢弃 clone、原 `rules` 一字不动。否则会留下「半更新的脏规则集」(比 bug 本身更隐蔽)。(等价做法:把 `applySequentialRuleUpdates` 重构成纯函数 / 先全量校验再 mutate —— 但 clone 法改动最小、最稳,推荐。)

- 保持 `assignmentsByContainerType` / `freeDays` 计算对「被跳过的规则集」稳健(被跳过的集仍能被引用、不抛错)。
- **不改** `applySequentialRuleUpdates` 的校验语义本身(操作员当前正在编辑的合法序列仍严格)。

测试(进 `test:all`):
- 新增 `scripts/audit-demurrage-save-resilience-test.js`:构造一家船司,一个规则集带「中间位开口规则」、一个带「免费层 + 相对天数」;同 POST 还改一个 localCharge concept/rate + 一个 terminalMix。断言:(a) 路由**不再**整单失败;(b) localCharge/terminalMix 改动**已落库**;(c) 两个坏规则集**保持原样**;(d) flash 含警告并点名它们;(e)**【原子性回归】**坏规则集没有被留下半更新状态(其 rules 的 startDay/endDay 与改动前逐字段一致)。
- 补 **relational 模式**「编辑→保存→读回」往返覆盖纳入 `test:all`(把 `scripts/relational/integration-test.js` 等价用例纳入,或新增顶层 `*-test.js`)—— 堵住「`test:all` 只跑 JSON 模式、relational 写路径不在 CI 网内」的真实缺口(这正是放过本类回归的根本原因)。

- **【gate】** `npm run test:all` 全绿(含新测试)→ 独立 PR → 合并 main → Railway 部署 → 先对**某家非受影响船司**编辑一项保存确认 `lineSaved`(行为中立验证)→ 再对 MSC 编辑一个 cargo+terminal 保存,确认 cargo/terminal **落库** + 坏 demoras 被跳过+警告。不过 → 回滚部署、报告。

---

## Phase 2 — 数据修复(彻底修好 3 家 demoras;**gated on José 天数确认**)

新增 `scripts/relational/fix-demurrage-rulesets.js`(复用 relational-repo/relational-map + store facade;`STORAGE_DRIVER=postgres`、`STORAGE_MODE=relational`;postgres creds;走 `assertProd` 守卫):
- **默认 dry-run**:扫**全部 21 家**船司每个规则集,标出违反不变量者(预期命中 ≥ {msc,whan-hai,oocl});对坏的产出「机械规整提案」(保留 importes,仅修天数序列):
  - **坏法 A(中间开口)**:删/合并陈旧中间开口规则,`resequenceRules` 重排 startDay。
  - **坏法 B(相对天数)**:免费层 `0-N` 后,计费层改**绝对天数**(`N+1` 起顺延),保留每层 importe。
- 输出 **before/after 表**(每家 / 每规则集 / 每层 start/end/importe/currency)给 José 审。
- `--apply` 才写:先备份受影响 carriers 行到 `backups/`(+ sha),单事务,经 `store.saveCarrier()`(per-entity, relational)写回;写后读回:每个规则集过 `applySequentialRuleUpdates`(dry 模拟)= 全 ok、importes 不变、行数零漂移、其它字段不动。
- `--revert`:从备份还原。

- **【gate】** dry-run 提案交 José 确认天数(见下「需 José 拍板」)。**确认前不得 `--apply`**。`--apply` 后读回校验全过 + `npm run quote-test` 9/9 + 对这 3 家受影响柜型做 demoras 报价 before/after 对比并随报告交付(数据修复会改天数,José 须知情)。

---

## Phase 3 — 线上验收

- 线上 UI 实际编辑 MSC / WHAN HAI / OOCL 各一项(一个 cargo + 一个 terminal)保存 → 确认 `lineSaved` + 改动可见;再编辑各自一条 demoras 保存确认可改。
- `/healthz` 正常、无 egress 异常、usage-guard 无告警。

---

## 需 José 拍板的唯一一件(只阻塞 Phase 2 `--apply`,**不阻塞 Phase 1**)

这 3 家 demoras **免费层之后的计费层,天数是绝对还是相对?** importes 已知且保留,只缺天数语义:
- **WHAN HAI** `gp-hc-sd`/`ot-fr-rf`、**OOCL** `gp-hq-dc`:免费 `0-N` 之后,计费层是从第 `N+1` 天起(**绝对**)还是从计费第 1 天重数(**相对**)?
  - Claude 绝对天数提案:WHAN HAI `gp-hc-sd` → `0-7 free / 8-10 = $140 / ≥11 = $155`;OOCL `gp-hq-dc` → `0-14 free / 15-19 = 原(1-5)importe / ≥20 = 原(6-10)importe`。
- **MSC** `imo-dry`/`special-45`/`imo-special-45`/`reefer`/`imo-reefer` 的中间 `>5`/`≥4` 开口规则:是**陈旧残留可删**,还是应为某**有界计费层**(如 `6-7`)?
- **Claude 判断**:坏法 B 看金额 + 标签像「免费期后逐日升档」,**绝对天数最可能对**;MSC 的重复中间开口**像编辑残留**。但天数驱动报价,必须 José 对着真实船司 tariff 确认,Claude 不臆测。

---

## 完成(交 Claude 审)
- 报告:Phase 0 证据(含排除 402/续费时间线、确认现在仍复现)、Phase 1 代码改动 + 测试(含原子性回归)、Phase 2 dry-run 提案 + José 确认 + `--apply` 读回校验 + 报价对比、Phase 3 线上验收。
- 确认:live blob 未写、`STORAGE_MODE` 仍 relational、备份就位、joyas/punas 零接触。
- 结尾附 `Post-task routing` 块(按 `docs/AI_AGENT_PROJECT_RULES.md`)。
