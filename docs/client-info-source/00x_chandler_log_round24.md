# 00x — 第N+24轮（核实RMW读缓存killshot / egress根因=读不是写 / PR#16待合并）

> 00w(CC写的round24) 续篇。Claude核实轮。最新轮次。

## 2026-06-20 第N+24轮 — Claude核实RMW读缓存killshot

**CC RMW killshot结果（PR#16 OPEN，feature/rmw-loop-killshot，从main=b9b443c切，待合并部署）**：
- **⭐egress根因=读不是写（CC修正了我和它前几轮的共同误判）**：Round21已根治写(生产实测0写/min)，但egress仍击穿70×，因为唯一读入口getShippingData()每请求整块拉~1.6MB blob无缓存，外部poller每2s打/exchange-rates/refresh时整块读发生在节流闸之前。实测读38.6/min≈55,598/天×1.6MB≈70GB/天。
- 定位铁证：getShippingData(store.js)是唯一读入口，包在server.loadShippingData(server.js:832)被59个路由调。触发器=外部客户端不在仓库(FX refresh route server.js:2910调loadShippingData每次先整块读才进节流闸)。前端无轮询、调度器每天一次、getUsers只login一次=均非元凶。
- 量化(生产只读探针scripts/rmw-egress-probe.js+pg_stat_statements)：blob 1235kB列压缩(egress解压~1.6MB)、revision 214825、写0/min(Round21已死)、读38.6/min≈55598/天=egress真凶。

**Claude核实store.js（读穿killshot实现，逻辑严密，认可）**：
- **读缓存killshot✓**：getShippingData先shippingCacheIsFresh()，命中返回structuredClone(shippingDataCache)(克隆隔离调用方改了不污染缓存)，不再每请求拉DB。TTL默认15min(env SHIPPING_CACHE_TTL_MS可调)。消除218k整块读。
- **写后失效/更新write-through✓**：saveShippingData写完setShippingDataCache、saveExchangeRates写完updateShippingCacheSection(["exchangeRates"])。单实例操作者读自己刚写永远命中最新(我特别关注的"别因缓存让用户以为没存上"，CC处理对了)。
- **主写定向化✓**：saveShippingData现在①pin exchangeRates(admin存模块用最新FX绝不回滚并发汇率)②无变更不落库(diff changed.length===0不写)③单section改→定向jsonb_set，跨section/冷缓存→全量兜底。
- 15min非60s推理对：连续轮询下TTL=egress地板，60s→69GB/月(仍超14×)，900s→4.6GB/月(达标)。单实例write-through零陈旧代价，纯egress调节阀。
- 测试9/9(含100读=0 DB pull/写后立即可见/无变更不落库/跨模块全量兜底)，全回归10/10。
- **结论：killshot彻底严密，认可。egress根因(无缓存整块读)已根治。**

**重要：CC的self-correction值得肯定** —— 它主动修正前几轮"FX写风暴"的框定(写已死但egress仍烧，真凶是无缓存整块读)，从第一性原理(pg_stat_statements读率)重新推导。这跟我上轮的诚实对账一致：之前几轮(包括我)的FX框架太窄，真凶是更广的读路径。

**待Chandler决定**：
1. **合并PR#16部署**（killshot待合并，合并后egress才真正降。CC建议合并后跑rmw-egress-probe.js确认读率→~0/min）。Claude建议合并(核实修复严密)。
2. CC的Global candidate：CC建议把"配额悬崖的读侧：READ egress可压过写，写风暴修复别漏无缓存整块读"升级。**这正好补全我上轮写进core的2条guardrail**——上轮guardrail偏"写"(贵操作节流+配额悬崖)，这轮证明READ egress也能击穿，该补"读侧"。建议升级/补进Cursor Project Master/database/框架。
3. out-of-band注意(CC提醒)：patch-prod-data/db:seed是独立进程，写后线上server缓存陈旧≤TTL→prod patch后redeploy或等一个TTL再抽查。**这是新的部署纪律**，要记进锚点。

**留尾（CC标[OUT_OF_SCOPE]）**：从源头停外部poller(需Railway log)、exchangeRates拆独立key(热冷分离)、应用层用量护栏、RLS/service_role。

**部署机制锚点（强化+新增）**：
- 生产=Supabase app_state(key=shipping-data)~1.6-2.2MB blob有José手改
- **新增读缓存纪律**：线上server有进程内读缓存(TTL默认15min)，write-through单实例零陈旧。**out-of-band写(patch-prod-data/db:seed独立进程)后，线上缓存陈旧≤TTL→patch后要redeploy或等一个TTL再抽查**(否则抽查看到的是缓存旧值)。
- 热子字段jsonb_set定向写；主写路径也diff后定向；改数据走patch不db:seed。

**项目状态**：main=b9b443c，PR#16(killshot)待合并。egress根因(读)已修待部署验证。José待回数据。

**本轮防compact写入**：00x_chandler_log_round24.md（本文件）
