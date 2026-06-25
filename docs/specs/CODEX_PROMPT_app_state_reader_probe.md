# CC PROMPT — 查清谁在用 PostgREST 读 `app_state`（14 次/天，只读）

> 背景：切到 relational 后，`app_state` blob 已冻结。`pg_stat_statements` 顶部有一条 PostgREST `select * from app_state`，~14 次/天（健康检查 round 已记，见 `docs/LESSONS.md` 2026-06-24「Supabase health check」条 + `docs/specs/CODEX_PROMPT_SUPABASE_HEALTHCHECK.md`）。
> **已知（Claude 本地已查证，不必重做）**：
> - Jose Expressline app **不**用 supabase-js/PostgREST，只用 `pg` 池（`src/lib/db.js`），从不发 `select * from app_state` → **不是 app 发的**。
> - 同租户：`pang uñas/nail-erp-mvp` 与本 PROD **同一个 Supabase project**（ref `polxyashvxbzdkkmxuox`），但只用 anon key 读自己的 ERP 表，**从不碰 `app_state`** → 不是来源，但确是同项目第二个租户。
> - 最可能：你/Estefani 在切换+排障期用 Supabase Dashboard 的 Table/SQL Editor 打开 `app_state` 浏览冻结 blob（无害但读到陈旧数据）。
>
> **铁律**：全程**只读**，不写任何库/任何项目；不碰 joyas/punas 数据；不打全量 blob（测量本身别造 egress——只看日志/聚合元数据）。

## 任务（只读）

1. **Supabase Dashboard → Logs（API Edge / PostgREST / Logs Explorer）**：过去 24–72h，过滤 path 含 `app_state`（形如 `/rest/v1/app_state?select=*`）。对每条请求取：
   - 身份：apikey 解出的 role —— `anon` vs `service_role`（dashboard 自身请求通常 service_role/带 dashboard 标识）。
   - user-agent：Supabase dashboard（浏览器 UA / `supabase-dashboard`）vs `supabase-js/<ver> node` vs curl/脚本。
   - 来源 IP：你的住宅/办公 IP（=你在点）vs 服务器/云 IP（=集成）。
   - 时间节奏：聚在你工作时段（=人工浏览）vs 全天均匀每 ~1–2h（=定时任务）。
2. **交叉印证**：Dashboard → Reports（Database/API）看 ~14 req/天到 `app_state` 与 egress 曲线是否吻合；SQL Editor 只读查 `pg_stat_statements`：`select query, calls, rows from pg_stat_statements where query ilike '%app_state%' order by calls desc;`（只读；只给次数，不分 REST/直连）。
3. **顺带确认**（同项目隔离）：日志里 `pang uñas` 的 anon 流量只命中它自己的表、不碰 `app_state`。
4. **若指向某个 saved SQL query 含 `select * from app_state`**：它现在读的是冻结陈旧 blob —— 标记应指到 relational 表或删除。

## 判定规则（写进报告）

- dashboard/service_role + 你的 IP + 工作时段节奏 → **无害**：只是你在看冻结 blob，无需动作（要清零就别再点那张表）。
- anon 或存储的 service_role key + 云端 IP + 全天均匀 → **外部集成在读冻结/陈旧 blob**：按 UA/IP 定位它，然后**指到新源（relational 实体表 / app 的 assembled 读）或退役**；在指好之前其读到的数据按「陈旧」处理。

## 完成（交 Claude / Chandler）
- 报告：14 次读的身份/UA/IP/节奏证据 + 结论（无害 dashboard 浏览 / 还有外部集成）+ 若有集成给出处置建议。
- 确认全程只读、未写任何项目、joyas/punas/pang uñas 数据零接触。
- 结尾附 `Post-task routing` 块。
