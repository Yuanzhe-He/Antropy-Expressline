# 任务:陆运 (inland) 收尾 — 数据还原 + 编码加固 + 真实费率灌入 + 路线缓存 + QA + 更新 PR

仓库:当前目录(Jose Expressline Consulting)。分支:`feature/inland-routes-map`(已有 10 个 commit,PR #1 已开)。
全程零人工:所有步骤由你执行;任何验收不符就停下报告,不要继续、不要猜。

## Step 0 — 规则与分支
1. 读 `AGENTS.md`、`docs/AI_AGENT_PROJECT_RULES.md`、`.ai/PROJECT_SCALE_OVERRIDES.md`、`docs/specs/20260610_inland_routes_map_IMPLEMENTATION_SPEC.md`。
2. `git status` 必须干净;`git fetch && git checkout feature/inland-routes-map && git pull --ff-only origin feature/inland-routes-map`。ff 失败或工作区不干净 → 停止报告。禁止 force push、禁止改 git 配置。

## Step 1 — 还原真实 tarifario(Latin-1 原件)
`data/source/tarifario-terrestres-2026.csv.gz.b64` 是 248 行真实费率 CSV 的 gzip+base64(由 Claude 经 Filesystem 写入,保留原始 Latin-1 编码)。

```bash
openssl base64 -d -A -in data/source/tarifario-terrestres-2026.csv.gz.b64 -out /tmp/tarifario.gz
gunzip -c /tmp/tarifario.gz > data/source/tarifario-terrestres-2026.csv
md5 -q data/source/tarifario-terrestres-2026.csv   # Linux 用 md5sum
wc -c data/source/tarifario-terrestres-2026.csv
wc -l data/source/tarifario-terrestres-2026.csv
```

验收(全部必须一致):MD5 `6d9bb4a4e159182881fd69c87fe4dcad`;71020 字节;249 行(含表头)。通过后删除 `.b64` 文件;CSV 保留入库作 provenance(私有仓库,与 data/shipping-lines.json 同等对待)。**不要用任何编辑器/Excel 打开后保存,会破坏编码。**

## Step 2 — seed 编码自动检测(加固)
背景:`scripts/seed-inland-from-csv.js` 硬编码 latin1 读取;`inland-catalog.js` 的 `normalizeDestinoKey` 不折叠重音,目录键含 `CIUDAD ACUÑA COAH`。未来 Jose 团队从 Excel 重导出的编码不可控(UTF-8/CP1252 随机),latin1 误读 UTF-8 会让 Ñ 行 mojibake 被跳过。
改法:文件读为 Buffer;先严格 UTF-8 解码(`new TextDecoder("utf-8", { fatal: true })`),失败回退 latin1;去 BOM。逻辑作为 `decodeCsvBuffer` 放进 `src/lib/inland-csv.js` 并导出,seed 脚本改用它。
测试:smoke 加用例——同一含 `CIUDAD ACUÑA COAH` 的行分别按 latin1 字节与 utf8 字节构造 Buffer 喂入,均解析到 `ciudad-acuna`。

## Step 3 — 灌入真实费率(本地 JSON,绝不碰 Supabase)
```bash
npm run inland:seed -- data/source/tarifario-terrestres-2026.csv
```
验收(`docs/specs/20260610_inland_seed_report.md` 必须逐项一致):rows **248** / entries **300** / destinations **43** / split rows **39** / null FULL **2** / unmapped **(none)**。
最高价抽查(任一不符 = 解析或编码出错,停止):apodaca S 72,000 F 93,500;la-paz S 207,900 F 273,000;guadalajara S 43,000 F 66,000;ciudad-acuna S 110,000 F 165,000。
确认 Codex 留的 12 条演示费率被幂等合并或清理,不残留假数据(检查 rateEntries 总数最终为 300,如有演示残留先清除再 seed)。

## Step 4 — 路线缓存
```bash
node scripts/refresh-inland-routes.js
```
验收:43/43 目的地有缓存(失败的重试后仍失败 → 列清单继续,不阻塞);`la-paz` 带轮渡标记;长途路线 viaCities 非空。

## Step 5 — 回归
`npm test` 全绿;`npm run build:data` 正常。

## Step 6 — 浏览器 QA(尽力而为,失败降级不阻塞)
Playwright(`npx playwright install chromium`;MapLibre 需 WebGL,canvas 空白时加 launch 参数 `--enable-unsafe-swiftshader` 或 `--use-gl=angle`)对 dev server 截图:
1. `/workbench/inland` 亮、暗主题各一张(全部路线已渲染,canvas 非空白);
2. `/workbench/inland?dest=apodaca`:Sencillo、柜数 2 → 面板显示总价 **$144,000 MXN 税前**、供应商 MAMUT、全部报价 13 条;
3. `/admin/inland` 列表页一张。
截图存 `docs/specs/qa-20260611/`。Playwright 装不上 → 降级 curl 冒烟(页面 200 + 报价接口对 apodaca/sencillo/2 返回 144000)并在 PR 注明待人工目检。

## Step 7 — 提交与 PR
Commit 拆分:(1) 编码自动检测+测试;(2) 真实数据(source CSV + shipping-lines.json inland 段 + seed report);(3) 路线缓存;(4) QA 产物。只动 inland 段,diff 不得波及 handover/customs 数据。
Push 分支(禁 force)。用 `gh pr comment 1 --body-file <(...)` 或编辑 PR 描述补充:验收数字、QA 结果与截图路径、needsReview 待 Jose 确认(morelos=Cuernavaca/CIVAC、edomex=Toluca 代表点)、生产灌库说明(合并部署后另行执行 `npm run inland:seed -- <csv> --target=production --confirm-production`,本任务不执行)。`gh` 不可用则把同样内容写入 `docs/specs/20260611_inland_finalize_PR_NOTES.md` 一并提交。

## 约束
不改放单/清关行为;不打印任何 secrets/DATABASE_URL;Excel/CSV 仍非运行时数据源(本 CSV 仅 seed 输入);不对生产跑任何写操作。
收尾按项目规则输出 Task Summary(含 blast radius)与完整 `## Post-task routing` 块;编码自动检测的经验写入 `docs/LESSONS.md`。
