# CC PROMPT(全量)— tarifas 收尾:git 提交核对 + 合并 PR #26 + 最终验收

> 接 docs/specs/CODEX_PROMPT_tarifas_step3_apply.md(Phase 2 已 --apply + 验证 + 缓存 clobber 事故已恢复)。tarifas 保存 bug 整条线**功能上已闭环**:Phase 1 修复上线(PR #25→deploy 1ff586bd)、Phase 2 数据修复已应用验证(deploy b50dfe49)、app_state reader 结案。本轮唯一目的:**把记录提交干净、合并 PR #26、跑最终验收,确认没有任何悬空**。
>
> **铁律**:不写 live app_state blob;STORAGE_MODE 保持 relational;不碰 joyas/punas/备份/migrator creds;合并触发的部署要确认健康;做完交 Claude 审。

---

## PART A — git 提交核对
- `git status` + `git log --oneline -8`:确认 main = ee9cc46(PR #25 已合)、当前分支、工作树状态。
- 列出所有**未跟踪 / 未提交**文件。重点确认这些**该跟踪**的文档/prompt 是否已提交,没提交的提交掉:
  - docs/specs/20260624_tarifas_save_bug_RESEARCH_AND_PLAN.md
  - docs/specs/CODEX_PROMPT_tarifas_save_unblock.md
  - docs/specs/CODEX_PROMPT_tarifas_step2_deploy_datafix.md
  - docs/specs/CODEX_PROMPT_tarifas_step3_apply.md
  - docs/specs/CODEX_PROMPT_tarifas_closeout.md(本文件)
  - docs/specs/CODEX_PROMPT_app_state_reader_probe.md
  - docs/LESSONS.md(本次新增条目)
- **确认 .gitignore 仍挡住**:backups/、.env.prod-migrator、.prod-migration-pin.json、blob 快照(.prod-blob-snapshot.json 等)。这些**绝不能进 git**——逐一确认 `git status` 里看不到它们。
- 把该跟踪但未提交的文档提交(信息如 `docs: tarifas save-bug research + codex prompts + lessons`)。backups/secrets 保持忽略。

## PART B — 合并 PR #26
- 审 PR #26 的 diff:应**只**含 Phase 2 工具(scripts/relational/fix-demurrage-rulesets.js)+ 验证/测试 + docs/LESSONS.md。逐项确认:**无任何密钥、无 prod 数据/备份 json、无 .env**。
- 合并 PR #26 → main。注意:这会触发 Railway 部署,但内容是 scripts+tests+docs(**非 app 运行时代码**),功能上是 no-op;部署还会顺带冷启动**刷新 app 缓存**(无害,反而再确认缓存新鲜)。
- 记录新 deploy id;确认部署成功 + `/healthz` 正常。

## PART C — 最终验收
- 线上 prod sanity:**badRuleSets=0** across 全部 21 家船司;`STORAGE_MODE=relational`;`/healthz` 正常;usage-guard 无告警、无 egress 异常 / 0×402/5xx。
- **对照原始 doc(ERRORES PAGINA TARIFAS v2)逐项确认现在都能存**:MSC / WHAN HAI / OOCL 三家 × {naviera 头部、terminalMix(PROBABILIDAD TERMINAL)、cargos locales、demoras、conceptos} 全部可保存(Phase 1 解套非 demoras + Phase 2 修好 demoras → 现在应 `lineSaved`)。可用「一次只读 + 一次可逆编辑再还原」确认,**别留下测试改动**(MSC 的 gp-hq-dc 日-18 规整除外,那是 canonical、已留)。
- `npm run test:all` 全绿(19/19 或更多)。

## 完成(交 Claude 审)
- 报告:PART A git 状态 + 提交了哪些文档 + 确认 secrets/backups 仍被忽略;PART B PR #26 合并 + deploy id + 健康;PART C prod sanity(badRuleSets=0)+ doc 逐项可保存确认 + test:all 结果。
- **明确回答**:还有没有任何未提交 / 未部署 / 悬空的东西。
- 结尾 Post-task routing。
