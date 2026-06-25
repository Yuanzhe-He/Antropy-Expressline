egress危机已基本解决：PR#16(读缓存killshot)已部署，生产实测读38.6→1.0/min、egress~70→~1.8GB/天(降97%)、写0/min。本任务收尾：①合并PR#17(TTL1h+用量护栏+/healthz)部署+验证②从源头定位并掐掉外部poller(F1，那个每2s打/exchange-rates/refresh的已登录源——DB虽不烧了但HTTP请求还在，且来源未知)。token不计成本，测试厚。做完详细报告。

# 任务：合并PR#17部署验证 + 从源头掐外部poller(F1)

仓库当前目录。本任务分支 feature/stop-external-poller(F1部分)。PR-only、不直推、不force-push、生产写入前备份。

## 先读
- docs/client-info-source/00z2_chandler_log_round26.md(护栏核实+egress落地)
- docs/client-info-source/00z_chandler_log_round25.md(CC上轮TTL+护栏)
- src/server.js(/exchange-rates/refresh路由 server.js:2910附近 + requireAuth + 启动/healthz)
- src/lib/exchange-rates.js(节流checkedWithinThrottle)

═══════════════════════════════════════════════
## 第一步 — 合并PR#17 + 部署 + 验证
═══════════════════════════════════════════════
- 确认PR#17(feature/usage-guard-and-ttl)状态：MERGEABLE就合并到main，Railway自动部署。
- 部署后验证：
  - curl 生产 /healthz → 确认返回JSON含shippingCacheTtlMs:3600000、usageGuard状态(reads/writes/thresholds)。
  - 跑 scripts/rmw-egress-probe.js → 确认TTL1h下读穿透降到~24/天量级(每窗口miss一次)、写仍0/min。
  - 确认启动日志打了TTL+护栏配置(read cache TTL: 3600s | usage-guard: ...)。
  - 抽查生产数据完好(B/C/E+José手改yards=28)。
- 若PR#17已合并，跳过本步直接做第二步。

═══════════════════════════════════════════════
## 第二步 — 从源头定位外部poller(F1，核心)
═══════════════════════════════════════════════
**背景**：pg_stat_statements显示某已登录外部源每~2s POST /admin/:moduleKey/exchange-rates/refresh(force路径)。已节流(DB写≈0)+读缓存(egress≈0)无害化，但**HTTP请求仍在打**，且来源未知。这是最后一个真正的尾巴。要查清是谁在打、然后掐掉或挡住。

**2A 定位是谁在打（先查清）**：
- 查Railway access log(若CC能访问Railway CLI/日志)：看 /exchange-rates/refresh 的请求来源——User-Agent、IP、Referer、cookie/session特征。判断是：①José挂着的某个后台页(浏览器标签没关，前端在轮询)②某个忘了关的监控/脚本③其它。
- 若CC无法直接看Railway log：在 /exchange-rates/refresh 路由里加**临时诊断日志**(记录每次请求的User-Agent/IP/Referer/时间，但不记任何secret/cookie值)，部署后看几分钟日志，定位来源特征。诊断完可移除或保留(轻量)。
- **重点判断**：这个refresh是不是某个前端页面在轮询？grep前端(public/ + views/)有没有定时POST /exchange-rates/refresh的代码(setInterval/setTimeout + fetch到refresh)。之前查过app.js无轮询，但要把views里的内联script、admin页也grep一遍(那个force refresh一定有触发源，要么前端要么外部)。

**2B 掐掉/挡住（按2A定位结果选）**：
- **若是前端页面轮询**(最可能)：找到那个定时POST refresh的前端代码，改掉——汇率不需要前端每2s刷，去掉轮询，或改成页面加载时刷一次、或大幅拉长间隔(如10分钟)、或visibilitychange页面不可见时停。这是真正的源头修复。
- **若是外部脚本/监控**(仓库外，改不了源)：在 /exchange-rates/refresh 路由加防护——①该路由本就该节流(已有checkedWithinThrottle)，确认force路径也被节流挡住(已确认)②可选加更强的访问控制：这个force refresh endpoint是否需要对外开放？若只该内部/admin用，加鉴权或限流(rate limit)挡住高频外部打。但注意别影响正常的手动刷新和scheduler。
- **若查不清来源**：至少确认现有节流+缓存已让它完全无害(DB写0+egress≈0)，加一个监控(用量护栏已有)，并在文档记录"F1外部源仍在打但已无害"，留待José侧排查(可能要问José是不是开着某个后台页)。

**2C 验证**：
- 修复后(若是前端轮询掐掉了)：确认 /exchange-rates/refresh 的请求频率从每2s降下来。
- 确认汇率功能仍正常(scheduler每天刷、手动刷有效、报价双价正确)。
- 确认没误伤正常功能。

═══════════════════════════════════════════════
## 验收
═══════════════════════════════════════════════
- 第一步：PR#17合并部署+/healthz验证+egress探针(TTL1h读穿透~24/天)+生产数据完好。
- 第二步：F1来源定位清楚(是前端轮询还是外部源)+掐掉或挡住(前端改掉轮询/或路由加防护/或确认无害留档)+汇率功能仍正常。
- 回归：smoke+quote9/9+o3+batch3+d-add+所有审计(含usage-guard8/rmw-cache9)全绿。
- 若第二步改了前端/路由：确认报价/计算/双价/手动刷汇率/scheduler不受影响。

## 全局约束
- 诊断日志不记secret/cookie值(只记UA/IP/Referer/时间)。
- 改路由鉴权/限流别误伤手动刷新和scheduler。
- 改生产数据/配置前备份，走patch不db:seed。
- 长TTL下out-of-band写后要redeploy或等TTL(部署纪律)。
- 防compact：进度写_ROADMAP+00z2；compact从那恢复。
- Task Summary+Post-task routing+lesson写LESSONS.md(F1源头定位+掐法)。

## 报告
- 第一步：PR#17部署+/healthz返回+egress探针实测(TTL1h读穿透)+数据完好。
- 第二步：F1来源(UA/IP/Referer特征+是前端轮询还是外部)+掐法(前端改了什么/或路由加了什么/或为何留档)+汇率功能验证。
- 回归全绿。
- 爆炸半径。
- 剩余留尾(service_role/exchangeRates拆key/邮件告警，都later)。

## 开始
合并PR#17→部署验证(/healthz+egress探针)→第二步定位F1(Railway log或加诊断日志或grep前端)→掐掉/挡住→验证汇率正常→回归→报告。连续做完，测试厚。
