彻底诊断egress真实原因（Chandler质疑：这破系统没几个客户，为什么一天1.8GB egress？到底在egress什么？那个外部poller现在还在不在？）+ 做一个100MB硬护栏（每天超阈值就报警+停失控查询）。Chandler对egress数字不放心，要当场实测真相，不要靠旧笔记推算。token不计成本，越彻底越好。做完详细报告，用大白话+具体数字解释。

# 任务：当场彻查egress真实原因 + 100MB可配置硬护栏

仓库当前目录。先git pull同步main。先确认main最新commit + 所有PR(#16读缓存/#17 TTL+护栏/#18 F1抓取/#19文档)是否都已合并部署。本任务分支 feature/egress-forensics-and-hard-guard。PR-only、不直推、不force-push。

## 先读
- docs/client-info-source/00z5_chandler_log_round29.md（本轮Chandler的困惑+概念澄清）
- docs/client-info-source/00z3_chandler_log_round27.md（F1 poller自停的发现）
- docs/client-info-source/00z2_chandler_log_round26.md（护栏+egress落地数字）
- src/lib/store.js（读缓存）+ src/lib/db.js（getAppState/saveAppState）+ src/lib/usage-guard.js（现有护栏）+ src/lib/refresh-monitor.js（F1抓取）+ src/server.js（/healthz、refresh路由）

═══════════════════════════════════════════════
## 第一部分 — 当场彻查egress真实原因（最重要，Chandler要真相不要推算）
═══════════════════════════════════════════════
Chandler的核心质疑：没几个客户的破系统，凭什么一天1.8GB egress？必须用**当场实测的真实数字**回答，不许用旧笔记推算。逐项查清：

**1. 现在真实egress到底多少？**
- 跑 scripts/rmw-egress-probe.js（若存在），实测当前读穿透率(reads/min)、写率(writes/min)。
- 跑 pg_stat_statements 查 app_state 的读/写累计次数 + 估算egress：
  ```sql
  select calls, rows, round(total_exec_time/1000) as total_sec,
         left(query, 80) as query
  from pg_stat_statements
  where query ilike '%app_state%'
  order by calls desc limit 10;
  ```
- 实测 blob 当前大小：`select pg_size_pretty(pg_column_size(payload)), pg_column_size(payload) from expressline.app_state where key='shipping-data';`
- 折算：当前reads/min × 1440 × blob大小 = 每天egress；× 30 = 每月egress。给出真实数字。

**2. 那个外部poller（卡住的门铃）现在还在不在？**
- curl 生产 /healthz，看 refreshRoute 字段：totalHitsToday、lastHitAt、distinctSources。
- 连续观测3-5分钟（每30s curl一次），看 refresh 路由今天/此刻还被打不打。
- 若 lastHitAt 是很久以前/null → poller已停（门铃不响了）。若还在每隔几秒涨 → poller还活着，抓它的来源指纹(IP/UA/Referer)。
- **明确回答：门铃现在还响不响？**

**3. 每次穿透读到底在读什么、多大？**
- 确认那个被反复读的就是 getAppState(key='shipping-data') 的整块 1.6MB blob，不是别的。
- 确认egress的构成：是不是100%都是这个blob的反复读？还有没有别的表/别的查询在贡献egress(查pg_stat_statements rows排序)？

**4. 缓存到底生效没有？**
- 确认 PR#16 读缓存 + PR#17 的1h TTL 是否真的部署生效：curl /healthz 看 shippingCacheTtlMs 是不是 3600000(1h)。
- 看 usageGuard.reads（穿透读计数）：如果1h TTL真生效，穿透读应该≈24/天。如果实测远超(如1440/天)，说明缓存没完全挡住——查为什么：是不是有的读路径绕过缓存？是不是force refresh绕过缓存直接读？是不是缓存key/TTL逻辑有bug？
- **这是关键诊断点**：如果门铃已停但egress还高，或门铃在打但缓存没挡住，要查出确切机制。

**5. 综合给出真相（大白话+数字）**：
- 现在每天/每月真实egress = 多少？
- 根因 = 门铃还在打？还是缓存漏了？还是别的？
- 能不能白嫖（月egress < Free的5GB）？还是必须付Pro？
- 如果egress仍异常高，确切的修复是什么？

═══════════════════════════════════════════════
## 第二部分 — 100MB可配置硬护栏（Chandler明确要）
═══════════════════════════════════════════════
**Chandler诉求**：每天egress超过特定值(如100MB，过去从没到过)就报警+停止查询。在现有usage-guard.js基础上扩展。

**做两档可配置（env控制）**：

**温和档（默认，推荐）**：超阈值时只停"失控的自动查询"，José正常用不受影响。
- 现有usage-guard已有"读severe→延长缓存TTL"和"写超阈值→停FX自动写"。扩展：增加一个按egress量(穿透读次数×blob大小折算MB)的每日阈值，默认对应~100MB（即穿透读次数阈值 = 100MB ÷ blob大小 ≈ 64次/天，做成env APP_STATE_DAILY_EGRESS_WARN_MB 默认100）。
- 超阈值：醒目报警日志[USAGE-GUARD-EGRESS-ALERT] + 强制拉长缓存TTL到地板(已有机制) + 标记triggeredToday。这样失控的自动刷新被缓存挡住，但José的正常读(缓存命中)不受影响。

**硬档（可选开启，env APP_STATE_HARD_STOP_ENABLED=true）**：超阈值直接拒绝所有对外DB穿透读，宁可系统暂时不可用也不烧钱。
- 超阈值后，getAppState的穿透读直接抛错/返回缓存兜底(如果有缓存就用旧缓存，没有就503)，直到次日重置或手动重启。
- 这是"核选项"，Chandler明确知道代价(系统可能暂时不可用)才开。默认关闭。
- 日志要极其醒目：[USAGE-GUARD-HARD-STOP] daily egress exceeded NMB, blocking DB reads until reset。

**两档都要**：
- 阈值env可调(APP_STATE_DAILY_EGRESS_WARN_MB 默认100)。
- 用blob实际大小动态折算（不要写死64次，要 阈值MB ÷ 当前blob大小）。
- 纯内存计数（不为计数引入DB写）。
- 跨天重置。
- /healthz 暴露当前egress估算(今日穿透读次数 × blob大小 = 今日egress MB)，让Chandler能随时curl看今天用了多少。

═══════════════════════════════════════════════
## 第三部分 — 概念沉淀
═══════════════════════════════════════════════
- docs/LESSONS.md 记：egress定义(往外吐的字节)；正常这系统egress应极低(几MB-几十MB/天)，高egress是bug不是正常成本；TTL延迟只影响out-of-band直接改库(José后台正常改立刻生效，写后更新缓存)；100MB护栏本质是bug警报器(正常永远到不了)。
- 代码注释把这些写清楚，便于以后看懂。

## 验收（测试厚）
- 第一部分：真实egress数字(每天/每月) + 门铃现状(还响不响) + 缓存是否生效 + 根因 + 能否白嫖 全部当场实测给出。
- 第二部分：温和档(超阈值延长缓存+报警，José不受影响) + 硬档(超阈值停穿透读，默认关) + env可调 + blob动态折算 + /healthz暴露今日egress。测试：模拟超阈值触发温和档、模拟开硬档触发停读、正常量级不误触、跨天重置、纯内存零DB写。
- 回归：smoke+quote9/9+所有审计全绿。
- /healthz 实测返回今日egress估算。

## 全局约束
- 护栏纯内存，不为计数引入DB写。
- 硬档默认关闭(避免误伤)，温和档默认开。
- 阈值用blob实际大小动态折算，不写死。
- 改生产数据/配置前备份，走patch不db:seed。
- 防compact：进度写_ROADMAP+00z5；compact从那恢复。
- Task Summary+Post-task routing+lesson写LESSONS.md。

## 报告（用大白话+具体数字，Chandler要看懂）
- 第一部分真相：现在每天egress=X MB、每月=Y GB；门铃现状=还响/已停；缓存生效情况=穿透读N次/天(对比理论24次/天)；根因=具体什么；能否白嫖=能/不能(月egress vs 5GB)；若仍高，修复=什么。
- 第二部分护栏：温和档+硬档实现、阈值、/healthz今日egress字段、测试结果。
- 回归全绿。
- 爆炸半径。
- 给Chandler的明确结论：白嫖能不能长期活？还是建议付Pro？为什么？

## 开始
git pull→确认PR都已部署→切feature/egress-forensics-and-hard-guard→第一部分当场彻查(探针+pg_stat_statements+/healthz+blob大小+门铃观测+缓存诊断)→第二部分100MB两档护栏→第三部分概念沉淀→深度测试→报告(大白话+数字)。连续做完。
