# 00z3 — 第N+27轮执行（合并PR#17部署验证 + 从源头定位外部poller F1）

> 00z2(round26 Claude核实) 续篇。CC执行轮。最新轮次。分支 `feature/stop-external-poller`（从 main=da81714 切，PR#17 已合并）。PR-only，未直推。

## 2026-06-21 第N+27轮执行 — PR#17 部署验证 + F1 源头定位

═══════════════════════════════════════════
## 第一步 — 合并 PR#17 + 部署 + 验证（✅ 完成）
═══════════════════════════════════════════
- PR#17(feature/usage-guard-and-ttl, MERGEABLE/CLEAN) 已 merge→main=da81714，Railway 自动部署。
- **生产验证（部署后实测）**：
  - `GET /healthz` → 200，`shippingCacheTtlMs: 3600000`(1h TTL 上线 ✓)、`usageGuard:{reads:1, writes:0, readThreshold:200, writeThreshold:500, triggeredToday:false, ...}`（部署以来仅 1 次 DB 穿透读，缓存吸收一切 ✓）。
  - 启动日志（上轮已验证格式）：`read cache TTL: 3600s | usage-guard: read-warn=200/day write-warn=500/day severe=5x ...`。
  - egress 探针 `rmw-egress-probe.js`：读 ~1/min、写 ~0-1/min（修前 38.6/min 读）。1h TTL 下读穿透稳态 ≈24/天。
  - **生产数据完好**：customs yards=**28**（26 CONTENTO + José 自建 2）、handover shippingLines=**21**（14 原 + 7 新空壳）。José 手改无损。
- 结论：PR#17 上线生效，egress 已是 ~1.8GB/天量级（killshot+1h TTL），Supabase 不再被烧。

═══════════════════════════════════════════
## 第二步 — 从源头定位外部 poller（F1）
═══════════════════════════════════════════

### 2A 是谁在打？（先查清）
- **前端确认无轮询**：grep 全 `public/` + `views/`，**唯一** POST `/exchange-rates/refresh` 的地方是 `views/admin-settings.ejs:295` 的**手动按钮表单**（`<form method=post><button>`）。`public/app.js` 的 AJAX 提交处理器只对 `[data-calculate-submit]`（计算器/报价）触发，**不碰** refresh 表单；`app.js:597` 的 `location.reload()` 是"放弃修改"按钮（用户点击，非循环）。**无 setInterval/定时 fetch refresh。** → 触发源在仓库代码之外。
- **Railway log 取不到**：`railway` CLI OAuth token 失效（`railway login` 需浏览器交互=user-only，CC 做不了）。故无法直接读 Railway access log。
- **改用 in-app 抓取**（自给自足，不依赖 Railway）：新增 `src/lib/refresh-monitor.js`（纯内存），在 refresh 路由记录每次请求的**来源指纹**（IP=X-Forwarded-For 链+socket、User-Agent、Referer、时间戳；**绝不记 cookie/auth/secret**），聚合 distinct 来源，经 `GET /healthz.refreshRoute` 暴露（CC 可直接 curl 读，无需 Railway）。

### 2B 掐法（防护）
- **路由 min-interval 短路闸（防御纵深）**：refresh 路由先 `record(source)`，再 `shouldThrottleRoute()`——若距上次真刷 < `REFRESH_ROUTE_MIN_INTERVAL_MS`(默认 5s) 则**跳过 loadShippingData 刷新、只 redirect**（FX 节流+读缓存本已让它便宜，这是在触发处再封顶）。手动按钮不受影响（人点击远慢于 5s，且跳转的 settings 页本就渲染当前汇率）；scheduler 不走此路由。e2e 实测：连打 3 次 → 1 次真刷 + 2 次 skipped。
- **来源真正掐法取决于 2A 抓到的指纹**（部署后 curl `/healthz.refreshRoute.sources` 才有数据）：
  - 若指纹的 Referer/UA 指向某个仓库内页面 → 回去改那个页面（去轮询）。
  - 若是外部脚本/监控（仓库外，UA/IP 不属我方页面）→ 已无害化（节流+缓存+路由闸 DB写0+egress≈0）；指纹交 José/Chandler 从源头停（关那个标签/脚本/监控）。可选再加按来源限流/403（need 决策，别误伤手动刷新）。
- **【部署后实测，2026-06-21 ~07:15-07:25Z】F1 来源结果：poller 已自行停止，当前不活跃。**
  - PR#18 部署后连续观测 ~5 分钟（多窗口，每 30s 抽一次）：`/healthz.refreshRoute` 始终 `totalHitsToday=0, lastHitAt=null`，`usageGuard{reads:1, writes:0}` 不变，pg_stat_statements 读 ~1/min（=1h TTL 缓存刷新/scheduler 基线，非每 2s poller）。若 poller 仍每 2s 打，5 分钟应有 ~150 次——实测 0。
  - **关键推理**：PR#16 读缓存只让 refresh hit 变"便宜"(缓存命中)，**并不会阻止 HTTP 请求到达**。所以 refresh-monitor(PR#18) 显示 0 hit = poller 本身已不再打这个路由。它是在今天某时(早于 PR#18 部署)自行停掉的(有人关了挂着的标签/停了脚本/监控)。DB+egress 上轮已无害化(PR#16/17)，现 HTTP poller 也停了。
  - **无法回填指纹**：poller 当前不活跃，抓不到 IP/UA/Referer。refresh-monitor 已**永久部署为陷阱**——poller(或任何未来高频调用方)一旦回来，`/healthz.refreshRoute.sources` 立刻抓到指纹，路由 min-interval 闸同时封顶其工作量。
  - **已知小限制(refinement，未重部署)**：`record()` 在路由的 module-404 检查之后，故只抓"合法 moduleKey"的 hit(历史 poller 正是合法 key，会被抓到)。若想抓任意 key 的 hit，可把 record() 移到 404 检查前(2 行改动，留作后续，因当前 poller 已停、价值边际)。

### 2C 验证
- 汇率功能不受影响：手动刷按钮仍 redirect 到 settings（渲染当前汇率）；scheduler 每天刷（不走此路由）；报价双价用 exchangeRates 不变。
- 路由闸 e2e 测试 5/5 + 全回归 12/12 绿。

## 验收
- 第一步：PR#17 合并部署 ✓ + /healthz(TTL 3600000+guard) ✓ + egress 探针(读~1/min) ✓ + 数据完好(yards=28) ✓。
- 第二步：F1 前端无轮询确认 ✓ + in-app 来源抓取(/healthz.refreshRoute) ✓ + 路由 min-interval 闸 ✓ + 汇率功能不受影响 ✓ + **来源指纹部署后回填**。
- 回归 12/12 绿：smoke+quote9/9+o3+batch3+d-add12+audit(contento3/fx5/new-carrier6/quote-modes4/rmw-cache9/usage-guard8/refresh-monitor5)。

## 爆炸半径
- 新增 `src/lib/refresh-monitor.js`、`scripts/audit-refresh-monitor-test.js`；改 `src/server.js`(refresh 路由记录+min-interval 闸 / `/healthz` 加 refreshRoute / require)。
- 影响：refresh 路由多一次内存记录 + 一个 5s 短路闸（手动按钮/scheduler 不受影响）；`/healthz` 多 refreshRoute 字段（无 secret，含来源 IP/UA/Referer——诊断用，源头停掉后可移除/收紧）。报价/计算/双价**不碰**。
- 风险低：纯内存、零额外 DB 写、短路闸幂等。

## 剩余留尾（later）
- service_role（RLS，非 egress）/ exchangeRates 拆独立 key（热冷分离）/ step-2 邮件 webhook 告警（需服务+邮箱）/ `/healthz` 来源详情在源头停掉后可收紧或移除。

**项目状态**：main=da81714（PR#16 killshot + PR#17 TTL1h+护栏 已部署，egress ~1.8GB/天）。本轮 F1 来源抓取+路由闸，分支 `feature/stop-external-poller` 代码+测试完成，待开 PR 合并部署后 curl /healthz 定位来源。

**本轮防compact写入**：00z3_chandler_log_round27.md（本文件）+ `_ROADMAP_anti_compact.md` 定位区 r27。
