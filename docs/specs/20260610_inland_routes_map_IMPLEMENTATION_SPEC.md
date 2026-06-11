# 陆运 (inland) 模块实现方案 — 真实路线地图 + 即时报价 + 精确地址

状态: 实现中
日期: 2026-06-10
分支: feature/inland-routes-map (从 main 切出, 不直推 main, 完成开 PR)

## 0. 目标

把预留的陆运/Transporte 模块落地为: 地图工作台 (Manzanillo 放射到目的地的真实公路路线) +
点击即报价 (跨供应商取最高价) + 精确地址 (后台粘贴 Google Maps 链接解析为精确收货点)。

数据源是 `TARIFARIO_TERRESTRES_TARIFAS_RUTAS_2026_.csv` (Latin-1, 248 行)。
铁律: Excel/CSV 只是录入物, 不是运行时数据源 (docs/bulk-upload-design.md); 一切写入经 store 层,
JSON 与 Postgres 两驱动都要工作。

## 1. 已锁定产品决策 (不再发问)

见任务 plan 第 1 节。要点: Sencillo/Full 各自独立取跨供应商最高价并标供应商; 固定 MXN, IVA 默认
16% 可切 0%; 合并目的地按规则拆分 (~43 目的地, ~300 费率条目); VIGENCIA 整列忽略;
MANANILLO→MANZANILLO; 缺 FULL 存 null; 一条走廊一条线, 多条目面板分层。

## 2. 环境确认 (Step 0 结论)

- 持久化: `shouldUseDatabase()` (db.js) — DATABASE_URL 在则 Postgres (expressline.app_state,
  key `shipping-data`), 否则 JSON (data/shipping-lines.json)。
- store 整体读写: getShippingData / saveShippingData 读写整个 shippingData 对象并 normalize;
  改 inland = load → 改 `modules.inland` → save。两驱动自动生效。
- normalizeModules 当前给 inland 用 normalizeGenericModuleData (空壳), 需换成 normalizeInlandModuleData。
- admin 分发: renderAdminRules 按 moduleKey 选视图 (customs→admin-customs, 其余→admin-module);
  新增 inland→admin-inland 分支。
- 不对生产跑 db:seed; seed 脚本默认本地 JSON, 生产需双确认参数。

## 3. 数据模型 (modules.inland)

```jsonc
"inland": {
  "settings": { "defaultQuoteCurrency": "MXN", "defaultPriceMode": "pretax" },
  "taxRatePresets": [ { "id","label","rate" } ],   // 沿用 0% / 16%
  "origins": [ { "id":"manzanillo","name":"Manzanillo","lat","lng" } ],
  "destinations": [ {
    "id","name","state","lat","lng",
    "coordSource": "seed-catalog|gmaps-link|manual",
    "needsReview": false,
    "precisePoints": [ { "id","name","lat","lng","note","source","link" } ],
    "enabled": true, "note": ""
  } ],
  "rateEntries": [ {
    "id","originId","destinationId","proveedor",
    "sencillo": number|null, "full": number|null, "currency":"MXN",
    "cliente","codigoCw","commodity","enabled":true,"note":"",
    "extras": { /* CSV 其余列原样, v1 不计算, 后台只读 */ }
  } ],
  "routeCache": [ {
    "id","originId","destinationId",
    "targetType":"destination|precisePoint","targetId":null,
    "encodedPolyline","distanceKm","durationMin",
    "viaCities":[],"engine":"osrm","fetchedAt","stale":false,"hasFerry":false
  } ]
}
```

派生值 (不落库): 每目的地 maxSencillo/maxFull + 对应供应商 + 条目数 (计算函数输出)。

normalize 规则 (store.js normalizeInlandModuleData):
- origins/destinations/rateEntries/routeCache 缺失给默认空数组 + 种子目录 (附录 B 的 43 目的地)。
- destination 缺坐标 → 用种子目录补; coordSource 默认 seed-catalog。
- rateEntries 金额非数字 → null; currency 固定 MXN。
- routeCache 与目的地/精确点坐标不一致检测在抓取脚本处理 (stale 标记)。
- 与 customs 一样用版本号 gate 一次性种子 (inlandSeedVersion), 之后保留用户编辑。

## 4. CSV 清洗 + seed (scripts/seed-inland-from-csv.js, npm: inland:seed)

- 入参 CSV 路径; Latin-1→UTF-8; 表头/单元格 trim。
- 金额 " $72,000.00 "→72000; 空/不可解析→null。
- ORIGEN: MANANILLO→MANZANILLO, 全部映射 origin manzanillo。
- DESTINO: 按附录 B 映射 id/名/坐标; 命中拆分规则一行爆多条:
  LEON/SILAO/IRAPUATO→León+Silao+Irapuato; CDMX EDOMEX→CDMX+Edomex;
  JALISCO/GUADALAJARA/ZAPOPAN 行并入既有 Guadalajara+Zapopan。
- VIGENCIA 丢弃; SENCILLO/FULL/PROVEEDOR/CONSIGNATARIO(→cliente)/CODIGO CW/COMODITY 入字段;
  其余列打包 extras。
- 幂等: 按 (destinationId, proveedor, cliente, commodity) 去重更新。
- 报告 (stdout + docs/specs 旁文件): 目的地数/条目数/被拆分行/null FULL 行/needsReview 清单。
- 默认只写本地 JSON; --target=production --confirm-production 才经 store 写 Supabase, 写前打印 diff。

## 5. 路线抓取与缓存 (src/lib/inland-routes.js, npm: inland:routes)

- OSRM: {OSRM_BASE_URL}/route/v1/driving/{olng},{olat};{dlng},{dlat}?overview=full&geometries=polyline。
  OSRM_BASE_URL 默认 https://router.project-osrm.org, 失败降级 routing.openstreetmap.de/routed-car。
  User-Agent 头; 串行; 间隔≥1.2s; 失败重试 2 次退避。
- 存 routeCache: encodedPolyline/distanceKm/durationMin/viaCities/fetchedAt/hasFerry。
- viaCities: 解码 polyline → 对附录 D 城市目录 (src/lib/inland-cities.js) 求点到折线最近距离
  (等矩近似 + cos 纬度校正) → <12km 命中 → 沿线排序 → 去起终点 → 最多 6。阈值/上限常量。
- 坐标变更 → 对应缓存 stale:true; 地图降饱和提示待刷新。
- La Paz 含轮渡: OSRM steps 有 ferry 或时长异常 → hasFerry:true, 面板标"含轮渡"。
- 前端内联 ~20 行 polyline decoder (precision 5), 不引第三方。
- OSRM 不可达前台兜底: 起终点大圆弧虚线 + "路线未缓存", 不阻塞报价。

## 6. 计算引擎 (src/lib/calculate.js computeInlandCalculator)

- 入参 { destinationId, serviceType:"sencillo"|"full", quantity, taxRateOverride?, priceMode, quoteCurrency:"MXN" }。
- 取该目的地 enabled 条目中 serviceType 的最高单价及供应商; rate×quantity 小计; 税前/税后;
  formula 字符串 + 解释 + 明细, 形状对齐 handover/customs 结果 (复用前台部件)。
- serviceType 无有效报价 → noRate 状态 (前台显示"该目的地无 Full 报价")。
- 同时返回全部条目 (供应商/sencillo/full/cliente/commodity) 供面板展开。
- modules.js: inland.implemented=true。

## 7. 前台地图工作台 (views/workbench-inland.ejs + public/inland-map.js + styles + i18n)

- MapLibre GL JS (CDN 锁版本) + OpenFreeMap positron/dark 跟随明暗主题; 保留 attribution。
- 图层: 缓存路线 GeoJSON (casing+主线); 目的地点+标签 (名 + MAX $); Manzanillo 脉冲起点;
  hover 高亮 tooltip; 点击 fitBounds + 其余降饱和 + 选中线动画虚线流动 + viaCities 沿线小标签。
- 右侧报价面板 (移动端底部抽屉): 目的地名; 途经 A→B→C · km · ≈h; Sencillo/Full 切换; 柜数步进;
  IVA 0/16; 大号总价 + 公式 + 最高价供应商; "全部报价(n)"展开表 (客户条目带标签);
  精确收货点 chips (选中→终点偏移/切换几何, 无缓存提示去后台刷新)。
- 面板顶部 <select> 选目的地 (与地图双向同步); 支持 ?dest= 深链。
- i18n 新增 inland.* (zh/es 双语); 黑白灰风格; 局部刷新不整页提交。

## 8. 后台 (全量编辑, admin-inland.ejs + /admin/inland/*)

A. 目的地与地址: 目的地表 (名/州/坐标/坐标源/路线状态/条目数/enabled, 增删改禁用);
   详情: 粘贴 Google Maps 链接或坐标 → 解析 → 小地图预览 → 保存; 精确收货点 CRUD; 路线刷新按钮 + 全量刷新。
B. 路线费率: 按目的地分组的条目表全字段可编辑 (proveedor/sencillo/full/cliente/codigoCw/commodity/enabled/note);
   extras 只读折叠; 实时显示该目的地 max S/F + 来源供应商; 增删行。
C. 批量上传: 扩展 generate_bulk_upload_templates.py 新增 sheets inland_destinations / inland_rate_entries /
   inland_precise_points; 流程按 bulk-upload-design (解析→dry-run→差异预览→确认→审计)。

端点:
- POST /admin/inland/resolve-link → { lat, lng, name?, normalizedLink } (附录 C, 含 SSRF 防护)。
- POST /admin/inland/routes/refresh (destinationId/precisePointId 或 all)。
- POST /admin/inland/destinations(/add /:id/save /:id/delete), precise-points, rate-entries CRUD。
- 模块设置页复用 admin-settings (币种/税率预设/价格口径)。

## 9. 链接解析 (附录 C, src/lib/inland-link-resolver.js)

优先级: 短链跟随重定向 (≤5 跳, 5s, 无 cookie, 仅 google.* /maps); 长链 !3d!4d → @lat,lng →
?q/query/ll → /dir 终点; 裸 lat,lng; /place/NAME 预填名。校验 lat∈[14,33] lng∈[-118,-86]
越界告警可强存。安全: 域名白名单, 不跟任意域, 体积/超时限制, 不日志完整请求头。

## 10. 测试 (scripts/smoke-test.js, 保持 npm test 一条命令)

- CSV 清洗: 金额解析; MANANILLO 修正; 三拆分各一例; null FULL; 幂等去重 (用合成 fixture)。
- 计算引擎: 跨供应商 max; S/F 独立; quantity; 税前后; noRate。
- 链接解析: !3d!4d / @ / q / 裸 / 短链 mock / bbox 外告警 / 非 google 拒绝。
- viaCities: 固定 polyline 断言命中/排序/上限。
- routeCache schema 进 build:data 规范化。
- i18n zh/es 键完整性。
- 回归: 放单/清关计算不受影响。
- 手动浏览器核对清单 (见末)。

## 11. Blast radius

- 页面: 新增 /workbench/inland, /admin/inland/*; 模块导航 (inland 变 Live)。
- 端点: 上述 /admin/inland/* 新端点; GET /workbench/inland (POST 计算)。
- 数据模型: modules.inland 结构替换 (origins/destinations/rateEntries/routeCache)。
- 测试: smoke-test 扩展。
- 热点文件: src/server.js, src/lib/store.js, src/lib/calculate.js, src/lib/modules.js,
  public/styles.css, src/lib/i18n.js, data/shipping-lines.json, views/*。
- 不动: 放单/清关计算; 汇率机制 (本模块固定 MXN)。

## 12. 与既有约定一致性自检

- 模块结构: 沿用 modules.js + getModuleData + renderWorkbench/renderAdminRules 分发 (新增 inland 分支), 不新开模块。OK
- i18n: 复用 t() 嵌套键, zh/es 双语同步, inland.* 命名空间 (title/subtitle 已存在)。OK
- bulk-upload: 扩展现有模板/流程, 不把 CSV 当运行时源。OK
- 持久化: 只经 store 层, JSON+Postgres 双驱动。OK
- 风格: 黑白灰 + 局部刷新 + 紧凑工作台 (BRAND_NOTES / UX_REVIEW_NOTES)。OK

## 13. 手动浏览器核对清单

明暗主题底图切换; 点击选中与面板联动; 移动端抽屉; 后台粘贴链接→预览→保存→刷新路线全链路;
?dest= 深链; OSRM 不可达兜底弧线。

## 14. 待 Jose 口头确认 (已给安全默认, 不阻塞)

- MORELOS → Cuernavaca/CIVAC 代表点 + needsReview。
- EDOMEX 拆出 → Toluca 代表点 + needsReview。

## 15. 已知缺口

- 实际 CSV 当前不在仓库; 目的地种子来自附录 B; 费率用合成 fixture 测试 + 少量示例种子;
  真 CSV 由 `npm run inland:seed <csv>` 灌入。
