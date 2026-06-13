# 陆运模块交付说明 / Entrega del módulo Transporte (Inland)

日期：2026-06-13 · 状态：已上线生产 (en producción)

## 1. 模块已上线 / El módulo ya está en vivo

陆运 / **Transporte (Inland)** 已部署到生产环境，地址：

- 前台报价工作台 / Workbench: **`/workbench/inland`**
- 后台管理 / Admin: **`/admin/inland`**

### 怎么用 — 前台报价 / Cómo cotizar

1. 打开 `/workbench/inland`，地图以 **Manzanillo** 为起点，向各目的地放射出真实公路路线 / rutas reales。
2. **点地图上的路线或目的地点**，或用面板顶部的下拉框选目的地 / destino。
3. 右侧面板即时显示报价 / **cotización**：
   - 切换 **Sencillo / Full**（单程柜型）。
   - 调整柜数 / cantidad。
   - 切换 **IVA 16% / 0%**。
   - 显示大号总价 + 计算公式 + 取价的供应商 / proveedor。
   - 「全部报价 (n)」可展开看该目的地所有供应商条目。
4. 支持深链 / deep link：`/workbench/inland?dest=apodaca` 直接定位某目的地。

### 怎么用 — 后台管理 / Cómo administrar

在 `/admin/inland` 可以全量编辑：

- **目的地 / destinos**：名称、州、坐标、坐标来源、路线状态、启用/停用。
- **费率条目 / tarifas**：proveedor、Sencillo、Full、cliente、código CW、commodity、启用、备注 (note)，可增删行。
- **精确收货点 / puntos de entrega precisos**：见第 4 节（粘 Google Maps 链接解析具体厂区）。
- **路线刷新 / refrescar rutas**：单条或全量重新抓取公路路线缓存。

---

## 2. 三个需要 Jose 知道或确认的点 / Tres puntos a confirmar

### a) Morelos / Edomex 默认代表点 — 请确认或给更准位置

我们替你设了两个默认代表点 / puntos representativos por defecto：

| 目的地 | 默认代表点 | 坐标 (lat / lng) |
|---|---|---|
| **Morelos** | Cuernavaca / CIVAC | `18.835 / -99.178` |
| **Edomex** | Toluca | `19.2826 / -99.6557` |

⚠️ 墨西哥州 (Estado de México) 与 Morelos 的工业区分布很广 / muy dispersos，城市级代表点只是粗略落点。**建议**：用后台的「**精确收货点 / punto de entrega preciso**」功能（第 4 节），粘具体厂区的 Google Maps 链接来细化，而不是依赖城市级代表点。

👉 **请确认这两个默认点可接受，或提供更准确的位置 / Por favor confirma o envía ubicaciones más precisas。**

### b) GDL / Zapopan 走廊的 LTP 两档报价 — 已两档保留

供应商 **LTP** 在 Guadalajara / Zapopan 走廊存在 **两档报价 / dos tarifas**：

- 第一档：Sencillo **29,000** / Full **43,000**
- 第二档：Sencillo **43,000** / Full **66,000**

这两行除价格外没有区分字段 / sin campo distintivo，所以系统**两档都保留**了。注意：报价默认取**最高价**，所以 LTP 在该走廊会以 43,000/66,000 参与「最高价」竞争。

👉 若其中一档是**过期或误录 / caduca o errónea**，你可以在后台把那一行 **disable（停用）并加 note 说明**，报价就会自动只用保留的那一档。

### c) La Paz 路线含跨海轮渡 — 属正常 / Es normal

La Paz (BCS) 的公路路线包含 **跨海轮渡 / ferry (transbordador)**（Mazatlán→La Paz），全程约 **3,614 km / ~48 小时**。报价面板会标注「**含轮渡 / con ferry**」。

👉 这是**真实的公路 + 渡轮路径**，不是异常数据 / no es un error。

---

## 3. 费率口径说明 / Base de cálculo de tarifas

- **取价规则**：对某目的地，取**跨供应商的最高价 / precio máximo entre proveedores**。
- **Sencillo 与 Full 各自独立**取最高价（分别比较、分别标注来源供应商）。
- **币种固定 MXN**（pesos mexicanos）。
- **IVA 默认 16%**，面板可一键切到 **0%**。
- 总价 = 最高单价 × 柜数 / cantidad（再按 IVA 口径出税前/税后）。

> 注：陆运报价**不**走汇率换算（固定 MXN），也**不影响**放单 / Liberación 与清关 / Despacho 的计算。

---

## 4. 后台粘 Google Maps 链接 → 精确收货点 / Punto de entrega preciso

当城市级代表点不够准时，用这个功能把收货点细化到具体厂区 / fábrica：

1. 在 **Google Maps** 找到具体收货地点（厂区、仓库、码头等）。
2. **复制该地点的链接 / copiar enlace**（地点页的「分享 / Compartir」→ 复制链接；短链 `maps.app.goo.gl/...` 或长链均可）。
3. 进 `/admin/inland`，打开对应**目的地 / destino** 的详情，找到「**精确收货点 / puntos de entrega precisos**」。
4. **粘贴链接 / pegar enlace**，系统会解析出经纬度。
5. **预览图钉 / vista previa del pin**：在小地图上确认落点正确。
6. **保存 / guardar**。
7. **刷新路线 / refrescar ruta**：让该精确点重新生成公路路线缓存。

> 安全说明：链接解析只接受 Google Maps 域名，落点会校验是否在墨西哥范围内 / dentro de México；越界会告警。

---

## 5. 快速核对清单 / Checklist

- [ ] 确认 Morelos=Cuernavaca/CIVAC、Edomex=Toluca 两个默认代表点（或给更准位置）。
- [ ] 复核 GDL/Zapopan 的 LTP 两档（29,000/43,000 与 43,000/66,000）是否都现行有效。
- [ ] 知悉 La Paz 含轮渡属正常。
- [ ] 需要时用「精确收货点」把工业区目的地细化到厂区。
