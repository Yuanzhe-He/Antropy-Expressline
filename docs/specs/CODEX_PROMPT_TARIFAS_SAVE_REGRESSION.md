# CC PROMPT — 修复船司(naviera)费率页保存失败(疑似 relational cutover 回归)

> **症状(何塞 feedback “ERRORES PAGINA TARIFAS v2”)**:船司费率编辑页**各区块都存不进去**——主档(船司名/代码/RFC/截关人/担保豁免)、终端概率(terminalMix)、本地费用(cargos locales)、滞期多规则集(demoras)、概念(conceptos)。至少 MSC / WAN HAI / OOCL 三家中招。截图里出现 “新码头” 默认名 + 概率 0 = 新加/改的值没存下。
>
> **Claude 已做的静态分析(直接读了代码,给你省时间,但也别全信、以日志为准)**:
> - 保存路径:所有船司保存路由(含大的整页保存 `POST /admin/:moduleKey/shipping-lines/:id`)→ `saveModule("handover", wholeDoc)`。relational 模式下 → `saveModuleTables("handover", normalized)` → `decompose` → **重写整个 handover 模块的 3 张表:container_types + carriers + carrier_local_charges**(一次事务)。
> - decompose/assemble 映射是**忠实的**:carriers 表有 7 个 jsonb 列(notes_extra/customs_note/container_groups/demurrage/guarantee/terminal_mix/quote_defaults/extra),terminalMix/demurrage/guarantee 都进 jsonb、读得回来。**所以不是“字段被丢”。**
> - 写原语 `upsertRows` 的 jsonb 处理正确(`JSON.stringify`+`::jsonb`),和迁移正向写同一套、parity 过过。**所以不是写原语 bug。**
> - **最可能的机理 = 整模块写撞约束后整事务回滚 → 啥都没存**:relational schema 加了 NOT NULL / CHECK,而 decompose 用 `?? null` 填充:
>   - `carriers.name` **NOT NULL**;`carrier_local_charges.concept` **NOT NULL**;`container_types.label` / `container_types.rate_group` **NOT NULL**;`carrier_local_charges.tax_rate` `numeric(8,4)`(精度/范围)。
>   - 因为 `saveModuleTables("handover")` 每次都重写**全部** container_types + 全部 carriers + 全部 local charges,所以**这些表里任何一处空值/脏值都会让每一次船司保存炸**——正好解释“系统性、各区块都存不了”。
>   - 但“改个已有费率也存不了”未必全是 NOT NULL;**可能还有别的约束,或其实是 cutover 前就存在的老 bug。以日志为准。**
> - **关键覆盖缺口**:测试套件跑在 JSON 模式(走 `saveShippingData` 整档写),**从没走过 relational 的 `saveModuleTables`+decompose 这条整档船司保存路径**;POSTCUTOVER 只验过单字段写。所以这类 relational 专属 bug 测试根本测不到。
>
> **铁律**:复现/诊断**不准写 live `shipping-data` blob、不准写 live `expressline` 业务表**;要写就写**临时 scratch schema 或沙盒**。不碰 joyas/punas。STORAGE_MODE 保持 relational(除非 Chandler 另行决定回滚 blob)。做完交 Claude 审。

## Step 1 — 看日志定位确切异常(只读,最快,先做)
何塞已经触发过这些失败,**异常很可能已经在 Railway 日志里**。
- 拉 Railway 生产日志,grep 船司保存路由的报错:`POST /admin/handover/shipping-lines/:id` 及子路由(`/terminal-mix/add`、`/local-charges/add`、`/demurrage-rule-sets/...`)。
- 找:**确切的 PG 异常**(例如 `null value in column "concept"/"name"/"label" violates not-null constraint`、某个 check 约束、numeric overflow 等)+ 堆栈 + 时间戳。
- 判定**回归 vs 老 bug**:这些报错是从 **cutover 部署时间点(deploy 596c5882/34519276 一带)** 开始的,还是更早就有?日志时间线能直接区分。
- 【产出】确切失败的表/列/约束 + 是不是 relational 专属 + 起始时间。

## Step 2 — scratch 复现确认(只读 live;只写 scratch)
- 写一个聚焦复现脚本:从**生产 `expressline` 表只读**取一个真实 handover 船司(如 MSC)的完整数据 → 在一个**临时 scratch schema**(`ensureRelationalSchema` 建)里跑等价于 `saveModuleTables("handover")` 的整模块写 → 复现那个 throw。
- 模拟何塞的几种编辑(改概念、改费率、加一个 local charge、改 terminalMix 名+概率、改 demurrage),确认**哪类编辑触发、撞哪个约束**。
- 【产出】可稳定复现的最小用例 + 确认根因。

## Step 3 — 根治(对着确认的根因选,别打补丁;保数据保真)
确认根因后,从下列方案里选**最根本**的(可能要组合)。原则:**relational 写要能接住 blob 当年能接住的同样数据**(迁移的 parity 契约);不要静默改写何塞的真实数据。
- **方案 A(收窄写范围,推荐评估)**:船司编辑改用**单船司写**而非整模块写——只写这一个 carrier(carriers 行 + 它的 carrier_local_charges),不再重写 container_types + 全部 carriers。这样不相关的脏数据不会再炸每一次保存,也更省、更不会误删。
  - **注意**:现在用整模块写是因为要顺带同步 customs 镜像备注(`carriers.customs_note` 来自 `customs.shippingLines` 镜像)。所以走单船司写**必须同时保住 customs_note**(把镜像备注一起传给单船司写,别让它被覆成 null)。现成的 `saveCarrierEntity` 只 decompose 单船司、不带 customs 上下文 → 会把 customs_note 抹成 null,**需要修这个**。
- **方案 B(让写接住空值)**:对 NOT NULL 但 blob 当年允许空的列,在 decompose 处做**安全兜底**(如 concept/name 空 → 合理占位或保留原值),或把这些约束**放宽到与 blob 一致**。权衡:放宽保真但语义松;兜底可能改数据——**别静默改真实值**。
- **方案 C**:若根因是某个具体 check/numeric 约束,针对性修(校验/夹取/放宽),并说明为什么 blob 当年能过。
- 【产出】根因说明 + 选定方案的理由 + 改动。

## Step 4 — 补上缺失的 relational 测试(堵住这个洞)
- 加一个测试,**在 relational 模式**走完整船司编辑保存(主档 + 本地费用 + terminalMix + demurrage + guarantee 一起改)经过 `saveModuleTables`/单船司写,**包含触发本 bug 的那种边界**(空概念/脏 container_type 等)。
- 这是放过这次回归的覆盖缺口——必须补。加进 test:all。
- 【闸】新测试在修复前**能复现失败**、修复后通过;test:all 全绿。

## Step 5 — 验证 + 部署
- 验证 MSC/WAN HAI/OOCL 那几类编辑在 relational 下**能存且读回来一致**(decompose→assemble 往返):改概念、改费率、改 terminalMix 名+概率、改 demurrage、改主档字段。
- 部署 + 部署后健康 + STORAGE_MODE 仍 relational。在生产上实测一笔何塞的编辑能存。
- 【产出】逐项验证结果 + 部署确认。

## 完成(交 Claude 审)
- 报告:确切根因(表/列/约束 + 回归还是老 bug + 起始时间)、选定的根治方案及理由、补的 relational 测试、逐项验证、部署。
- 没写 live blob、没误改/误删 live 业务数据、joyas/punas 零接触。
- 结尾 Post-task routing。
