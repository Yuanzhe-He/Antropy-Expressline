# CC PROMPT(全量)— Step 8 提交 + 播种守卫加固 + 迁移终审 + backlog 盘点

> 接上轮:Step 8 可逆退役已执行(prod 终态 `expressline.app_state = { shipping-data-retired-20260625 (rev 215132), users }`),但**未提交**(4 个新 scripts/relational/ 工具 + 2 处 doc 编辑留作审查)。本轮做四件事:(1) 提交 Step 8 工作;(2) **把退役制造的"播种隐患"用对称守卫永久焊死**;(3) 迁移终审 + 完成记录;(4) 盘点未跟踪 backlog(只报告、不提交,交 Chandler 定)。
>
> **Step 7(路由层 saveModule 整模块写→saveCarrier 按实体写)本轮不做**——已作为"刻意推迟项"(触发=上多实例前),当前 clobber 由单实例+缓存失效纪律已堵住。不要在本轮动 admin 路由的写粒度。
>
> **铁律**:只碰 `expressline` schema;joyas/punas 零接触。每步 gate,不过就停。**精准 git add,绝不 sweep**;提交前确认 secrets/backups/.env/.prod-migration-pin.json 不在暂存集。代码改动最小化、可测。做完交 Claude 审。

---

## PART 1 — 提交 Step 8 工作(工具 + 文档)
- `git status` 列出本轮 Step 8 产生的未跟踪/改动文件。应是:`scripts/relational/retire-blob.js`、`scripts/relational/cleanup-stray-shipping-data.js`(及本轮新增的其它 scripts/relational/ 工具)+ 2 处 doc 编辑(`docs/specs/20260622_blob_to_relational_CUTOVER_RUNBOOK.md` 的 Step 8 执行记录、`docs/LESSONS.md` 的退役+re-seed 教训)。**以 git status 实际为准**,不要假设。
- **精准** add 上述文件(逐个 path,不 `git add -A`/`.`)。**提交前确认**:`backups/`(含退役存档 json)、`.env*`、`.prod-migration-pin.json`、任何 secret **都不在**暂存集(它们应已 gitignore;若有意外出现,停下报告)。
- 一个 PR(可两个 commit:commit1=Step 8 工具+文档;留 PART 2 的代码改动作为 commit2 进同一 PR)。review diff。
- 【gate】暂存集只含 Step 8 工具+文档、无 secrets/backups → 继续(PR 合并放到 PART 2 之后一起部署)。

## PART 2 — 播种守卫加固(把退役制造的隐患永久焊死)
**背景**(已由 Claude 读代码确认):`src/lib/store/index.js` 的 `getShippingData()` 里,**relational 读路径已有守卫**(表空时先查 blob,blob 非空就 throw 拒绝播种,只有都空才播种);但 **blob/dual 读路径缺这半边**——blob 缺失时直接播种+写库,没先查关系表是否非空。退役后 blob 没了,一进 blob 模式就播种 demo 数据(上轮 CC 踩到的 stray re-seed)。

- **改 `getShippingData()` 的 `blob | dual` 分支**:在"`storedData` 缺失 → 播种"那条路径上,**对称补上 relational 路径已有的守卫**:播种前先查关系表是否非空(用与 relational 守卫**完全相同的判空语义**,即 `getShippingTablesAssembled()` 真值=表非空);若表非空 → **throw** 一个清晰错误(例如:"app_state.shipping-data MISSING 但关系表 NON-EMPTY —— 拒绝在退役/迁移后状态上播种 demo 数据;进 blob 模式前请先用 prod-reverse-to-blob.js 重建 blob")。只有关系表也空(真正全新库)才播种。**改动最小**,只加这一段对称守卫,不动其它逻辑。
- **CI 测试**:加测试证明新守卫——DB 模式 + blob 缺失 + 关系表非空 → throw(不播种);全新库(两边都空)仍正常播种。CI 是 JSON 模式无真库,故用现有测试 harness 的 db 层 mock/stub 方式(stub `getAppState`→null、`getShippingTablesAssembled`→非空、`shouldUseDatabase`→true,断言 throw)。若无法干净地在 CI 覆盖,报告原因,改用下面的 prod 验证脚本兜底。
- **prod 验证脚本**(最有说服力):写一个脚本(在**自己进程的 env** 里设 STORAGE_MODE=blob,**不碰线上 app 的 STORAGE_MODE**),指向 prod(blob 已退役、关系表非空),调用 store 的 getShippingData → **断言它 throw**(而非播种出 stray)。这同时把上轮那个 cutover 期 prod-write-roundtrip.js 的隐患也变成 fail-loud。跑前确认线上 app 仍 STORAGE_MODE=relational、不受影响。
- `test:all` 全绿(含新测试)。
- 【gate】守卫已加 + 测试证明(CI 或 prod 脚本)+ test:all 绿 → 继续。

## PART 1+2 合并部署
- PR(commit1 工具+文档 + commit2 守卫+测试)合并到 main → Railway 部署。
- 部署后验证:`/healthz` 200、STORAGE_MODE=relational、prod 终态仍 `{ shipping-data-retired-20260625, users }`(守卫不改数据)、badRuleSets=0、关系表行数零变化、无 egress 异常/0×402/5xx。
- 【gate】部署健康 + 终态不变 → 继续。

## PART 3 — 迁移终审 + 完成记录
- 对照 runbook 核对 **Steps 1–8 全部完成且健康**;逐条确认当前 prod 状态(STORAGE_MODE=relational、18 表、终态、回滚路径)。
- 产出一份简洁的**迁移完成记录**(runbook 末尾追加一节,或单独 `docs/specs/MIGRATION_COMPLETE_20260625.md`):
  - 8 步全done;当前 prod 终态;**回滚路径**(prod-reverse-to-blob.js --apply → STORAGE_MODE=blob,或 retire-blob.js --revert,或 Supabase PITR,或 Phase-0 备份)——现在加上 PART 2 的守卫后,**误进 blob 模式会 fail-loud 而非播种**,回滚必须先 reverse-to-blob 重建 blob;
  - **两个刻意推迟项 + 明确触发条件**:(a) 退役 blob 行的**硬 DROP**=唯一不可逆,留作"更长稳定窗口后或永不做";(b) **Step 7 路由层按实体写**=上多实例前必须做,当前由单实例+缓存失效纪律已堵住 clobber。
- **识别现已过时的 cutover 期脚本**(会翻 STORAGE_MODE=blob 或假设 blob 存在的那些,如 prod-write-roundtrip.js):在记录里标注"已过时(迁移完成、blob 已退役);PART 2 守卫已使其 fail-loud"。可选:给这些脚本加一行注释指向该记录。**不删**。
- 记一句:沙盒 `fnczokogchlhutyskbdw` 迁移已完成、现可安全删除(Chandler 自行决定,**本轮不删**)。
- 【gate】完成记录落盘 + 终审通过 → 继续。

## PART 4 — 未跟踪 backlog 盘点(只报告,不提交)
- `git status` 列出**不属于本轮工作**的未跟踪/未提交文件(上轮 CC 提到的 pre-existing backlog:其它 CODEX prompts、AGENTS.md、CLAUDE.md、docs/client-info-source/ 日志、.ai/、.cursor/、supabase/ 等)。
- **分类 + 每类建议**(供 Chandler 决策):
  - (a) 明显该跟踪的记录:docs/specs 的 prompt 文档、docs/LESSONS.md、AI-workflow memory 等 → 建议提交;
  - (b) AI agent 规则:AGENTS.md、CLAUDE.md、.cursor/、.ai/ → 建议提交(是 agent 规则),但标出供 Chandler 确认;
  - (c) 含糊:supabase/、docs/client-info-source/ → 描述内容 + 给建议;
  - (d) 绝不提交:backups/、.env*、.prod-migration-pin.json、任何 secret → 确认已 gitignore。
- **本轮对 backlog 一个都不提交**——只产出这份分类清单,Chandler 下轮定哪些提交。
- 【gate】分类清单产出 → 完成。

## 完成(交 Claude 审)
- 报告:PART 1 暂存集(确认无 secrets/backups);PART 2 守卫代码 diff + 测试证明 + test:all;合并部署后 /healthz + 终态 + badRuleSets=0;PART 3 迁移完成记录 + 两个推迟项 + 过时脚本标注;PART 4 backlog 分类清单。
- 确认:只动 expressline、joyas/punas 零接触、精准提交无 secrets、关系表数据零变化、退役终态不变。
- 结尾 Post-task routing。
