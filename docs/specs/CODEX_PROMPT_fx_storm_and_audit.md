FX写风暴源头排查（Claude已本地定位机制链，真凶高置信=某高频请求带refreshRates:true每次触发FX刷新写库）+ 全面检测上线的所有东西（Chandler要"检测上线的有没有问题"）。token不是成本，检测越厚越好。做完详细报告。

# 任务：掐FX写风暴源头 + 全面检测上线成果

仓库当前目录(main=a5ebde1)。先git pull同步本地main。分支 feature/fx-storm-and-audit。PR-only、不直推、不force-push、生产写入前备份。

## 先读
- docs/client-info-source/00s_chandler_log_round20.md（Claude定位的真凶机制链）
- docs/client-info-source/00r_chandler_log_round19.md（FX bug背景+部署锚点）
- src/lib/exchange-rates.js、src/lib/exchange-rate-scheduler.js、src/lib/db.js（patchAppStateField）

═══════════════════════════════════════════════
## A — 查掐FX写风暴源头（核心）
═══════════════════════════════════════════════
**背景**：生产DB每~3秒被写一次(改exchangeRates)，一天~2.8万次=失控。CC上轮已无害化(saveExchangeRates改jsonb_set定向写，不再覆盖模块数据)，但**源头那个"每3秒触发刷新"没掐**。每天2.8万次写浪费DB配额。

**Claude本地定位的真凶机制链(高置信，CC确认)**：
- scheduler正常(每天墨西哥午夜0:00一次force刷)，不是凶手。
- 真凶在请求路径：server.js有`loadShippingData({refreshRates})`包装，refreshRates=true时刷汇率→若changed→saveExchangeRates写库。
- exchange-rates.js的`refreshExchangeRatesIfStale`catch分支(外部API失败时)返回`changed:true`→refreshExchangeRatesNow里`if(changed) saveExchangeRates`→写库。
- 推断：某高频请求带refreshRates:true → 外部汇率API(Frankfurter/ExchangeRate-API)失败或needsExchangeRateRefresh每次返回true → changed:true → 每个请求写一次DB。

**A1 本地确认真凶（先查清再改）**：
- grep `refreshRates` 和 `loadShippingData` 所有调用点：哪些路由/中间件带refreshRates:true？是不是某个高频路径(每页加载/某中间件/健康检查)？列出来。
- 查`needsExchangeRateRefresh`：为什么会每次返回true？重点：
  - lastCheckedAt是否正确持久化到Supabase？(jsonb_set写的是exchangeRates整个对象还是只部分？catch分支设的lastCheckedAt有没有真存进去？)
  - catch分支(API失败)设了lastCheckedAt:now()但返回changed:true→下次needsRefresh看lastCheckedAt日期==今天应该返回false才对……查为什么没生效(是不是写库的exchangeRates被后续读覆盖/或needsRefresh判断有bug/或每次请求reload的shippingData是刷新前的旧值)。
  - 外部汇率API是不是一直失败(Frankfurter/ExchangeRate-API在生产网络不可达)→导致每次走catch→每次changed:true。
- 用日志/复算确认那~3秒节奏：是外部某服务每3秒打某endpoint，还是内部每个请求都触发。查有没有endpoint(如/exchange-rates/refresh或某admin页轮询)被外部高频打。

**A2 修复（按A1查到的真凶）**：
目标：FX写从2.8万/天降到正常(一天几次)。按真凶选措施(可多选)：
- **掐每请求刷新**：FX刷新不应在每个请求触发。若loadShippingData默认refreshRates:true→改成默认false，只scheduler(每天)+显式手动刷新endpoint触发。或加节流：内存throttle/DB lock，最多每N分钟(如60分钟)真刷一次，其余请求直接用缓存的exchangeRates不写库。
- **修needsExchangeRateRefresh/catch逻辑**：API失败时不应导致每请求重写。失败分支要么changed:false(不写库，保留旧汇率+记lastError一次)，要么正确推进lastCheckedAt使当天不再重试(避免每请求重刷)。确保成功刷新后当天needsRefresh返回false。
- **若外部API生产不可达**：确认Frankfurter/ExchangeRate-API在Railway生产能否访问(网络/出口限制)。若不可达，FX一直失败→要么换可达的源，要么失败时优雅降级(用上次成功汇率，不每请求重试写库)。
- **若是外部轮询/挂着的admin页**：找到那个每3秒打的来源。若是admin页前端轮询→降低轮询频率或去掉。若是外部监控→该endpoint加节流不每次写库。

**A3 验证**：
- 改后本地模拟高频请求(连续打几十次那个路径)→确认不再每次写库(加日志/计数)。
- 确认FX刷新仍正常工作(scheduler每天刷、手动刷有效、汇率正确用于报价双价)。
- 部署后观察生产DB写频率是否下降(revision增速)。

═══════════════════════════════════════════════
## B — 全面检测上线的所有东西（Chandler要"检测上线有没有问题"）
═══════════════════════════════════════════════
B/C/E数据上轮patch进生产，FX修复也上了。全面验证生产现状没问题。

**B1 生产数据still正确（patch后+FX修复后，确认没被冲/没回退）**：
- 抽查生产Supabase + live HTTP：
  - B费率：KMTC新名(Doc Fee at Destination/Container Release Fee)+ISD 15 still在
  - C场站：26个CONTENTO场站+真价(Servimaniobras 3800...TEP 5850) still在，customs yards=28(26+José自建2)
  - E元数据：HAPAG code=HAPLLOMEX、ONE=ONE_MEX、14家rfc still在
  - 7空壳船司(SINOKOR等) still在
  - **José手改still零损失**：CMA50/ZIM改名/COSCO/José自建2场站 still在(FX无害化后这些没再被冲)
- 多次复读(间隔30s+)确认稳定，FX写不再覆盖这些。

**B2 报价模式四组合（上线后回归）**：
- 模式一(仅墨西哥段)/模式二(海运+墨西哥段) × USD/MXN × EN/ZH/ES：生成PDF，段显示/隐藏对、双价(USD含16%/MXN不含)对、三语对、非墨段12项+墨段11项预设对。

**B3 新增船司功能（上线后深测）**：
- 后台建一家新船司(name/code/rfc)→编辑加费率/押金/滞期→报价/清关页可选→删除级联干净。
- customs镜像同步、7空壳可被填实。

**B4 CRUD矩阵回归（上次QA的延续）**：
- 关键实体增改删跳转：换单费率、yard(26 CONTENTO后)、新增船司、港口/码头/堆场。确认无"不能编辑/没删除键/加完404"回归。

**B5 XSS回归**：
- 全仓grep `<%- JSON.stringify` 确认仍全safeJson、无裸JSON.stringify入script。新视图(admin-module创建表单等)无新注入点。

**B6 双价math + 核心计算**：
- quote-test 9/9、计算器成本(含CONTENTO yard dropoffCharges成本侧)、双价MXN/USD合计。确认FX修复没影响汇率换算。

═══════════════════════════════════════════════
## 验收
═══════════════════════════════════════════════
- A: 真凶定位清楚(哪个请求/为什么每次刷)+修复(FX写降到正常)+验证(本地高频不再每次写、FX仍正常)。
- B1-B6全部检测出结果，发现问题列表(严重度+file:line+建议)。
- 完整回归：smoke+quote9/9+o3+batch3+d-add全绿。
- 若A的修改涉及生产数据/配置：先备份，按部署锚点(jsonb_set定向写/不db:seed)。

## 全局约束
- FX修复优先不破坏现有汇率功能(报价双价依赖汇率)。
- 改生产数据/配置前备份，走patch模式不db:seed。
- 数据模型改动走normalizer+back-compat。
- 防compact：进度写_ROADMAP+00s；compact从那恢复。
- Task Summary+Post-task routing+lesson写LESSONS.md(FX写风暴源头根因+修复)。

## 报告
- A: 真凶根因(哪个请求带refreshRates:true、为什么needsRefresh每次true、外部API是否可达、3秒来源)+修复+DB写频率前后对比
- B1-B6检测结果(生产数据still正确逐项+José手改still在+四组合+新增船司+CRUD+XSS+math)
- 发现的问题汇总(严重度+file:line+建议)
- 部署：A修复做完合并部署，盯生产DB写频率下降
- 爆炸半径

## 开始
git pull→切feature/fx-storm-and-audit→A1定位真凶(grep refreshRates/loadShippingData/needsRefresh)→A2修复→A3验证→B1-B6全面检测→报告→合并部署。连续做完。
