# CC PROMPT(全量)— Step 8:退役冻结 blob(可逆改名,非硬删)

> 接 docs/specs/20260622_blob_to_relational_CUTOVER_RUNBOOK.md(Steps 1–6 已执行,LIVE in relational;Step 8 pending)。tarifas 整条线已闭环。本轮做迁移的 **Step 8——退役那个冻结的 `app_state.shipping-data` blob**,但用**可逆的改名**方式,不做不可逆的硬删除(硬删推迟到更长安全窗口后、Chandler 100% 放心时,或永不做)。
>
> **为什么**:blob 自 cutover 冻结(rev 215132),之后所有编辑只写了关系表;blob 已是过期死数据。runbook 明确:`STORAGE_MODE=blob` 直接切会丢 relational-era 编辑。真回滚路径(prod-reverse-to-blob.js 从当前表重建 + Supabase PITR + Phase-0 原始备份文件)都不依赖这行。所以这行是过期残留 + 误读陷阱(上次 app_state reader 发现的 Dashboard 浏览就是它),清理掉。
>
> **铁律**:**只碰 `expressline` schema 的 `app_state`**;joyas/punas/其它 schema 零接触。写 `app_state` 用 admin/postgres 凭据(migrator 是 app_state SELECT-only)。每步 gate,不过就停下报告。**可逆优先**:存档 + 改名(非删),保留一键 revert。做完交 Claude 审。

---

## PART A — 盘点 + 确认只退役孤立的 shipping-data
- 连 prod(admin/postgres 凭据,assertProd ref==polxyashvxbzdkkmxuox)。列出 `expressline.app_state` 全部 key 及各自 `pg_column_size(payload)` / 更新时间。
- **确认哪些 key 是 app 在 relational 模式下仍然实时读的**(grep 代码:relational 模式下 app 还从 app_state 读什么?例如 `users`/auth 等)。**只有确认 `shipping-data` 在 relational 模式下不再被 app 读**,才继续。`users` 或任何仍被读的 key **一律不动**。
- 【gate】确认 `shipping-data` 是孤立的(relational 模式下 app 不读它)→ 继续。若 app 仍读它,停下报告(说明我对状态的理解有误)。

## PART B — 存档(写前完整快照)
- 把 `app_state` 里 `shipping-data` 这一行(key + 完整 payload + 任何元数据)导出到 `backups/app_state-shipping-data-retired-20260625.json`(+ sha256)。这是精确的 cutover-era 快照,和 Phase-0 原始备份 `backups/prod-cutover-…/app_state.json` 双保险。
- 确认 `backups/` 仍被 gitignore(这文件绝不进 git)。
- 【gate】导出文件存在 + sha 记录 → 继续。

## PART C — 先证明回滚不依赖这行
- dry-run `node scripts/relational/prod-reverse-to-blob.js`(**不带 --apply**,只写 scratch key `shipping-data-rollback-test`,不碰 live `shipping-data`):确认它能从**当前关系表**重建出一个合法 blob 并通过其内部 round-trip 校验(decompose(rebuilt)==tables 等)。
- 这证明:即使 live `shipping-data` 被改名/移走,真回滚路径(从关系表重建)照样可用。
- 【gate】reverse dry-run 通过 → 继续。失败 → 停下报告,**不要改名**。

## PART D — 可逆退役:改名(非删除)
- 写一个小脚本 `scripts/relational/retire-blob.js`(dry-run 默认 / `--apply` 才写 / `--revert` 还原),admin 凭据:
  - dry-run:打印将把 `expressline.app_state` 里 key=`shipping-data` 改名为 `shipping-data-retired-20260625`(若该名已存在则报错),并显示 size。
  - `--apply`:单事务把这行的 key 改名(`UPDATE expressline.app_state SET key='shipping-data-retired-20260625' WHERE key='shipping-data'`,或等价的安全做法);写前再确认 PART B 的导出存在。
  - `--revert`:改回 `shipping-data`。
- 执行 `--apply`。记录改名前后该行存在性。
- 【gate】改名成功 + `shipping-data` 这个 live key 现在为空、`shipping-data-retired-20260625` 持有原 payload → 继续。

## PART E — 验证 app 与回滚都正常
- app 健康:`/healthz` 200、`STORAGE_MODE=relational`、启动日志无因 `shipping-data` 缺失而报的**致命**错(非致命 warn 可接受,记录下来)。
- relational 读写仍正常:对某船司做一次**可逆**的小编辑(改个值再改回,经线上 app),确认 `lineSaved` + 落库 + 还原。
- `badRuleSets=0`(全 21 家),usage-guard 无告警、无 egress 异常 / 0×402/5xx。
- **回滚演练**(只读/scratch):再 dry-run 一次 `prod-reverse-to-blob.js`(写 scratch key),确认改名后回滚仍能从关系表重建——即"退役了 blob,但安全网还在"。
- 【gate】app 健康 + relational 读写正常 + 回滚演练通过 → 完成。

## PART F — 更新 runbook
- 在 20260622_blob_to_relational_CUTOVER_RUNBOOK.md 记:**Step 8 已执行(可逆改名退役)**——live `shipping-data` 已改名为 `shipping-data-retired-20260625`(payload 完整保留、可 `--revert`);存档 `backups/app_state-shipping-data-retired-20260625.json`(sha …)。**回滚路径更新**:不再有"切 STORAGE_MODE=blob 读冻结 blob"这条(那行已退役);真回滚 = `prod-reverse-to-blob.js --apply`(从当前关系表重建 live blob)→ 切 blob 模式,或 Supabase PITR,或 Phase-0 原始备份。**硬删除推迟**:`shipping-data-retired-…` 这行的彻底 DROP 留作更长安全窗口后的可选最终清理(唯一不可逆步骤,本轮不做)。

## 完成(交 Claude 审)
- 报告:PART A app_state key 盘点 + 确认 shipping-data 孤立;PART B 存档文件 + sha;PART C reverse dry-run 通过;PART D 改名结果;PART E app 健康 + relational 读写 + badRuleSets=0 + 回滚演练;PART F runbook 更新。
- 确认:只动了 expressline.app_state、joyas/punas 零接触、导出在 backups/(gitignore)、改名可 revert、关系表数据零变化。
- 结尾 Post-task routing。
