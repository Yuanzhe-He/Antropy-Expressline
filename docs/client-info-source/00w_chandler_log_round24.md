# 00w — 第N+24轮（RMW 循环 killshot：egress 根因=无缓存整块读 / 结构性修复读写路径）

> 00v 续篇。最新轮次。分支 `feature/rmw-loop-killshot`（从 main=b9b443c 切）。PR-only，未直推。

## 2026-06-20 第N+24轮 — 掐断 app_state 整块读写循环 + 结构性修复

### 一句话结论
**egress 罪魁是读，不是写。** round21 掐了写风暴（实测生产 0 写/分），但 egress 仍被击穿 70x，因为 `getShippingData()` 每请求整块拉 ~1.6MB blob、**无缓存**，而那个外部 poller 还在每~2 秒打 `/exchange-rates/refresh`，每次 hit 仍触发整块读（round21 的节流闸在读**之后**）。实测**读 38.6/min ≈ 55,598/天 × 1.6MB ≈ ~70GB/天，写 0**。修复=读入口加进程内缓存（killshot）+ 主写定向 jsonb_set + 无变更不落库 + 写后失效。

═══════════════════════════════════════════
## 第一步 — 定位（铁证）
═══════════════════════════════════════════

**调用图（grep server.js 4672 行 + 前端 + lib）**：
- 读：唯一入口 `store.getShippingData()`（store.js:2315）→ DB 模式 `getAppState(shipping-data)` 整块拉，**无任何缓存**。被 `server.loadShippingData()`（server.js:832）包一层，**59 个路由调它**（每页面加载 / 每 admin 操作 / 每 FX refresh）。
- 触发器=**外部客户端，不在仓库代码里**：round21 已确认"某已登录外部源每~2 秒 POST `/admin/:moduleKey/exchange-rates/refresh`"。该 route（server.js:2910）调 `loadShippingData({forceRefreshRates:true})` → **line 833 每次都整块读 1.6MB**，**然后**才进 `refreshExchangeRatesIfStale` 的节流闸。**round21 掐了写没掐读。**
- 前端无轮询：核实 `public/app.js` 开头的 `setTimeout` 全是 UI 动画，`fetch` 是 AJAX 表单提交，无 setInterval autosave/poll。
- `getUsers` 只在 `/login` POST 调一次（非元凶）；`requireAuth`（server.js:90）登录禁用、不读库；调度器每天午夜一次（非元凶）。

**量化（生产只读探针 `scripts/rmw-egress-probe.js` + pg_stat_statements，2026-06-21 05:43Z）**：
```
shipping-data blob : 1235 kB 列压缩 (1,264,898 B) | revision 214,825
WRITES: 0 in 60.6s = 0.0/min, ~0/day        ← round21 写风暴已根治
READS : 39 in 60.6s = 38.6/min, ~55,598/day ← 读风暴仍全天在线
est. read egress: ~70 GB/day（reads/day × blob）← 击穿 5GB 免费版的真凶
```
- pg_stat_statements 累计读 220,177（task 给的 218,364 之后又长了）。读≈写指纹里的 211k 全量写=round21 前 FX 写风暴的历史量（修复后 FX 走 jsonb_set，写=0）。

═══════════════════════════════════════════
## 第二步 — 结构性修复（不管触发器，根治读写路径）
═══════════════════════════════════════════

### A 读缓存（killshot）— `src/lib/store.js getShippingData`
- DB 模式加进程内内存缓存：缓存 normalized blob，命中返回 `structuredClone`（调用方会改，发 clone 隔离），**不再每请求整块拉 DB**。
- **call-time TTL**（env `SHIPPING_CACHE_TTL_MS`，默认 **15min**）：连续轮询下缓存每窗口只 miss 一次 → egress 地板 ≈ 1 pull/TTL × 1.6MB。15min 默认让 egress 即使外部 poller 永不停也落在免费版内（~96 pulls/天 vs 修前 ~55k）。TTL=0 可禁用。
- **为什么 15min 不是 60s**：连续轮询下 60s TTL→1440 pulls/天 ≈ 69GB/月（仍 14x 超），300s→14GB/月，900s→4.6GB/月（达标）。单实例部署（无 railway replica / 无 cluster / 单 app.listen）+ write-through ⇒ TTL 在正常运行下**零陈旧代价**，纯 egress/安全网调节。

### B 主写定向 + 无变更不落库 — `src/lib/store.js saveShippingData` + `src/lib/db.js patchAppStateField`
- `patchAppStateField` 泛化支持**嵌套数组路径**（`["modules","handover"]` → pg `text[]` `{"modules","handover"}`，段加引号转义防注入）。
- `saveShippingData` 现在：
  1. **pin exchangeRates**：用缓存里最新 FX 覆盖入参的 FX，admin 存模块时绝不回滚并发 FX 更新（round21 FX-only jsonb_set 的对偶）。
  2. **无变更不落库**：diff 缓存，无变更直接 return 不写（FX lastCheckedAt 空转那类 bug）。
  3. **单 section 改→定向 jsonb_set**：只写那一个变的 module（如 `{modules,inland}`），不搬整 blob，也不会 clobber 其它模块的并发改动。
  4. **跨 section（如删船司级联 handover+customs）/ 冷缓存→全量写兜底**（保留旧行为）。
- saveShippingData 后**刷新缓存**（全量写 setCache / 定向写只更新那个 section，不动 TTL 时钟）。

### C 缓存写后失效/更新（操作者立刻看到自己改动）
- 所有写路径 write-through：`saveShippingData`（全量/定向都更新缓存）、`saveExchangeRates`（patch 后 `updateShippingCacheSection(['exchangeRates'])`）、seed（写后 setCache）。
- 单实例 ⇒ 同进程读写共享缓存 ⇒ 操作者读自己刚写的永远命中最新。多实例靠 TTL 兜底。

### 触发器（Step 2C）
- 触发器是**外部客户端**，代码里掐不掉。但**读缓存已让它无害**：poller 每 hit 现在是缓存命中（0 DB egress），仅每 TTL 一次 miss。彻底归零需从源头停 poller（Railway access log / José 挂着的后台 tab）= F1 留尾，需 ops 介入。

═══════════════════════════════════════════
## 第三步 — 止血
═══════════════════════════════════════════
- 读风暴现在仍在线（实测 38/min）。最快止血=部署本修复（读缓存）。无更快的代码内止血（触发器外部、route 要保留），缓存修复本身即止血，低风险。**待合 PR 部署。**

## 验收
- **测试厚**：新增 `scripts/audit-rmw-cache-test.js`（mock db 层，DB 模式）9/9：100 读=0 DB pull、读隔离 clone、单模块定向写、写后操作者立刻可见、无变更不落库、跨模块全量写兜底、FX slice 刷新、FX pin 防回滚、TTL 过期再 pull。
- **全回归 10/10 绿**：smoke + quote 9/9 + r2-o3 + r2-batch3 + d-add 12/12 + audit(contento 3 / fx-throttle 5 / new-carrier 6 / quote-modes 4) + rmw-cache 9。
- **生产探针**（部署前基线，只读不写）：写 0/min、读 38.6/min、blob 1235kB。**部署后 re-run `node scripts/rmw-egress-probe.js` 应见读率→~0/min（缓存吸收）。**

## 爆炸半径
- 改文件：`src/lib/store.js`（读写路径 + 缓存）、`src/lib/db.js`（patchAppStateField 嵌套路径 + 注释复位[INCIDENTAL_FIX]）、新增 2 脚本。
- 影响：所有读 shipping-data 的页面/路由（59 处）走缓存；所有 saveShippingData 写路径（47 处 admin CRUD）走定向/全量兜底。报价/计算/双价/新增船司逻辑**不碰**（纯持久化层）。
- 数据模型不变（blob 形状不变，normalizer 不变）。生产数据完好（José 手改 yards=28 等不受影响——定向写比旧全量写更不会 clobber）。
- 多实例：当前单实例无陈旧；若未来 scale out，rate 数据跨实例最多陈旧一个 TTL（15min，rate 类可接受）。
- **out-of-band 写注意**：`patch-prod-data.js` / `db:seed` 是独立进程，写后**线上 server 缓存陈旧 ≤TTL**；prod patch 后要 redeploy（重启清缓存）或等一个 TTL 窗口再生产抽查。

## 安全尾（later）
- Express Line 用 postgres 超级用户经连接池直连，RLS 不生效。建议改 service_role / 受控角色（非 egress 原因，later）。
- 可选硬化：①把 exchangeRates 拆独立小 key（热冷分离，FX 彻底不搬大 blob）②round21 推荐的应用层用量护栏（内存计数超阈值降级+告警）。

**项目状态**：main=b9b443c。写风暴 round21 已根治；本轮读风暴结构性修复（读缓存 killshot），待合 PR 部署 + 部署后探针验证读率骤降。

**本轮防compact写入**：00w_chandler_log_round24.md（本文件）+ `_ROADMAP_anti_compact.md` 定位区 r24。
