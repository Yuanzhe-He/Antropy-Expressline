# 任务：陆运 (inland) 直接上生产 — 合并部署 + 删演示数据 + 灌真实费率（一次做完，全量报告）

仓库：当前目录（Jose Expressline Consulting）。
关键事实：生产 antropy-expressline-production.up.railway.app 当前部署 main，陆运仍是空壳；功能代码在 feature/inland-routes-map（PR #1），从未合并。生产库含 12 条 Codex 演示 rateEntries（假数据），需删除。
用户决策：无真实用户/数据；跳过预览验收；直接合并上生产；12 条演示假数据直接删除，灌真实数据时整段替换 inland.rateEntries，绝不与真实数据并存。A、B 连续执行，中间不停，结束给全量报告。

## 0. 总则
- 先读：AGENTS.md、docs/AI_AGENT_PROJECT_RULES.md、.ai/PROJECT_SCALE_OVERRIDES.md、docs/specs/20260610_inland_routes_map_IMPLEMENTATION_SPEC.md、docs/specs/20260611_inland_finalize_TASK_PROMPT.md。
- 全程禁止 force push、禁止改 git 配置、禁止打印任何 secrets/DATABASE_URL。
- 本任务 A、B 连续执行不停顿，除非命中下列硬停条件：验收数字不符；seed 无法整段替换、演示数据只能与真实数据并存且无清理路径；Railway 部署来源/分支无法确认；生产 store 写入路径不确定。命中即停并报告，不猜不续。
- 生产部署若必须手动触发（非自动跟踪 main），给出确切命令并停下让用户执行，不替用户点生产部署按钮——这是唯一允许的中途暂停点。

## 阶段 A — 合并到 main 并部署
1. git status 干净；git fetch；git checkout feature/inland-routes-map && git pull --ff-only。不干净或 ff 失败即停。
2. 确认 morelos/edomex 已 confirmed：MORELOS lat 18.8350 lng -99.1780、EDOMEX lat 19.2826 lng -99.6557、needsReview=false、coordSource=seed-catalog-confirmed。若仍为 true，改 src/lib/inland-catalog.js，本地重跑 npm run inland:seed -- data/source/tarifario-terrestres-2026.csv（不带 --target），npm test 全绿，单 commit 后 push。
3. 确认 Railway 部署来源：查 railway.json/railway.toml/Procfile/nixpacks 及 README/docs/env-setup.md，判定生产是自动跟踪 main 部署还是手动部署。结论与依据写入最终报告。
4. 合并 PR #1 到 main：优先 gh pr merge 1 --squash；gh 不可用则本地 git checkout main && git merge --no-ff feature/inland-routes-map && git push origin main。不 force push。
5. 部署：自动跟踪 main → 等待完成并核对生产 commit hash 与 main 一致；需手动 → 给出确切命令后停下让用户执行（唯一允许的暂停点），用户执行后再继续 B。
6. 部署后只读核对：生产 /workbench/inland 不再是"预留中"空壳、模块 Live、页面可加载（此刻费率可能仍是 12 条演示数据，正常，B 段清理并灌真实）。

## 阶段 B — 删演示数据 + 灌真实费率
1. 备份生产 inland 段：经 store 读取导出 modules.inland 当前值到 docs/specs/20260611_prod_inland_backup.json（不打印到日志），作回滚锚点。
2. 整段替换灌库：执行真实数据 seed，并确保 inland.rateEntries 被整段替换（12 条演示删除、写入 300 条真实）。以脚本实际签名为准，预期形如 npm run inland:seed -- data/source/tarifario-terrestres-2026.csv --target=production --confirm-production --replace。
   - 若脚本不支持整段替换、只能增量合并 → 硬停报告。先实现 --replace（替换 inland.rateEntries）或一次性清理脚本（删除现存演示条目）再灌，绝不并存。
   - 灌前打印 diff 概要（删除 12 演示 / 写入 300 真实），核对后落库。
3. 生产路线缓存：若生产 routeCache 为空或为演示数据，执行 node scripts/refresh-inland-routes.js --target=production（以实际签名为准；若缓存随 JSON 段一起入库则说明，避免重复抓取）。43 条目标，失败列清单不阻塞。
4. 生产验收（只读核对）：rateEntries=300（演示 12 条不存在）、唯一 id 300、四个最高价一致（apodaca 72,000/93,500、la-paz 207,900/273,000、guadalajara 43,000/66,000、ciudad-acuna 110,000/165,000）、guadalajara 与 zapopan 各两档 LTP（29,000/43,000 与 43,000/66,000）、43 路线有缓存、la-paz 带轮渡标记、needsReview 为空。

## 最终全量报告（A+B 一次性输出，含以下全部）
1. 阶段 A 结果：分支同步、morelos/edomex 状态、Railway 部署来源判断+依据、合并方式与 commit、部署状态与生产 commit hash、生产陆运页核对结果。
2. 阶段 B 结果：备份文件路径、灌库 diff（删 12 / 增 300）、生产验收逐项数字（上述每一项打勾或标差异）、路线缓存结果、回滚方法（用 backup.json 经 store 还原）。
3. 任何硬停或暂停点的说明（若有）。
4. Task Summary（含 blast radius）+ 完整 ## Post-task routing 块。
5. lesson 写入 docs/LESSONS.md：「生产 seed 前演示/种子数据必须整段替换不得并存」「功能在分支≠已上线，需确认合并到部署分支并完成部署」。
6. 杂散文件 data/source-tarifario-2026.csv（md5 18dec98b…，非 canonical）保持未入库，在报告中确认。

## 约束复述
不删真实 248 行费率数据与 data/source/ 下 canonical CSV（删除对象仅限生产库 12 条演示假数据）；不改放单/清关行为；Excel/CSV 仅作 seed 输入；不 force push、不直推 main 绕过 PR（除 gh 不可用时 --no-ff merge）、不打印 secrets；生产部署若需手动则给命令让用户执行、不替用户点。
