彻查那个"自动轮询"bug到底是什么、在哪、现在还在不在（Chandler质疑：正常网页打开查一次就完事，根本不该有东西每隔几秒自动查询。这个轮询是bug不是设计，必须揪出来）+ 做一个"超量整站停+提示联系管理员"的护栏（Chandler不介意系统暂时停，要的是到量真停，不是温和降级）。Chandler要当场实测真相+大白话+真实数字，不要旧笔记推算。token不计成本，越彻底越好。

# 任务：揪出自动轮询bug的根源 + 超量整站停护栏

仓库当前目录。先git pull同步main，确认所有PR(#16/#17/#18/#19)是否都已合并部署+main最新commit。本任务分支 feature/kill-poller-and-hardstop。PR-only、不直推、不force-push。

## 背景（Chandler的核心认知，必须理解）
- **轮询是bug不是正常设计**：正常网页打开查一次就完事，不会每隔几秒自动查。轮询只在股票/聊天/外卖追踪这种实时场景才需要。这个货代报价系统(汇率一天变一次)根本不需要轮询。那个每2秒戳一次的东西是意外/bug，必须揪出来杀掉。
- **缓存不轮询**：缓存是被动的，没人查就什么都不做。轮询是另一个东西干的。
- **两个bug叠加**：①轮询bug(最致命，跟人数无关、24h不停)②大箱子(整个业务数据塞在一个~1.6MB blob，搬一次就1.6MB)。
- **Chandler不介意系统暂时停**：护栏要的是"超量→报警→整站停→页面提示请联系管理员"，他当管理员人工查因恢复。不要"只停某功能"(那需系统判断是谁干的，复杂且可能误判)。

## 先读
- docs/client-info-source/00z5_chandler_log_round29.md（含round30关键更正：轮询是bug、egress算术、护栏改整站停）
- docs/client-info-source/00z3_chandler_log_round27.md（F1 poller自停发现+refresh-monitor）
- src/lib/store.js + src/lib/db.js + src/lib/usage-guard.js + src/lib/refresh-monitor.js + src/server.js

═══════════════════════════════════════════════
## 第一部分 — 揪出自动轮询bug的根源（最重要，根子）
═══════════════════════════════════════════════
Chandler要知道：这个不该存在的自动轮询，到底是什么、在哪、现在还在不在。

**1. 当场实测现状**：
- 跑 scripts/rmw-egress-probe.js：实测当前读穿透reads/min、写writes/min。
- pg_stat_statements 查 app_state 读写累计次数：
  ```sql
  select calls, rows, round(total_exec_time/1000) as total_sec, left(query,80) as query
  from pg_stat_statements where query ilike '%app_state%' order by calls desc limit 10;
  ```
- blob大小：`select pg_size_pretty(pg_column_size(payload)), pg_column_size(payload) from expressline.app_state where key='shipping-data';`
- 折算真实egress：reads/min × 1440 × blob大小 = 每天；×30 = 每月。

**2. 那个轮询门铃现在还响不响**：
- curl 生产 /healthz 看 refreshRoute：totalHitsToday、lastHitAt、distinctSources。
- 连续观测3-5分钟(每30s curl一次)看 refresh 路由此刻还被打不打。
- 明确回答：门铃现在还响吗？如果还响，抓来源指纹(IP/UA/Referer)。

**3. 揪出轮询代码的根源（关键）**：
- **彻底grep前端**：public/*.js + views/**/*.ejs 里所有 setInterval、setTimeout、定时 fetch、自动刷新、autosave、location.reload 循环。把每一处列出来：在哪个文件哪一行、多久触发一次、触发什么。
- 重点找：有没有任何前端代码在定时POST /exchange-rates/refresh 或定时GET某个会触发整块读的接口。
- 确认 refresh-monitor(PR#18)抓到的来源是仓库内页面还是仓库外脚本——若仓库内某页面在轮询，揪出那个页面那段代码。
- **即使门铃当前停了，也要确认仓库代码里到底有没有"会轮询的代码"**——如果有(哪怕暂时没触发)，是定时炸弹，要杀掉/改掉。如果仓库里完全没有，那轮询来自外部(José的浏览器开着某页/外部脚本)，refresh-monitor陷阱保留等它再来抓。

**4. 给真相（大白话+数字）**：
- 现在每天/每月真实egress = 多少？
- 轮询门铃现在还响吗？根源在仓库内(哪个文件)还是仓库外？
- 能不能白嫖(月egress<5GB)？
- 大箱子(1.6MB blob)要不要拆(热冷分离，把频繁读的小部分单独存)？值不值得？

═══════════════════════════════════════════════
## 第二部分 — 超量整站停护栏（Chandler要的，不纠结只停某功能）
═══════════════════════════════════════════════
**Chandler明确**：超量→报警→整站对外停→页面提示"请联系管理员"，他人工查因恢复。不要温和降级，不要纠结"只停哪个功能"。

**在现有usage-guard.js基础上做**：
- 每日egress阈值：env APP_STATE_DAILY_EGRESS_LIMIT_MB（默认100）。用blob实际大小动态折算成穿透读次数阈值(阈值MB ÷ 当前blob大小)，不写死。
- 超阈值后：
  1. **后台醒目报警日志**：[USAGE-GUARD-HARD-STOP] daily egress exceeded NMB (today reads=X × blob=Y MB), site entering maintenance mode until manual reset.
  2. **对外整站停+友好页面**：超阈值后，所有会触发DB读的对外请求，返回一个友好的维护页面(HTTP 503)，页面写"系统暂时维护中，请联系管理员"(中/西双语)，不是裸500/白屏。可用一个中间件在超阈值时拦截。
  3. **记录当天情况供查因**：把当天的egress估算、穿透读次数、refresh门铃命中数(refreshRoute)记下来，/healthz 能看到，方便管理员(Chandler)查"为什么超了"。
  4. **手动恢复**：跨天自动重置，或提供手动恢复开关(env APP_STATE_HARD_STOP_ENABLED=false 临时禁用整个机制 / 或重启清零 / 或一个admin端点重置当日计数——CC选最简单可靠的)。
- 纯内存计数，不为计数引入DB写。
- **健康端点/healthz要能让Chandler随时curl看：今天egress估算多少MB、阈值多少、是否已触发停机、门铃今天响了几次**。

**注意**：José后台正常用(缓存命中)不该轻易触发——阈值100MB对应穿透读约64次/天，远高于正常。只有又出现失控轮询才会触发。触发=有bug了，Chandler收报警人工查。

═══════════════════════════════════════════════
## 第三部分 — 概念沉淀
═══════════════════════════════════════════════
docs/LESSONS.md + 代码注释写清：
- 轮询是bug非正常设计(正常网页打开查一次就完事，实时场景才轮询)；缓存被动不轮询。
- egress = 搬箱子次数 × 每次大小；两bug叠加(轮询+大箱子1.6MB)。
- TTL延迟只影响绕过系统直接改库；José后台正常改立刻生效(写后更新缓存)。
- 护栏=bug警报器，正常永远到不了100MB。

## 验收（测试厚）
- 第一部分：真实egress数字+门铃现状+轮询代码根源(仓库内哪行/或仓库外)+能否白嫖+拆箱子建议，全当场实测。
- 第二部分：超阈值→报警+503维护页(中西双语)+/healthz今日egress可见+手动恢复。测试：模拟超阈值触发整站停+返回维护页、正常量级不触发、跨天重置、纯内存零DB写、José正常用(缓存命中)不误触。
- 回归：smoke+quote9/9+所有审计全绿。
- /healthz 实测返回今日egress估算+阈值+停机状态+门铃命中。

## 全局约束
- 护栏纯内存不引入DB写。
- 维护页友好(中西双语"请联系管理员")，不裸500。
- 阈值用blob实际大小动态折算。
- 改生产数据/配置前备份，走patch不db:seed。
- 防compact：进度写_ROADMAP+00z5；compact从那恢复。
- Task Summary+Post-task routing+lesson写LESSONS.md。

## 报告（大白话+数字，Chandler要看懂）
- 第一部分真相：现在每天egress=X MB、每月=Y GB；门铃还响吗(还响/已停)；轮询代码根源=仓库内哪文件哪行/或确认仓库外；能否白嫖=能/不能；拆箱子值不值得。
- 第二部分护栏：阈值、超量整站停+维护页、/healthz今日egress字段、手动恢复方式、测试结果。
- 回归全绿。
- 给Chandler的明确结论：①轮询bug根源到底是什么②白嫖能不能长期活③要不要拆箱子④要不要付Pro。

## 开始
git pull→确认PR部署→切feature/kill-poller-and-hardstop→第一部分揪轮询根源(实测+grep全前端+/healthz门铃)→第二部分整站停护栏(报警+维护页+/healthz+手动恢复)→第三部分概念沉淀→深度测试→报告(大白话+数字)。连续做完。
