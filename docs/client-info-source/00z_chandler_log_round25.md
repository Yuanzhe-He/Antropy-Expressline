# 00z — 第N+25轮执行（TTL拉长env化 + 应用层用量护栏告警 + 读侧沉淀）

> 00y(round25 prompt) 续篇。CC执行轮。最新轮次。分支 `feature/usage-guard-and-ttl`（从 main=67ae1df 切，PR#16 killshot 已合并）。PR-only，未直推。

## 2026-06-21 第N+25轮执行 — TTL调优 + 用量护栏 + 读侧

### 前置：PR#16(killshot)已合并
- PR#16(feature/rmw-loop-killshot, MERGEABLE/CLEAN) 已 merge 到 main=67ae1df，killshot 读缓存上生产（Railway 自动部署）。本轮在其上做。

═══════════════════════════════════════════
## A — 读缓存 TTL 拉长 + env 化（降 egress 地板）
═══════════════════════════════════════════
- **默认 TTL 15min → 1 小时**（`store.js getShippingCacheTtlMs`，env `SHIPPING_CACHE_TTL_MS` 仍 call-time 可调，0=禁用）。
- **两个频率别混（关键澄清，写进代码注释）**：①真去外部查汇率=一天一次够(scheduler 管)②读缓存 TTL=1.6MB blob 在内存缓存多久才重读 DB。外部 poller 每 2s 打一次每次要读 blob，TTL 越长真读越少 egress 越低。
- **egress 地板估算**：1h TTL → 连续轮询下每窗口只 miss 一次 ≈ **24 次真读/天 × 1.6MB ≈ 38MB/天 ≈ ~1.1GB/月**，远低于 5GB 免费版（修前 ~55k 读/天 ≈ ~70GB/天）。
- **部署纪律（TTL 拉长的唯一代价，写进注释+本文档+roadmap）**：`patch-prod-data.js`/`db:seed` 是独立进程写 DB，线上 server 进程内缓存陈旧最多一个 TTL。**prod patch 后要 redeploy（重启清缓存）或等一个 TTL 才在线上生效/抽查**，否则看到旧缓存。单实例 write-through 下自己改数据立刻可见（无此问题），仅 out-of-band 写有。

═══════════════════════════════════════════
## B — 应用层用量护栏 + 日志告警 + 自动降级（核心：出事当场刹车+留证据）
═══════════════════════════════════════════
新增 `src/lib/usage-guard.js`（纯内存，**不为计数引入任何 DB 写**）。从"等月底账单"→"Railway 日志当场可见 + 自动降级"。

- **计数（在 db 层真 I/O 处）**：`db.getAppState`→`recordRead()`（**只数 DB 穿透读**——缓存命中在 store 层短路，永不到 getAppState，不计数）；`db.saveAppState`+`db.patchAppStateField`→`recordWrite()`。
- **阈值（env 可调，call-time）**：读穿透 `APP_STATE_READ_WARN_THRESHOLD`=200/天（1h TTL 下正常≈24，宽裕不误报）；写 `APP_STATE_WRITE_WARN_THRESHOLD`=500/天；severe 倍数 `APP_STATE_READ_SEVERE_MULTIPLIER`=5；告警去重间隔 `APP_STATE_GUARD_ALERT_INTERVAL_MS`=5min；降级 TTL 地板 `APP_STATE_GUARD_DEGRADE_TTL_MS`=1h。
- **告警（醒目+去重）**：超阈值打 `console.error("[USAGE-GUARD-ALERT] app_state DB reads/writes today=N exceeded threshold=M ...")`。首次穿越立刻告警，之后每 interval 至多一次（**告警自身不变成日志风暴**）。
- **自动降级（降失控行为，不停服务，区分读写+自动 vs 用户）**：
  - 写超阈值：`saveExchangeRates`(FX=**自动写**) 调 `shouldDegradeAutoWrite()`→true 则**跳过 DB 写、保留缓存**（FX 仍从缓存供给）；`saveShippingData`(后台改费率/建船司=**用户关键写**)**永不阻断**，照写只计数+告警。
  - 读穿透 severe(≥5×阈值)：`getShippingCacheTtlMs` 调 `shouldExtendReadCache()`→强制 TTL 地板拉到 1h，钳住 egress（缓存被狂读/失效时的安全网）。
- **可见性**：`triggeredToday` flag + `GET /healthz`（无 auth，返回今日 reads/writes/阈值/是否告警/降级状态，**无 secret**）+ 启动日志打 TTL+护栏配置（Railway 启动可见）。
- **跨天重置**：按日期 rollDay 清零（纯内存，进程重启清零可接受，配合 TTL+FX 节流足够）。
- **不接邮件**（本轮）：项目无邮件设施（src/lib 无 mailer，env.js 仅 .env 加载）。日志告警+自动降级已实现"当场刹车+留证据"。邮件/webhook 是 step-2，需 Chandler 指定服务+收件地址。

═══════════════════════════════════════════
## C — 读侧沉淀（项目 LESSONS）
═══════════════════════════════════════════
- `docs/LESSONS.md` 新增 round-25 教训：TTL=egress 旋钮（缓存刷新 cadence ≠ 上游 fetch cadence）；单实例+write-through 下长 TTL 零陈旧代价，仅 out-of-band 写需重启；别等月底账单——自加轻量用量护栏（数真贵操作、异常倍数告警、降失控行为不降用户/不降服务）；只数 DB 穿透读（排除缓存命中）+ 护栏自身免 DB 写；区分自动 vs 用户写。
- round-24 的"READ egress 可压过写/写风暴修复别漏无缓存整块读"已在 LESSONS（上轮）。
- 全局 `Cursor Project Master/database/` 读侧框架由 Claude web 端补，CC 不动那边。

## 验收（测试厚）
- **新测 `scripts/audit-usage-guard-test.js` 8/8**：正常量级静默无误报 / 读告警(穿越1次+去重不风暴+过 interval 再告警) / severe→extend cache / 写告警+auto degrade / 跨天重置 / **缓存命中不计读** / **护栏纯内存零 DB 写** / **降级不对称(FX auto 丢弃、admin user 照写、缓存仍刷新)**。
- **全回归 11/11 绿**：smoke + quote9/9 + o3 + batch3 + d-add12/12 + audit(contento3/fx5/new-carrier6/quote-modes4/rmw-cache9/usage-guard8)。
- **/healthz 实测**：JSON 模式起服务 curl `/healthz` 返回 `{status:ok, shippingCacheTtlMs:3600000, usageGuard:{...}}`；启动日志打 `read cache TTL: 3600s | usage-guard: read-warn=200/day write-warn=500/day ...`。
- **生产验证**：
  - **⭐PR#16 killshot 已部署，实测生效**（06:43Z）：读 **38.6/min→1.0/min**（~55,598/天→~1,426/天）、est. egress **~70GB/天→~1.8GB/天**（降 ~97%）、写仍 0/min。缓存在吸收 poller。`/healthz` 现 404（属 PR#17 未部署，正常）。
  - **PR#17（本轮）部署后**：re-run `scripts/rmw-egress-probe.js` 应见读穿透再降到 ≈24次/天（1h TTL）；`curl /healthz` 应见 `usageGuard.reads≈24/天`、`triggeredToday:false`、`shippingCacheTtlMs:3600000`；护栏正常量级不告警；生产数据完好(B/C/E+José手改yards=28)。

## 爆炸半径
- 改文件：新增 `src/lib/usage-guard.js`、`scripts/audit-usage-guard-test.js`；改 `src/lib/db.js`(计数 hook)、`src/lib/store.js`(TTL 1h+guard-aware+FX degrade)、`src/server.js`(启动日志+/healthz)、`docs/LESSONS.md`。
- 影响：所有 app_state DB I/O 经护栏计数（纯内存，零额外 DB 写）；TTL 默认 1h（env 可调）；新增公开只读 `/healthz`。报价/计算/双价/新增船司逻辑**不碰**。
- 风险低：护栏默认阈值宽裕（正常量级远低于阈值），degrade 只在异常倍数触发且只降自动写/延长缓存，用户操作与服务不受影响。
- **部署纪律新增**：长 TTL 下 out-of-band 写(patch/seed)后需 redeploy 或等 TTL。

## 安全尾（later，不变）
- postgres 超级用户→service_role/受控角色（非 egress，later）。
- exchangeRates 拆独立小 key（热冷分离）。
- 从源头停外部 poller（F1，需 Railway log）。
- step-2 邮件/webhook 告警（需 Chandler 指定服务+邮箱）。

**项目状态**：main=67ae1df（含 PR#16 killshot）。本轮 TTL 1h + 用量护栏告警 + 读侧，分支 `feature/usage-guard-and-ttl` 代码+测试+文档完成，待开 PR 合并部署。

**本轮防compact写入**：00z_chandler_log_round25.md（本文件）+ `_ROADMAP_anti_compact.md` 定位区 r25。
