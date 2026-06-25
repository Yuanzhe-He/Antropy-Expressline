# CC PROMPT — Supabase 体检（只读）+ 收尾 3 个小加固

> 背景：POSTCUTOVER_VERIFY 已完成、Claude 已审：回滚已证明可执行（prod-reverse-to-blob.js，双标志安全，scratch 演练无损往返）；auto-seed 守卫已部署（PR #23 → 596c5882）；live 写路径验过；隔离=代码级（role=postgres，src/ 里 0 跨租户引用）；出处 diff 空（部署==审过的 0569cc2）。
> 本 prompt 两阶段：**Phase 1 只读 Supabase 体检**（egress 实测/缓存画像/备份防线/监控），**Phase 2 收尾 CC 自列的 3 个小残留加固**（小写入、逐个闸）。**先做 Phase 1 确立基线，再做 Phase 2。**
> 铁律：Phase 1 什么都不改（唯一例外 usage-guard 阈值可调）；Phase 2 只做下列 3 项、每项有闸；不碰 joyas/punas；不写 live shipping-data blob；STORAGE_MODE 保持 relational。测量本身别造 egress。做完报告交 Claude 审。

## Phase 1 — Supabase 体检（只读测量）

### 1.1 egress 暴量实测（"忽然疯狂提取"还在不在）
- pg_stat_statements：按 total rows/calls/mean_time 取 top 查询，看 relational 真实读写模式，确认没有单条查询高频拉全量（老风暴特征：getShippingData 每次 ~1.6MB × 几十万次）。
- Supabase egress 指标（dashboard/API）：过去几天/几周曲线，在预期地板（cache TTL 1h → ~24 miss/天 × ~1.6MB ≈ ~1GB/月）还是在飙。确认切 relational 后没复发。
- /healthz：curl 它，今天 app_state 读/写 vs 阈值、是否报警。确认读数低、无报警。

### 1.2 relational 缓存/读量实测【Claude 发现，重点】
架构发现：relational 下 per-entity 写调 invalidateShippingDataCache（整体失效）→下次读重拉全 18 表；blob 模式是定向更新缓存段。→José 活跃编辑时冷读比 blob 多。
- 实测：relational 正常使用的冷读频率/缓存命中率？读量是否合理，还是活跃编辑在驱动过多冷拉？多 admin 并发会放大。
- 若过多：标记优化项（写时定向更新缓存段而非整体失效）。现在别实现，只测量+报告。

### 1.3 数据丢失防线（"忽然少很多"）
- 确认 Supabase 自动备份开着（付费档每日备份/PITR），记保留窗口。这是数据丢了的恢复网。
- 确认恢复路径齐：Supabase 备份 + 冻结 blob + 本地 cutover 备份。
- 确认无静默丢失：抽查行数（carriers=21/customs_yards=28/inland_destinations=44/inland_rate_entries=300…）稳定且与 cutover 基线一致。

### 1.4 监控落地
- 确认 usage-guard 阈值对 relational 合适（读 200/写 500 每天）。relational per-entity 写在正常使用下写次数可能更高——确认既不误报也不掩盖真风暴，需要就调（Phase 1 唯一允许的改动）。
- 确认 /healthz 生产可达且暴露计数器。
- 建议周期性检查：定时 curl /healthz + 周期 pg_stat_statements/egress 检查。

## Phase 2 — 收尾 3 个小加固（小写入，逐个闸）

### B1 — 启动断言（防 STORAGE_MODE 被清→静默读冻结 blob）
- 加 CC 自己 Part 4 建议的启动断言：DB 模式 + 关系表非空 + STORAGE_MODE≠relational → 打醒目 warning（app 在读冻结 blob、不是表）。
- 仅 console.warn、行为中立。test:all 仍全绿 + 加测试覆盖该断言。部署（行为中立、一次重启）+ 健康闸。
- 【闸】test:all 全绿 + 部署后 app 健康 + STORAGE_MODE 仍 relational。不过→回滚部署、报告。

### B2 — 撤销冗余 grant（可选清理，最小权限）
- 所有权转移时的 `grant expressline_migrator to postgres` 现在没用了（表已归 postgres）。撤销：`revoke expressline_migrator from postgres`。
- 注意：postgres 本就宽角色，这成员资格不增加它任何权限→撤销是**零功能影响的纯清理**。撤销后实测：postgres 仍能读写 18 表、migrator 仍能跑自己脚本（有独立 CRUD grant）、隔离证明仍过。
- 【闸】撤销后 postgres 读写 18 表 OK + migrator 脚本 OK + 隔离证明仍过。**有任何疑问就别撤、保持现状报告**。

### B3 — CI 跨租户引用守卫（锁死代码级隔离）
- 加一个测试/脚本：grep src/ 有无 joyas_/punas_ 引用，有就 fail；加进 test:all。这样以后谁不小心引入跨租户查询会被 CI 挡。
- 【闸】守卫脚本跑过（当前 0 引用→pass）+ 进了 test:all + test:all 全绿。

## 完成（交 Claude 审）
- 报告 Phase 1 体检结论（egress 是否复发+数字、备份防线+保留窗口、relational 缓存画像、监控状态）+ Phase 2 三项加固结果。
- STORAGE_MODE 保持 relational、live shipping-data blob 未写、备份/migrator creds 未动、joyas/punas 零接触。
- 结尾 Post-task routing。
