# CODEX/CC PROMPT — 生产 app 切换【push → merge #22 → dual → relational，一次连续跑，现在执行】

> **决策（Claude 定，已核 git 历史 + 权衡 CC 的分开-PR 建议）**：用 **push + merge #22（一个 PR、一次部署）**。关系层 25 commit 线性叠在重构（13a18d0=PR #22 当前 tip）之上；push 后 PR #22 变“重构+关系”，merge 一次把全部部署。理由：合并后 app 在 blob 模式能否启动+服务已被 test:all（STORAGE_DRIVER=json 启动整个 app 打真 HTTP）覆盖；分开只多一次重启+一个分支+merge 坑，收益边际。
>
> 现状：生产 expressline 18 表建好灌好 parity=0，app 仍读 blob；关系层代码本地（0569cc2）**未 push**。
> ⚠ 这步会重启装着 expressline+joyas+punas 三业务的 live app（短暂停机）。Chandler 现在在线。一次连续跑，每 Phase 硬闸，任一不过立即停+报告+回滚指引+不进下一 Phase。

## 铁律
1. 只碰 expressline。joyas_*/punas_* 一字节不碰。
2. José 在活跃改生产 → 绝不丢他的编辑（dual 期 dual-write + 重对齐回填；影子闸把关）。
3. 任一硬闸不过 → 停、报告、给回滚指引、不继续。
4. 停在 relational，不退役 blob（blob + 本地备份 = 回滚锚，留着别动、别提交清理）。

## Phase 0 — Railway 授权（CC 触发弹窗，Chandler 在浏览器授权）
- 跑 `railway login` → 浏览器弹出 → **停下等 Chandler 在浏览器完成授权**（凭据不经过你）→ `railway whoami` 确认已登录 → `railway status`/`railway link` 确认连的是 Express Line 那个 service。
- 记录当前 STORAGE_MODE（应为 unset/blob）。
- 【硬闸】railway 已授权 + service 正确。不过 → 停（这步只有用户能做）。

## Phase 1 — Phase A 授权（app role 拿 18 表权限，DB-only、安全可逆）
- 18 表现在归 expressline_migrator 所有 → 用 admin/owner 凭据给 app 连库的 role（postgres）授权：对每张 expressline.<table> grant SELECT/INSERT/UPDATE/DELETE + 关联 sequence 的 USAGE,SELECT（含 upsert 需要的）。
- 【硬闸】**以 app role 实测**：每表在一个事务里 select+insert+update+delete 后 rollback（不留痕），全部成功。不过 → 停。

## Phase 2 — push 分支（PR #22 变“重构+关系”，不部署）
- `git push origin feature/refactor-godfiles`（本地 0569cc2 → origin/feature。**Railway 跟 main、不跟 feature，所以这步不触发任何部署**）。
- 【硬闸】origin/feature == 本地 0569cc2；确认 660c022（facade）等关系 commit 现在在 PR #22 里。

## Phase 3 — merge PR #22 → 部署（blob 模式，行为字节级不变）
- merge PR #22 → main（用 **merge commit / fast-forward 保留历史，别 squash 成一坨**）→ Railway 自动部署 main。STORAGE_MODE 仍 unset/blob → 新代码跑 blob 模式 = 与切前行为字节级一致。
- 【硬闸】部署后 app 健康（/healthz + 一条真实读路径 smoke）、STORAGE_MODE 仍 blob、读写行为与切前一致。不过 → Railway 回滚上一个 deploy、报告。

## Phase 4 — STORAGE_MODE=dual + 重对齐 + 影子比对（切 relational 前唯一安全闸）
- `railway variables --set STORAGE_MODE=dual` → app 写 blob+表、读仍走 blob（用户无感）。验健康。
- **重对齐**：重钉当前 live blob（新 sha）+ 重跑 forward migrate（幂等 + 8 死链 drop + Q4/Q5 闸），把 Phase 3 部署窗口里 José 的新编辑回填进表。
- **影子比对**：**app 的 relational 读路径**投影 == blob 读，逐实体。**偏差必须恰是已知 8 个悬空 drop**。若出现别的 delta → 再跑一次重对齐（José 编辑会收敛）→ 再比；若稳定后仍 ≠8 → 真 drift → 停、报告、不切。
- 【硬闸】parity=0、影子偏差 == 恰好那 8 个。不过 → 停。

## Phase 5 — STORAGE_MODE=relational
- 影子闸过 → `railway variables --set STORAGE_MODE=relational`（读+写都走表）。验健康 + José 抽查（cmaDocFee=50 / kmtcIsd=15 / ZIM / COSCO / 2 自建 yard / 7 空壳 carrier）。
- 【硬闸】app 健康 + 抽查正确。不过 → 按下面回滚指引退、报告。

## 完成（停在 relational，交 Claude 审）
- 报告：每 Phase 闸结果 + push/merge 的 commit + Railway 部署状态 + 新 parity + 影子结果 + 切后 smoke 输出 + 当前 STORAGE_MODE。
- ⚠ 回滚指引（写进报告）：relational 下 **blob 已冻结、不再更新**。要回退别直翻 STORAGE_MODE=blob（会丢 José relational 期编辑）。无损回滚：① reverse-migrate（表→blob，write 模式，admin 凭据，已验 reverse==normalize）把 José 编辑灌回 blob；② 再 STORAGE_MODE=blob。
- **不退役 blob**（blob + backups/prod-cutover-… + .prod-migration-pin.json = 回滚锚，留着别动、别提交清理）。
- 结尾用 docs/AI_AGENT_PROJECT_RULES.md 的 Post-task routing 块。
- 唯一该停 = 任一硬闸不过（尤其 Phase 4 影子 ≠ 恰好 8 → 绝不切）。除此一路跑到 relational 报告。
