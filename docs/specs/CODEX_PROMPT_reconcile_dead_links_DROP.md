# CODEX/CC PROMPT — 8 个死 carrier→yard 链：无损 DROP + 沙盒验证（cutover 前最后一块去风险）

> 决定：DROP 这 8 个死链（cma-cgm/maersk/zim/msc → 已删 demo yard = 悬空指针，无损）。
> ⚠ off-ramp：若 José 本意这 4 个船司要【真实】yard 映射、demo yard 只是占位 —— 那就**别跑这个**，把 José 要的具体 yard 给 Chandler，改写 remap prompt。本 prompt 是 DROP 路径。
> 全部在沙盒 fnczokogchlhutyskbdw（已含真生产快照）。**零生产接触、零生产写。**

## 1. 做什么
1. 在 migrate-forward 的 normalization 里，把【指向不存在 yard 的 carrier→yard 引用】显式丢弃（drop dangling ref），并**逐条 loud log**：哪个 carrier 的哪个引用、指向哪个已删 yard ID 被丢了（可审计）。
2. **区分清楚，别一律静默吞**：只丢"指向集合里不存在的 ID"的悬空引用（目标已删 = 无损）；若出现【别的】类型 orphan（指向的 ID 其实存在、只是没正确进集合），仍然 abort/报告——只解决"悬空到已删 yard"这一类。
3. 这条 normalization 成为迁移的固定行为（cutover Step 3 会在真生产 blob 上跑同一套），所以现在在真生产快照上验证 = 验证 cutover 会做的事。

## 2. 沙盒验证（打 fnczokogchlhutyskbdw 的真生产快照）
- 重跑 migrate-forward（含上面的 drop）+ Q4 orphan 闸 + Q5 currency 闸 → 闸 PASS、parity=0。
- reverse==normalize + forward 幂等。
- José 手改抽查完好：CMA doc fee=50 / KMTC ISD 15 / ZIM 改名 / COSCO reprice / 2 自建 yard / 7 空壳 carrier。
- integration + test:all 在 relational/dual 真数据下全绿。

## 3. 报告（关键安全检查）
- 贴：被 drop 的 8 条引用清单（carrier → 已删 yard ID）、parity 报告、两闸结果。
- **post-drop 状态**：CMA-CGM / Maersk / ZIM / MSC 这 4 个船司在 drop 之后**还有没有别的有效 yard 映射、还是变成 yard-less**？逐个列出来——这样 Chandler 能判断"某船司没 yard"会不会影响实时报价。
- 若有任何船司 drop 后 yard-less 且看起来不对 → 标出来等 Chandler 看，别当成已解决。

## 4. 收尾
- commit 这个 reconcile（分支 feature/refactor-godfiles 上）。
- **仍停在生产 cutover 线**——这是沙盒验证 drop，不是生产 cutover。
- .prod-blob-snapshot.json + 沙盒继续留着（验证用），别提交快照。
- 结尾用 docs/AI_AGENT_PROJECT_RULES.md 的 Post-task routing 块（Cursor 格式）。
- 唯一该停 = 闸命中 / parity≠0 / 某船司 drop 后异常 yard-less；除此做完报告。
