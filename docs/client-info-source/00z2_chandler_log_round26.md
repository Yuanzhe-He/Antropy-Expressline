# 00z2 — 第N+26轮（护栏核实 + egress生产实测降97% + 下一步）

> 00z(CC写的round25) 续篇。Claude核实轮。最新轮次。
> 注：CC把它的日志写成00z_chandler_log_round25.md，本文件用00z2避免冲突，记round26核实。

## 2026-06-20 第N+26轮 — Claude核实用量护栏 + egress落地里程碑

**⭐⭐egress生产实测落地（最关键）**：
- PR#16(killshot)已合并部署(main=67ae1df→PR#17从此切)。生产实测06:43Z：读38.6→1.0/min、egress~70→~1.8GB/天(降97%)、写0/min。**Supabase不再被烧。**
- PR#17(feature/usage-guard-and-ttl，OPEN待合并)：TTL拉到1h(地板再降到~24读/天≈~1.1GB/月)+应用层用量护栏+/healthz。部署后读穿透再降到~24/天。

**CC PR#17内容**：
- A TTL 15min→1h(getShippingCacheTtlMs，env SHIPPING_CACHE_TTL_MS可调/0禁用)。地板1h=24读/天×1.6MB≈38MB/天≈1.1GB/月。
- B 用量护栏usage-guard.js(纯内存)：db层getAppState→recordRead(只数穿透，缓存命中在store层短路到不了)，saveAppState+patchAppStateField→recordWrite。阈值env可调(读200/天、写500/天、severe5×、告警间隔5min、降级TTL地板1h)。醒目去重告警[USAGE-GUARD-ALERT]。自动降级：写超阈值FX(auto)跳过DB写保留缓存、admin(user)永不阻断；读severe(≥5×)强制TTL地板1h。/healthz(无auth无secret)+启动日志。跨天重置。
- C 读侧沉淀LESSONS+LESSON_CANDIDATES。

**Claude核实usage-guard.js（读穿，认可）**：
- 只数穿透读✓(recordRead注释"Cache hits never reach here"，缓存命中store层短路)。
- 区分自动写vs用户写✓(shouldDegradeAutoWrite只FX用，"USER writes never consult this; they always proceed")。
- 纯内存不引入DB写✓。告警去重✓(首次立即+每5min最多一次)。/healthz无secret✓。
- 测试8/8+全回归11/11。护栏严密。

**当前状态**：
- main=67ae1df(PR#16已部署，egress降97%)。
- PR#17(TTL1h+护栏+/healthz)OPEN待合并。**下一步=合并PR#17部署，验证TTL1h读穿透→~24/天+/healthz上线。**

**留尾（CC标[OUT_OF_SCOPE]，都是later）**：
- F1从源头停外部poller(需Railway log查那个每2s打/exchange-rates/refresh的已登录源)。
- postgres超级用户→service_role(RLS不生效，非egress)。
- exchangeRates拆独立小key(热冷分离)。
- step-2邮件/webhook告警(需指定服务+邮箱)。

**部署机制锚点（强化）**：
- 生产=Supabase app_state(key=shipping-data)~1.6-2.2MB blob有José手改。
- 读缓存TTL默认1h(PR#17后)，write-through单实例零陈旧。**out-of-band写(patch-prod-data/db:seed独立进程)后线上缓存陈旧≤TTL→patch后redeploy或等一个TTL再抽查。**
- 热子字段jsonb_set定向写；主写diff后定向；改数据走patch不db:seed。

**全局沉淀已完成（前几轮）**：core/AGENTS.md 2条guardrail(贵操作节流+配额悬崖含读侧)、Cursor Project Master/database/专题(README+raw案例+quota-cliff-checklist含读侧一节+expensive-op-throttle)、LESSON_CANDIDATES。

**本轮防compact写入**：00z2_chandler_log_round26.md（本文件）
