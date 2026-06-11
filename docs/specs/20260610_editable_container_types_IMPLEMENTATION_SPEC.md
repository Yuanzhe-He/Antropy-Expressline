# 可编辑柜型主表 实现方案 (Editable Container Type Master)

状态: 已实现 (方案 B), 已测试
日期: 2026-06-10

## 实现落点 (2026-06-10)

- `src/lib/store.js`: `CONTAINER_TYPE_MASTER_VERSION` + `RATE_GROUP_NAMES` 导出;
  `buildSeedContainerTypeMaster` / `normalizeContainerTypeMaster`;
  `normalizeHandoverModuleData` 改为读持久化主表 (版本号种子化), 清关继续派生。
- `src/server.js`: `countCustomsContainerReferences`; 路由
  `/admin/handover/container-types/add | save | :key/delete(?force=1)`;
  `renderAdminSettings` 传 `rateGroupNames`。
- `views/admin-settings.ejs`: 换单设置页柜型可编辑 (改名 / 改费率组 / 删除 / 解绑并删除 / 新增);
  清关设置页只读 + 提示语。
- `src/lib/i18n.js`: `containerTypes.*` (zh + es), 含费率组显示名。
- `scripts/smoke-test.js`: 覆盖 增 / 改 / 删 + 同步到两个模块。
- 验证: 隔离 JSON 副本上 增/改/删 实时同步到换单前台 + 清关前台; 引用拦截 + 解绑删除; 两边报价仍 200; `npm test` 通过。

## 决策 (2026-06-10)

- 采用**方案 B**: 保留换单费率组模型; 做可编辑的显示柜型主表。
- 主表每条 = `{ key, label, rateGroup }`, 其中 `rateGroup` 是 `RATE_GROUPS` 的命名组
  (`dry / reefer20 / flatrack20 …`); `rateGroupKeys = RATE_GROUPS[rateGroup]`。
- 主表存在 `modules.handover.containerTypes` (换单拥有), 清关继续派生 (key+label)。
- 首次加载用版本号 `containerTypeMasterVersion` 从 `STANDARD_HANDOVER_CONTAINER_TYPES`
  种子化 (rateGroup 由常量 rateGroupKeys 反查命名组); 之后以持久化主表为准, 保留用户编辑。
- 删除行为: **被费率引用则禁止删除**, 给出明确解释 (列出引用处), 并提供**快捷解绑** (一键清掉
  清关里该柜型的费率后再删)。引用判定 = 清关存在该柜型的非零费率 (固定费 / 落柜 / 清关堆场)。

## 1. 背景 / 需求

用户希望「把柜型打通」: 后台有一个地方能增 / 删 / 改柜型, 换单 (handover) 与
清关 (港口和码头 / customs) 实时共用, 改一处两处都变。

当前 (2026-06-10) 清关柜型已实时派生自换单, 但换单柜型本身是**代码常量**, 后台无法编辑。

## 2. 现状: 「柜型」其实是三层

| 层 | 位置 | 形态 | 谁在用 | 可编辑? |
|---|---|---|---|---|
| 显示柜型 (ISO) | `STANDARD_HANDOVER_CONTAINER_TYPES` `src/lib/store.js:55` | `40GP / 20GP / 45OT…` (20 个), 带 `key/label/code/teu/rateGroupKeys` | 换单前台选择器; 清关全部 (派生) | 否 (代码常量) |
| 费率组 | 每个船公司 `containerGroups` `src/lib/store.js:757` | `gp-hq-dc / fr-20…` (约 17 个), 按船公司各存一份 | 换单后台 `views/admin.ejs` 按 `group.key` 编辑本地费 / demoras | 是 (但是「费率组」, 不是显示柜型) |
| 映射 | `RATE_GROUPS` `src/lib/store.js:36` + `rateGroupKeys` | 显示柜型 → 费率组 | `resolveRateGroupKey` `src/lib/calculate.js:76` | 否 (代码常量) |

关键事实: 换单的船公司费率不是按显示柜型 (40GP) 存的, 而是按费率组 (gp-hq-dc) 存,
显示柜型通过 `rateGroupKeys` 映射过去。清关 (统一后) 则是直接按显示柜型 (40GP) 存费率。

因此「加一个柜型」对清关只需 `{key,label}`, 对换单还要决定它走哪个费率组, 否则换单算不出价。

## 3. 设计决策 (需用户选择)

### 方案 A — 拍平 (柜型彻底变成一个概念)

换单也改成「按显示柜型直接存费率」, 去掉费率组中间层。之后全系统只有一个柜型概念 =
可编辑主表。编辑器只需 `{key,label}`。

- 优点: 心智最简单, 真正「一处」; 编辑器最干净。
- 缺点: 换单定价模型大改; 失去「一个费率管一组柜型」的便利 (如所有 dry 柜共用一个费率);
  换单现有费率数据需迁移 / 重置; **定价回归风险高**。

### 方案 B — 保留费率组, 主表可编辑 (推荐)

保留换单费率组模型不动。把**显示柜型主表**做成可编辑 (key、label、以及每个柜型归到哪个
费率组)。清关用 key+label; 换单用 key+label+rateGroupKeys。

- 优点: 不动换单定价行为, 风险低; 用户仍然只编辑一个主表。
- 缺点: 编辑器要带「费率组」字段 (新增柜型时选它走哪个费率组); 底层仍是两层, 但用户只面对一个主表。

### 方案 C — 最小 (仅显示层)

主表只管 `{key,label}`, 驱动清关 + 换单前台选择器; 换单费率组 / 后台费率维持现状,
新柜型默认归到某个费率组。比 B 再省一点, 但新柜型的费率归属不可视化, 容易出错。

推荐: **方案 B** (单一编辑入口 + 不破坏换单定价)。

## 4. 方案 B 文件级改动 (待确认后细化)

1. `src/lib/store.js`
   - 新增持久化、可编辑的柜型主表 (放在 `shippingData` 顶层或 `modules` 共享处), 首次加载用
     `STANDARD_HANDOVER_CONTAINER_TYPES` 作为种子 (用版本号 gate, 仿 `containerTaxonomyVersion`)。
   - `normalizeHandoverModuleData` / `normalizeCustomsModuleData` 改为从主表读 `containerTypes`,
     不再写死常量。
   - 保留 `RATE_GROUPS` / `rateGroupKeys`; 主表每条带 `rateGroupKeys` (编辑器维护)。
2. `src/server.js`
   - 新增柜型主表 CRUD 路由: 增 / 删 / 改 (key、label、费率组)。删除时校验是否被船公司费率 /
     清关费率引用, 给出提示。
3. 后台视图
   - 扩展 `views/admin-masters.ejs` (现在是只读「柜型表」) 成可编辑, 或新建编辑页。
4. `src/lib/i18n.js` — 新增标签 (zh + es)。
5. 迁移 — 首次加载把常量种子进主表; 之后以主表为准。
6. `scripts/smoke-test.js` — 覆盖增删改 + 两个模块同步生效。

## 5. 影响面 (Blast radius)

- 页面: 换单前台选择器、清关前台选择器、换单后台费率表、清关后台费率表、`admin-masters` / `admin-settings` 柜型总览。
- API: 新增柜型 CRUD; 受影响的现有保存路由 (船公司费率、清关费率)。
- 数据: 柜型从常量变为持久化主表; 需迁移种子。
- 计算: `resolveRateGroupKey` / demoras 规则解析依赖 `rateGroupKeys`, 改错会导致换单报价错误。
- 测试: `npm test` smoke; 需新增柜型 CRUD 与同步用例。

## 6. 风险与回滚

- 风险: 新柜型 `rateGroupKeys` 配错 → 换单报价取错费率组。删柜型 → 引用它的费率成孤儿。
- 缓解: 删除前引用校验; 新柜型默认归到合理费率组; 迁移用版本号确保只跑一次。
- 回滚: 主表种子来自常量, 可保留常量作为 fallback; 出问题可禁用主表回到常量。

## 7. 验证

- `npm test` (smoke)
- 隔离 JSON 副本起服务: 增/删/改柜型后, 换单前台、清关前台、两边后台费率表同步反映; 换单 + 清关报价仍正常 (HTTP 200, 总价合理)。

## 8. 待用户确认

- 选 A / B / C?
- 删除某柜型时, 若被费率引用, 是「禁止删除」还是「删除并清掉相关费率」?
