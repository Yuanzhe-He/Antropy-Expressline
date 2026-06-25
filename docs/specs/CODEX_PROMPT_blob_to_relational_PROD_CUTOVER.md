# CODEX/CC PROMPT — Express Line 数据层 blob→关系表【生产 cutover｜逐步硬闸，每步等 Chandler 明确批准】

> 🚦 运行前置检查（开工第一件事，必须用 git/filesystem 核实；任一不满足即停、不许进 Step 1）：① scripts/relational/ 有正向迁移(blob→tables)+反向迁移(tables→blob)+parity harness；② src/lib/store/ 有 STORAGE_MODE=blob|dual|relational facade；③ 沙盒 fnczokogchlhutyskbdw 上 2a parity=0 + test:all/quote 在 relational/dual 全绿；④ 2b per-entity 写+并发测试已建；⑤ 代码 PR 已评审合并。任一缺失 → 本 prompt 不可运行，先回去把本地 2a→2b 做完（别碰生产）。
> ⚠ 生产 = polxyashvxbzdkkmxuox，**一个项目里装着三个生意**：expressline schema（我们）、public.joyas_*（Althea 珠宝）、public.punas_*（pang uñas 美甲）。
> 这是整个项目唯一【不可逆】的一步，打的是【三个活业务】的生产库。规则和本地 build 完全相反：**不是一口气连续做，是每一步硬停、等 Chandler 对那一步明确说 go 才做下一步。**

## 0. 三条铁律（违反即停）
1. **只碰 expressline schema，永不碰 joyas_*/punas_*/其他 schema。** 这两个是另外两个生意的生产数据。
2. **逐步执行**：每个 step 做完 → 报告（含验证输出）→ **停**，等 Chandler 对下一步明确 go。**不许把多个 step 串起来一口气做**（你之前越过软性等待，这里每个 step 是硬闸）。
3. **每步可回滚**：blob 始终是 source of truth，直到 relational 被证明；任何一步异常 → 回滚（STORAGE_MODE=blob + reverse migration + backup 兜底）。

## 1. 必读 + 前置
- docs/specs/20260621_blob_to_relational_redesign.md §C（cutover 计划 + parity 计数 + Q4 orphan 闸 + Q5 币种闸）。
- scripts/sandbox-guard.js（你写的 ref guard）—— 生产这步要写一个**反过来**的 prod guard（见 §2）。
- 沙盒里 2a→2b 的迁移/反向/facade/测试产物（生产用同一套，只是目标库变 prod expressline）。

## 2. 生产 cutover guard（开工先写 + 先证明，比沙盒 guard 更严）
sandbox-guard 是「只许沙盒、禁生产」；cutover 要「**只许生产 expressline、禁碰 joyas/punas**」。三层：
- **(a) ref 正向断言**：DATABASE_URL 的 project ref 必须 == polxyashvxbzdkkmxuox（唯一要打生产的场景）。
- **(b) schema 级隔离（比 ref 更关键）**：用一个**只对 expressline schema 有权限的专用 DB role** 连接（对 public/joyas_*/punas_* 无任何权限）；search_path 锁 expressline；所有迁移 SQL 显式 expressline. 限定。
- **(c) 先证明隔离**：用这个 role 跑 `select 1 from public.punas_customers limit 1` 和一个 joyas 表 select —— **必须 permission denied**（证明这个连接物理上碰不到另外两个生意）。把拒绝输出贴给 Chandler。**这步过不了，后面一律不做。**
- 没有这个 role / 建不了 → 停下问 Chandler，别用 superuser 裸跑生产。

## 3. cutover steps（每步硬停等 go）

**Step 1 — 备份（只备 expressline）**：导出 prod expressline.app_state + audit_logs + quote_snapshots 到可验证文件（行数 + checksum）。**不导 joyas/punas**。报告备份位置 + 校验和。【停，等 Chandler 确认备份在、可用】

**Step 2 — 生产建表**：沙盒验过的同一套 18 表幂等 migration，**只在 prod expressline schema** 建（guard + 限定 role）。报告建了哪些表 + 没动 app_state。【停】

**Step 3 — 正向迁移 + 生产数据闸**：prod expressline.app_state blob → expressline 表，跑：
- **Q4 orphan 闸**（每 yard.shippingLineIds ∈ carriers、每 customs line id ∈ handover）—— 这次跑在【真生产数据】（José 的 method-B 映射这里才有）。
- **Q5 币种闸**（扫 prod blob，遇 {MXN,USD} 外币种直接拒、不静默 coerce）。
- 任一闸命中 → **停，报告，等 Chandler 决定怎么 reconcile**，不自行绕过。
报告迁移行数 + 两闸结果。【停】

**Step 4 — parity 闸（生产）**：自动 diff（行数 + 字段级 + §C 的 José 手改抽查：CMA 50 / KMTC 15 / ZIM 改名 等）blob-projection vs expressline 表，**必须 = 0**。贴 parity 报告。【停，等 Chandler 确认 diff=0】

**Step 5 — 切 dual（部署）**：STORAGE_MODE=dual 部署（写 blob+表、读 blob、影子读表 diff）。观察窗：José 编辑双写、影子 diff 持续监控。报告观察窗 diff。【停，等 Chandler 确认观察窗干净】

**Step 6 — 切 relational（部署）**：STORAGE_MODE=relational（读写表，blob 留 fallback 一窗口）。报告 app 健康 + 关键路径（报价/admin 写）实测。【停】

**Step 7 — per-entity 写生效（2b，若未默认）**：路由走 per-entity 定点写。报告并发/目标写行为。【停】

**Step 8 — 退役 blob fallback（安全窗口后）**：停写 blob → 最终 drop blob 列/表（只在 expressline）。【停，最终确认】

## 4. José 手改窗口
- 备份→迁移→切换之间 José 可能在改 prod。Step 5 的 dual 窗口捕获他的编辑（双写）；每次切换前做一次 parity 复查确认没丢编辑。
- 建议 Step 1-4 选 José 不活跃的低峰窗口做，减少 in-flight 编辑。

## 5. 回滚
- 任何一步异常：STORAGE_MODE 退 blob + reverse migration（表→blob）+ backup 兜底。blob 在 relational 证明前始终是 source of truth。
- 退役 blob（Step 8）之前，整个过程随时可退回纯 blob。

## 6. 部署/Railway
- STORAGE_MODE 改要部署。schema migration 必须在 relational 部署【之前】先在 prod expressline 建好（Express Line 部署不自动迁移）。顺序：Step 2-3 迁移 → 再带 STORAGE_MODE 部署。

## 7. 报告 + 收尾
- 每步：做了什么（限 expressline 证明）+ 验证输出 + 回滚点。
- 全程 joyas/punas 零接触的证明（§2c 的 permission denied + 每步 SQL 的 expressline 限定）。
- 结尾 Post-task routing（Cursor 格式）。
- 唯一推进方式 = Chandler 对每一步明确 go；任何不确定 → 停。
