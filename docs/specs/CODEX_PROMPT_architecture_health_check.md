对 Express Line 做一次架构体检（READ-ONLY，只读不改），产出证据驱动的体检报告，告诉 Chandler 这个项目架构到底健不健康、哪里该优化、blob→表重构的具体形状。这是「架构优化」工作的第一步：先体检，再决定动不动。token 不计成本，证据要扎实（每个结论带 file:line）。

# 任务：Express Line 架构体检（READ-ONLY 调研 + 出报告）

仓库当前目录（Jose Expressline Consulting）。**本任务只读不改**——不编辑代码、不装依赖、不跑测试（除了 wc -l / grep 这类只读命令）。产出一份体检报告写到 docs/specs/YYYYMMDD_architecture_health_check_REPORT.md。

## 背景
- Express Line 是小型 JS 货代报价系统（Node/Express + EJS，Supabase Postgres）。不是大型 TS，别期待找到 ESLint boundaries / dependency-cruiser。
- 已知信号：server.js ~4672 行（疑似 god-file）；所有业务数据塞在 app_state 一行的一个 JSONB 字段 = ~1.6MB blob（疑似单 blob 反模式，既是 egress 问题也是耦合问题）。
- 这次体检是「架构优化」的第一步。egress 危机（配额）已基本闭环，现在看「代码组织本身」健不健康。
- 参考方法：Cursor Project Master/architecture/frameworks/architecture-health-check.md（如果 CC 读得到该路径；读不到就按下面的 A-G 走）。

## 体检项（每个结论必须带 file:line 证据，不许凭文件名猜）

### A. 栈与规模
- 语言、框架、DB 访问层确认。
- 规模：源码文件数、总 LOC（wc -l 或等价，只读）。
- 已有 docs/ARCHITECTURE.md 吗？它声称的结构 vs 实际是否一致？

### B. 大文件清单（god-file 检查）
- 列出最大的 10 个源文件（路径 + 行数）。
- 对每个 > ~800 行的文件：它混了哪些职责？（如 server.js 是不是既接路由又实现业务逻辑又管持久化）。粘 2-3 处不同职责挤在同一文件的证据片段（file:line）。
- 特别标出"组合根里塞业务逻辑"的文件（server.js 既 wire 路由 AND 实现它们？）。
- 行数参考：普通模块 200-800 行，复杂模块 800-1200，远超的是 god-file 候选。

### C. 耦合与边界（谁依赖谁）
- 项目实际分成哪些模块（src/lib/* 各文件的职责）。
- 对最核心的 3-5 个文件（server.js、store.js、db.js 等），列出它 import 什么、谁 import 它（迷你 caller-ledger）。找：被几十个地方 import 的 hub，或 reach 进很多文件的 spider。
- 边界是 convention-only 吗（没有 lint 强制）？跨模块调用是走清晰的 API 还是直接进内部？
- 小项目重点：到底有没有清晰的模块边界，还是大部分逻辑堆在几个大文件里？如实描述实际结构（file:line）。

### D. 数据层 cohesion（单 blob 检查）★重点
- 持久数据怎么存？已知是 app_state 一行一个 JSONB blob。确认这个 blob 里到底塞了哪些不相干的实体（船公司/港口/堆场/费率/汇率/模块配置…），各在 blob 的什么路径（file:line + blob 结构）。
- 读一个小字段要不要加载整个 blob？写一个字段要不要 read-modify-write 整个 blob？（已知是，确认并给证据）。
- 有没有同一实体的并行镜像副本要保持同步？（已知 modules.customs.shippingLines vs modules.handover.shippingLines，确认还有没有别的）。
- ★交叉引用：这个 blob 既是架构问题（耦合）也是 database 问题（egress）。两个都点出来。

### E. 改动爆炸半径探针
- 挑 2 个现实的小改动（如"给船公司加一个字段"、"改一个汇率"），追踪每个要改多少个分散的地方。健康架构=少且局部;耦合架构=多且分散。
- 找过去痛点的证据：代码里 "keep in sync"/"also update" 注释、normalizer-parity bug、"works live, lost on round-trip"（docs/LESSONS.md 里有不少这类，引用）。

### F. 结论
- "架构当前 {健康 / 有局部问题 / 需要结构性重构}，主要证据：___"
- 列出找到的具体问题，按"多伤害改动安全性"排序。
- 每个问题：现在值得修，还是可接受的稳态？（说清取舍。不要估工时/成本。）

### G. 若需要结构性重构 — 只出形状不执行
若 F 发现真问题，勾勒（不执行）：
- god-file（server.js 4672 行）→ 拆成哪些模块（按职责：路由注册 / 各模块 handler / 业务计算 / 持久化…）。
- 单 blob → 拆成哪些规范化表（实体清单：shipping_lines / ship_line_charges / ports / yards / inland_* / exchange_rates / module_config…）。给每张表的字段 + 主键 + 外键草图。
- 缺边界 → 小项目至少给一个"文档化的模块边界"建议。
- 迁移约束：哪些数据/行为必须零丢失（尤其 José 手改的生产数据：yards=28 含 José 自建 2、carriers=21 含 7 新空壳、CMA doc fee 50、KMTC ISD 15、ZIM 改名、COSCO 编辑）。
- 建议分阶段：拆成几个独立可验证的阶段，每阶段执行前有 human checkpoint。

## 硬规则
- READ ONLY——不编辑、不装依赖、不跑测试。
- 每个结论带 file:line 证据——不靠文件名或 package.json 猜。
- 不估成本/工时/ROI。
- 不要反射性地说"维持现状"——健康就带证据说健康，有问题就点名。
- 区分"thin ownership"和"小文件"——文件可以小但所有权模糊，或大但内聚。
- 单 blob 检查记住它同时是架构问题（耦合）和 database 问题（成本），两个都点。
- blob→表重构是大手术：只出形状不执行，Chandler review 后单独立项分阶段做。

## 输出
- 写 docs/specs/YYYYMMDD_architecture_health_check_REPORT.md，H2 标题 A-G，每个结论带 file:line。~600-900 字干货。
- 报告末尾给 Chandler 明确结论：① 架构整体健不健康 ② 最该先动的 1-2 个结构性问题是什么 ③ blob→表 和 server.js 拆分，哪个更紧急、为什么 ④ 这次只体检没动代码，下一步要不要执行重构由 Chandler 定。

## 与数据库优化的关系（别重复劳动）
- egress/配额那条线（读缓存、TTL、用量护栏、poller）已经在做，不在本次体检范围。
- 本次只看"代码组织"。但 blob 既是架构也是数据库问题，体检会点出它——blob→表重构同时解决耦合和 egress，是两条线的交汇点。如果体检确认 blob→表值得做，它会取代之前 egress 那条线里"拆 exchangeRates 独立 key"那种打补丁式的小优化（真拆表比打补丁彻底）。

## 防 compact + 收尾
- 体检发现写 docs/LESSONS.md（如果发现新的架构教训）。
- Task Summary + Post-task routing。
- 报告路径告诉 Chandler。

## 开始
确认只读模式 → A 摸规模 → B 大文件清单（wc -l 排序 + 看 server.js 混了什么）→ C 耦合（读核心文件的 import/被 import）→ D 单 blob（blob 结构 + 读写放大 + 并行镜像）→ E 爆炸半径（2 个小改动追踪 + 引用 LESSONS 痛点）→ F 结论排序 → G 重构形状（只出不执行）→ 写报告。连续做完。
