# CODEX/CC PROMPT — Express Line cutover 前【生产数据 dry-run：沙盒里跑真生产数据｜只读生产一次，全部在沙盒】

> 目的：在不可逆的生产 cutover 之前，把 runbook Step 3-4 那些"只能在 cutover 跑"的生产数据闸（Q4 orphan / Q5 currency / parity on real data）**提前在沙盒里用真生产数据跑一遍**，把惊喜消灭在 cutover 之前。这是"在 cutover 前安全地一次性做尽量多"的那一步。
> 安全口径：生产【只读一次】expressline.app_state（我们自己的数据，不碰 joyas/punas）；所有迁移/写/验证全在沙盒 fnczokogchlhutyskbdw。**零生产写。**

## 0. 铁律
1. 生产【只读】：唯一对生产的动作 = 一条 `select payload from expressline.app_state`（只读 Express Line 自己的 blob）。**绝不**碰 public.joyas_*/punas_*，**绝不**对生产写任何东西、不建表、不改。
2. 所有 mutation（建表、迁移、写、改）全在沙盒 fnczokogchlhutyskbdw。
3. guard：读生产那一步，断言 DATABASE_URL ref == 生产 polxyashvxbzdkkmxuox 且 SQL 只 `select ... from expressline.app_state`（不许其他表/schema）；写/迁移那些步，沿用 sandbox-guard 断言 ref == 沙盒。

## 1. 步骤（一个连续 run，做完报告，不中途停）
1. **抓真生产 blob（只读）**：连生产、`select payload from expressline.app_state`，存到 gitignore 的文件（如 .prod-blob-snapshot.json，先确保进 .gitignore）。报告大小 + sha256。只读，不写生产。
2. **灌进沙盒**：把这份真生产 blob 灌进沙盒 fnczokogchlhutyskbdw 的 expressline.app_state（覆盖沙盒里的 seed），作为 dry-run 输入。
3. **跑全套迁移工具链（打沙盒）**：
   - 正向迁移 blob→表（migrate-forward）。
   - Q4 orphan 闸（gates.js orphanGate）—— 这次跑【真生产数据】，José 的 method-B yard↔line 映射在这里才暴露。
   - Q5 currency 闸（currencyGate）—— 扫真生产 blob 币种。
   - parity（parity.js）—— blob 投影 vs 表 = 0 + §C 的 José 手改抽查（CMA 50 / KMTC 15 / ZIM 改名 / COSCO reprice / 2 自建 yard / 7 空壳 carrier）。
   - reverse==normalize（migrate-reverse）+ forward 幂等。
4. **关系/dual 模式跑测试（打沙盒、真数据）**：integration + test:all 在 relational/dual，确认真数据下也绿。
5. **报告**：每个闸/parity 在【真生产数据】下的结果。重点列出：seed（14 carriers）没暴露、但真数据暴露的任何 orphan / 杂币种 / parity 偏差。**有就列出来、停下等 Chandler 决定怎么 reconcile，不自行绕过。**

## 2. 这一步证明了什么 / 没证明什么（诚实）
- 证明：真生产数据能干净地迁成关系表、parity=0、两个闸通过 —— 把 cutover Step 3-4 的风险提前消化。
- 没证明：生产实际切换（dual/relational 部署、José 编辑窗口、生产读写延迟）—— 那些还是 cutover 的逐步硬闸。
- 这一步之后，真 cutover 的 Step 3-4 基本是"对同一份数据重跑一遍已验过的东西"，惊喜大幅减少。

## 3. 收尾
- 报告 + dry-run 产物（parity 报告、两闸结果、测试结果）。
- 生产零写、joyas/punas 零接触的证明（唯一生产 SQL = select expressline.app_state）。
- ⚠ .prod-blob-snapshot.json 是真生产业务数据 → 必须 gitignore、不提交；dry-run 完即删（别久留 disk）。沙盒里现在也含一份生产数据快照 → cutover 后（或你说删时）一并 supabase projects delete。
- 结尾用 docs/AI_AGENT_PROJECT_RULES.md 的 Post-task routing 块（Cursor 格式）。
- 唯一该停 = 闸命中 / parity≠0（停下等 reconcile）；除此一路做完报告。
