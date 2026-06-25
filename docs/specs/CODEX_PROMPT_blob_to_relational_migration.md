# CODEX/CC PROMPT — Express Line 数据层迁移 blob→关系表【本地全做完，但生产切换前硬停】

> 前提：代码结构重构已完成（PR #22，server.js→107 行、store.js→lib/store/ 7 模块，14/14 绿、behavior-exact）。
> 建议先合 PR #22 进 main，本任务从 main 起新分支。依据 docs/specs/20260621_blob_to_relational_redesign.md。日期 2026-06-22。

## 0. 总目标 + 本轮和代码重构的根本区别
- 把单 blob（app_state 一坨 JSONB）迁成关系表（按实体），还架构债 + 给并发修复打地基。
- 【根本区别】上一轮代码搬移可逆（git 回滚）→ 一口气冲；**本轮动 José 真生产数据、不可逆、零丢失硬约束** → 本地可逆的活一口气做完，但**任何碰生产 schema/数据的动作硬停、等 Chandler 逐项批准**。

## 0.1 诚实的收益边界（先讲清，别高估）
- egress 急性痛已被 PR #16-19 压了 ~97%（读缓存 + patchAppStateField）。
- 并发 clobber（saveAppState 全量覆盖回滚 José 编辑）是剩下的真风险，但**彻底修它要把写改成 per-entity（路由级写粒度变化）= 行为变化**，不在本轮 facade-保持的迁移里。
- 本轮直接收益 = 正规可查询/可索引 schema + 读按实体（更省 egress）+ **给 per-entity 写（真正的并发修复）打地基**；不是灭正在烧的火。per-entity 写做成紧接着的 follow-up。

## 1. 必读（真读不靠记忆）
- docs/specs/20260621_blob_to_relational_redesign.md（权威 schema 设计）+ docs/DATABASE_SCHEMA.md + src/lib/db.js（app_state / migrateDatabase / 驱动）。
- 已重构的 src/lib/store/{index, normalize-customs, normalize-handover, normalize-inland, normalize-quote, normalize-shipping-data, shared}（迁移要建在 index.js facade 背后）。
- ../_AI_WORKFLOW/core/AGENTS.md、docs/AI_AGENT_PROJECT_RULES.md、docs/LESSONS.md
  —— 尤其上轮 file→dir __dirname / bundledDataDir 那个 footgun，本轮 schema/seed 路径同类风险要警惕。

## 2. 铁律
- 【facade 不变】src/lib/store/index.js 对外 public API 逐字节不变（getShippingData / saveShippingData / 缓存 / getUsers / saveExchangeRates / RATE_GROUP_NAMES / ...）→ routes/lib 0 改动、路由数 67 不变。只换 facade 内部：blob→表。
- 【行为不变】全量 route 级测试（含上轮 14 套）在新关系驱动下与 JSON/blob 完全一致；报价 diff=0。这证明 facade 透明。
- 【本地优先，零生产接触】schema + 迁移脚本 + 双写 + 影子读 + 校验全在本地 Postgres（supabase 本地栈需 Docker；没有就 STORAGE_DRIVER=postgres 连一个一次性非生产库 —— 缺则停下问 Chandler，别碰生产）。
- 【可逆】迁移脚本幂等可重跑 + 配反向（表→blob）回滚脚本。

## 3. 本地一口气做完（这部分不许 defer）
1. schema：按 plan 设计实体表（每个 normalize-* 对应一组表）+ 索引 + FK；写 migration（建表，不动 app_state）。
2. 迁移脚本：app_state blob → 实体表，幂等可重跑；+ 反向脚本（表→blob）。
3. facade 内部改造：getShippingData 从表组装（不读整 blob）；saveShippingData 内部拆成 per-entity upsert（API 签名不变）；保留 blob 读写作 fallback 开关（STORAGE_MODE=blob|dual|relational）。
4. 双写 + 影子读：dual 模式写 blob+表、读 blob 同时影子读表并 diff；跑出 parity 报告。
5. parity 闸：自动 diff（行数 + 字段级）blob-projection vs 表，必须 = 0。
6. 全量测试：STORAGE_MODE=relational 下跑 test:all（14 套）+ quote-test，全绿 + 报价 diff=0；再跑 dual 模式确认影子 diff=0。
- 每步一 commit、test:all 绿、facade API 不变、路由数 67 不变。
- compact 不是停工理由：维护 _ROADMAP_anti_compact.md + TodoWrite，resume 接着做。

## 4. 生产切换 —— 【硬停，等 Chandler 逐项批准，绝不自动做】
本地全部做完 + parity=0 + 全测试绿后，停下，给 Chandler 一份切换 runbook（不执行）：
- ① 备份生产 app_state（可验证导出到文件）。
- ② 生产建表（migration）。
- ③ 生产跑迁移脚本 blob→表 + parity 校验=0。
- ④ 切 STORAGE_MODE=dual 观察窗（José 编辑双写、影子 diff 监控）。
- ⑤ parity 持续=0 后切 relational，blob 留 fallback 一个窗口。
- José 编辑窗口：迁移→校验→切换之间 José 的手改如何不丢（dual 写覆盖 + 切换前最后一次 parity）。
- 这五步任何一步碰生产，CC 都不自动做：列出来、等 Chandler 说哪步、给一步做一步。

## 5. 报告 + 收尾
- 本地：schema + 迁移/回滚脚本 + parity 报告（=0）+ 全测试结果（relational & dual 都绿）+ facade API 未变证明 + 路由数 67。
- 生产切换 runbook（未执行，等批准）。
- 诚实：本轮收益 = schema/读 egress/并发地基，不含 per-entity 写（follow-up）。
- 结尾用 docs/AI_AGENT_PROJECT_RULES.md 的 Post-task routing 块（Cursor 格式）。
- 唯一该停 = ① 本地缺非生产 DB/Docker（真 blocker）② 生产切换硬停等批准；除此本地部分一路做完。
