# 环境变量配置指南

本项目的目标架构是：

```text
GitHub 保存代码
Railway 运行 Express 网站
Supabase 提供 Postgres 数据库
```

真实密钥只放在 Railway Variables 或本机未提交的 `.env` 文件里。不要把真实值写进 GitHub。

## 生产必须配置

使用 Supabase Postgres 时，Railway 上需要：

```env
NODE_ENV=production
SESSION_SECRET=replace-with-a-long-random-secret
DATABASE_URL=postgresql://postgres.<project-ref>:<database-password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true
DATABASE_SCHEMA=expressline
FX_REFRESH_TIME_ZONE=America/Mexico_City
FX_REFRESH_HOUR=0
FX_REFRESH_MINUTE=0
```

`PORT` 不需要手动设置，Railway 会自动提供。

`FX_REFRESH_*` 可以不填；不填时默认按墨西哥城时间每天 `00:00` 自动刷新一次 USD/MXN。

`SKIP_FX_REFRESH=1` 只适合测试时临时使用，生产不要配置，否则汇率不会自动刷新。

如果暂时不用数据库，或需要临时强制使用 JSON fallback，可以设置：

```env
DATA_DIR=/app/runtime-data
STORAGE_DRIVER=json
```

生产连接数据库时不要设置 `STORAGE_DRIVER=json`。

## 数据库初始化

数据库启用后，`DATA_DIR` 和 Railway Volume 可以移除。

`DATABASE_SCHEMA=expressline` 用于把本项目和同一个 Supabase 数据库里的其他项目隔离开。本项目只会创建和读写 `expressline.*`，不会改 `public.joyas_*`。

数据库初始化命令：

```bash
npm run db:migrate
npm run db:seed
npm run db:check
```

`db:seed` 会把当前仓库里的 `data/shipping-lines.json` 和 `data/users.json` 写入 `expressline.app_state`。上线后不要随便重复 seed，否则会用仓库里的种子数据覆盖线上配置。

## 未来 AI 审票功能可能需要

如果系统要读取发票、提单、PDF、图片并自动核价，需要按实际供应商选择：

```env
OPENAI_API_KEY=replace-with-openai-api-key
```

或：

```env
OPENROUTER_API_KEY=replace-with-openrouter-api-key
```

如果需要把发票文件存到 Supabase Storage，后端还需要：

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_KEY=replace-with-supabase-service-role-or-secret-key
```

`SUPABASE_SERVICE_KEY` 只能放服务端环境变量，不能给浏览器使用。

## 获取 SESSION_SECRET

在本机终端运行：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

复制输出结果，填到 Railway 的 `SESSION_SECRET`。

## 获取 DATABASE_URL

1. 打开 Supabase Dashboard。
2. 进入你的 project。
3. 点击顶部或侧边的 `Connect`。
4. 选择 `Connection string`。
5. 选择 `Session pooler`。
6. 复制 Postgres URI。
7. 把 `[YOUR-PASSWORD]` 替换成你的 database password。
8. 确认末尾包含 `sslmode=require&uselibpqcompat=true`；如果没有，就加上 `?sslmode=require&uselibpqcompat=true`。

建议使用 `Session pooler`，因为本项目部署在 Railway 上，是长期运行的 Express 服务，不是 serverless function。

## 获取 SUPABASE_URL

只有使用 Supabase SDK、Storage、Auth 或 Admin API 时才需要。

1. 打开 Supabase Dashboard。
2. 进入你的 project。
3. 打开 `Project Settings`。
4. 进入 `API`。
5. 复制 `Project URL`。
6. 填到 `SUPABASE_URL`。

## 获取 SUPABASE_SERVICE_KEY

只有后端需要管理私有文件、绕过 RLS 做后台任务时才需要。

1. 打开 Supabase Dashboard。
2. 进入你的 project。
3. 打开 `Project Settings`。
4. 进入 `API`。
5. 找到 `service_role` 或 `secret` key。
6. 复制到 Railway 的 `SUPABASE_SERVICE_KEY`。
7. 在 Railway 里把这个变量 Seal，避免以后在 UI 或 API 中被读出。

如果这个 key 曾经在截图、聊天、GitHub、日志里出现过，应立即在 Supabase 里 rotate。

## 在 Railway 填变量

1. 打开 Railway Dashboard。
2. 进入项目。
3. 选择运行 Express 网站的 service，不是数据库 service。
4. 打开 `Variables`。
5. 点 `New Variable` 逐个添加，或点 `RAW Editor` 一次性粘贴。
6. 保存后 Railway 会重新部署。
7. 对 `DATABASE_URL`、`SESSION_SECRET`、`SUPABASE_SERVICE_KEY`、AI API key 使用 Seal。

Railway 会扫描仓库根目录的 `.env.example`，并提示可以导入这些变量名。但真实值仍然要你手动填。
