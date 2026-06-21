# 00y — 第N+25轮（TTL含义澄清 + 用量护栏+告警 + 读侧补全 prompt）

> 00x 续篇。最新轮次。

## 2026-06-20 第N+25轮 — Chandler问TTL含义/能否拉长/出错为何不发邮件

**Chandler的三个问题 + Claude澄清**：
1. **TTL 15min是什么意思/能拉长吗？** 澄清两个不同频率：
   - 频率1=真去外部查汇率：一天一次够(scheduler管)，Chandler说"3小时一次都行"对。
   - 频率2=读缓存TTL(15min)：跟查汇率无关，是"1.6MB blob在内存缓存多久才重读DB"。外部poller每2s打一次每次要读blob，缓存15min→15min内只真读1次。TTL=缓存多久，"egress地板"=TTL越长真读越少egress越低(15min=96次/天，3h=8次/天)。
   - **TTL拉长的代价**：①自己改数据无论TTL多长立刻看到(写后更新缓存)②José多实例改/你看：单实例不存在此问题③patch脚本直接改生产DB后线上缓存陈旧最多一个TTL(或手动重部署立刻生效)。
   - **结论：单实例下TTL拉到1-3小时安全、egress更低，代价仅patch后等一个TTL(或重部署)。建议拉到1小时，做成env随时可调。**
2. **出错为何不立刻发现/发邮件？Supabase没这功能吗？** Chandler对——应该立刻发现不该闷着。现在设计纯被动(压低egress但无主动告警)，未来失控只能等月底账单。Supabase免费版基本无用量告警，付费版有但不实时不细。不能指望Supabase。正确做法=自己加轻量告警(就是前几轮提过的应用层用量护栏+告警)。
3. **查汇率不用最低限度** —— 对，查汇率一天一次/3小时一次都行，与TTL是两回事。

**Claude核实项目无邮件能力**：src/lib无mailer/notify，env.js只基础.env加载。发邮件要从零接邮件服务(SendGrid/Resend/SMTP)+配密钥+发送代码=较重。且Chandler本来就要从源头掐外部poller(F1)，掐掉这风暴就没了，邮件更多防未来未知失控。

**Claude建议告警分两步**：
- 第一步(这次，轻量不依赖外部)：应用层用量护栏+启动可见+日志告警+自动降级。Railway日志能看，异常留证据，严重自动降级。从"等月底账单"→"出事当场刹车+日志可查"。
- 第二步(以后想要再做)：邮件/webhook告警，需Chandler提供用什么发+发到哪。

**给Chandler的选择**：
- A. 这次先做轻量版(用量护栏+日志告警+自动降级，不接邮件)+TTL拉长+补全局读侧。立刻能做。
- B. 这次就要邮件告警，需Chandler给邮件服务+邮箱。
- Claude先按A写prompt(A无论如何该做，B在A基础上加邮件)。

**本轮prompt三件事**：
1. TTL拉长+env化(默认1小时SHIPPING_CACHE_TTL_MS，可调；说明patch后重部署或等TTL)。
2. 应用层用量护栏+日志告警+自动降级(数读/写次数，超正常N倍→醒目error日志+降级失控行为；纯内存不引入新写)。
3. 全局读侧补全(Cursor Project Master/database/frameworks补"读侧"一节：READ egress可压过写，写风暴修复别漏无缓存整块读；core guardrail上轮偏写)。
4. 前提：先合并PR#16(killshot)再在其上做，或CC判断一起做。测试厚。

**待Chandler定**：A还是B(邮件)。Claude按A出prompt。

**项目状态**：main=b9b443c，PR#16(killshot)待合并。本轮在其上加TTL调整+护栏+告警。

**本轮防compact写入**：00y_chandler_log_round25.md（本文件）
