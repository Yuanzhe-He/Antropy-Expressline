# 00z9 — 第N+34轮执行（代码结构重构 server.js/store.js god-file 拆分，Phase 0-2）

> 最新轮次。CC执行轮。分支 `feature/refactor-godfiles`（从 main=58cd443 切）。PR-only。行为零变化（纯搬移）。

## 2026-06-22 第N+34轮 — god-file 拆分（分阶段，Option A=JSON-mode 测试）

### 前置决策：测试环境（Chandler 选 Option A）
- 本机无 Docker/Postgres（`supabase start` 需 Docker），无法起本地库。**但代码库测试本就跑 JSON-mode in-process**（smoke-test 等 `STORAGE_DRIVER=json` + `createApp()` + HTTP）——纯代码搬移用它验证最忠实、零生产风险；本地 Postgres 对本任务无意义（测试强制 JSON）。Chandler 选 A=用 JSON-mode 原生方式。**全程零生产接触、零数据库改动。**

### Phase 0 — 测试网（commit f90a4fe）✅
- `npm run test:all`（`scripts/run-all-tests.js`）：顺序跑全部 *-test.js（子进程隔离），汇总+任一失败非零退出。
- `scripts/audit-admin-routes-test.js`：route 级 CRUD over HTTP（JSON-mode，隔离 temp DATA_DIR，不碰仓库 data/ 或生产），填上 ~47 个之前没测的 admin 路由：settings、container-types、customs ports/terminals/yards、inland origins/destinations/rate-entries（每个 create→read-back→delete）+ 一个 no-500 wiring sweep（fixed-charges/storage-rule-sets/local-charges/terminal-mix/demurrage-rule-sets/inland routes refresh/workbench GETs）。
- 基线 **test:all = 13/13 绿**。**没有绿基线不准动 server.js**（已满足）。

### Phase 1 — middleware + 小路由（commit d288ec8）✅
- `src/middleware/auth.js`（publicDemoUser/attachUser/requireAuth）、`i18n.js`（语言协商）、`locals.js`（safeJson XSS-safe，正则字节一致 + flash）。
- `src/routes/health.js`（GET /healthz）、`src/routes/exchange-rates.js`（POST /admin/:m/exchange-rates/refresh，含 refresh-monitor 陷阱）。
- server.js import+wire；**中间件顺序原样保留**（urlencoded→static→session→language→user→safeJson→flash）。requireAuth 重新 import（仍守 61 路由）。
- 验证：路由计数守恒（server.js 73 + 模块 2 = 75）；test:all 13/13；/healthz+启动日志+中间件实测 OK。

### Phase 2 — workbench 路由（commit 5013c76）✅
- `src/routes/workbench.js`：5 个 workbench 路由（GET /workbench/:m + POST handover/customs/inland/quote/quote/pdf）**逐字节搬移**为 `register(app, ctx)`。lib 函数直接 import；20 个 server.js view/form helper 经 `ctx` 传入。`INLAND_ADMIN_TARGET` const 留在 createApp（admin/inland 用）。
- 验证：server.js 零 /workbench 路由；test:all 13/13（**quote-test 9/9 断言精确报价输出 = 行为 diff 检查**）；load OK。
- **server.js：4707 → ~4150 行。**

### 方法（每阶段一致）
纯搬移 + 改 import，业务逻辑一行不动。`ctx` = createApp 里组装一次的 server.js helper 集（helper 仍在 server.js，经 ctx 传给 routes 模块；transitive 调用经各自闭包解析，无需全列）。每阶段后 test:all 全绿 + 路由计数守恒 + load OK + 关键路由实测。用 node splice 脚本做大块删除（先 assert 边界行再写）。

### ⏳ 下一增量（Phase 3-4，本轮未做，留专注 pass）
- **Phase 3**：admin 路由按模块拆（inland 1873-2398 含 markRouteStale 闭包 / customs 2638-3480 / handover-shipping-lines 3488-4200 / quote settings）+ 业务 helper 下沉 lib/（customs-rules / handover-forms / rule-engine）。**最大最纠缠的一块（~60 路由），且部分 sub-route 测试较薄**——为守"行为零变化"，不在 end-of-turn 赶工，留专注 pass（Phase 0 测试网已就位使其安全）。
- **Phase 4**：store.js（2606 行）→ lib/store/{index, normalize-handover/customs/inland/quote, normalize-shipping-data}，对外 API 签名不变（与数据方案 blob→relational 衔接点）。
- **Phase 5**（可选）：calculate/quote 内部拆、i18n 按模块分文件。

### 收益（诚实）
- 本轮：server.js -557 行、middleware/routes 模块化、**测试网从 ~smoke+quote 扩到 13 套含 admin CRUD 覆盖网**。
- 收益=可维护性/改动安全/可测试性。**代码解耦不降 egress/不改性能**（egress 是数据层 blob→表 的收益，别混）。

### 验收 / 爆炸半径
- 行为零变化：纯搬移；test:all 13/13 每阶段绿；路由计数守恒；quote 精确输出不变。
- 零业务逻辑改动、零 DB 改动、零生产接触。改动文件：新增 middleware/*（3）、routes/*（3）、scripts/run-all-tests.js、scripts/audit-admin-routes-test.js；改 server.js（搬移）、package.json（test:all）。
- 回滚：每阶段独立 commit，`git revert` 单 commit 即可（纯搬移，干净）。

**项目状态**：main=58cd443。本轮 god-file 拆分 Phase 0-2 完成（3 commit，全绿），Phase 3-4 留下一增量。分支 `feature/refactor-godfiles` 待开 PR。

**本轮防compact写入**：00z9_chandler_log_round34.md（本文件）+ `_ROADMAP_anti_compact.md` 定位区。
