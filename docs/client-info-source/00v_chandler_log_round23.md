# 00v — 第N+23轮（egress调查揭示更广RMW循环 / 核实读写路径未优化 / 出根因prompt）

> 00u 续篇。最新轮次。

## 2026-06-20 第N+23轮 — pg_stat_statements调查 + Claude核实读写路径

**Chandler给的Supabase egress调查（决定性证据）**：
- 单项目polxyashvxbzdkkmxuox，100% Shared Pooler Egress，361.6GB（免费版5GB击穿70倍），6/14起爆。
- pg_stat_statements TOP：①`select payload from expressline.app_state where key=$1` 218,364次（读）②`insert...on conflict do update set payload=excluded.payload` 211,747次（写）③pgbouncer.get_auth 40,983次（连接churn）。
- **读≈写(218k≈211k)=关键指纹**：热路径有"整块读→改→整块写回"循环，每3秒一次全天不停。361.6GB÷218k≈1.6MB/payload=blob大小。egress主要是读路径（218k次整块拉1.6MB≈350GB）。

**⭐⭐这修正了我之前几轮的FX框架（诚实对账）**：
- 之前几轮把问题框成"FX写风暴"，CC修了FX节流（checkedWithinThrottle 15分闸），掐了"外部每2秒打/exchange-rates/refresh"这一个触发器，实测60秒0写。
- **但egress数据是7天累计**，包含FX修复前的量。且这份数据揭示问题更广=不只FX：读路径无缓存+主写路径整块写=结构性问题，任何高频触发器都会造成整块读写。
- 必须确认：FX节流之后那个"每3秒整块读写"还在不在？还有没有别的高频路径调getShippingData/saveShippingData。

**Claude核实store.js（读穿了，确认两个未优化点）**：
- **getShippingData读路径完全没优化**：DB模式`getAppState(shippingDataStateKey)`每次整块拉~1.6MB blob，无任何内存缓存。=218k次读/~350GB egress直接来源。
- **saveShippingData主写路径还是整块写**：`saveAppState(...normalizeShippingData(data))`整块覆盖。只有saveExchangeRates用了patchAppStateField(jsonb_set定向写)，主写路径没用。
- db.js已有patchAppStateField(jsonb_set单字段)可复用，但只FX写用了。
- 调度器每天午夜一次非元凶。元凶触发器在server.js(4000行，隔离环境没法grep)+可能前端setInterval。前端app.js开头是主题/滚动无轮询，未扫完。

**下一轮prompt（根因RMW循环，结构性修复）**：
1. 定位触发器：CC grep server.js(saveShippingData/getShippingData/refreshExchangeRatesIfStale/saveAppState/app.use/setInterval)找每请求或高频调整块读写的路由/中间件；grep public/前端setInterval/fetch/autosave找每3秒的定时器。
2. 量化确认：SQL `select pg_column_size(payload)...`确认blob大小；当前egress/写频（FX节流后是否已降，还有没有RMW循环）。
3. 结构性修复（不管触发器是不是FX都修）：①写→主写路径saveShippingData能定向就用patchAppStateField，无变更不落库②读→getShippingData加进程内内存缓存(启动读一次/按变更/TTL刷新，别每请求整块拉)③前端→autosave debounce、setInterval关掉或拉长、visibilitychange暂停。
4. 止血选项：若现在还在烧，先临时禁用那个前端setInterval/暂停部署，再上修复。
5. 安全尾：Express Line用postgres超级用户经连接池直连RLS不生效，建议改service_role/受控角色（非egress原因，later）。
6. 测试厚（Chandler一贯要求），改完全回归+生产抽查egress降。

**部署机制锚点（不变+强化）**：生产=Supabase app_state(key=shipping-data)2.18MB blob有José手改；热子字段jsonb_set定向写；改数据走patch不db:seed。**新增：读路径要内存缓存别每请求整块拉；主写路径也要尽量定向写。**

**项目状态**：main=b9b443c。FX节流已上但egress揭示更广RMW循环待根治。

**本轮防compact写入**：00v_chandler_log_round23.md（本文件）
