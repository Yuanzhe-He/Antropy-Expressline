# 研究 + 计划 — 「PAGINA TARIFAS 不保存」(ERRORES PAGINA TARIFAS v2)

> 状态：**根因已确认并在本地用真实 prod 数据复现**。计划为可执行。唯一需要 José 业务确认的是三家船司 demoras 的「正确天数分层」（见 §6 决策项）。
> 作者：Claude（Opus 4.8, 1M）· 2026-06-24。证据来自 `feature/refactor-godfiles` 工作树 + `.prod-blob-snapshot.json`（真实冻结 prod blob）。

---

## 0. TL;DR（大白话）

- 客户（Estefani）报：MSC / WHAN HAI / OOCL 的「船司编辑页」**保存不了任何改动**——改 terminales、cargos locales、corte、conceptos 全都不保存。
- **根因（已确认，不是数据库迁移导致的）**：这三家船司**存量的 demoras（demurrage）规则集**违反了保存时的「天数必须单调递增、开口规则必须放最后」校验。保存处理器在**写库之前**会校验该船司**所有** demoras 规则集；任一不合法就 `redirectWithFlash('error')` 直接返回，**永远走不到 `saveModule()`**。于是操作员在同一页改的**所有东西**（本地费用、码头、conceptos）跟着被丢弃 = 「什么都没保存」。
- **受影响集合 = 恰好 {msc, whan-hai, oocl}**，其余 18 家船司正常保存 —— 与客户反馈逐字吻合。
- **与 blob→relational 切换无关**：这是纯表单校验门，blob 模式下同样会拦；relational 写路径本身是好的（已逐项排除）。切换只是时间上的巧合。
- **死锁特性**：操作员自己也无法用 UI 修好 —— 要保存 MSC，必须**一次性**让 MSC 全部 6 个规则集都合法，而其中多个是坏的；改一个、保存、又被另一个拦。所以**必须先修数据**才能解套。
- **修复 = 数据修复（解套，需 José 确认天数）+ 代码加固（让这类存量坏数据再也无法把整页锁死，并给操作员可读的西语提示）**。

---

## 1. 背景与问题陈述

- 项目：物流成本工作台（换单/清关/陆运）。线上 `antropy-expressline-production.up.railway.app`，Railway 自动部署 `main`，Supabase Postgres（schema=`expressline`），已切到 `STORAGE_MODE=relational`。
- 2026-06-24 10:12，Estefani 发来 `ERRORES PAGINA TARIFAS version 2.docx`（7 张截图 + 文字）：
  - **MSC**：`No puedo guardar cambios en las terminales` / `No se guardan los cambios en los cargos locales` / `No se guardan datos del corte`。
  - **WHAN HAI**：`No se guarda ningún cambio`。
  - **OOCL**：`No me permite hacer cambios` / `No puedo cambiar los conceptos`。
- 截图覆盖船司编辑页全部分区：naviera 头部、PUERTO/PROBABILIDAD TERMINAL（terminalMix）、LOCAL CHARGES（cargos locales）、MULTIPLES SETS DE DEMORAS（demoras 规则集）。
- 时间线：Jun 23 切 relational（José 当时「spot-check 正确」= 看数据，不是编辑保存）→ Jun 24 10:12 此反馈。**这其实是切换后第一次真正在线上做「编辑并保存」**。切换时唯一的写证明 `scripts/relational/prod-write-roundtrip.js` 只验了 `store.saveCarrier()` 翻转一个**空壳船司**的 `customsNote`——既不是真实编辑路径（`saveModule`），也不含 charges/terminalMix/demurrage。

---

## 2. 根因（已确认，附证据）

### 2.1 因果链（mode-independent）

1. **渲染**：`views/admin-module.ejs:437` 把每条 demoras 规则的结束日渲染成 `value="<%= rule.endDay ?? '' %>"`。所以**非末位规则的 `endDay=null` 会渲染成空输入框**，倒序/重叠的天数原样回显。
2. **提交**：`POST /admin/:moduleKey/shipping-lines/:id`（`src/routes/admin-shipping-lines.js:614`）在 demoras 循环（`:737-769`）里对该船司**每个**规则集调 `applySequentialRuleUpdates`（`src/lib/rule-engine.js:218-266`）。
3. **校验拒绝**：
   - `src/lib/rule-engine.js:230` 空框 → `endDay=null`；
   - `:242-247` 非末位规则 `endDay=null` → 拒绝 `admin.openEndedRuleMustBeLast`；
   - `:232-240` `endDay < nextStart`（天数倒退/重叠）→ 拒绝 `admin.invalidRuleRange`。
4. **整单中止**：拒绝即 `redirectWithFlash(req,res,"error",updateResult.message,...)`（`src/routes/admin-shipping-lines.js:749-757`），**早于唯一的保存调用** `await saveModule("handover", shippingData)`（`:788`）。
5. 结果：`saveModule` 永不执行，**内存里已经改好的 `updated`（含 localCharges/terminalMix/corte/guarantee）全部丢弃** = 「nothing saves」。

### 2.2 实测的坏数据（来自 `.prod-blob-snapshot.json`，经 `normalizeShippingData`）

- **MSC**（`openEndedRuleMustBeLast`）—— 多个规则集带「中间位的开口规则」（陈旧残留）：
  - `imo-dry`：`[0]0-5 free, [1]6→null(开口,非末位!), [2]8-14, [3]15-17, [4]18>` ← `[1]` 触发拒绝。
  - `special-45` / `imo-special-45`：同样 `[1]6→null` 非末位。
  - `reefer` / `imo-reefer`：`[1]4→null` 且 `[2]6→null` 两个中间开口。
  - （`gp-hq-dc` 本身合法：`0-7,8-14,15-17,18>`。）
- **WHAN HAI**（`invalidRuleRange`）—— 「免费层 + 计费层从第 1 天重新计数」：
  - `gp-hc-sd`：`[0]0-7 free, [1]1-3, [2]≥4(start/end=null)` ← `[1]end=3 < nextStart=8` 拒绝。
  - `ot-fr-rf`：`[0]0-3 free, [1]1-3, [2]≥4` ← 同样倒退。
- **OOCL**（`invalidRuleRange`）：
  - `gp-hq-dc`：`[0]0-14 free, [1]1-5, [2]6-10` ← `[1]end=5 < nextStart=15` 拒绝。
  - （`ot-fr-rf`：`0-3,1-5(→ok),6-10,11>` 这条恰好合法。）

> 两种坏法：**(A) 中间位开口规则**（MSC，明显是历次编辑残留的重复 `>5`/`≥4`）；**(B) 免费层后计费层用「相对天数」从 1 重数**（WHAN HAI/OOCL，截图 image5 正是此形）。两者的**金额(importes)是对的，错的只是天数序列**。

### 2.3 已排除的其他假设（adversarial 验证）

| 假设 | 结论 | 依据 |
|---|---|---|
| relational `saveModule/syncTable` 写失败或丢字段 | **排除** | `decompose→syncTable→buildUpsertSql` 是合法 Postgres（行值 NOT IN 全非空 text 主键、FK 级联剪枝子行）；blob↔表往返对真实 prod 数据**无损**保留 concept/rate/terminalMix/demurrage。 |
| `carrier_local_charges.concept NOT NULL` / `numeric(8,4)` / CHECK 被一次正常编辑违反 | **排除** | 对真实 prod blob 全量 decompose = **0 违规**；编辑时空 concept 保留旧值（route `:670-674`），tax 远小于 9999.9999。 |
| `ensureRelationalReady` owner-only DDL 在写时抛错 | **排除** | 读路径同样调它；线上读正常 → DDL 成功；`CREATE...IF NOT EXISTS` 建好后即 no-op。 |
| `STORAGE_MODE` 未生效 / 缓存陈旧 | **排除为主因** | 即便是 blob 模式，§2.1 的校验门照样拦这 3 家；`saveModule` 每次写后 `invalidateShippingDataCache()`。 |
| 部署版本 ≠ 分析版本 | **排除** | `origin/main`(部署=4d971e6) 与 HEAD 在保存路径上**逐字节相同**；仅 `src/lib/db.js` 多 33 行纯诊断函数（启动告警），与保存无关。 |

---

## 3. 修复方案

> 目标：①立刻解套（操作员能正常保存）；②让「存量坏 demoras 数据锁死整页」这一类问题**结构性消失**；③不悄悄改动会影响报价的天数语义；④给操作员可执行的西语提示。

### 3.1 代码加固（durable root-fix）— 推荐主修

**改 `src/routes/admin-shipping-lines.js` 的大编辑处理器（`:614` POST）**，把「一处 demoras 不合法 → 丢弃整页」改成**隔离失败**：

- 先应用**所有非 demoras 编辑**（name/notes/invoice/guarantee/localCharges/terminalMix/corte）。
- demoras 循环里逐个规则集调 `applySequentialRuleUpdates`；**若某规则集校验失败：跳过对该规则集的更新（保持其库内原样，不丢数据、不悄改报价），收集一条「该规则集 X 因 <原因> 未更新」**，**继续处理其余规则集**，最后照常 `saveModule("handover", ...)`。
- flash 改为：保存成功 + 若有跳过项，附西语警告：`Se guardó todo excepto las reglas de demoras de «<set>» (revisa los días: <motivo>)`，并尽量带上锚点/高亮。
- 效果：操作员真正在改的 cargos/terminales/conceptos **立即落库**；坏的 demoras 规则集不再把整页锁死，且明确告诉操作员去修哪一个。

> 备选（未选为主修，列出权衡）：在 normalizer/`rule-engine` 层「读时自动规整」规则集为单调序列（删中间开口、resequence）。优点是 3 家自动愈合；**缺点是会悄悄改动驱动报价的天数分层** → 必须配 `quote-test` + 给 José 看 before/after。故只作为 §3.2 数据修复的实现手段，不作为隐式运行时行为。

### 3.2 数据修复（解套 + 规整为合法单调序列）— 需 José 确认天数（见 §6）

写 `scripts/relational/fix-demurrage-rulesets.js`（relational + postgres creds，**先备份、dry-run 默认、`--apply` 才写**）：

- 扫描**全部** 21 家船司的 `demurrage.ruleSets`，标出违反不变量的（预期命中 ≥ {msc,whan-hai,oocl}）。
- 对每个坏规则集，产出**规整提案**：
  - **坏法 A（中间开口）**：删除/合并陈旧的中间开口规则，保留真实分层与 importes，`resequenceRules` 重排 startDay。
  - **坏法 B（相对天数）**：把免费层之后的计费层换成**绝对天数**（免费 0-N，则计费层依次 N+1.. 顺延），保留每层 importes。
  - 例（提案，待 José 确认）：WHAN HAI `gp-hc-sd` → `0-7 free / 8-10 = $140 / ≥11 = $155`；OOCL `gp-hq-dc` → `0-14 free / 15-19 = (原1-5的importe) / ≥20 = (原6-10的importe)`；MSC `imo-dry` → 删去中间 `6→null`，留 `0-5 free / 8-14 / 15-17 / 18>`（6-7 缺口请 José 确认是否应为 `6-7` 计费层）。
- `--apply` 后用 store facade（relational）读回校验：每个规则集过 `applySequentialRuleUpdates`（dry 模拟）= 全 ok；importes 不变；行数/其它字段零漂移。

> **重要**：天数分层驱动报价 demoras 计算，**Claude 不臆测具体天数**。脚本只产出「机械规整提案」，José 拍板正确分层后再 `--apply`。

### 3.3 关闭测试网缺口（无论根因如何都该补）

- 新增 `scripts/audit-demurrage-save-resilience-test.js`：构造一家「带中间开口规则 + 免费层相对天数」的船司，断言（a）保存**不再**丢弃同页其它编辑；（b）非 demoras 改动成功落库；（c）坏规则集被跳过并给出警告。进 `test:all`。
- 新增 relational 模式的「编辑→保存→读回」往返测试（把 `scripts/relational/integration-test.js` 的等价覆盖纳入 `test:all`，或新增一支顶层 `*-test.js`）。这是发现根因时暴露的真实缺口：`npm run test:all` 只跑 JSON 模式，relational 写路径不在 CI 网内。

---

## 4. 受影响文件 / blast radius

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/routes/admin-shipping-lines.js`（`:614` 处理器 + 6 个 demoras 子路由的同构逻辑） | demoras 校验从「整单中止」改为「隔离跳过 + 警告」 | 中：改保存语义，靠新测试 + 审计套件兜底；不碰非 demoras 字段写入 |
| `src/lib/rule-engine.js` | 仅当采用 §3.2 规整：新增纯函数 `canonicalizeRuleSet()`（被修复脚本调用，不改运行时校验） | 低：纯函数 + 单测 |
| `scripts/relational/fix-demurrage-rulesets.js`（新） | prod 数据修复，备份+dry-run+`--apply`+读回校验 | 高（写 prod）：按现有 patch 纪律（备份、单事务、校验、可回滚） |
| `scripts/audit-demurrage-save-resilience-test.js`（新）+ relational 往返测试 | 测试网 | 低 |
| `docs/`（本计划 + LESSONS + 两个 CODEX_PROMPT） | 文档 | 无 |

不碰：计算/报价核心、relational 存储层（已验证无辜）、blob、备份、migrator creds、joyas/punas。

---

## 5. 验证 / 回滚

**验证（CC 执行）**
1. 线上只读确认（gate）：`SELECT id, demurrage->'ruleSets' FROM expressline.carriers WHERE id IN ('msc','whan-hai','oocl')` 仍是 §2.2 形态；并查 Railway 日志确认这 3 家 POST 返回的 flash 是 `admin.invalidRuleRange`/`admin.openEndedRuleMustBeLast` 而非 `admin.lineSaved`。
2. 代码加固后：`npm run test:all` 全绿（含新测试）；本地用 prod 快照跑「编辑 MSC 的一个 cargo + 一个 terminal 并保存」→ 断言 cargo/terminal 落库、坏 demoras 集被跳过并警告。
3. 数据修复：dry-run 输出 before/after 给 José → 确认 → `--apply` → 读回每个规则集过校验、importes 不变、行数零漂移。
4. 部署后：在线上 UI 实际编辑 MSC/WHAN HAI/OOCL 各一项并保存，确认 `lineSaved` + 改动可见；`/healthz` 正常、无 egress 异常。
5. 报价回归：`npm run quote-test`（9/9）+ 对这 3 家受影响柜型做一次 demoras 报价 before/after 对比（数据修复会改天数 → 必须 José 知情）。

**回滚**
- 代码：revert 该 PR（保存语义改动是单文件局部）。
- 数据：修复脚本写前备份 carriers 行（+ 冻结 blob 仍是 anchor）；`--revert` 从备份还原；relational→blob 整体回滚仍是既有 `scripts/relational/prod-reverse-to-blob.js --apply` + `STORAGE_MODE=blob`。

---

## 6. 需 José 确认的业务决策（唯一阻塞 `--apply` 的项）

**MSC / WHAN HAI / OOCL 三家 demoras 的「正确天数分层」是什么？** importes 已知且保留，只需确认天数：
- WHAN HAI `gp-hc-sd` / `ot-fr-rf`、OOCL `gp-hq-dc`：免费层之后的计费层，天数是**绝对**（如免费 0-7 后从第 8 天起）还是**相对**（从计费第 1 天起）？§3.2 给了绝对天数提案。
- MSC `imo-dry`/`special-45`/`imo-special-45`/`reefer`/`imo-reefer`：中间的 `>5`/`≥4` 开口规则是**陈旧残留可删**，还是应为某个**有界计费层**（如 `6-7`）？

> 代码加固（§3.1、§3.3）**不依赖**此决策，可先行执行解套；数据规整的 `--apply` 等 José 拍板。

---

## 7. 任务一（你的 Q1）：谁在用 PostgREST 读 `app_state`（14 次/天）

- **应用本身排除**：Jose Expressline app 只用 `pg` 连接池（`src/lib/db.js`，Session pooler），**不用** supabase-js / PostgREST / REST；它读 `app_state` 是参数化 `select payload ... where key=$1`，relational 模式读的是实体表，**从不发 `select * from app_state`**。所以那 14 次 PostgREST 全量读**不是 app 发的**。
- **同租户发现（重要）**：`pang uñas/nail-erp-mvp` 与 Jose **PROD 同一个 Supabase project**（ref `polxyashvxbzdkkmxuox`），但它只用 anon key 读自己的 ERP 表（customers/orders/...），**从不碰 `app_state`** → 不是这 14 次的来源，但它是**同项目的第二个租户**（跨租户隔离 + 共享 egress/配额，值得单独留意）。
- **最可能来源**：你/Estefani 在切换期 + 排障期用 **Supabase Dashboard 的 Table Editor / SQL Editor 打开 `app_state`** 浏览那个冻结 blob（每次 = 一发 PostgREST `select *`）→ **无害但读到的是切换那刻的陈旧数据**。
- **需 CC 去查（本地查不到）**：Supabase 的 PostgREST/API 请求日志里这些 `app_state` 读的 **身份(apikey: anon vs service_role)、user-agent、来源 IP、时间节奏**。判定规则：dashboard/service_role + 你的 IP + 工作时段 = 无害；anon/存储的 key + 云端 IP + 全天均匀 = 还有个外部集成在读冻结 blob → 指到新源或退役。见 `docs/specs/CODEX_PROMPT_app_state_reader_probe.md`。

---

## 8. 文档影响

- 本计划：`docs/specs/20260624_tarifas_save_bug_RESEARCH_AND_PLAN.md`。
- 执行 prompt（保存解套）：`docs/specs/CODEX_PROMPT_tarifas_save_unblock.md`。
- 执行 prompt（reader 排查，只读）：`docs/specs/CODEX_PROMPT_app_state_reader_probe.md`。
- 完成后 `docs/LESSONS.md` 记：①「切换后第一次真实编辑保存」是必须主动跑的验收（spot-check 看数据 ≠ 验证写路径）；②严格序列校验门 + 存量坏数据会把整页锁死，校验失败必须隔离而非整单中止；③测试网只覆盖 JSON 模式 → relational 写路径的 CI 缺口。
