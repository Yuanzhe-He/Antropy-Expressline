# CC PROMPT(全量)— Phase 2 --apply(已确认)+ 报价验收 + 线上实测 +(附)app_state reader 排查

> 接 docs/specs/CODEX_PROMPT_tarifas_step2_deploy_datafix.md。**PART 1(Phase 1 修复)已上线生产并验证**(deploy 1ff586bd;ZIM 对照 lineSaved;MSC/WHAN HAI/OOCL 非 demoras 编辑落库+坏集跳过 5/2/1+警告 flash;四家还原逐字节不变;健康干净)—— Estefani 已解套。**PART 2 dry-run 已产出、OOCL 末档已改开口 [20-∞] $160**。本轮:Chandler 已确认 → 跑 `--apply` + 验收 + 线上实测。Claude 已审 Phase 2 脚本(双闸/备份/读回校验)+ dry-run 输出,签发。
>
> **Chandler 已确认(发本 prompt = 确认这些)**:
> 1. 天数按 dry-run 提案:WHAN HAI `gp-hc-sd`→`1-7 free / 8-10 / 11-∞`、`ot-fr-rf`→`1-3 free / 4-6 / 7-∞`;OOCL `gp-hq-dc`→`1-14 free / 15-19 / 20-∞`;MSC 五个坏集 collapse 同费率重复档。
> 2. **OOCL `gp-hq-dc` 末档 = `[20-∞]` $160**(保留现有递增 $150→$160;脚本已是此值)。
>
> **MSC `gp-hq-dc` 日-18 缺口 — 仅知会 José,不在本次 `--apply` 范围**:MSC 的 `gp-hq-dc`(合法集,过 gate,不在 8 个坏集内)有陈旧 1 天缺口(`[15-17]` 后 `[19-∞]`,缺第 18 天)。Phase 2 脚本不碰它。引擎会在下次保存 MSC 时规整为 `[18-∞]`(第 18 天 → 计 $180)。这是可见计费变化,请 José 知悉(缺口几乎肯定是录入残留、规整为 `[18-∞]` 是 canonical)。下面 PART C 的 MSC 实测会自然触发这次规整——属预期、正确,不视作回归。**若 José 认为第 18 天不该计 $180,停下报告(那是另一处数据决策)。**
>
> **铁律**:不写 live `app_state` blob;relational 写只经 store facade per-entity/`saveCarrier`;prod 数据写=备份+写后读回校验+可 `--revert`;`STORAGE_MODE` 保持 relational;不碰 joyas/punas/备份/migrator creds;importes 一律逐字保留;每步有 gate,不过就停下报告别强推;做完交 Claude 审。

---

## PART A — Phase 2 `--apply`(已确认,写)
- 先再跑一次 dry-run 确认状态没漂移(8 个坏集、每个 AFTER 过 gate、importesPreserved=true、OOCL 末档 `[20-∞ 160 USD]`、0 blocking)。
- 执行:`node scripts/relational/fix-demurrage-rulesets.js --apply --jose-confirmed`
- 脚本会:写前备份受影响 carriers 行到 `backups/`(+sha)→ 单事务 `store.saveCarrier()`(relational per-entity)写回 8 个修好的集 → 写后读回校验(每集过 gate + importes 不变 + 行数零漂移)。任一失败 → 自动 abort + 打印 `--revert` 命令。
- 【产出】backup 文件名 + sha + applied 集数(预期 MSC 5 + WHAN HAI 2 + OOCL 1 = 8)+ 读回校验结果。
- 【gate】读回校验全过 → 继续。任一失败 → 立即 `--revert` + 报告,不往下走。

## PART B — 报价影响验收
- `npm run quote-test` → 9/9(确认整体报价回归没破)。
- **对 MSC / WHAN HAI / OOCL 受影响柜型,跑 demoras 报价 before/after 对比**:对每个受影响柜型,取几个代表性滞留天数(覆盖免费期内、第一计费档、末档,如 OOCL 取 10/17/22/30 天),算修复前 vs 修复后的 demoras 费用,列表交付。**这是让 Chandler/José 看清数据修复对真实报价的影响** —— 重点标出任何金额变化(理论上免费期+各档费率没变,只是天数边界规整,所以变化应只出现在原先"坏序列"覆盖错的天数段)。
- 【gate】quote-test 9/9 + 报价对比表已产出 → 继续。

## PART C — 线上 UI 实测(三家 demoras 现在应可编辑)
- 对 MSC / WHAN HAI / OOCL **各编辑一条 demoras**(如某档金额改一下再改回)保存 → 现在应 **`lineSaved`**(不再是 `lineSavedExceptDemurrage`,因为这三家 demoras 修复后都合法了)。
- **MSC 注意**:保存 MSC 会顺带把 `gp-hq-dc` 的日-18 缺口规整为 `[18-∞]`($180)——这是预期的 canonical 规整(José 已知会),**不要试图还原这个缺口**(它现在是 canonical 形态)。WHAN HAI/OOCL 的测试金额改动照常还原。
- `/healthz` 正常、`STORAGE_MODE=relational`、usage-guard 无告警、日志无 egress 异常 / 0×402/5xx。
- 【产出】三家 `lineSaved` 截图/日志 + MSC `gp-hq-dc` 规整后形态确认 + 健康。

## PART D(独立、只读、可后做)— app_state reader 排查
接 `docs/specs/CODEX_PROMPT_app_state_reader_probe.md`。背景:pg_stat_statements 有个 PostgREST `select * from app_state`(~14×/天)在读冻结 blob;app 走 pg pooler 不走 PostgREST,所以不是 app;punas 只 anon 读自己 ERP 表也排除;最可能是 Chandler/Estefani 切换期用 Dashboard 看表。
- 查 Supabase 日志里打到 `/rest/v1/app_state` 的 PostgREST 请求:来源 IP、User-Agent、用的 key/role(anon/service_role/authenticated)、时间分布。
- 判定:Dashboard 浏览(来自 Supabase 自有基础设施 + 与 Chandler 看表时段相关)= 无害;云端 IP + 全天均匀 + 带某 API key = 还有外部集成在读陈旧 blob,得指到新源或退役。
- 【只读】不改配置、不动 app_state、不碰 joyas/punas。
- 【产出】这 14×/天到底是什么 + 是否需处置。

---

## 完成(交 Claude 审)
- 报告:PART A backup 名+sha+读回校验;PART B quote-test 9/9 + 三家受影响柜型 demoras 报价 before/after 对比表;PART C 三家 `lineSaved` 实测 + MSC `gp-hq-dc` 规整确认 + 健康;PART D app_state reader 结论。
- 确认:live blob 未写、`STORAGE_MODE` 仍 relational、备份就位、报价仅预期变化、joyas/punas 零接触、WHAN HAI/OOCL 测试编辑已还原。
- 结尾 `Post-task routing`。
