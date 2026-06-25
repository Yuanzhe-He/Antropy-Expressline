最彻底解决egress根本病根：①揪出并删除那个不该存在的自动轮询(不是调慢是删除)②抓出那个"幽灵"——每2秒打接口的外部来源到底是谁③拿出把"大blob拆成真正关系表"的最彻底重构方案。Chandler明确：不考虑代码量、不考虑token、不考虑改动成本，要最彻底的数据调取量+速度优化。要当场实测+大白话+真实数字。

# 任务：删轮询 + 抓幽灵 + 出blob→关系表的最彻底重构方案

仓库当前目录。先git pull同步main，确认所有PR(#16-#19)是否都已合并部署+main最新commit。本任务分支 feature/kill-poller-catch-ghost。PR-only、不直推、不force-push。

## 背景（Chandler的核心认知 + Claude已确认的病根）
- **轮询是bug不是设计**：正常网页打开查一次就完事，不该每隔几秒自动查。这个货代报价系统(汇率一天变一次)根本不需要轮询。那个每2秒戳一次的是bug，要删除不是调慢。（之前错误地建议把它从2s拉到15min/1h——那只是盖布，bug还在。）
- **核心病根=大blob**：Claude已看db.js确认——所有业务数据(船公司/港口/码头/堆场/费率/汇率)全塞进app_state表唯一一行的一个JSONB字段=~1.6MB blob。getAppState每次整块select整个1.6MB。这就是"查一个汇率数字也要搬整个信封"。正常practice应该是"查哪儿调哪儿"。
- **不考虑成本，要最彻底**：Chandler要最彻底的数据调取量+速度优化，不考虑代码量/token/改动量。

## 先读
- docs/client-info-source/00z6_chandler_log_round31.md（本轮：承认轮询判断错+大blob病根+最彻底重构+抓幽灵）
- docs/client-info-source/00z3_chandler_log_round27.md（F1 poller自停发现+refresh-monitor）
- src/lib/db.js（getAppState整块读/saveAppState/patchAppStateField/三张表结构）
- src/lib/store.js（getShippingData/缓存/normalizeShippingData——blob结构）
- src/server.js（59个路由怎么用loadShippingData、refresh路由）
- 所有前端 public/*.js + views/**/*.ejs

═══════════════════════════════════════════════
## 任务1 — 揪出并删除那个轮询（直接做，不是调慢是删除）
═══════════════════════════════════════════════
- **彻底grep**：public/*.js + views/**/*.ejs + server.js 里所有 setInterval、setTimeout、定时fetch、自动刷新、autosave循环、location.reload循环、任何"每隔X秒/X毫秒自动做某事"的代码。逐一列出：文件:行、触发间隔、触发什么。
- **判断每一处**：这个定时器是不是必要的？货代报价系统几乎不需要任何轮询。任何"定时自动刷新数据/自动保存/自动轮询接口"的代码，除非有明确不可替代的理由，否则删除或改成事件驱动(用户操作时才触发)。
- **特别找**：有没有任何代码在定时触发汇率刷新、或定时触发会读整个blob的接口。
- **如果仓库里有轮询代码** → 删掉/改事件驱动，说明改了什么、为什么安全。
- **如果仓库里完全没有轮询代码** → 那轮询来自外部(见任务2幽灵)，仓库侧确认干净。

═══════════════════════════════════════════════
## 任务2 — 抓出那个"幽灵"（独立硬任务，查到底）
═══════════════════════════════════════════════
**幽灵=那个每2秒POST /admin/:moduleKey/exchange-rates/refresh 的外部来源**。pg_stat_statements曾显示它打了21万+次。它是整件事的第一推动力。必须查清它是谁。

- **实测它现在还在不在**：curl 生产 /healthz 看 refreshRoute(totalHitsToday/lastHitAt/distinctSources)。连续观测5分钟(每30s一次)看现在还打不打。
- **抓指纹**：refresh-monitor(PR#18)记录了来源IP/UA/Referer。curl /healthz.refreshRoute.sources 看抓到了什么。如果幽灵现在活跃，直接抓到IP/UA/Referer。
- **查Railway日志**：尝试railway CLI看access log里 /exchange-rates/refresh 的来源(若token失效需Chandler浏览器登录=user-only，那就说明，让Chandler自己看或授权)。
- **判断幽灵身份**：根据IP/UA/Referer判断是——①José或某同事浏览器开着某个后台页(那个页在轮询)？②某个忘了关的脚本/监控？③其它？
- **如果抓到是某个仓库内页面在轮询**(Referer指向你的某个页面) → 回任务1删那个页面的轮询代码。
- **如果幽灵当前不活跃** → 说明，refresh-monitor陷阱保留，并给Chandler一个明确建议：怎么从源头确认/排除(比如问José是不是开着后台页、检查有没有部署过什么定时任务/监控)。
- **给Chandler明确结论**：幽灵现在还在吗？它是谁(或最可能是谁)？怎么从源头根除？

═══════════════════════════════════════════════
## 任务3 — 最彻底重构方案：大blob → 真正的关系表（出方案文档，不直接埋头改）
═══════════════════════════════════════════════
**这是根治。** Chandler要最彻底的方案，不考虑成本。但这是大手术，**先出详细方案设计文档，Chandler review后再执行**，不要直接开始改。

写一份 docs/specs/YYYYMMDD_blob_to_relational_redesign.md，包含：

**A. 现状分析**：
- 当前1.6MB blob里到底装了什么——列出blob的完整结构(modules.handover/customs/inland/quote下面各有什么、exchangeRates、有多少船公司/港口/堆场/费率条目)。
- 量化：每个部分多大？哪些是"热数据"(频繁读，如汇率)、哪些是"冷数据"(很少变，如港口列表)？
- 现在59个路由分别读blob的哪些部分？哪些路由其实只需要一小部分却搬了整个？

**B. 目标关系表设计**：
- 设计规范化的表结构。候选：shipping_lines(船公司)、ship_line_charges(费率，FK到船公司)、ports/terminals(港口码头)、yards(堆场，含CONTENTO 26+José自建2)、inland_routes/inland_vehicles(陆运)、exchange_rates(汇率单独表)、module_config(模块级配置)等。
- 每张表的字段、主键、外键、索引。
- 给出完整的 CREATE TABLE DDL。
- 说明：查KMTC费率怎么查(select where line=kmtc，只搬几行)、改汇率怎么改(update exchange_rates一行)、egress怎么从"每次1.6MB"降到"每次几KB"。

**C. 迁移方案**：
- 怎么把现有blob的数据迁移到新表(写一个迁移脚本：读blob → 拆解 → 插入各表)。
- **关键：José的手改数据必须零丢失**(yards=28含José自建2、carriers=21含7新空壳、CMA doc fee 50、KMTC ISD 15、ZIM改名、COSCO等手改)。迁移前备份，迁移后逐项核对。
- 迁移是一次性的：blob → 新表，之后blob废弃或保留只读备份。

**D. 代码改造范围**：
- store.js的getShippingData/saveShippingData等要怎么改(从读整个blob → 按需查表)。
- 59个路由要怎么改(每个只查自己需要的表)。
- 缓存策略怎么变(规范化后还需不需要缓存？需要的话缓存什么——可能缓存少数热表，或者根本不需要因为查询本身就小了)。
- 报价/计算/PDF逻辑受什么影响。
- 估算改造范围(哪些文件、大概多少处)。

**E. 风险与回滚**：
- 大重构的风险(数据迁移出错、漏改路由、报价结果变化)。
- 怎么验证迁移正确(逐表核对、报价结果前后对比)。
- 回滚方案(保留blob作为fallback，新表出问题能切回)。
- 建议的执行步骤(分几个PR、每步怎么验证)。

**F. 收益量化**：
- 重构后预期egress(每次查询从1.6MB → 几KB，降多少)。
- 速度提升(索引查询 vs 整块解析)。
- 并发安全(改不同行不打架)。
- 给Chandler明确结论：这个重构值不值得做、工作量量级、建议怎么分步执行。

**不要在本轮直接执行重构**，只出方案文档。Chandler review后单独立项执行。

## 验收
- 任务1：轮询代码全部列出+删除/改造(或确认仓库无轮询)。回归全绿。
- 任务2：幽灵现状(还在不在)+身份(是谁/最可能)+根除建议，当场实测。
- 任务3：完整方案文档(A现状/B表设计含DDL/C迁移含José数据保护/D改造范围/E风险回滚/F收益)。不执行。
- 回归：smoke+quote9/9+所有审计全绿(任务1可能改前端轮询，确认不破坏功能)。

## 全局约束
- 轮询是删除不是调慢。
- 任务3只出方案不执行，José手改数据保护是迁移的硬约束。
- 改生产数据/配置前备份，走patch不db:seed。
- 防compact：进度写_ROADMAP+00z6；compact从那恢复。
- Task Summary+Post-task routing+lesson写LESSONS.md(轮询是bug该删/大blob是反模式/规范化方案)。

## 报告（大白话+数字，Chandler要看懂）
- 任务1：找到的轮询代码(文件:行+间隔)+删了什么/或确认仓库干净。
- 任务2：幽灵现状(还响吗)+是谁(IP/UA/Referer指纹或最可能身份)+怎么根除。
- 任务3：方案文档路径+摘要(现状blob多大装了啥、目标表怎么设计、迁移怎么保护José数据、改造范围、预期egress降到多少、值不值得做、怎么分步)。
- 回归结果。
- 给Chandler明确结论：①轮询删了吗②幽灵是谁③最彻底重构方案长什么样、要不要做、怎么分步做。

## 开始
git pull→确认PR部署→切feature/kill-poller-catch-ghost→任务1(grep全前端+server揪轮询并删除)→任务2(实测/healthz+Railway log抓幽灵指纹查身份)→任务3(写blob→关系表重构方案文档，不执行)→回归→报告(大白话+数字)。连续做完。
