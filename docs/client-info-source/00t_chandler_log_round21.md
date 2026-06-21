# 00t — 第N+21轮（执行：掐FX写风暴源头 + 全面检测上线）

> 00s 续篇。最新轮次。分支 feature/fx-storm-and-audit（PR#14 已合并部署 main=ffa0429）。

## 2026-06-21 第N+21轮 — CC执行 round20 的 prompt

### A — FX写风暴源头查掐 ✅
**A1 定位真凶（本地+生产实测）**：
- 量化：生产每~2秒写一次 app_state（**~47520/天**，比之前估的2.8万还高）。
- 每次写**只改 exchangeRates.lastCheckedAt**（rates不变、lastError=null）→ = **成功的强制刷新**。
- `needsExchangeRateRefresh(生产)` = **FALSE**（rates今天fresh）→ 所以是 **force:true**。
- 唯一 force 路径 = `POST /admin/:moduleKey/exchange-rates/refresh`（forceRefreshRates:true）。无前端轮询 JS。→ **某已登录的外部源每~2秒打这个 endpoint**（看不到生产请求日志，源头本身待掐）。
- 附带发现：该 route 还多做一次 `saveShippingData`(全量覆盖)=冗余 + 被打时的数据 clobber 隐患（我上轮 jsonb_set 只修了 loadShippingData 里那处，漏了这个 route）。

**A2 修复**：
- `exchange-rates.js` 加**节流**：即使 force，若 lastCheckedAt 在 `FX_MIN_REFRESH_INTERVAL_MS`(默认15分) 内→跳过(changed:false 不 fetch 不写)。把 2秒打的源头从"每请求写"压到"每窗口≤1写"(~96/天)。scheduler(每天)+ 真人手动刷(窗口外)仍работ。
- `server.js`：删掉 /exchange-rates/refresh 里冗余的 saveShippingData（loadShippingData 已 jsonb_set 持久化汇率）。
- 导出 needsExchangeRateRefresh；测试 `scripts/audit-fx-throttle-test.js` 5/5。

**A3 部署+验证**：PR#14→main=ffa0429→部署success→**实测生产60秒内 0 写**（前 11写/20秒）。revision 冻在 214818。**写风暴从 ~47520/天 → ~0（窗口内）/最多 ~96/天**。FX 仍正常（rates今天、asOfDate今天、无error；窗口外会刷）。

### B — 全面检测上线 ✅
- **B1 生产数据 13/13**：B(KMTC新名+ISD15)/C(26 CONTENTO真价3800-5850)/E(HAPAG/ONE code+14rfc)/D(7空壳) 全在；**José手改全在**(CMA50/ZIM Borrar/COSCO ot-fl-pl20/自建2场站；yards=28)。A 部署后复查仍 intact。
- **B2 报价模式 4/4**：模式一隐藏NO MEXICO(11行)/模式二双段(23=12+11)、三语(12非墨段全EN/ZH/ES，墨段ES回退EN by design)、双价(MXN不含IVA+USD含16%)、6个 mode×lang PDF 全 %PDF。
- **B3 新增船司**：audit-new-carrier 6/6 + d-add 12/12。
- **B4 CRUD回归**：smoke+quote9/9+o3+batch3+4审计 全绿。
- **B5 XSS**：无裸 JSON.stringify，全 safeJson。
- **B6 双价math+CONTENTO成本侧**：quote 9/9 + audit-contento 3/3。

### 发现/留尾
- F1（中）：FX写风暴**源头**（外部每~2秒打 /exchange-rates/refresh 的已登录源）已被节流**无害化**(写已≈0)，但 HTTP 请求仍在打。需查掐源头（疑似挂着的admin页/外部监控/带cookie的脚本）——看不到生产请求日志，建议 Chandler 查 Railway access log 或 José 是否挂着后台页。
- F2（已修）：/exchange-rates/refresh 的冗余 saveShippingData(clobber隐患) 已删。
- admin-masters.ejs:129 指向不存在的 /admin/masters/refresh-exchange-rates（死表单，404，非风暴源）——低优先，可后续清。

**部署机制锚点(不变)**：生产=Supabase；改代码部署即生效；改数据走patch脚本(jsonb_set定向写)永不db:seed；FX只jsonb_set写exchangeRates+节流。

**本轮防compact写入**：00t_chandler_log_round21.md（本文件）+ _ROADMAP
