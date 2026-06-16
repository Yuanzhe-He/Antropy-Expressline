# 陆运 v2 第二批 — 实施 Spec（实现级）

> 分支：`feature/inland-v2-batch2`（已切，base = `main@66ccf37`，**栈在 batch1 之上**，见 §0 K7）。PR-only。
> 来源任务书：本轮消息「任务 B」；客户原始资料归档：`docs/client-info-source/README.md`。
> 本 Spec = Step 1。**写完即停，等 Chandler 确认口径后再做 Step 2。**
> 范围：S2 车型 6 档 / S3 路线照片(URL) / S4 routing provider 抽象+后台人工覆盖 / S5 时间里程进 PDF。
> **不在本批**：车型差异化费率灌入、3 种报价模式重构、真接 Google 付费 API、CNY 段（任务 C，会议后另立项）。

---

## 0. 请先确认的口径（确认后才动代码）

- **K1（车型枚举 + 西语名）**：6 档 `key`：`light_1_5t`(1.5吨) / `light_3_5t`(3.5吨) / `short_8t`(8短) / `sencillo`(单拖) / `full`(双拖) / `lowboy`(低平板)。中文已定；**西语名待 José 确认**（他是西语域专家）。我的建议默认：1.5吨=`Camioneta 1.5t`、3.5吨=`Rabón 3.5t`、8短=`Torton 8t`、单拖=`Sencillo`、双拖=`Full`、低平板=`Cama baja / Lowboy`。→ José 会上校西语名。
- **K2（车型数据模型）**：**保留 `rateEntry.sencillo` / `full` 原字段不动**（CSV 导入/计算器/burreo/map-data 全依赖它们），**新增 `vehiclePrices:{light_1_5t,light_3_5t,short_8t,lowboy}`** 仅承载新 4 档（初始 null）。取价用 helper `getVehiclePrice(entry,type)`：sencillo/full 读顶层、其余读 vehiclePrices。→ 我的判断：加字段不破旧逻辑、零回归，**推荐 K2**。
- **K3（照片落点 + 安全口径）**：`imageUrls:string[]` 放在 **destination**（首选；José 说"我做过的案例"=路线/目的地）+ 可选 precisePoint。**只存 http(s) URL，绝不 base64/二进制**。**关键安全澄清**：图片由**浏览器**加载（`<img src>`），**服务器不抓取** → **无 SSRF 面**（与会抓取的 `inland-link-resolver` 不同，那个服务器跟链才要域白名单）。本批真实风险是**存储型 XSS** → 用 scheme 校验(只 http/https) + HTML 转义 + 纯 `<img src>`（不 innerHTML 注入）防住。**是否限制图床域名白名单**？我的建议：**不限制**（José 可能用 Drive/imgur/自有），仅 scheme+转义；非 https 给"不安全"提示。→ 确认。
- **K4（routing 数据源）**：本批 **OSRM 默认（免费、已验证）+ 后台人工覆盖（核心交付）**；`GoogleDirectionsProvider` 只做**接口骨架**（读 `GOOGLE_MAPS_API_KEY`，未配置不启用），**不真接付费 API**。→ José 原话"全部用 Google API"，但其真实诉求是"修改选项"=人工覆盖；是否启用付费 Google 留会议。确认按此。
- **K5（无价车型行为）**：选了无费率的车型（新 4 档默认无价）显示 **"待报价 / Pendiente"**，**不报错、不阻塞**；默认车型 = `sencillo`。→ 确认。
- **K6（生产数据）**：**本批不需要 CSV 重新 seed**——新字段（vehiclePrices 空 / imageUrls 空 / manualOverride null）全由**后台人工录入**，不来自 CSV。normalize 自动补默认值。**但**受 batch1 教训约束：**新字段必须先部署再录入**，否则线上旧 app 每 ~2s 重写 app_state 会把未知字段抹掉（见 batch1 报告）。故 batch2 **零 prod 写**，只需部署后由运营在后台填。→ 确认。
- **K7（分支基线）**：batch1 **未提交**（working tree 脏，0 commits beyond main），且与 batch2 **同改** store/inland-csv/calculate/inland-map/admin-inland/server/i18n → 无法干净并行。已把 batch2 **栈在 batch1 之上**（base=main，携带 batch1 改动）。**建议：先把 batch1 提交成独立 commit**（我不擅自 commit，按"用户要求才提交"），再让 batch2 stacked PR；否则两批改动在 working tree 混在一起、难拆两个 PR。→ **请定：是否授权我先 commit batch1**（保全已验证工作）。

---

## 1. 现状锚点（实现依据，file:line）

| 主题 | 事实 | 锚点 |
|---|---|---|
| 车型 | CSV `TIPO DE SERVICIO`=CHASIS/PLATAFORMA(248/248)、`CONTENEDOR`=20"/40"(248/248)，**无车型差异数据**；`sencillo`/`full` 已是 toggle | `inland-csv.js:11-22` / `workbench-inland.ejs:45-49` |
| 计算器 | `computeInlandCalculator` 读 `entry[serviceType]`，serviceType∈{sencillo,full}，硬编码 MXN | `calculate.js:1002-1006` |
| map 数据 | `buildInlandMapData` 出 per-dest `maxSencillo/maxFull(+Provider)`（batch1 加了 `maxBurreo*`） | `server.js:1229-1261` |
| 路线缓存 | `routeCache[]`：`originId,destinationId,targetType,distanceKm,durationMin,viaCities,hasFerry,stale,engine,fetchedAt`（43/43） | `store.js:1931-1950` |
| OSRM 抓取 | `fetchOsrmRoute(origin,dest)` → `{encodedPolyline,distanceKm,durationMin,hasFerry,engine}`；多 base URL + 重试 | `inland-routes.js:161-213` |
| 路线刷新 | `refreshOneInlandRoute` 调 fetchOsrmRoute 写 routeCache；admin「刷新」遍历目的地 | `server.js:~1972-2046` |
| 目的地/精确点 | `normalizeInlandDestination`(+precisePoints)，destination 有 lat/lng/state/note；precisePoint 有 name/lat/lng/link | `store.js:1870-1904` |
| 链接解析 | `inland-link-resolver` **服务器跟短链** → 有域白名单 + Mexico bbox（这是 SSRF 防护所在；图片不走这条） | `inland-link-resolver.js` |
| PDF 路线 | batch1 已加 `resolveQuoteRoute` + quote-document route-meta（携带中） | `quote.js`(batch1) / `quote-document.ejs`(batch1) |

---

## 2. S2 车型 6 档（数据模型 + 后台 + 前台）

**数据模型**（K2，附加、零回归）：
- 新建 `src/lib/inland-vehicles.js`：`VEHICLE_TYPES=[{key,zh,es,legacy?}]` 6 档（sencillo/full 标 legacy 映射顶层字段）；`DEFAULT_VEHICLE_TYPE="sencillo"`；`getVehiclePrice(entry,type)`。
- `store.js normalizeInlandRateEntry`：增 `vehiclePrices:{light_1_5t,light_3_5t,short_8t,lowboy}`（各 `parseNullableNumber`，默认 null）。`sencillo`/`full` 不动。
- `calculate.js computeInlandCalculator`：`serviceType` 扩到 6 枚举（非法值 → 默认 sencillo）；取价 = `getVehiclePrice`；该车型无价 → 走 `noRate` 风格返回 `pendiente:true`（前台显示"待报价"）。**sencillo/full 路径数值不变**（回归）。burreo 仍按 sencillo/full（新车型暂无 burreo）。
- `server.js buildInlandMapData`：per-dest 增 `maxByVehicle:{type:{rate,provider}}`（6 档 max；新档多为 null）。保留 `maxSencillo/maxFull` 兼容。
- 前台 `workbench-inland.ejs` + `inland-map.js`：2 键 toggle → **6 档选择器**（segmented/select）；选中取 `maxByVehicle[type]`；无价显示"待报价/Pendiente"。
- `admin-inland.ejs`：费率行增 4 个新车型价输入（sencillo/full/burreo 已有）。保存路由 `rate-entries/save` 解析 `re_veh_<type>_<id>`。
- `i18n.js`：6 车型名 zh/es（K1）。

## 3. S3 路线/目的地照片（只存 URL）

- `store.js normalizeInlandDestination`（+可选 precisePoint）：增 `imageUrls:string[]` —— 规范化：仅保留 `^https?://` 字符串、trim、去重、cap ≤12。
- 新 helper `normalizeImageUrls(value)`（store 内）。
- `admin-inland.ejs`：目的地详情区加「案例图片 / Imágenes」多条 URL 输入 + `<img>` 预览（escape）。新增/删除走表单（`dest_image_*` 或专用路由 `/admin/inland/destinations/:id/images`）。
- 前台 `inland-map.js`：地图 popup / 结果区显示缩略图（有则显示，点开大图）。
- **安全（K3）**：scheme 仅 http(s)；HTML 全转义；**服务器不 fetch 图片** → 无 SSRF；XSS 由转义 + `<img src>` 防住。非 https 仅提示。
- **硬约束**：绝不 base64/二进制入 `shipping-data`。

## 4. S4 Routing provider 抽象 + 后台人工覆盖（核心交付）

- `inland-routes.js` 重构 provider 模式：
  - `RoutingProvider` 接口：`fetchRoute(origin,dest) → {distanceKm,durationMin,viaCities,encodedPolyline,hasFerry,engine}`。
  - `OsrmProvider`：包现有 `fetchOsrmRoute`（默认，免费）。
  - `GoogleDirectionsProvider`：**骨架**——读 `GOOGLE_MAPS_API_KEY`；未配置 `isAvailable()=false`；本批**不真调付费 API**（实现请求/解析形状 + TODO 标注）。
  - 选择器：`getRoutingProvider()` 读 `ROUTING_PROVIDER`（默认 `osrm`）；google 未配 key 时回退 osrm。
- **后台人工覆盖（José 真正要的"修改选项"）**：
  - `store.js normalizeInlandRouteCacheEntry`：增 `manualOverride:{distanceKm,durationMin,viaCities}|null` + `source:"osrm"|"google"|"manual"`（默认按 engine）。
  - **有效值** = `manualOverride.x ?? fetched.x`（manual 优先）；新 helper `effectiveRoute(rc)`。
  - `admin-inland.ejs` 路线区每条：① 「重新抓取」(当前 provider) ；② 「人工覆盖」km/时长/途经（填了即 `source=manual`）；③ 「清除覆盖」。
  - 新/改路由：`/admin/inland/routes/refresh`（走 provider）、`/admin/inland/routes/:destId/override`、`/.../clear-override`。
  - `refreshOneInlandRoute` 改用 `getRoutingProvider().fetchRoute`。
- 前台/PDF 用 `effectiveRoute`（manual 优先）；无缓存/失败 → 留空"—"，不阻塞。

## 5. S5 时间里程进 PDF（batch1 已做，本批对齐 override）

- batch1 已加 `resolveQuoteRoute` + quote-document route-meta（携带中）。本批**仅改**：`resolveQuoteRoute` 取值改用 `effectiveRoute(rc)`（manual override 优先），其余不动。

---

## 6. 测试清单

- **S2**：`getVehiclePrice` 6 档；computeInlandCalculator——sencillo/full 数值**回归不变**、新档有价/无价(pendiente)、非法 serviceType 回退、null 安全；map-data maxByVehicle。
- **S3**：`normalizeImageUrls`（合法 http(s)/去重/cap/拒 `javascript:`、`data:`、`file:`）；admin 增删；前台渲染转义。
- **S4**：provider 选择（osrm 默认 / google 无 key 回退）；`effectiveRoute` manual 优先；OSRM 抓取回归；override 后 source=manual；清除 override 回 fetched。
- **S5**：PDF route 用 override 值。
- **全局**：`STORAGE_DRIVER=json npm test`（放单/清关/inland/quote 全绿）；`node scripts/quote-test.js`。

## 7. Blast radius（热文件）

| 文件 | 改动 | 影响 |
|---|---|---|
| `src/lib/inland-vehicles.js`(新) | 车型枚举/helper | 共享 |
| `src/lib/store.js` | rateEntry.vehiclePrices / dest.imageUrls / routeCache.manualOverride+source | `modules.inland` 形状（**附加、向后兼容**） |
| `src/lib/calculate.js` | computeInlandCalculator 6 档 | `/workbench/inland`、报价取数；**sencillo/full 数值不变** |
| `src/lib/inland-routes.js` | provider 抽象 | 路线抓取；OSRM 行为不变 |
| `src/server.js` | map-data maxByVehicle、admin 路由(车型/图片/override)、refresh 用 provider | `/workbench/inland`、`/admin/inland/*` |
| `public/inland-map.js`+`workbench-inland.ejs` | 6 档选择器、缩略图 | 前台面板 |
| `views/admin-inland.ejs` | 车型价/图片 URL/override 录入 | 后台 |
| `src/lib/i18n.js` | 车型名+图片+override 串 zh/es | 文案 |
| `views/quote-document.ejs`+`quote.js` | resolveQuoteRoute 用 effective | 对客 PDF（batch1 基础上微调） |
| **生产 `modules.inland`** | **零 prod 写**（新字段后台录入，post-deploy） | 见 K6 |

**不触碰**：放单/清关计算、quote 双价逻辑（batch1）、`data/users.json`、密钥；不 force push / 不直推 main。

## 8. 执行顺序（确认口径后）

S2 车型 → S3 照片 → S4 provider+override → S5 PDF 对齐 → 收尾(Task Summary + Post-task routing + LESSONS + 本批零 prod 写)。任一步验收不符 → 停下报告。

---

> **当前停在此（Step 1 完成）。请确认 §0 K1–K7（尤其 K1 西语车型名、K3 照片安全口径=无SSRF/防XSS、K7 是否授权先 commit batch1）。确认后我从 S2 开始。**

---

## 9. 实现备注 / 已知 by-design（Step 2–5 落地后补，2026-06-16）

- **F1（已修）**：`calculate.js` 的 `totalExplanation`/`noRateExplanation` 原用 `serviceType === "full" ? full : sencillo` 二元三元，新增 4 档车型会错误显示成"单拖"。已改为 6 档 → i18n key 映射（`vehicleLabel(t, type)`，复用 S2 车型 i18n）。
- **F2（已修）**：`buildInlandDestinationSeed()` 漏带 `imageUrls`，与 `normalizeInlandDestination`（补 `[]`）字段不一致。已加 `imageUrls: []`。
- **F3（by-design，记录不改）**：短驳费（burreo）按 `serviceType` 取值，仅单拖/双拖在 CSV 有数据；新增 4 档车型 `burreo[新车型]=undefined` → 短驳费按 0 计。这是**有意为之**（新车型暂无短驳数据）。**待 José 会议确认**：新车型短驳是沿用单/双拖档，还是各档独立；确认前新车型短驳=0。
