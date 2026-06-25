# CC PROMPT(全量)— 部署 Phase 1(多测) + Phase 2 数据修复(OOCL 末段开口)

> 接 docs/specs/CODEX_PROMPT_tarifas_save_unblock.md 与 20260624_tarifas_save_bug_RESEARCH_AND_PLAN.md(根因=demoras 表单校验门,和存储无关;Claude 已审 PR #25 + Phase 2 脚本签发)。本轮:**部署 Phase 1(Chandler 批准,要多测,不计 token)** + **Phase 2 把 OOCL 末段改开口后 dry-run,--apply 仍 gated**。
>
> **Chandler 的两个决定**:
> 1. **部署 Phase 1**(合 PR #25 → main → Railway 生产)。要**比常规更充分地测**(不计 token 成本)。
> 2. **OOCL `gp-hq-dc` 最后一档 = 开口 `[20-∞]`**(不是有界 `[20-24]`)。依据:滞期费行业标准是阶梯递增、最高档"thereafter"一直收到柜子离场;有界会让第 24 天后免费占柜,违背目的。Claude 已联网确认。
>
> **铁律**(不变):不写 live `app_state` blob;relational 写只经 store facade per-entity/saveModule;任何 prod 数据写必须 备份+dry-run 默认+`--apply` 才写+写后读回校验+可回滚;STORAGE_MODE 保持 relational;不碰 joyas/punas/备份/migrator creds;**importes 一律逐字保留、不臆造**;每阶段有 gate,不过就停下报告别强推;做完交 Claude 审。

---

## PART 1 — 部署 Phase 1(PR #25)+ 加强验证

### 1a. 合并前回归(本地,充分)
- `npm run test:all` → 必须 17/17 全绿(含新 resilience + relational round-trip 测试)。
- `npm run quote-test` → 9/9(**证明报价/计算零影响** —— Phase 1 不碰报价逻辑,但显式跑一遍坐实)。
- **真实坏数据的本地复现**(不计 token,值得做):用最新冻结 prod 快照(或只读拉 prod 的 MSC/WHAN HAI/OOCL demurrage),在 JSON 模式起真 app,对**这三家各模拟一次**「改一个非 demoras 字段(如某 localCharge 的 concept 或一个 terminalMix 名)+ demoras 原样重交」的整页 POST,断言:(a) 请求不再整单失败;(b) 那个非 demoras 改动**落库**;(c) 坏 demoras 规则集**逐字节不变**(原子跳过);(d) flash 是 `lineSavedExceptDemurrage` 且点名坏集。这比合成用例更能证明修复对**真实坏数据**有效。
- **【gate】** 上述全过 → 继续部署。任一不过 → 停下报告,不合并。

### 1b. 合并 + 部署
- 合并 PR #25 → main → Railway 自动部署到生产。
- 记录新 deploy id + commit。

### 1c. 部署后验证(生产,充分;**不改真实数据**)
- 健康:`/healthz` 正常、`railway variables` 确认 `STORAGE_MODE=relational`、日志无 egress 异常 / 无 402 / 无 5xx。
- **行为中立**:对**某家未受影响船司**做一次「无改动重交」→ 期望 `lineSaved`(原行为)。
- **解套验证(三家)**:对 MSC / WHAN HAI / OOCL **各做一次真实但可逆的非 demoras 小编辑**(例如:给某 localCharge 改个 concept 文本,记下原值;或加一行 terminalMix),保存 → 期望:
  - 成功 + flash 是 `lineSavedExceptDemurrage`(坏 demoras 被跳过、点名);
  - 该非 demoras 改动**确实落库**(读回确认)——**这就是 Estefani 之前做不到的事**;
  - **随后把这个测试编辑改回原值/删掉**,确保生产数据不因验证而变化。
- **未变确认**:确认三家的 demoras 规则集在以上验证后仍是原状(无改动重交不应改动任何数据)。
- **【gate】** 行为中立通过 + 三家非 demoras 编辑确认能落库且已还原 + 健康正常 → Phase 1 完成。否则回滚部署、报告。

---

## PART 2 — Phase 2 数据修复(先把 OOCL 改开口,再 dry-run;`--apply` gated)

### 2a. 把 OOCL 末段改成开口
在 `scripts/relational/fix-demurrage-rulesets.js` 的 `PROPOSALS.oocl["gp-hq-dc"]`,把最后一档改为开口:
```js
oocl: {
  "gp-hq-dc": [
    { startDay: 1,  endDay: 14,   copyFromIndex: 0 }, // free 1-14
    { startDay: 15, endDay: 19,   copyFromIndex: 1 }, // orig "1-5" -> 15-19  ($150)
    { startDay: 20, endDay: null, copyFromIndex: 2 }, // orig "6-10" -> 20+ OPEN-ENDED ($160) — demurrage 最高档持续计费
  ],
},
```
(其余 MSC / WHAN HAI 提案不变。)

### 2b. dry-run 并产出最终 before/after
- `node scripts/relational/fix-demurrage-rulesets.js`(只读)。
- 产出全部三家、每个规则集、每层 `start/end/importe/currency` 的 before/after 表。
- **自检**:每个 AFTER 过 gate(脚本里 `gateReason`=null)、`importesPreserved`=true、OOCL `gp-hq-dc` 最后一档显示 `[20-∞ …]`(不再有 BOUNDED warning)。
- **把这张 before/after 表完整贴出来**给 Chandler(尤其 OOCL 三档的实际 importe —— Chandler 要核对最后一档是 $160 还是应改成别的数)。
- **【gate — 停在这里】** dry-run 通过且表已贴出 → **停下报告,等 Chandler 确认天数+OOCL 末档费率**。**未确认前绝不 `--apply`。**

### 2c.（确认后才做)`--apply`
- Chandler 确认 before/after(及 OOCL 末档费率)后,执行 `node scripts/relational/fix-demurrage-rulesets.js --apply --jose-confirmed`。
- 脚本会:写前备份受影响 carriers 行到 `backups/`(+sha)、单事务经 `store.saveCarrier()`(relational per-entity)写回、写后读回校验(每个规则集过 gate + importes 不变 + 行数零漂移)。任一校验失败 → 自动报错 + 给 `--revert` 命令。
- `--apply` 后:`npm run quote-test` 9/9 + 对这三家受影响柜型做一次 demoras 报价 before/after 对比(数据修复改了天数,交付对比让 Chandler/José 看清影响)。
- 线上 UI 实测:对 MSC / WHAN HAI / OOCL 各编辑一条 demoras 保存 → 现在应能存(不再被拦)。

---

## 完成(交 Claude 审)
- 报告:Part 1 合并前回归(含真实坏数据复现)+ 部署 id + 部署后验证(三家非 demoras 编辑确能落库且已还原);Part 2 OOCL 改开口 + dry-run before/after 全表 +(确认后)`--apply` 读回校验 + 报价 before/after 对比 + 线上 demoras 编辑实测。
- 确认:live blob 未写、STORAGE_MODE 仍 relational、备份就位、报价零意外漂移、joyas/punas 零接触、验证用的临时编辑已还原。
- 结尾 Post-task routing。
