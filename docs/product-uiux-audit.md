# Product / UIUX Audit Report

日期：2026-05-02

项目：Express Line / Antropy AI logistics cost workbench

## 0. 2026-05-04 UIUX 落地记录

本轮已落地两类前台交互修正，均不改变费用计算业务逻辑：

- 销售端不再在主内容区重复显示 `换单 / 清关 / 陆运` 模块切换；模块切换统一放在左侧导航。
- 换单和清关的页头从大 hero 改为紧凑的统一边框卡片，标题和简介放在同一个框内，减少首屏高度。
- 换单船公司切换不再触发整页提交；前端只局部更新船公司提示、开票口径、押金状态、柜型下拉和税率覆盖项。
- 清关船公司 / 港口 / 码头 / 场站切换不再触发整页提交；前端只局部更新可选码头、可选场站、当前选择摘要和税率覆盖项。
- 真正的报价计算仍然只在用户点击 `立即计算` 时提交服务端，保持现有计算口径不变。

代码证据：

- 紧凑页头结构：[views/workbench.ejs](../views/workbench.ejs#L3)、[views/workbench-customs.ejs](../views/workbench-customs.ejs#L3)
- 页头样式：[public/styles.css](../public/styles.css#L486)
- 换单下拉改为前端联动标记：[views/workbench.ejs](../views/workbench.ejs#L77)
- 清关联动下拉标记：[views/workbench-customs.ejs](../views/workbench-customs.ejs#L68)
- 前端局部联动实现：[public/calculator.js](../public/calculator.js#L243)
- 服务端只输出局部联动需要的精简依赖数据：[src/server.js](../src/server.js#L590)

## 1. 我用了什么 skill，怎么搜的

当前 Codex 本地可用 skill 列表里没有专门的 `Product/UIUX` skill。因此这份报告没有调用某个本地 UIUX skill 文件，而是组合使用了以下三类方法论：

1. `Heuristic Evaluation skillset`
   - 依据 Nielsen Norman Group 的 10 条可用性启发式原则。
   - 用来检查：系统状态可见性、错误预防、用户控制、真实业务语言、识别优于记忆、极简设计和帮助文档。

2. `Accessibility / WCAG skillset`
   - 依据 W3C WCAG 2.2，尤其是 focus visible、target size、input assistance、consistent navigation。
   - 用来检查：键盘可用性、按钮和链接焦点、表单反馈、目标尺寸、明暗模式对比。

3. `Enterprise Workflow / Form UX skillset`
   - 依据 Microsoft Dynamics UI/UX principles、Fluent UI 对一致性、简洁性、可扩展性的建议，以及 Baymard 对表单和错误恢复的研究。
   - 用来检查：长表单、规则维护、后台配置、保存反馈、减少重复录入、降低误操作。

联网搜索关键词：

- `Nielsen Norman Group 10 usability heuristics user interface design official`
- `W3C WCAG 2.2 focus visible target size input assistance official`
- `Baymard form usability preserving input errors defaults`
- `Microsoft Dynamics UI UX design principles enterprise forms dashboard`
- `monochrome minimal dashboard UI design black white grey enterprise app`

参考来源：

- Nielsen Norman Group heuristic summary: https://media.nngroup.com/media/articles/attachments/Heuristic_Summary1_A4_compressed.pdf
- W3C WCAG 2.2: https://www.w3.org/TR/wcag/
- W3C Focus Visible understanding: https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html
- W3C WCAG 2.2 new criteria: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- Microsoft Dynamics UI/UX principles: https://learn.microsoft.com/en-us/dynamics365/guidance/develop/ui-ux-design-principles
- Baymard form design: https://baymard.com/learn/form-design
- Baymard checkout flow UX: https://baymard.com/learn/checkout-flow-ux-optimization

## 2. 总体判断

目前网站已经可以作为外部 demo 使用：换单和清关流程能跑，后台能维护主要规则，中西语和明暗模式已经接入，换单规则页的滚动体验也比之前好。

但如果从产品经理和正式业务系统角度看，它还不是一个真正成熟的内部报价系统。主要问题集中在四类：

1. 销售前台还缺“业务单”的概念，算价结果无法保存、追踪、复用或导出。
2. 后台规则维护可以改很多数据，但缺版本、审计、误操作防护和完整 CRUD。
3. 一些交互会让用户失去上下文，比如自动提交、长表单底部保存、错误提示不贴近字段。
4. 可访问性和键盘操作还不够完整，尤其是按钮/链接焦点、长表单导航、可搜索选择器。

## 3. 业务流程检查

当前业务流程大致是：

1. 用户登录。
2. 进入换单 / 清关 / 陆运模块。
3. 换单前台选择船公司、业务性质、BL 数、demoras 天数、柜型和数量。
4. 系统输出总价、税前税后、公式、附加信息。
5. 如果是换单 + 清关连续业务，可以继续跳转到清关。
6. 清关前台录入港口、码头、船公司、场站、柜型、数量和天数。
7. 后台按模块维护船公司、码头、场站、税率、汇率和阶梯规则。

这条链路功能上成立，但产品上还缺两个关键对象：

1. `业务单 / Quote / Case`
   - 现在只是一次页面计算。
   - 业务人员真正需要的是“一票业务”的持续状态。

2. `规则版本 / Quote snapshot`
   - 当前如果后台规则改了，历史报价无法证明当时按哪套规则算。
   - 咨询和报价系统通常需要留痕，否则后续很难解释差异。

## 4. 至少 20 个可改进点

### 1. 增加“业务单 / Quote ID”作为前台主线

代码证据：

- 换单前台只是一个 POST 表单，没有业务单 ID：[views/workbench.ejs:86](../views/workbench.ejs#L86)
- 清关前台也是独立 POST 表单：[views/workbench-customs.ejs:64](../views/workbench-customs.ejs#L64)
- 目前只把上次表单存在 session：[src/server.js:482](../src/server.js#L482)

问题：

现在用户是在“算一次”，不是在处理“一票业务”。如果销售回头要查报价、继续清关、或给客户解释金额，没有稳定编号。

优化理由：

符合 NN/g 的“visibility of system status”和“recognition rather than recall”。用户应该知道自己正在处理哪一票业务，不应该靠记忆。

具体优化：

- 新增 `quotes` 数据结构。
- 每次计算生成 `quoteId`，显示在页面顶部。
- 换单、清关、陆运都围绕同一个 `quoteId` 继续。
- 后续可以加 `Draft / Calculated / Approved / Sent` 状态。

### 2. 换单到清关的连续业务需要从 session 升级为持久化上下文

代码证据：

- 继续清关按钮只在结果后出现：[views/workbench.ejs:229](../views/workbench.ejs#L229)
- 连续业务上下文写入 session：[src/server.js:488](../src/server.js#L488)

问题：

session 丢了、换浏览器、换账号，连续业务关系就丢了。

优化理由：

业务上“换单 + 清关”是一票连续业务，不应该只是浏览器会话状态。

具体优化：

- 把 `linkedWorkflow` 存到 quote snapshot。
- 清关页面通过 `quoteId` 拉取换单上下文。
- 页面上展示“来自换单 quote X”的可点击来源。

### 3. 船公司 / 港口选择不应 `onchange` 立即提交（已解决）

代码证据：

- 换单船公司选择现在只带 `data-handover-line-select`，没有 `onchange` 提交：[views/workbench.ejs](../views/workbench.ejs#L77)
- 清关船公司、港口、码头、场站选择只带局部联动标记：[views/workbench-customs.ejs](../views/workbench-customs.ejs#L68)
- 局部刷新逻辑在前端处理：[public/calculator.js](../public/calculator.js#L243)

原问题：

用户可能已经输入柜型、数量、天数，切换船公司或港口时页面提交，容易造成上下文变化或字段重置感。

优化理由：

Baymard 强调错误恢复和保留输入；自动提交会让用户感觉系统“抢走控制权”。

已落地：

- 换单切换船公司时，页面不刷新，只更新船公司提示、开票信息、押金状态、柜型下拉和税率覆盖项。
- 清关切换船公司 / 港口 / 码头 / 场站时，页面不刷新，只更新码头、场站、当前选择摘要和税率覆盖项。
- 已有数量输入会保留；如果新船公司没有同名柜型，系统自动落到可用柜型。
- 仍保留服务端计算作为唯一报价计算入口，避免前端复制计算逻辑。

### 4. 前台结果应增加“保存报价 / 导出 / 分享”

代码证据：

- 结果区只有继续清关和展示结果：[views/workbench.ejs:229](../views/workbench.ejs#L229)
- 搜索代码没有发现 `export` / `pdf` / `snapshot` 的正式持久化功能。

问题：

销售算完之后不能把结果固定下来，也不能发给客户或内部复核。

优化理由：

报价类系统的核心不是只算数字，而是生成可追溯、可复核、可传递的报价。

具体优化：

- 增加 `保存草稿`、`导出 PDF`、`复制报价摘要`。
- 保存时记录输入、规则版本、汇率、税率覆盖、结果金额。
- 导出里区分“内部成本明细”和“客户可见摘要”。

### 5. 结果公式应该做渐进展示，而不是默认完整展开

代码证据：

- 总公式直接显示：[views/workbench.ejs:278](../views/workbench.ejs#L278)
- 每项公式直接显示：[views/workbench.ejs:317](../views/workbench.ejs#L317)

问题：

公式对复核人员有用，但对销售日常报价会增加视觉负担。

优化理由：

NN/g 的“aesthetic and minimalist design”不是少功能，而是把低频信息折叠起来。

具体优化：

- 默认只显示总价、税前税后、关键业务提示。
- 明细公式放进 `展开计算过程`。
- demoras 阶梯用表格展示，比一长串公式更容易审。

### 6. 前台需要“客户可见 / 内部成本”两种结果视图

代码证据：

- 当前结果直接展示所有费用块：[views/workbench.ejs:290](../views/workbench.ejs#L290)

问题：

你前面提到“目前可以暴露成本，后期加入账号分级”。从产品上，应提前把“内部成本”和“客户报价”分层。

优化理由：

销售、运营、财务看到的信息粒度不一样。即使暂时不做权限，也应先做展示模式。

具体优化：

- 增加结果视图切换：`内部成本` / `客户摘要`。
- 客户摘要隐藏费率、公式、成本拆分，只保留项目、金额、备注。
- 后续权限分层直接复用这个展示层。

### 7. 税率覆盖区需要折叠和差异提示

代码证据：

- 税率覆盖直接渲染所有 control：[views/workbench.ejs:178](../views/workbench.ejs#L178)
- 清关同样直接渲染所有税率覆盖：[views/workbench-customs.ejs:184](../views/workbench-customs.ejs#L184)

问题：

费用项变多后，税率区会很长。大部分情况下用户只需要默认税率，只有例外才改。

优化理由：

识别优于记忆，但也要减少噪音。默认项应可见，例外项要突出。

具体优化：

- 默认折叠为“税率全部跟后台默认”。
- 只有用户点“修改税率”才展开。
- 被修改的项目显示 `已覆盖` badge。
- 结果区明确列出“本次税率覆盖项”。

### 8. 增加柜型行时应避免 `innerHTML` 拼接

代码证据：

- 动态行通过 `innerHTML` 拼接：[public/calculator.js:29](../public/calculator.js#L29)
- option 文本直接插入模板字符串：[public/calculator.js:17](../public/calculator.js#L17)

问题：

当前数据主要来自后台维护，理论上管理员输入的 label 可能进入 HTML。虽然是内部系统，但这仍然是 XSS 风险。

优化理由：

产品层面，后台可维护字段越来越多时，不能假设所有输入永远可信。

具体优化：

- 用 `document.createElement` 创建节点。
- `textContent` 写入 label。
- 如果继续用模板，至少加 HTML escape helper。

### 9. 删除最后一行柜型时“重置为 1”不够直观

代码证据：

- 最后一行删除时不删除，而是重置数量和选择：[public/calculator.js:60](../public/calculator.js#L60)

问题：

用户点击删除，预期是删除。系统改成重置，容易让人困惑。

优化理由：

符合 NN/g 的“match between system and real world”：按钮行为应符合用户预期。

具体优化：

- 如果只剩一行，删除按钮置灰并显示 tooltip：“至少保留一组柜型”。
- 或允许删除到 0 行，然后显示“新增柜型”空状态。

### 10. 后台长表单需要 sticky 保存条

代码证据：

- 换单规则保存按钮在表单底部：[views/admin-module.ejs:311](../views/admin-module.ejs#L311)
- 清关规则保存按钮在整页底部：[views/admin-customs.ejs:384](../views/admin-customs.ejs#L384)

问题：

后台表单很长，用户改了上半部分后要滚到底部保存，容易忘记保存或误以为自动保存。

优化理由：

企业后台常见模式是底部 sticky action bar 或顶部保存状态，减少操作成本。

具体优化：

- 增加 sticky save bar：`未保存更改 / 保存 / 放弃修改`。
- 表单 dirty 后保存按钮高亮。
- 保存成功后显示“已保存于 14:32”。

### 11. 后台缺少未保存更改提醒

代码证据：

- 当前滚动脚本只保存滚动状态，不检测表单是否 dirty：[public/app.js:95](../public/app.js#L95)
- 后台模块切换是普通链接：[views/partials/admin-tabs.ejs:4](../views/partials/admin-tabs.ejs#L4)

问题：

用户在后台改了数据后，点击左侧船公司、模块 tabs、返回前台，都可能丢失未保存内容。

优化理由：

NN/g 的“error prevention”：最好在用户犯错前阻止。

具体优化：

- 监听 admin form 的 input/change。
- 离开页面或点击内部链接前提示。
- 保存后清除 dirty 状态。

### 12. 删除阶梯规则需要确认

代码证据：

- 删除按钮直接提交 POST：[views/admin-module.ejs:293](../views/admin-module.ejs#L293)
- 清关 storage 删除也是直接提交：[views/admin-customs.ejs:详见 storage 删除按钮区域，当前是直接 `formaction` POST]

问题：

删除阶梯会影响报价规则，属于高风险动作。现在没有确认。

优化理由：

规则系统的删除必须可撤销或二次确认，否则运营误点会影响报价。

具体优化：

- 点击删除打开确认 modal。
- 文案展示：柜型、区间、金额。
- 增加“撤销最近一次删除”，或保存前先标记删除、保存后才生效。

### 13. 后台主数据还不是完整 CRUD

代码证据：

- 代码中有 demurrage add/delete route：[src/server.js:1341](../src/server.js#L1341)
- 清关 storage add route：[src/server.js:1074](../src/server.js#L1074)
- 但港口、码头、场站、船公司主要是循环已有数据编辑：[views/admin-customs.ejs:89](../views/admin-customs.ejs#L89)

问题：

后台可以维护已有港口/码头/场站，但日常运营一定会遇到新增码头、新增场站、新增船公司的情况。

优化理由：

产品长期使用必须支持主数据完整生命周期。

具体优化：

- 为 `shipping lines / ports / terminals / yards / container types / charges` 增加 create/delete。
- 删除前检查引用关系。
- 不直接硬删，先做 disabled/archive。

### 14. 清关后台应该拆成左侧对象树 + 右侧详情

代码证据：

- 清关后台是一个大表单，从顶部包到底部：[views/admin-customs.ejs:23](../views/admin-customs.ejs#L23)
- 港口、码头、场站都在同一页纵向展开：[views/admin-customs.ejs:80](../views/admin-customs.ejs#L80)

问题：

清关规则比换单复杂，长页维护会越来越难。用户很难知道自己在改哪个码头或场站。

优化理由：

企业配置后台适合对象树：左侧对象列表，右侧当前对象详情。你已经在换单规则页引入这个模式，清关也应一致。

具体优化：

- 左侧树：港口 > 码头；场站单独分组。
- 右侧显示选中对象的固定费、堆存费、落柜费、清关费。
- 保存只保存当前对象，降低误改范围。

### 15. 配置列表需要搜索、过滤和快速定位

代码证据：

- 换单配置列表只是循环链接，没有搜索框：[views/admin-module.ejs:31](../views/admin-module.ejs#L31)
- 模块导航也只是全部显示：[views/partials/module-rail.ejs:2](../views/partials/module-rail.ejs#L2)

问题：

船公司、码头、场站数量上来后，用户要手动滚动查找。

优化理由：

NN/g 的“flexibility and efficiency of use”：熟练用户需要更快路径。

具体优化：

- 配置列表顶部增加 search input。
- 支持按状态、港口、船公司、是否有 demoras 阶梯过滤。
- 增加最近编辑 / 收藏。

### 16. 多选场站控件不够友好

代码证据：

- 船公司和场站映射用原生 multiple select：[views/admin-customs.ejs:65](../views/admin-customs.ejs#L65)
- 场站绑定船公司也用 multiple select：[views/admin-customs.ejs:312](../views/admin-customs.ejs#L312)

问题：

原生 multiple select 对非技术用户不友好，尤其需要按住键盘多选，容易误取消。

优化理由：

后台运营人员需要清晰看到“已选”和“可选”，而不是记住 multi-select 操作方式。

具体优化：

- 改成 searchable checkbox list 或 dual-list transfer。
- 已选项显示 chip。
- 增加“全选 / 清空 / 只看已选”。

### 17. 错误提示应该靠近字段，而不是只靠页面 flash

代码证据：

- Flash 显示在页面顶部：[views/partials/header.ejs:117](../views/partials/header.ejs#L117)
- 阶梯规则校验失败后 redirect 回页面：[src/server.js:1547](../src/server.js#L1547)

问题：

如果用户在很长的 demoras 表里填错某一行，页面顶部提示不一定能让他立刻找到字段。

优化理由：

WCAG input assistance 和 NN/g error recovery 都要求错误能明确指向问题并给出解决办法。

具体优化：

- 校验失败时保存错误字段 key。
- 对具体 input 加 `aria-invalid` 和错误文案。
- 自动滚动到第一个错误字段并聚焦。

### 18. 按钮和链接缺少统一 `:focus-visible`

代码证据：

- CSS 只定义了 input/select focus：[public/styles.css:135](../public/styles.css#L135)
- button 和链接只有 hover，没有 focus-visible：[public/styles.css:100](../public/styles.css#L100)

问题：

键盘用户 tab 到按钮或链接时，不一定有足够清楚的焦点反馈。

优化理由：

W3C WCAG 2.2 明确要求键盘焦点可见。

具体优化：

```css
a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
```

### 19. 操作按钮可以更图标化，但必须保留文字或 tooltip

代码证据：

- 添加/删除都是纯文字按钮：[views/workbench.ejs:149](../views/workbench.ejs#L149)
- 删除柜型按钮是文字：[views/workbench.ejs:172](../views/workbench.ejs#L172)

问题：

内部工具高频操作中，添加、删除、刷新、保存可以用图标辅助扫描。但纯图标也可能降低可理解性。

优化理由：

更适合密集表单：图标 + 文本或图标 + tooltip 能提升扫描效率。

具体优化：

- 引入轻量 icon set，例如 lucide。
- `+` 用 Plus icon，删除用 Trash icon，保存用 Save icon。
- 桌面端显示 icon + text，窄屏显示 icon + tooltip。

### 20. 计算结果缺少“规则来源 / 版本 / 更新时间”

代码证据：

- 结果只展示汇率日期：[views/workbench.ejs:217](../views/workbench.ejs#L217)
- 数据保存是直接写 JSON，没有规则版本：[src/lib/store.js:1094](../src/lib/store.js#L1094)

问题：

如果报价结果被质疑，用户只能看到汇率日期，不能知道船公司规则是谁什么时候改的。

优化理由：

报价系统需要可解释性，不只要算对，还要能证明为什么这么算。

具体优化：

- 给每次后台保存生成 `rulesVersion`。
- 结果页显示：规则版本、最后修改人、最后修改时间。
- Quote snapshot 固定引用该版本。

### 21. demurrage 税率计算有潜在业务 bug

代码证据：

- demurrageTaxRate 取的是第一个柜型第一条规则的税率：[src/lib/calculate.js:416](../src/lib/calculate.js#L416)
- 后续每条 demurrage item 都使用同一个 taxRate：[src/lib/calculate.js:464](../src/lib/calculate.js#L464)
- 后台实际上每条规则都可维护税率：[views/admin-module.ejs:271](../views/admin-module.ejs#L271)

问题：

业务上每条 demoras 阶梯规则都有税率字段，但计算时没有逐条使用该规则自己的税率。

优化理由：

这是“后台可配置”和“前台计算”不一致，属于高优先级修复。

具体优化：

- 在 demurrage 循环内按 `rule.taxRate` 解析税率。
- override key 可以细到 `handover:demurrage:${rule.id}`，或至少按柜型分组。
- 测试覆盖：同一柜型两条阶梯不同税率，输出应分别计算税后。

### 22. 后台保存是整文件覆盖，缺少并发保护

代码证据：

- 写 JSON 使用 `writeFile` 覆盖整个文件：[src/lib/store.js:104](../src/lib/store.js#L104)
- 多个后台保存都调用 `saveShippingData`：[src/server.js:1027](../src/server.js#L1027)

问题：

两个用户同时编辑时，后保存的人可能覆盖先保存的人。

优化理由：

正式后台要保护运营维护的数据，尤其是报价规则。

具体优化：

- 短期：保存时带 `dataVersion`，版本不一致提示冲突。
- 中期：改 Postgres，按对象更新。
- 长期：加 audit log 和 rollback。

### 23. 登录和权限体验仍是 demo 级

代码证据：

- 密码明文存在 JSON：[data/users.json:7](../data/users.json#L7)
- 登录直接比较明文：[src/server.js:771](../src/server.js#L771)
- 后台只要求登录，不区分角色：[src/server.js:42](../src/server.js#L42)

问题：

对 demo 可以接受，但上线给客户看时，公开 demo 账号会削弱信任，也容易被误操作。

优化理由：

产品体验不只是页面，账号安全和权限边界也是用户信任的一部分。

具体优化：

- 密码 hash。
- 登录失败限流。
- 至少分 `admin / pricing / sales / readonly`。
- 后台敏感操作只允许 admin。

### 24. 清关后台缺少 section navigation / anchors

代码证据：

- 清关后台连续包含映射、港口码头规则、场站规则：[views/admin-customs.ejs:43](../views/admin-customs.ejs#L43)
- 保存按钮在底部：[views/admin-customs.ejs:384](../views/admin-customs.ejs#L384)

问题：

清关后台内容密度高，用户需要快速跳到“船公司映射 / 码头堆存 / 场站落柜”。

优化理由：

长配置页必须有导航，否则用户在页面中会失去位置感。

具体优化：

- 页面顶部增加 sticky section nav。
- 每个 section 有锚点。
- 当前滚动到哪个 section，高亮对应 nav。

### 25. 前台输入默认值还可以更贴近业务

代码证据：

- BL、天数、柜量只是普通 number input：[views/workbench.ejs:110](../views/workbench.ejs#L110)
- 清关天数也是普通 number input：[views/workbench-customs.ejs:124](../views/workbench-customs.ejs#L124)

问题：

销售需要快速报价，常用值应该少输入。例如 BL 默认 1、柜量默认 1、天数默认 0 是对的，但 UI 上还可以更快。

优化理由：

高频内部工具要减少键盘输入和重复动作。

具体优化：

- 数量输入增加 stepper `- / +`。
- 天数增加常用 quick chips：`0 / 7 / 10 / 15 / 30`。
- 柜量为 0 时不参与计算，并给出视觉提示。

### 26. 前台缺少“字段解释”的轻量帮助

代码证据：

- 部分字段有 helper，比如清关 storageDays：[views/workbench-customs.ejs:127](../views/workbench-customs.ejs#L127)
- 换单 BL、demoras、业务性质没有同等解释：[views/workbench.ejs:99](../views/workbench.ejs#L99)

问题：

新销售可能不知道 demoras 天数从 0 还是 1、业务性质怎么选、税前税后有什么影响。

优化理由：

NN/g 的 help/documentation 原则：最好不需要说明，但复杂业务需要内联帮助。

具体优化：

- 字段旁加 `?` tooltip。
- demoras tooltip 写明：按自然日，可从 0 开始，免费段由后台规则决定。
- 业务性质 tooltip 写明：仅换单、仅清关、换单 + 清关连续业务的差异。

### 27. 模块导航状态可以更明确

代码证据：

- 模块 nav 只显示 title/subtitle：[views/partials/module-rail.ejs:2](../views/partials/module-rail.ejs#L2)
- sidebar 工作区也只显示 stateLabel：[views/partials/header.ejs:44](../views/partials/header.ejs#L44)

问题：

陆运是预留模块，但用户看到它时可能以为可用。当前虽有状态文字，但还可以更强。

优化理由：

系统状态可见性：用户应该一眼知道哪个模块可计算，哪个只是占位。

具体优化：

- 给模块加 status dot：`Live / Draft / Planned`。
- Planned 模块禁用主 CTA，点击进入说明下一步。
- 后台设置页可以配置模块启用状态。

### 28. 明暗模式目前只存在浏览器本地，不能跟账号同步

代码证据：

- 主题使用 localStorage：[public/app.js:4](../public/app.js#L4)
- 服务端没有保存 theme preference：[src/server.js:753](../src/server.js#L753)

问题：

换浏览器或设备后主题不会跟随账号。

优化理由：

不是高优先级，但对内部系统用户体验是稳定性细节。

具体优化：

- 短期保留 localStorage。
- 后续账号系统上线后，把 theme 存到 user preferences。
- 登录后服务端把主题注入 HTML，减少首次加载闪动。

### 29. 当前测试偏后端烟测，缺少真实浏览器 UI 测试

代码证据：

- 测试脚本通过 fetch 检查 HTML 和 POST 流程：[scripts/smoke-test.js:280](../scripts/smoke-test.js#L280)
- 没有 Playwright / browser click 测试。

问题：

滚动保持、明暗模式、移动端布局、表单交互都属于真实浏览器行为。HTTP 测试无法完全覆盖。

优化理由：

UIUX 改动最容易在浏览器里出问题，尤其是 sticky、scroll、focus、responsive。

具体优化：

- 增加 Playwright。
- 覆盖：登录、主题切换、语言切换、后台列表点击不跳顶、长表单滚动、移动端截图。
- 每次 UI 改动跑 screenshot diff。

### 30. 页面顶部 hero 对内部工具略占空间（已解决）

代码证据：

- 当前换单 / 清关页头使用统一小卡片：[views/workbench.ejs](../views/workbench.ejs#L3)、[views/workbench-customs.ejs](../views/workbench-customs.ejs#L3)
- 标题卡片样式为紧凑高度：[public/styles.css](../public/styles.css#L486)

原问题：

现在视觉更高级，但内部报价系统的核心是输入和结果。长期高频使用时，过大的顶部区域会压缩工作区。

优化理由：

Microsoft 的企业 UI 原则强调简洁和聚焦任务。运营工具不应像 landing page。

已落地：

- 销售端默认使用紧凑页头，不再使用大 hero。
- 模块简介和标题合并在同一边框卡片内，减少视觉割裂和首屏占用。
- 左侧导航已经承担模块切换功能，主内容区不再重复显示模块选择。

## 5. 优先级建议

### P0：先修会影响金额或信任的问题

1. 修复 demurrage 按规则税率计算的问题。
2. 增加 quote snapshot 和规则版本。
3. 增加保存报价 / 导出报价。
4. 后台增加未保存更改提醒和删除确认。
5. 登录密码和权限从 demo 级升级。

### P1：提升日常效率

1. 清关后台改成对象树 + 详情。
2. 后台主数据完整 CRUD。
3. 配置列表搜索和过滤。
4. sticky 保存条。
5. 税率覆盖折叠并显示覆盖差异。

### P2：提升专业感和可访问性

1. 加 `:focus-visible`。
2. 增加字段 tooltip。
3. 把公式折叠到详情。
4. 加 section navigation。
5. 加 Playwright UI 测试。

## 6. 下一步最合理的实施顺序

如果只选 5 件最值得立刻做的，我建议：

1. 修复 demurrage 税率按规则计算。
2. 新增 quote 保存和 quote ID。
3. 后台 sticky save bar + unsaved warning。
4. 清关后台对象树化。
5. 增加 Playwright 测试，覆盖滚动、主题、语言、报价主流程。

这 5 件做完后，网站会从“可演示原型”明显接近“可给客户长期试用的内部工具”。
