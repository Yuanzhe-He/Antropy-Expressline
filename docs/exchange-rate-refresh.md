# 汇率刷新机制记录

记录日期：2026-05-04

## 目的

系统里的费用可以配置为 USD 或 MXN，因此报价计算需要稳定的 `USD / MXN` 汇率。汇率用于把不同币种费用统一换算到前台选择的汇总币种。

## 这次问题

后台曾显示 `2026-04-30` 的汇率日期，不是因为报价计算逻辑错误，而是因为旧接口返回的数据日期仍停留在 `2026-04-30`。系统当天已经记录过 `lastCheckedAt`，所以不会在同一天重复拉取，导致页面继续显示旧的汇率日期。

修复方向：

- 主源从 Frankfurter v1 改成 Frankfurter v2。
- 增加 ExchangeRate-API Open Access 作为备用源。
- 增加服务启动后的每日自动刷新。
- 增加 `npm run fx:refresh` 手动刷新命令。

## 当前数据源

主源：

- Provider: Frankfurter
- Docs: `https://frankfurter.dev/`
- Endpoint: `https://api.frankfurter.dev/v2/rates?base=USD&quotes=MXN`
- 特点：无 API key，公开接口，文档说明跟踪多家央行每日汇率。

备用源：

- Provider: ExchangeRate-API Open Access
- Docs: `https://www.exchangerate-api.com/docs/free`
- Endpoint: `https://open.er-api.com/v6/latest/USD`
- 特点：无 API key，每日更新，有限流和 attribution 要求。

如果 Frankfurter 请求失败或返回格式不含 `USD / MXN`，系统会自动尝试备用源。

## 自动刷新

服务启动时会开启一个内部定时器：

- 默认时区：`America/Mexico_City`
- 默认时间：每天 `00:00`
- 默认行为：强制刷新 USD/MXN，并保存到当前存储层

对应代码：

- `src/lib/exchange-rate-scheduler.js`
- `src/server.js`

可选环境变量：

```env
FX_REFRESH_TIME_ZONE=America/Mexico_City
FX_REFRESH_HOUR=0
FX_REFRESH_MINUTE=0
```

这三个变量不填也可以，系统会使用上面的默认值。

生产环境不要配置：

```env
SKIP_FX_REFRESH=1
```

这个变量只适合测试环境。配置后，自动汇率刷新会关闭。

## 手动刷新

本机或 Railway shell 可以执行：

```bash
npm run fx:refresh
```

成功时会输出类似：

```text
fx-refresh-ok provider=Frankfurter asOf=2026-05-04 USD/MXN=17.5053
```

后台也保留了“立即刷新汇率”按钮，适合运营人员在页面上手动刷新。

## 当前验证结果

2026-05-04 已手动刷新成功：

```text
provider=Frankfurter
asOfDate=2026-05-04
USD/MXN=17.5053
lastError=null
```

后台设置页已确认显示：

```text
汇率日期: 2026-05-04
USD -> MXN: 17.5053
```

## 测试清单

修改汇率逻辑后至少跑：

```bash
npm test
npm run build:data
npm run db:check
npm run fx:refresh
```

如果改了汇率相关 JS 文件，也跑：

```bash
node --check src/lib/exchange-rates.js
node --check src/lib/exchange-rate-scheduler.js
node --check scripts/refresh-exchange-rates.js
```

页面验证：

- 打开后台设置页。
- 检查 provider 是否为 `Frankfurter` 或备用源名称。
- 检查 `汇率日期` 是否合理。
- 检查 `USD -> MXN` 和 `MXN -> USD` 是否同时存在。
- 点击“立即刷新汇率”，确认页面刷新后没有 `lastError`。

## Railway 注意事项

Railway 上运行的是 Express 长驻服务，所以内部 `setTimeout` 定时器可以工作。只要 service 正常运行，到每天墨西哥城时间 `00:00` 会自动刷新。

Railway 必要变量仍然是：

```env
NODE_ENV=production
SESSION_SECRET=...
DATABASE_URL=...
DATABASE_SCHEMA=expressline
```

汇率刷新变量是可选项：

```env
FX_REFRESH_TIME_ZONE=America/Mexico_City
FX_REFRESH_HOUR=0
FX_REFRESH_MINUTE=0
```

不要把真实数据库密码、Supabase service key、OpenAI key 写入文档或提交到 GitHub。

## 后续可选优化

- 如果客户要求墨西哥官方 FIX 口径，可以接 Banxico SIE API，但通常需要 Banxico token。
- 如果要更强的可审计性，可以把每次刷新记录写入 `audit_logs`，包括 provider、as-of date、rate、success/failure。
- 如果要更严格的生产监控，可以增加汇率过期告警，例如超过 2 天未更新就在后台显示红色提示。
