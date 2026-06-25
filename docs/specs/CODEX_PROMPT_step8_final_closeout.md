# CC PROMPT(全量)— Express Line 迁移最终收尾:提交剩余产物 + backlog 落定 + 全仓 NUL 扫描 + 闭环核验

> 接 PR #29(Step 8 提交 + 播种守卫 + 迁移终审 + backlog 盘点已 merge/部署 ef4f715f)。本轮把**所有还该现在做的**一次清掉:(1) 提交 PR #29 后才写、尚未提交的两个收尾产物;(2) 按 Chandler 决策落定 backlog 提交;(3) 全仓扫描有没有别的文件被 stray NUL 搞成隐形二进制(store/index.js 上轮中招、已修,怀疑是类问题);(4) 最终干净态核验 + 迁移闭环确认。
>
> **Step 7(路由层按实体写)本轮不做**——刻意 park(触发=上多实例前),clobber 当前由单实例+缓存失效纪律已堵住。不要动 admin 路由写粒度。
>
> **铁律**:只碰 `expressline` schema;joyas/punas 零接触。**精准 git add,绝不 sweep**;每个 commit 前 grep 确认无 secrets/backups/.env/.prod-migration-pin。代码改动行为不变、可测。做完交 Claude 审。

---

## PART 1 — 提交剩余收尾产物 + 落定 backlog
`git status` 核对当前未跟踪/改动。按下面三组处理,**逐 path 精准 add**,合到**一个 PR**(可分多个语义化 commit):

**(1) 本轮收尾产物(必提交)**
- `docs/specs/MIGRATION_COMPLETE_20260625.md`(上轮写的迁移完成记录)
- `docs/LESSONS.md` 的新条目(上轮的 seed-guard + NUL 教训)
- commit msg 例:`docs(migration): commit Step 8 closeout records (migration-complete + LESSONS)`

**(2) 批准提交的 backlog**
- **项目记录**:`docs/specs/*` 的 prompt 文档、`docs/DATABASE_SCHEMA.md`、`docs/AI_WORKFLOW_*` 报告、`AI_AGENT_PROJECT_RULES.md`(及同类纯项目/dev 记录)
- **AI agent 规则**:`AGENTS.md`、`CLAUDE.md`、`.cursor/`、`.ai/`
- **关税源数据(仅 csv)**:`data/source-tarifario-2026.csv`
- commit msg 例:`chore(repo): track project records, agent rules, and tariff CSV source`

**(3) gitignore,不提交**
- 把 `supabase/.temp/` 加入 `.gitignore`(瞬态 CLI 状态);commit msg 例:`chore(gitignore): ignore supabase/.temp transient CLI state`

**(4) 本轮一律不提交、原样留着(Chandler 后续单独定)**——**不要 add 这些**:
- `client-info-source/` 下的日志(`00*_chandler_log`)、`jose_meeting_notes`、`CONTENTO_*`(客户内部记录,仓库读权限归属待 Chandler 确认)
- `data/TARIFARIO 15.06.26.xlsx`(3.4MB 二进制,Chandler 单独定)
- 报告里明确列出这些"已留作 Chandler 决策"。

**提交前硬检查**:对每次 `git diff --cached --name-only` 跑 grep,确认 `backups/`、`.env*`、`.prod-migration-pin.json`、任何 secret、以及上面 (4) 的 client 笔记/xlsx **都不在**暂存集。若有意外,停下报告。

- 【gate】三组 commit 暂存集正确(无 secrets/backups、无 (4) 项)→ 继续。

## PART 2 — 全仓 stray NUL / 隐形二进制扫描 + 行为不变修复
**背景**:上轮发现 `src/lib/store/index.js` 有个不可见 NUL 字节(`path.join("\0")`),让 git/GitHub 把整个文件当二进制、diff 全被隐藏;已修为空格(只是 Map 去重分隔符、行为不变)。怀疑是类问题。

- 扫描所有**应为文本**的已跟踪文件(至少 `src/`、`scripts/`、`docs/`、根级 `*.md`、`*.json`、`*.js`)里有没有嵌入的 NUL 字节 / 被 git 当成二进制的(例如 `grep -rlP '\x00'` 跨这些路径,或检查 git 对各文件的 binary 判定 / `.gitattributes`)。
- 对每个命中:判断该 NUL 是否真该在(几乎肯定不该);若是误入,**行为不变地**修掉(像 store/index.js 那样:确认它只是无语义的分隔/填充、不被当字符串比较或解析,再替换为安全字符),逐个在报告里说明"在哪、原本起什么作用、为何替换后行为不变"。
- 若发现的 NUL 处于**有语义**的位置(被解析/比较),**不要擅改**,停下报告交 Claude/Chandler 判。
- 改完 `test:all` 全绿。
- 【gate】扫描完成 + 命中(若有)已行为不变修复或已上报 + test:all 绿 → 继续。

## PART 1+2 合并部署
- PR(PART 1 的几个 commit + PART 2 的修复 commit)合并 main → Railway 部署。
- 部署后:`/healthz` 200、STORAGE_MODE=relational、prod 终态仍 `{ shipping-data-retired-20260625, users }`、badRuleSets=0、关系表行数零变化、无 egress 异常/0×402/5xx。
- 【gate】部署健康 + 终态不变 → 继续。

## PART 3 — 最终干净态核验 + 迁移闭环确认
- `git status` 确认:除 PART 1(4) 刻意留下的 client 笔记/xlsx 外,**没有其它本该跟踪却未提交的 dev/项目产物**(即仓库对"该跟踪的东西"已干净)。
- 更新 `docs/specs/MIGRATION_COMPLETE_20260625.md`(它本身这轮才提交,可在同 PR 或追一笔):标注迁移**已 100% 闭环**,并列出**剩余非代码项**(都不是 bug、不影响运行):
  - **刻意 park 项 + 触发**:(a) 退役 blob 行硬 DROP=唯一不可逆,更长窗口后或永不做;(b) Step 7 路由层按实体写=上多实例前必做,当前单实例+缓存纪律已堵 clobber。
  - **Chandler 手动项**:沙盒 `fnczokogchlhutyskbdw` 可删(本轮不删);client-info-source 笔记/3.4MB xlsx 的提交决策;(业务侧)向 José/Estefani 告知 WHAN HAI+OOCL 历史报价 $0 滞期、修复后未来报价含滞期。
  - **过时但已 fail-loud 的 cutover 脚本**(上轮已列,勿删):prod-write-roundtrip.js 等。
- 【gate】干净态核验通过 + 完成记录终稿 → 完成。

## 完成(交 Claude 审)
- 报告:PART 1 三组 commit 的暂存集(含 grep 确认无 secrets/backups/无 (4) 项);PART 2 NUL 扫描结果(命中清单 + 每个的行为不变说明,或"无命中")+ test:all;合并部署后 /healthz + 终态 + badRuleSets=0;PART 3 干净态核验 + 完成记录终稿 + 剩余项清单。
- 确认:只动 expressline、joyas/punas 零接触、精准提交无 secrets、client 笔记/xlsx 未提交、关系表数据零变化、退役终态不变。
- 结尾 Post-task routing。
