# 00z6 — 第N+31轮（承认轮询判断错+大blob是病根+要最彻底重构+抓幽灵）

> 00z5(round29/30) 续篇。最新轮次。Chandler三个尖锐批评，全部成立。

## 2026-06-21 第N+31轮 — Chandler三连批评 + 要最彻底方案

**Chandler三个批评（全部成立，Claude认）**：
1. **轮询判断错**：Claude最初建议把轮询从2s拉到15min/1h，但如果轮询本不该存在，正确做法是删掉不是调慢。Claude承认：把bug当"需要调优的正常功能"处理了，错误。拉TTL只是盖布，bug还在。正确第一反应=找到它删掉它。
2. **每查一次调全量DB**：现在查任何小东西都搬整个1.6MB blob。Chandler质疑这不正常，正常该"查哪儿调哪儿"。Claude确认这是核心病根。
3. **幽灵没单独查**：Claude上版prompt写了"揪轮询代码"但没把"幽灵到底是谁"作为独立硬任务。Chandler要求全量prompt查幽灵。

**Claude看db.js确认的现状（亲眼）**：
- DB有三张表：app_state、audit_logs、quote_snapshots。但所有业务数据(船公司/港口/码头/堆场/费率/汇率)全塞进app_state表唯一一行(key='shipping-data')的一个JSONB字段=1.6MB blob。
- getAppState每次整块select payload(整个1.6MB)。patchAppStateField只在写时局部jsonb_set，读还是整块。CC注释自己写了"不必重新搬整个几MB blob"——说明意识到了但只优化了写。
- 比方：现状=所有东西塞一个封死的大信封，查一个数字要搬整个信封；正常=文件柜有很多抽屉，查哪个抽哪个。

**最彻底的正常设计（Claude给Chandler讲的"跳出来看"）**：
- 把大blob拆成真正的关系表：shipping_lines(船公司)、ports/terminals(港口码头)、yards(堆场)、charges(费率，关联船公司)、exchange_rates(汇率)，每个实体一行。
- 好处：查哪儿调哪儿(select where，只搬几KB不搬1.6MB)、改哪儿改哪儿、egress自然低、可建索引快、天然防并发覆盖(改不同行不打架)。
- 术语=数据规范化(normalization)+从blob迁移到关系表。工作量大(建表+迁移数据+改所有读写)但最彻底。
- 缓存是"信封方案"的补丁；文件柜方案根本不需那么依赖缓存。

**本轮prompt三任务（最彻底档，不考虑成本/token/改动量）**：
1. **揪出并删除轮询**(不是调慢是删除)：查清在哪/是什么/为什么存在，grep全前端+server，删掉/改成事件驱动。
2. **抓幽灵**(独立硬任务)：那个每2s打/exchange-rates/refresh的外部来源到底是谁。实测/healthz.refreshRoute、Railway log(或加诊断)、抓IP/UA/Referer指纹。查到底。
3. **最彻底重构方案**：CC拿出完整的blob→关系表规范化方案。先出方案设计文档(建表schema/迁移步骤/改造范围/风险/回滚)，Chandler看了再决定执行。这是大手术，分"出方案"和"执行"两步。

**注意**：第3项是大重构，先让CC出详细方案文档(docs/specs/)，不要直接埋头改。Chandler review方案后再执行。第1、2项可以直接做(查+删轮询、抓幽灵)。

**部署机制锚点（不变）**：生产=Supabase app_state(key=shipping-data)1.6MB blob有José手改；改数据走patch不db:seed；热子字段jsonb_set。重构迁移时尤其注意José手改数据不能丢(yards=28含José自建2、carriers=21含7新空壳、CMA50/KMTC/ZIM等手改)。

**本轮防compact写入**：00z6_chandler_log_round31.md（本文件）
