# CODEX/CC PROMPT — 生产 relational 上线后全量核查 + 补齐回滚证明 + 加固脚枪

> 背景：生产 app 已在 STORAGE_MODE=relational 跑（deploy 2d624a6e），读写 18 表，blob 冻结作回滚锚（Step 8 未做）。Claude 已读真代码审过：facade dual 写 blob-first、影子读包 try/catch 永不抛、per-entity 写原子、parity=0/影子==8 都验过——这些没问题。
> Claude 发现几个**需要 CC 在 live 上核实/补齐**的点，按重要性排。**铁律：不改 STORAGE_MODE；不碰 joyas/punas；绝不写 live blob 的 `shipping-data` key（只用 scratch key）；只读为主。** 每部分有硬闸，做完报告交 Claude 审。

## Part 1 —【最重要】证明回滚可执行（否则就是"搞搞后面改不了了"）
**现状缺口**：生产 reverse 只验证过重建（prod-04 verify-only，且用 migrator 角色对 app_state 只有 SELECT、写不了）；唯一能写 blob 的 `migrate-reverse.js` 连的是**沙盒**。所以回滚的**写动作**没脚本、没角色、从没跑过。
**做（全程只写 scratch key，绝不碰 `shipping-data`）**：
1. 写一个 prod 专用 reverse-to-blob（用 admin/postgres 凭据，因为 migrator 写不了 app_state）：读当前 18 表 → assemble → normalizeShippingData → writeBlob 到 scratch key `shipping-data-rollback-test`（**不是** `shipping-data`）。
2. **证明无损往返**：decompose(重建出的 blob) 与**当前 18 表** canonical 逐表比对 → 必须完全相等（即这个回滚 blob 能精确重建出当前的表）。再对重建 blob 跑 José 抽查（cmaDocFee=50/kmtcIsd=15/ZIM/COSCO/2 自建 yard/7 空壳）必须过。
3. 把**确切的回滚命令**写进 runbook（这个新脚本 `--apply` 才写真 `shipping-data` key），让真要回滚时是一条已验证的命令、而不是临场现写。
- 【硬闸】重建 blob decompose 回去 == 当前表（canonical 全等）+ José 抽查过。`shipping-data` key 全程未被写。不过 → 停、报告。

## Part 2 — live 写路径验证（read-only 闸只验过读，写没在 live 验过）
**现状**：prod-D-shadow、prod-E-verify 都是只读。relational 模式下"真写一笔→落表→读回"没在 live app 上验过（per-entity 写在沙盒/集成测过，但 live 未确认）。
**做**：
1. 在 live relational 下，通过 app 真实写路径做一笔**良性可逆**编辑（如对某 carrier 用 saveCarrier 原样重存、或改个 note 再改回）→ 读回确认落表 → 还原。证明 relational 写在 live 能落库+读回。
2. FX 写：确认下一次 FX 刷新把 exchange_rates 表写新了（relational 读到的汇率是最新）——观察一个刷新周期或确认最近 updated_at。
- 【硬闸】写往返在 live 成功 + 还原 + FX 刷新更新了表。不过 → 报告（别强行修，先报）。

## Part 3 — 加固 auto-seed 脚枪（防 MXQ 那类静默覆写）
**现状隐患**：facade relational 读路径里，若 `getShippingTablesAssembled()` 返回 null（**18 表全空**）→ app 会用打包 demo 种子 `saveShippingTables(seed)` **覆写生产表**，静默掩盖数据丢失。触发窄（全表空）但后果重。
**做（代码改动 + 本地测，最小化）**：
1. 改 facade（src/lib/store/index.js）relational 读的 seed 分支：**仅当表空 AND app_state 的 `shipping-data` blob 也空**（真·全新库）才 seed；若**表空但 blob 非空**＝数据丢失 → **不 seed demo**，抛明确错误（让运维去 blob/备份恢复，而不是 demo 数据被写进去）。生产 blob 是冻结非空的，所以未来任何"表被清空"都会被这条挡住。
2. 本地 test:all 必须仍全绿 + 加一条测试：表空 + blob 非空 → 不 seed、报错。
3. 部署这个加固（很小、低风险——只改"全表空"这一极端边缘，正常运行不触发）。部署后健康闸。
- 【硬闸】test:all 全绿 + 新测试过 + 部署后 app 健康（/healthz + 真实读 smoke）。不过 → 回滚部署、报告。

## Part 4 — 配置耐久性 + 角色/隔离/出处确认（只读）
1. **STORAGE_MODE 耐久性**：确认 Railway 上 STORAGE_MODE=relational 是**持久设置**（重启后还在）。文档化风险：若它被清掉，facade 默认回 `blob`（getStorageMode 里 `|| "blob"`）→ app 静默读**冻结的 blob**＝服务过时数据。建议：加一条启动断言（DB 模式 + 表非空 + STORAGE_MODE≠relational → 打醒目 warning）。
2. **app 的角色/隔离**：确认 live app 连库用的 role（是 postgres 吗？）。说明：现在 app 对 joyas/punas 的隔离是**代码级**（postgres 能访问它们，只是 app 代码不查）——不是物理权限挡的。确认 app 所有查询都 schema 限定在 expressline、代码里没有任何 joyas/punas 访问。澄清 CC 之前报告里"joyas/punas permission denied"指的是 migrator、不是运行中的 app。
3. **出处**：确认 main tip = bb4930a8、部署的代码树 == 0569cc2（Claude 审过的），无意外 diff。
- 报告以上发现。

## 完成（交 Claude 审）
- 报告每部分闸结果 + Part 1 的确切回滚命令 + Part 4 的三项确认 + 任何残留风险。
- 全程未改 STORAGE_MODE、未写 live `shipping-data`、blob+备份+migrator creds 未动、joyas/punas 零接触。
- 结尾 Post-task routing。唯一该停 = 任一硬闸不过。
