# 00q — 第N+18轮（核实patch脚本安全+诊断救事故 + Chandler三拍板）

> 00p 续篇。最新轮次。

## 2026-06-20 第N+18轮 — CC诊断发现José手改+patch脚本 / Claude核实 / 三拍板

**CC数据上生产结果（PR#12，停在写生产前）**：
- Part1 CONTENTO真价✅：26场站maniobra从占位填真价(3800-5850来自PDF)，26/26真价0占位0编造。
- Part2 数据上生产⏸等拍板：
  - **备份已做**：backups/prod-shipping-data-2026-06-20T21-26-51.json(2.18MB,sha256 773788)，gitignore本地回滚锚点。
  - **⭐诊断关键发现：生产不是纯seed，José后台手改过**：CMA doc fee 45→50、ZIM改名、COSCO改价、**KMTC ISD José自己已改15**、**José自建2个场站"新场站4/5"**。→ db:seed全量覆盖会清掉这些，必须外科patch。
  - patch脚本scripts/patch-prod-data.js：dry-run默认/--apply才写/写前再备份/saveAppState原样写。dry-run验证19处改动全保José手改。
- Part3 5审计全过：①代码vs数据落地(报价模板11+12/车型7档/柜型/nameZh-Es/normalizer字段=代码常量已生效，唯一未生效=本批B/C/E，无历史功能缺口)②CONTENTO回归3/3③新增船司深测6/6④CRUD全绿⑤XSS干净。

**⭐⭐这个诊断救了事故**：若前面真按db:seed推数据，会清掉José的CMA50/ZIM/COSCO手改+自建2场站。CC上轮没自动seed、这轮诊断出手改改用patch=避免真实损失。**且证明José一直在用系统、后台真实操作。**

**Claude核实patch脚本（read全文，安全）**：
- dry-run默认必须--apply才写✓
- 写前再备份pre-patch snapshot✓
- C的yard外科式：keptNonContento明确保留所有非假非CONTENTO的yard=**José自建2场站保留**✓(核了filter逻辑)
- B的KMTC ISD改15幂等(if rate!==15，José已15脚本不重复动)✓
- saveAppState原样写不full re-normalize保José形状✓
- 不打印secrets✓
- **结论：脚本只改B/C/E 19处，不动José手改，可信。**

**Chandler三拍板（Claude建议）**：
1. 落地方式→**方式A外科patch**(强烈推荐，唯一安全。生产有José手改，db:seed会清掉)。Claude核实脚本安全，建议批准--apply。
2. 7家空壳→**建议要(--with-shells)**。José一给费率就能填，且空壳inert无害(只name/code费率空)。比让José自己点省事。
3. PR合并时机→**建议先patch后合并**(或顺序无所谓，两者独立：patch改Supabase数据，PR合并只上代码，CONTENTO价只影响seed对已有生产数据无影响)。稳妥：patch写完抽查通过→合并。

**待Chandler最终确认**：方式A / 要空壳 / 先patch后合并（Claude三个都给了建议，等Chandler点头CC执行）。

**部署机制锚点（再次确认并加强）**：
- 生产=Supabase app_state(key=shipping-data)，有José后台手改
- 改代码→部署自动生效；改数据→必须patch(不能db:seed，会清手改)
- 安全改数据生产流程：备份→诊断canonical diff→dry-run patch→--apply(再备份)→抽查
- **以后任何改生产数据都走patch脚本模式，永不db:seed(除非确认无手改)**

---

## 2026-06-21 第N+18轮 续 — 执行patch（Chandler三拍板后）+ 撞上FX写风暴 + 修复 + 数据已上生产

**Chandler三拍板已下**：①方式A外科patch ②要7空壳(--with-shells) ③先patch后合并。CC执行：

1. **首次--apply 写进去又被覆盖**：patch写成功但秒回旧值。诊断：生产 app_state revision=21万+，每~3s一次写，只改 exchangeRates（FX汇率），保留其余模块。
2. **根因（CC查实，第二个救事故级发现）**：FX刷新（每请求+定时器+某外部每3s强制刷）走 `saveShippingData` 全量覆盖整个 shipping-data blob；FX fetch 慢→每次保存基于几秒前的旧读→**全量覆盖回滚任何并发数据改动**。这不只挡了patch，**José自己后台改的也可能被这个FX写悄悄冲掉**=真实数据完整性bug。
3. **修复（已合并部署 c0ddf19）**：新增 `db.patchAppStateField`(jsonb_set 单字段) + `store.saveExchangeRates`，两处FX保存点改为**只 jsonb_set 写 exchangeRates**，永不碰模块数据。验证：jsonb_set 对生产 no-op→handover/customs/inland/quote 字节级不变；回归全绿。
4. **patch脚本升级**：--apply 改 CAS(compare-and-swap)+verify-persist(写后盯住，被冲就重写)。
5. **先合并(含FX修复)后patch**（顺序被迫调整：patch必须等FX修复部署后才能落住）：PR#12 合并→main=c0ddf19→部署success→重跑patch→**[stable] 落住了**。
6. **生产抽查 19/19 全过**：
   - B/C/E生效：KMTC新名(Doc Fee at Destination/Container Release Fee)+ISD 15、HAPAG=HAPLLOMEX、ONE=ONE_MEX、14家rfc、26 CONTENTO真价(3800-5850)、7空壳(SINOKOR等)。
   - **José手改全保住**：CMA doc fee 50、ZIM改名(Import Container/Borrar)、COSCO ot-fl-pl=20、José自建2场站(新场站4/5)都在；customs yards=28(26+2)。
   - live HTTP抽查同样确认（KMTC页新名+rfc、列表7空壳、customs页 CONTENTO 场站）。

**结果**：数据已安全上生产，José手改零损失，FX数据完整性bug一并修掉。备份 backups/prod-shipping-data-2026-06-20T21-26-51 + pre-patch snapshot 在手。

**新锚点（重要）**：生产有个**FX写风暴**（每~3s写 exchangeRates，来源疑似某外部每3s强制刷 /exchange-rates/refresh 或挂着的admin页）。已用 jsonb_set 让它无害化（不再碰数据），但**写仍频繁**（浪费DB写）。建议后续查这个3s强制刷的来源并掐掉。

**本轮防compact写入**：00q_chandler_log_round18.md（本文件）
