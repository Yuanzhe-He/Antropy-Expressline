# CODEX/CC PROMPT — Express Line 数据层 blob→关系表【全量关系化 + per-entity 写｜本地一口气，生产切换前硬停】

> 前提：代码重构完成（PR #22，store/index.js facade 在该分支）。先合 PR #22 进 main，本任务从 main 起新分支（未合则 stack on feature/refactor-godfiles）。
> Supabase 已续费 → 生产 cutover 不再被付费 gate（但本地构建/测试仍用非生产 DB，生产只在 §5 硬停步碰）。
> 依据 docs/specs/20260621_blob_to_relational_redesign.md。Chandler 口径：长期最好的改法、不计 token 成本 → 做【全量 Phase 2 + per-entity 写】，不是 Phase 1 半量。

## 0. 总目标 + 终态
把单 blob（app_state 一坨 JSONB）彻底迁成按实体的关系表，并把写从「全 blob 覆盖」改成「per-entity 定点写」。
终态：① 全业务数据在正规关系表（可查询/可索引）；② 读按实体（不再读整 blob）；③ 写按实体（José 改一个 port 只写那一行，不再覆盖整坨）→ 根治并发 clobber + 写 egress。

## 0.1 两个子阶段（一口气连续做，但各自独立验证 —— 为了可验证，不是为省成本）
- 为什么分：2a 是「数据表示」变化（迁移），2b 是「写行为」变化（per-entity）。塞进一个不可验证的大改，出问题分不清是迁移错还是写改错——对 José 不可逆的生产数据，可验证性是硬要求。
- 所以：2a 做完、全测试与旧行为逐字节一致、commit；再做 2b、新写粒度测试 + 并发测试绿、commit。一个 CC run 连续做完，不在中间停。

## 1. 必读（真读不靠记忆）
- 【权威 schema 设计文档：本构建 prompt 执行前必须已存在且经 Chandler 批准】docs/specs/20260621_blob_to_relational_redesign.md——**若不存在，先走“schema 设计先行”步骤产出并评审通过，再执行本 prompt**。依据 = docs/specs/20260505_*_IMPLEMENTATION_SPEC.md（storage rule sets / terminal·yard / demurrage / terminal mix）+ 20260610_editable_container_types_IMPLEMENTATION_SPEC.md + src/lib/store/normalize-* 的真实数据形状。
- src/lib/db.js（驱动 + app_state + migrateDatabase）。
- src/lib/store/{index, normalize-customs, normalize-handover, normalize-inland, normalize-quote, normalize-shipping-data, shared}（2a 建在 index.js facade 背后；2b 给 facade 加 per-entity 写方法）。
- ../_AI_WORKFLOW/core/AGENTS.md、docs/AI_AGENT_PROJECT_RULES.md、docs/LESSONS.md（尤其 file→dir __dirname/bundledDataDir footgun + normalizer parity 坑）。

## 2. Harness + 铁律
- 【非生产 DB —— CC 自取，别让 Chandler 手贴】Supabase CLI 已装、本地有 auth/keys → CC 自己用 CLI 建/取一个隔离沙盒库，不要叫 Chandler 手贴 URL。STORAGE_DRIVER=postgres + 沙盒 URL。
- 【⚠ 共享 org 隔离 = 硬约束】这个 Supabase org 由多人、3 个项目共用。CC 必须：① 先 `supabase projects list` 枚举，按 .env 里生产 host（aws-1-us-west-1.pooler.supabase.com）认出生产 ref + 另外 2 个他人项目 ref；② 新建一个明确命名的专用沙盒项目（如 expressline-mig-sandbox），**绝不复用那 3 个里的任何一个**；③ 开工先报告沙盒 ref；④ **任何 DDL/迁移/写之前，硬断言所用 DATABASE_URL 的 project ref == 沙盒 ref 且 ∉ {生产, 其他 2 个}，不符立即拒跑**。注意 schema 名 expressline 不构成隔离（生产也叫 expressline）——隔离在 project 级。
- 【本地优先，零生产接触】schema + 迁移 + 双写 + 影子读 + parity + 全测试全在这个沙盒库；那 3 个共用项目（尤其生产）一步不碰；生产只在 §5 cutover 硬停步碰。
- 【可逆】迁移脚本幂等可重跑 + 反向脚本（表→blob）。

## 3. 子阶段 2a：全量关系化（facade 不变、行为逐字节一致）
1. schema：按 plan 给【所有实体】建表（exchangeRates / inland routes·origins·destinations·rate-entries / customs ports·terminals·yards·storage-rules / shipping-lines·local-charges·terminal-mix·demurrage / handover forms / quote 备注 / users / ...）+ 索引 + FK；migration 建表不动 app_state。
2. 迁移脚本：app_state blob → 全实体表，幂等可重跑 + 反向脚本。
3. facade 内部：getShippingData 从表组装（不读整 blob）；saveShippingData 内部拆 per-entity upsert（API 签名不变）；STORAGE_MODE=blob|dual|relational 开关，blob 留 fallback。
4. 双写 + 影子读：dual 模式写 blob+表、读 blob 同时影子读表 diff；出 parity 报告。
5. parity 闸：自动 diff（行数 + 字段级）blob-projection vs 表 = 0。
6. 全测试：STORAGE_MODE=relational 跑 test:all（14 套）+ quote-test 全绿 + 报价 diff=0；dual 模式影子 diff=0。
- facade public API 逐字节不变 → routes/lib 0 改、路由 67 不变。每步 commit + test:all 绿。
- 2a 完成且全绿 = 行为-exact 检查点，commit，再进 2b。

## 4. 子阶段 2b：per-entity 写（行为改进 —— 根治并发 clobber）
1. store facade 加 per-entity 写方法（saveCustomsPort / saveInlandRoute / saveShippingLineLocalCharge / ... 对应每类实体），各自只 upsert 自己那行/那组。
2. 把 admin 写路由调用点从 saveShippingData(整坨) 改成对应 per-entity 写（José 改一个 port → 只写该 port 行，不再读改写整 dataset）。
3. 测试：给每个改过的写路由加/改断言「只动目标实体、其他实体不变」；加并发测试（两个不同实体并发写不互相 clobber）。
4. 保留 saveShippingData 作兼容入口（仍可全量写），路由默认走 per-entity。
- 这是本任务风险最集中的子阶段（动写语义、触多路由）——测试网必须覆盖每个改的写路由（Phase 0 已建 admin 覆盖，2b 在其上加目标-写断言）。每步 commit + test:all 绿。

## 5. 生产 cutover —— 【硬停，等 Chandler 逐项批，绝不自动做】
本地 2a+2b 全做完 + parity=0 + 全测试绿后，停下，给 Chandler 一份 cutover runbook（不执行）：
① 备份生产 app_state（可验证导出）。② 生产建表。③ 生产跑迁移 blob→表 + parity=0。④ 切 dual 观察窗（José 编辑双写、影子 diff 监控）。⑤ parity 持续=0 → 切 relational，blob 留 fallback 一窗口 → 之后切 per-entity 写。
- José 编辑窗口：迁移→校验→切换间 José 手改如何不丢（dual 写 + 切前最后一次 parity）。
- 每步碰生产 CC 不自动做：列出、等 Chandler 说哪步、给一步做一步。

## 6. 防 compact + 报告 + 收尾
- _ROADMAP_anti_compact.md + TodoWrite 跟 2a→2b 全子项；compact 来了读它 + git log 接着做，不当收工。
- 报告：schema（全实体）+ 迁移/反向脚本 + parity=0 + 全测试（relational/dual 绿）+ 2b 目标-写&并发测试 + facade/路由不变证明 + cutover runbook（未执行）。
- 诚实：2a 行为-exact、2b 写行为改进（更好但变了，靠测试网兜）；生产收益要等 cutover（Chandler 逐项批）。
- 结尾用 docs/AI_AGENT_PROJECT_RULES.md 的 Post-task routing 块（Cursor 格式）。
- 唯一该停 = ① 缺非生产 DB URL（真 blocker）② 生产 cutover 硬停等批；除此本地 2a+2b 一路做完。
