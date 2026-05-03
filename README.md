# 物流成本操作台

本地原型，当前已经拆成三个业务界面：

- `换单 / Liberacion`
- `清关 / Despacho`
- `陆运 / Transporte`

其中：

- `换单` 已接完整计算逻辑
- `清关` 已接一页式计算逻辑，包含 `码头固定费 / 码头堆存费 / 落柜 / 清关堆场费`
- `陆运` 仍是独立占位模块，后续可直接扩展

## 当前能力

- 中 / 西语切换
- 黑白灰风格的前台 + 后台
- 所有登录账号当前都可进入前台和后台修改规则
- 汇率通过 Frankfurter API 拉取 `USD / MXN`
- 费用项支持按项设置币种和默认税率
- 前台支持按费用项临时覆盖税率
- `换单` 支持：
  - 船公司
  - BL 数量
  - 混装箱型与数量
  - demoras 天数
  - 押金
  - 税前 / 税后显示
  - 汇总币种
  - 连续业务：换单后可带上下文进入清关
- `清关` 支持：
  - 业务性质
  - 港口
  - 码头
  - 船公司
  - 场站
  - 混装箱型与数量
  - 天数
  - 税前 / 税后显示
  - 汇总币种
  - 费用拆分：
    - 码头固定费
    - 码头堆存费（阶梯累进）
    - 落柜
    - 清关堆场费

## 后台结构

- 模块设置页：
  - 默认币种
  - 默认显示口径
  - 税率预设
  - 汇率状态
- 换单规则页：
  - `cargos locales`
  - `garantia`
  - `demoras`
  - 发票限制
  - `corte de demoras`
  - 支持按箱型新增 / 删除阶梯
- 清关规则页：
  - 船公司与场站映射
  - 港口与码头规则
  - 码头固定费
  - 码头堆存费阶梯
  - 场站落柜费
  - 场站清关费
  - 支持按码头 + 箱型新增 / 删除阶梯

## 业务文档

详细业务口径见：

- [docs/business-process.md](</Users/yuanzhehe/Desktop/Cursor Project/Jose Expressline Consulting/docs/business-process.md>)

## 启动

```bash
npm install
npm run dev
npm test
```

如果要重新从 Excel 生成换单基础数据：

```bash
npm run build:data
```

默认地址：

```text
http://localhost:3000
```

如果 `3000` 被占用：

```bash
PORT=3101 npm run dev
```

## 演示账号

- `admin / admin123`
- `sales / sales123`
- `pricing / pricing123`

## 数据结构

- Excel 会被抽取到 `data/shipping-lines.json`
- 当前数据按模块分区保存：
  - `handover`
  - `customs`
  - `inland`
- 后台保存会直接写回 `data/shipping-lines.json`

## 当前边界

- 持久化仍是本地 JSON，不是数据库
- 账号密码仍是本地演示结构，不适合直接上线
- `build:data` 现在会保留已有的清关 / 陆运模块配置和汇率结构，但仍建议先备份数据再重抽 Excel
