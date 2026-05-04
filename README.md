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
- 当前临时关闭登录入口，所有访问者都可进入前台和后台修改规则
- 汇率通过公开 API 拉取 `USD / MXN`：Frankfurter v2 主源，ExchangeRate-API Open Access 备用源
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

如果要校验并规范化当前应用数据：

```bash
npm run build:data
```

当前系统不再把 Excel 当作数据源。`build:data` 只读取并规范化应用自己的数据文件，不会读取任何 Excel。

如果要手动强制刷新汇率：

```bash
npm run fx:refresh
```

服务启动后会按 `America/Mexico_City` 时间每天 `00:00` 自动刷新一次汇率；也可以通过后台“立即刷新汇率”按钮手动刷新。

如果需要生成 Excel 批量上传模板：

```bash
npm run templates:excel
```

模板输出到：

```text
templates/bulk-upload/express-line-bulk-upload-template.xlsx
```

模板只用于后台批量上传，不作为系统启动、计算或构建的数据来源。设计说明见 [docs/bulk-upload-design.md](</Users/yuanzhehe/Desktop/Cursor Project/Jose Expressline Consulting/docs/bulk-upload-design.md>)。

默认地址：

```text
http://localhost:3000
```

如果 `3000` 被占用：

```bash
PORT=3101 npm run dev
```

## Railway 部署

当前项目可以从 GitHub 部署到 Railway。Railway 会读取 `package.json`，安装依赖，并通过 `npm start` 启动服务。

建议在 Railway 里配置：

- `SESSION_SECRET`: 一段足够长的随机字符串
- `DATABASE_URL`: Supabase Postgres 的 Session pooler connection string
- `DATABASE_SCHEMA`: `expressline`
- `FX_REFRESH_TIME_ZONE`: 可选，默认 `America/Mexico_City`
- `FX_REFRESH_HOUR`: 可选，默认 `0`
- `FX_REFRESH_MINUTE`: 可选，默认 `0`

完整环境变量说明和 Supabase / AI key 获取步骤见 [`docs/env-setup.md`](docs/env-setup.md)。

当前代码已支持 Supabase Postgres。数据库迁移前可以继续使用 JSON fallback；如果暂时不用数据库，Railway 上需要给服务添加 Volume，并把 Volume mount path 设置为：

```text
/app/runtime-data
```

首次启动时，如果 Volume 目录为空，系统会从仓库内的 `data` 种子文件初始化 `shipping-lines.json` 和 `users.json`。

数据库部署命令：

```bash
npm run db:migrate
npm run db:seed
npm run db:check
```

## 访问权限

当前临时关闭登录入口，打开站点后会直接进入换单页面。所有访问者都有前台和后台的完整修改权限。

## 数据结构

- 当前原型的数据源是应用自己的 `data/shipping-lines.json`
- 当前数据按模块分区保存：
  - `handover`
  - `customs`
  - `inland`
- 后台保存会直接写回 `data/shipping-lines.json`
- Excel 只作为批量上传模板，不作为数据源

## 当前边界

- 持久化仍是本地 JSON，不是数据库
- 登录和权限分层暂时关闭，不适合直接正式上线
- `build:data` 只做应用数据规范化；正式上线前建议迁移到数据库，并为批量上传增加 dry-run、差异预览和审计日志
