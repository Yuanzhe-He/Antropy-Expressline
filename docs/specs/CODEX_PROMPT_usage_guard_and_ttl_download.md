RMW读缓存killshot(PR#16)已核实严密。本任务在其上：①把读缓存TTL拉长+env化(查汇率本就一天一次，缓存TTL可拉到1小时降egress地板)②加应用层用量护栏+日志告警+自动降级(出错当场刹车+留证据，不等月底账单)③补全局database专题读侧。token不计成本，测试厚。做完详细报告。

# 任务：读缓存TTL调优 + 应用层用量护栏告警 + 读侧沉淀

仓库当前目录。**先确认PR#16(feature/rmw-loop-killshot)状态**：若未合并，先合并到main(killshot是egress止血，已核实严密)再在main上做本任务；若已合并，直接main上做。本任务分支 feature/usage-guard-and-ttl。PR-only、不直推、不force-push、生产写入前备份。

## 先读
- docs/client-info-source/00y_chandler_log_round25.md(本轮：TTL含义/护栏告警/读侧)
- docs/client-info-source/00x_chandler_log_round24.md(killshot核实)
- src/lib/store.js(读缓存shippingDataCache/getShippingCacheTtlMs/saveShippingData/saveExchangeRates)+ src/lib/db.js
- `Cursor Project Master/database/frameworks/expensive-op-throttle.md`(护栏模式3)+ `quota-cliff-checklist.md`(含新补的读侧一节)

═══════════════════════════════════════════════
## A — 读缓存TTL拉长 + env化(降egress地板)
═══════════════════════════════════════════════
**背景澄清(重要，别混)**：有两个不同频率。
- 真去外部查汇率：一天一次够(scheduler管)，不需要高频。
- 读缓存TTL：1.6MB blob在内存缓存多久才重读DB。外部poller每2s打一次每次要读blob，TTL越长真读越少egress越低(15min=96次/天，1h=24次/天，3h=8次/天)。
**单实例下TTL拉长安全**：自己改数据写后更新缓存立刻可见；唯一代价=patch脚本直接改生产DB后线上缓存陈旧最多一个TTL(或重部署立刻生效)。

**做**：
- 读缓存默认TTL从15min拉到**1小时**(env SHIPPING_CACHE_TTL_MS已存在，改默认值)。保持env可调(call-time读，0=禁用)。
- 在代码注释+00y+部署文档里写清楚：**TTL拉长后，用patch-prod-data改生产数据后要么手动重部署、要么等一个TTL才在线上生效**(否则线上抱旧缓存)。这是部署纪律。
- 说明：1小时下egress地板=24次/天×1.6MB≈38MB/天≈1.1GB/月，远低于5GB免费版。TTL是纯egress调节阀，单实例零陈旧代价。

═══════════════════════════════════════════════
## B — 应用层用量护栏 + 日志告警 + 自动降级(核心，出错当场发现)
═══════════════════════════════════════════════
**目标**：出错当场刹车+留清晰证据，从"等月底账单"→"Railway日志立刻可见+自动降级"。防未来任何失控读写(不只这次FX/外部poller)。

**实现(参考expensive-op-throttle.md模式3，纯内存不依赖外部)**：
- 在db层getAppState/saveAppState(或store层读写入口)加内存计数器：分别数"今天读了多少次app_state DB"(注意：是真正穿透到DB的读，缓存命中不算)和"今天写了多少次app_state"。
- 阈值(env可调)：
  - 读DB穿透：正常一天≤几十次(TTL1h下≈24次+少量)。阈值如**200/天**(env APP_STATE_READ_WARN_THRESHOLD)。
  - 写：正常一天≤几十次。阈值如**500/天**(env APP_STATE_WRITE_WARN_THRESHOLD)。
- 超阈值行为(降级，不停服务)：
  - **立刻记醒目error日志**(包含：当前计数、阈值、key、时间窗口)。Railway日志能直接看到。日志要醒目(如`[USAGE-GUARD-ALERT] app_state DB reads today=N exceeded threshold=M`)。
  - **去重/限频**：超阈值后别每次都刷日志(否则日志风暴)，如每超过一次阈值或每N分钟记一次。
  - **自动降级**(可选但推荐，区分读写)：
    - 读穿透超严重阈值(如阈值的5倍)：说明缓存失效或被狂读，可临时强制延长缓存TTL/拒绝非必要读，保护egress。
    - 写超阈值：对FX这类自动写可降级(停写用缓存)；用户主动关键写(后台改费率/建船司)放行不阻断，但计数+日志。
  - 设一个内存flag记录"今日是否触发过告警"，便于health check/admin查看。
- 计数器按日期跨天重置。纯内存(进程重启清零可接受，配合TTL+节流足够)。
- **护栏本身不引入新DB写**(纯内存计数，别为计数而写库)。

**边界**：
- 区分"缓存命中"vs"DB穿透读"——只数穿透读(命中读是免费的，不该触发告警)。
- 区分"自动写"(FX等可降级)vs"用户关键写"(放行)。
- 多实例：内存计数进程级，各实例独立。安全网非精确计量，不为跨实例精确而引入DB写。

**注**：本次不接邮件(项目无邮件设施，接SendGrid/Resend/SMTP较重)。日志告警+自动降级已实现"出事当场刹车+留证据"。若Chandler后续要邮件/webhook推送，再单独接(需指定服务+收件地址)。这次先把轻量版做扎实。

═══════════════════════════════════════════════
## C — 全局database专题补"读侧"(Claude会自己补Cursor Project Master，这里CC只补项目LESSONS)
═══════════════════════════════════════════════
- 在docs/LESSONS.md补/确认"读侧"教训：写风暴修复别漏无缓存的整块读；READ egress可压过写(本案218k读≈350GB > 写)；唯一读入口要加缓存；表面指标陷阱(只看写次数会漏读)。
- (Cursor Project Master/database/的读侧框架由Claude在web端补，CC不用动那边)

## 验收(测试厚)
- A：TTL默认1h+env可调+部署纪律注释。
- B：护栏(读穿透计数/写计数/超阈值醒目日志/日志去重/自动降级区分读写/区分自动vs用户写/纯内存不引入写/缓存命中不计数)。
- C：LESSONS读侧。
- 护栏测试：模拟超读阈值→醒目日志+降级+日志不风暴；模拟超写阈值→FX降级、用户关键写放行；正常量级(几十次)→护栏完全不干预无误报；缓存命中不触发；跨天重置；护栏不引入额外DB写。
- 回归：smoke+quote9/9+o3+batch3+d-add+所有审计全绿。读缓存(命中/写后失效/TTL)、报价/计算/双价/新增船司不受影响。
- 生产验证：部署后测egress/写频，确认TTL1h下读穿透≈24次/天、护栏正常量级不告警。生产数据完好(B/C/E+José手改yards=28)。

## 全局约束
- 护栏纯内存，不为计数引入DB写。
- 只数DB穿透读(缓存命中不算)，区分自动写vs用户关键写。
- TTL拉长后patch生产数据要重部署或等TTL(部署纪律，写进注释+文档)。
- 改生产数据/配置前备份，走patch不db:seed。
- 防compact：进度写_ROADMAP+00y；compact从那恢复。
- Task Summary+Post-task routing+lesson写LESSONS.md(TTL调优+用量护栏告警+读侧)。
- 参考Cursor Project Master/database/frameworks/的护栏/节流模式。

## 报告
- A：TTL默认值+env+地板估算(1h=多少GB/月)+部署纪律。
- B：护栏实现(读穿透vs命中计数/读写阈值/醒目日志格式/去重/自动降级区分读写+自动vs用户/flag)+测试结果。
- C：LESSONS读侧。
- 回归全绿+生产egress/写频实测。
- 爆炸半径。

## 开始
确认/合并PR#16→切feature/usage-guard-and-ttl→A TTL拉长env化→B用量护栏+日志告警+自动降级→C LESSONS读侧→深度测试→生产验证→报告。连续做完，测试厚。
