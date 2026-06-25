# CODEX/CC PROMPT — 生产 DB 迁移【Phase 0-4：建表+灌数据+验证，一次连续跑，APP 完全不动】

> 现状：架构重构 done（PR #22）；数据层迁移代码 done + 已在真生产快照沙盒验过（parity=0、闸、José 编辑完好、8 死链 drop 验过）。
> 这一步：把关系表**真正建到生产、灌好、验证**——但**只动数据库、完全不碰正在跑的 app**（不 merge、不部署）。app 继续从 blob 读、照常服务，对它和三个生意零影响、零停机风险。
> ⚠ 生产 = polxyashvxbzdkkmxuox，装着 expressline + joyas + punas 三个生意。**只碰 expressline schema，永不碰 joyas_*/punas_*。**
> 一次连续跑，每个 Phase 有硬闸，任一闸不过立即停+报告+不进下一 Phase。做完停下交 Claude 审。

## 铁律
1. **只碰 expressline schema**。joyas_*/punas_* 一个字节不碰——用只对 expressline 有权限的 role 物理隔离（Phase 1）。
2. **不动 app**：不 merge PR、不部署、不改 STORAGE_MODE。app 这一步全程从 blob 读、行为不变、不重启。
3. **非破坏**：只 READ blob（app_state）+ 建新表 + 写新表。**绝不改 app_state/audit_logs/quote_snapshots 这些现有数据**。blob 始终是 source of truth。
4. 任一硬闸不过 → 停、报告、不继续。

## Phase 0 — 备份（到本地）
- 把生产 expressline 的 app_state + audit_logs + quote_snapshots 导出到**本地**文件（gitignore），记行数 + sha256。
- 【硬闸】备份文件存在、可读、行数>0、校验和记录。否则停。

## Phase 1 — 建 restricted role + 证隔离（关键安全地基）
- 用现有宽权限凭据（一次性 admin 动作）建 expressline_migrator role：revoke all on schema public、grant usage+create on expressline、grant all on expressline 所有表、alter role set search_path=expressline。（确切 SQL 见 docs/specs/20260622_blob_to_relational_CUTOVER_RUNBOOK.md §2）
- **证隔离**：用这个 role 连，跑 `select 1 from public.punas_customers limit 1` 和一个 joyas 表 select —— **必须都 permission denied**。把拒绝输出贴出来。
- 【硬闸】隔离证明通过（punas/joyas 都 permission denied）。**不过 → 立即停、不建任何表、不迁移**。后面 Phase 全用这个 role 连。

## Phase 2 — 建表（只在 expressline）
- 用 expressline_migrator role，把沙盒验过的同一套 18 表幂等 migration 建到生产 expressline。
- 【硬闸】18 表建好、app_state/audit_logs/quote_snapshots 未被改动（确认只新增、没动现有表）。

## Phase 3 — 正向迁移 + 8 死链 drop + 生产数据闸
- expressline.app_state blob → expressline 表（migrate-forward，含已验过的 8 死链 dropDanglingRefs）。
- Q4 orphan 闸 + Q5 currency 闸跑在**真生产数据**。
- 【硬闸】Q4 post=PASS(0)（除已知 8 个悬空 drop，逐条 log）、Q5 PASS。出现任何**非"悬空到已删 yard"**的 orphan → 停、报告、不自行绕过。

## Phase 4 — parity 验证
- parity：blob 投影 vs expressline 表 = 0 + José 手改抽查（CMA doc fee=50 / KMTC ISD=15 / ZIM / COSCO / 2 自建 yard / 7 空壳 carrier）。
- reverse==normalize（写 rollback key 不写 live）+ forward 幂等。
- 【硬闸】parity DATA diff=0、José 抽查全过。不过 → 停、报告。

## 完成（停在这里，交 Claude 审）
- 报告：每个 Phase 的硬闸结果 + 隔离证明输出 + 被 drop 的 8 条 + parity 报告。
- **生产现在状态**：expressline 多了 18 张建好+灌好+parity=0 的表；app_state 等现有数据**没动**；app 仍从 blob 读、行为不变、没停机。
- 关系表是**此刻的快照**——app 切换前 José 若改 blob，切换时会重跑 forward 同步（幂等）。这没问题。
- 全程 joyas/punas 零接触证明（Phase 1 的 permission denied + 每步 SQL 的 expressline 限定）。
- 本地备份 + .prod-blob-snapshot + 沙盒留着别提交。
- 结尾用 docs/AI_AGENT_PROJECT_RULES.md 的 Post-task routing 块（Cursor 格式）。
- 唯一该停 = 任一硬闸不过；除此一路做完报告。**不 merge、不部署、不动 app。**

## 下一步（不在本 prompt 里，Claude 审完再发）
app 切换：merge PR #22 + 部署 STORAGE_MODE=dual（选低峰窗口，因为部署会重启正在跑的三业务 app）→ dual 烤一阵看 shadow（偏差应恰是已知 8 个）→ 切 relational → 之后退役 blob。这步动 live app、有停机风险，所以单独走、选时机。
