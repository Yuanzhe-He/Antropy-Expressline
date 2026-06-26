# 00z7 — 第N+32轮执行（删轮询=确认无轮询可删 + 抓幽灵=当前不活跃陷阱加固 + blob→关系表方案）

> 00z6(round31 Claude prompt) 续篇。CC执行轮。最新轮次。分支 `feature/kill-poller-catch-ghost`（从 main=58cd443 切）。PR-only，未直推。

## 2026-06-21 第N+32轮执行 — 删轮询 + 抓幽灵 + 最彻底重构方案

═══════════════════════════════════════════
## 任务1 — 揪轮询：彻底 grep，结论=**仓库零轮询，没有可删的**
═══════════════════════════════════════════
- **`setInterval` 全仓 0 处**（public/ + views/ + src/ 唯一命中是 refresh-monitor.js 里的一句注释）。
- 列出每个定时器/递归构造，逐一判定（全是一次性 UI，非轮询）：
  - `public/app.js`：requestAnimationFrame/setTimeout（主题应用、滚动、result-just-updated 高亮移除、加载 spinner 最短时长）= 一次性 UI；`fetch`(:434)=计算器 AJAX 提交(用户点)；`location.reload()`(:597)=「放弃修改」按钮(用户点)。
  - `public/calculator.js`/`inland-map.js`：rAF/setTimeout = 地图路线 dash 动画、UI。
  - views 内联 `<script>`：仅 `admin-quote.ejs`(增删备注行,点按钮)、`header.ejs`(setInitialTheme 读 localStorage) = 一次性，无定时；其余 `<script type=application/json>` 是数据块。
  - `calculator.ejs:47` `onchange="this.form.submit()"` = 用户改下拉才提交。
  - `src/server.js`：无 setInterval/setTimeout。
  - `exchange-rate-scheduler.js`：setTimeout 但 scheduleNext 算的是**下一个午夜**（一天一次），非轮询，合理保留。
- **结论**：货代报价系统不需要任何轮询；仓库里本来也没有。那个每 2s 的轮询**100% 来自仓库之外**（幽灵，见任务2）。仓库侧确认干净，无需删改。

═══════════════════════════════════════════
## 任务2 — 抓幽灵：当前**不活跃**，Railway log 取不到，陷阱已加固
═══════════════════════════════════════════
- **实测现状（5 分钟连续观测，每 30s 一次 curl /healthz.refreshRoute）**：`totalHitsToday=0 / lastHitAt=null / distinctSources=0` 全程不变；usageGuard reads=4 writes=14 全程不动。→ **幽灵当前不打了**（若每 2s 活跃，5 分钟应有 ~150 次）。与 round27 一致：它早些时候自停了。
- **Railway access log 取不到**：`railway` CLI OAuth token 失效，`railway login` 需浏览器交互=**user-only，CC 做不了**。这是直接 HTTP 来源识别的硬卡点——**只有 Chandler 浏览器登录 Railway 才能看 access log**。
- **陷阱加固（本轮改进）**：把 refresh 路由的来源记录 `refreshMonitor.record()` 移到**模块校验之前**（原来在 404 检查之后，只抓合法 moduleKey）。现在**任意 moduleKey 的 hit 都被指纹捕获**。e2e 实测：POST `/admin/BOGUS/exchange-rates/refresh` → HTTP 404，但 /healthz.refreshRoute 仍抓到 `ip=198.51.100.5 ua=GhostBot/1.0 referer=...`。
- **怎么从源头根除（给 Chandler）**：
  1. 幽灵一旦再出现 → `curl <prod>/healthz` 看 `refreshRoute.sources` 的 **IP/UA/Referer**：UA=HeadlessChrome/Playwright/puppeteer→自动化/AI 脚本；UA=某监控名→监控服务；普通浏览器 UA→真人开着标签。
  2. Chandler 可 `railway login` 后看 access log 里 /exchange-rates/refresh 的来源（user-only）。
  3. 重点排查方向（结合上轮发现）：**本地 `.env` 直连的是生产库** → 任何本地 `npm run dev` + 本地点/脚本刷汇率都会打生产、且生产侧无 HTTP 痕迹（打的是 localhost）。问：6/13-14 开发报价功能时，是否在本地把 app 跑起来、或让 AI agent 用浏览器反复点过「刷新汇率」？这条最可能。
- **结论**：幽灵现在静默、抓不到实时指纹；陷阱已永久部署且加固（回来即抓任意 key）；根除需 Chandler 侧（Railway log / 确认本地 dev-agent 活动 / 关掉源头）。

═══════════════════════════════════════════
## 任务3 — 最彻底重构方案（blob→关系表）：**只出方案，未执行**
═══════════════════════════════════════════
- 方案文档：`docs/specs/20260621_blob_to_relational_redesign.md`（A 现状/B 表设计含完整 DDL/C 迁移含 José 数据保护/D 改造范围/E 风险回滚/F 收益）。
- **实测 blob 结构（真实数字，2026-06-21 生产）**：总 **1.83MB**。inland **1.42MB=77%**(44目的地/300费率/44路线 geometry，冷)、customs 285KB、handover 107KB、quote 10.7KB、**exchangeRates 仅 299 字节(热,每天1变+幽灵每2s戳)**。
- **核心病根量化**：热数据(FX 299B)与冷大块(inland geometry 1.42MB)焊在同一 blob → 汇率刷新路由只需 299B 却搬 1.83MB = **放大 ~6,100×**。59 个路由全走 loadShippingData 整块读。
- **目标设计**：~12 张关系表（exchange_rates 单表 / carriers+carrier_charges 消除 handover-customs 镜像 / customs_ports/terminals/yards+join / container_types / inland_origins/destinations/rate_entries + **inland_route_cache 冷大块单表** / quote_drafts/notes / module_settings）。查哪儿调哪儿、改哪儿改哪儿、行级并发安全。
- **收益**：汇率路径 1.83MB→200B(~9000×)；报价页→~11KB；陆运页不再背 1.42MB geometry；egress 正常使用降到每天几 MB 且不依赖缓存。
- **建议分两阶段**：**Phase 1（20%工作量拿~95%收益，强烈推荐先做）**=只拆 exchange_rates + inland_route_cache 两表；**Phase 2**=全实体关系化（靠兼容层 `assembleShippingData` 灰度、每步可回滚）。
- **José 数据保护是迁移硬约束**：迁移前备份+单事务+逐项核对(carriers=21/yards=28含自建2/CMA50/KMTC15/ZIM改名…)+报价结果前后逐字段一致；blob 保留只读 fallback；feature flag `STORAGE_MODE=blob|relational` 可秒切回。
- **不在本轮执行**，Chandler review 方案后单独立项。

## 验收
- 任务1：轮询全列出 ✓ + 确认仓库零轮询无可删 ✓。
- 任务2：幽灵现状(不活跃,5min 0 hit)✓ + 身份(抓不到实时,最可能=本地 dev/agent 连生产库)✓ + 根除建议 ✓ + 陷阱加固(任意 key,e2e 验证)✓。
- 任务3：方案文档完整(A-F+DDL+迁移+风险+收益+分阶段)✓，未执行 ✓。
- 回归 12/12 绿 + e2e(bad moduleKey 仍被指纹)✓。

## 爆炸半径
- 改 `src/server.js`（refresh 路由：record 提到校验前，捕获任意 moduleKey）—— 行为上仅"更早记录来源"，不影响刷新逻辑/手动按钮/scheduler。
- 新增方案文档 `docs/specs/20260621_blob_to_relational_redesign.md`（纯文档，不执行）。
- 报价/计算/双价/数据**不碰**。无数据库改动（重构是后续单独立项）。

## 剩余留尾（later）
- blob→关系表重构执行（Phase 1 先做，Chandler 拍板后立项）。
- 幽灵源头根除（Railway log / 确认本地 dev-agent，user-only）。
- service_role(RLS)/邮件告警 step-2（都 later）。

**项目状态**：main=58cd443（egress 事件已闭环：读缓存+1h TTL+护栏+陷阱）。本轮：确认仓库零轮询、幽灵不活跃陷阱加固、出 blob→关系表最彻底重构方案（未执行）。分支 `feature/kill-poller-catch-ghost` 待开 PR。

**本轮防compact写入**：00z7_chandler_log_round32.md（本文件）+ `_ROADMAP_anti_compact.md` 定位区 + `docs/specs/20260621_blob_to_relational_redesign.md`。
