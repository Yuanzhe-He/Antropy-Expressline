# 00q — 第N+18轮（补CONTENTO真价 + 数据上生产诊断 + 5项审计）

> 00p 续篇。最新轮次。分支 feature/jose-r3-data-deploy（从 main=4846b8f 切）。

## 2026-06-20 第N+18轮 — CC执行

**Part 1 CONTENTO真价 ✅**：读 CONTENTO_yards_full_pricing.md，contento-yards.js 的 26 场站 maniobra 从占位填真价(3800~5850)，去 pendiente note。验证 26/26 真价、0 占位、0 编造。commit 62bcda3。

**Part 2 数据上生产 ⏸ 停在写入前等 Chandler**：
- 备份生产 Supabase app_state ✅：backups/prod-shipping-data-2026-06-20T21-26-51-678Z.json(2.18MB, sha256 773788975641e865)。backups/ 已 gitignore。
- **诊断关键发现：生产有 José 手改**！CMA doc fee 45→50、ZIM 改名(Import Container/Borrar)、COSCO 改价、**KMTC ISD 已是 15**(José后台自己改的)、**José 自建 2 个场站**(customs-yard-…"新场站 4/5")。
- **结论：db:seed 全量覆盖会清掉这些 → 必须外科式 patch**。
- patch 脚本 scripts/patch-prod-data.js(dry-run 默认，--apply 才写，写前再备份，saveAppState 原样写保 José 形状) + scripts/seed-new-carriers.js(7家空壳)。commit 54de2b2。
- **dry-run 验证 19 处改动**：E 14 rfc+HAPAG/ONE code；B KMTC 2 改名(ISD 幂等已15)；C 删 3 假场站+加 26 CONTENTO+**保留 José 2 自建场站**。
- **唯一停下点：等 Chandler 批 patch(方式A，推荐) vs db:seed(方式B，不可用)，批准后跑 `node scripts/patch-prod-data.js --apply`。**

**Part 3 审计 1–5 全过**(commit fb410fe + 报告 docs/specs/20260620_data_deploy_audit_REPORT.md)：
- 审计1 代码vs数据：报价模板(11+12)、车型7档、柜型master、nameZh/Es、normalizer字段 = 代码→部署已生效(逐一生产核实)。唯一未生效=本批 B/C/E，patch 补。**无历史功能缺口**。
- 审计2 CONTENTO 3/3、审计3 新增船司深测 6/6(重名去重/空名拒/删除级联/7空壳幂等)、审计4 全回归 7 套件绿、审计5 XSS 干净。
- 低危项 F1(允许重名船司，去重id安全) F2(数据机制易忽略，已写LESSONS)。

**José 问题清单**：第8条 PDF 缺失已 RESUELTO(26 真价已补)。其余 1-7 待 José。

**机制锚点(记牢)**：生产=Supabase，改代码部署即生效，改数据需 patch/seed/后台手改。生产有 José 手改→只能 patch 不能 seed。

**下一步**：Chandler 批 patch → 跑 --apply → 生产抽查(KMTC新名+ISD15+rfc、26场站+José场站还在、José手改未丢) → 合并 PR。

**本轮防compact写入**：00q_chandler_log_round18.md(本文件) + _ROADMAP_anti_compact.md
