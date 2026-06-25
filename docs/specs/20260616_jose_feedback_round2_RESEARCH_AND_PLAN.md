# Jose Feedback (Round 2, 2026-06-16) — Research Report & Improvement Plan

> Source: `~/Desktop/20260616 Jose consulting.docx` (José live screen-share, mixed
> 中文/Spanish, 23 screenshots). Every item below was checked against the actual
> code on branch `feature/inland-v2-batch2` (HEAD `01c988e`), not against any
> agent self-description. File:line references are real.

---

## 0. Method & scope

- Read: the docx text + **all 23 embedded screenshots**; the AI-workflow layer
  (`_AI_WORKFLOW/core/AGENTS.md`, `notion_writing_standards.md`,
  `codex_capabilities.md`), and project docs (`ARCHITECTURE.md`,
  `AI_AGENT_PROJECT_RULES.md`, `DATABASE_SCHEMA.md`).
- Read code: `server.js` routes, `store.js`, `inland-*.js`, `quote*.js`,
  `options.js`, `modules.js`, `calculate.js`, `inland-link-resolver.js`, and the
  views `admin-module.ejs`, `admin-customs.ejs`, `admin-inland.ejs`,
  `workbench-quote.ejs`, `quote-document.ejs`, `inland-map.js`, `quote.js`,
  `app.js`.
- Architecture (confirmed): Node + Express + EJS, single JSON blob persistence
  (`expressline.app_state`, Supabase or JSON-volume fallback). Modules:
  `handover/换单`, `customs/港口和码头`, `inland/陆运`, `quote/报价`.
- Each feedback item is given an ID (H#/O#/Q#) for traceability and tagged
  **CONFIRMED BUG**, **MISSING FEATURE**, or **DESIGN/DECISION**. Complexity
  tags S/M/L describe blast radius, not schedule.

---

## 1. ⚠️ Blocking pre-check: which build is production running?

The 404 screenshot (image11) is `antropy-expressline-production.up.railway.app`
and its module rail shows **放单 / 港口和码头 / 陆运 / 报价 / 规则配置**, with 陆运
tagged "预留". Other screenshots show batch1 (Sencillo/Full + IVA toggle, image14)
and batch2 (precise points, image15) — so **production already has batch1 + batch2
features**, which matches the code I read.

But git state is muddy:
- `origin/main` local ref = `66ccf37` (= *before* batch1/2).
- `feature/inland-v2-batch1` and `feature/inland-v2-batch2` **are pushed**
  (`remotes/origin/feature/inland-v2-batch*` exist) but **not merged to main**.

So production is serving batch2 features while `main` appears to predate them.
**Action before any deploy work:** `git fetch --all` then confirm what Railway
actually builds (which branch/commit). Do **not** assume `main` == production.
This does not change the bug analysis below (verified against batch2 code = what
José tested), but it changes the merge/deploy plan.

---

## 2. 换单 / Handover — per-carrier charge editor

UI = `views/admin-module.ejs` (shared by handover & customs); save handler =
`POST /admin/:moduleKey/shipping-lines/:id` (`server.js:3880`). Screenshots:
image1 (ZIM "Borrar 85"), image2/5/7/9 (MSC/WANHAI/OOCL/KMTC headers),
image3/6/8 (Cargos locales), image10 (RCL demoras).

### H1 — Local charges: add-only, **no delete** — CONFIRMED BUG (S)
`admin-module.ejs:258-304` renders each local-charge row (concept, tax, BL,
group rates) with **no per-row delete button**; only `Agregar cargo local`
exists (`:242`). José's "Borrar 85 usd" is a junk charge named *Borrar* he
cannot remove. There is also no `local-charges/:id/delete` route.
**Fix:** add a per-row delete button (`formaction=.../local-charges/:chargeId/delete`)
+ route + store op (filter `localCharges`). Mirror the existing demurrage-rule
delete pattern.

### H2/H3 — Can't edit / can't add a missing amount — CONFIRMED BUG (M)
`admin-module.ejs:289` `<% if (rate) { %>` — a group-rate cell renders an input
**only when `charge.groupRates[group.key]` already exists**. If a (charge ×
container-group) cell was never seeded, it shows **blank with no input**, so the
operator literally cannot type a value. Same guard for the BL cell (`:273`).
This is exactly COSCO's "había 12 usd y 90 usd pero no estaban escritos" and
OOCL/WANHAI "no me deja editar datos / cargos locales mal".
**Fix:** always render an editable input + currency select for every group/BL
cell; on save, create the rate object when a value is entered (today the save at
`server.js:3925-3940` only updates existing rate objects). Also allow adding a
brand-new concept row with all columns (COSCO special-container 50–150 USD).

### H4 — RCL "no me deja agregar demoras" — CONFIRMED BUG/UX (S)
`admin-module.ejs:359` the `Agregar tramo` button lives **inside** the
per-rule-set loop, and rule delete is disabled at `rules.length <= 1` (`:427`,
matches greyed Eliminar in image10). If a carrier has **zero** rule sets, there
is no "add tramo" affordance at all — only `Agregar set`. José expected to add a
demora row directly.
**Fix:** ensure `Agregar set` seeds a usable first tramo, surface `Agregar tramo`
even when 0 sets exist (or auto-create a default set), and confirm the
add-rule/add-set handlers persist (`server.js:3556`, `:3612`).

---

## 3. 港口和码头 / Customs — ports & terminals (其他 §1–3)

UI = `views/admin-customs.ejs`; routes around `server.js:2611-3150`.

### O1 — "后台无法添加港口码头，页面不存在" (404) — CONFIRMED BUG (S/M)
Verified: all `/admin/customs/terminals/...` routes are **POST-only**
(`server.js:2672+`); there is **no GET** for `/admin/customs/terminals/:id`, so
the screenshot URL `/admin/customs/terminals/customs-port-1781643207…` (a *port*
id under a *terminals* path, hit by a GET) returns the 404 page. The real
ports/terminals admin lives at `GET /admin/customs/shipping-lines` (`:2611`).
The add-port/add-terminal buttons themselves are correct POSTs that redirect to
`#customs-port-…` anchors.
**Fix:** reproduce live to capture the exact trigger (most likely a stale anchor
nav or an AJAX redirect landing on a GET), then (a) add a defensive
`GET /admin/customs/terminals/:id → 302 /admin/customs/shipping-lines#customs-terminal-:id`,
and (b) verify the add-port/add-terminal happy path end-to-end.

### O2 — Remove "业务性质 / business nature" — CONFIRMED, easy (S)
The enum lives in `options.js:12-16` (`handover_only / customs_only /
handover_customs`). José: "所有的都是清关，没有方单+清关 → 拿掉". 
**Fix:** hide the business-nature selector from the customs ports/terminals UI
and default to `customs_only`. Keep the enum in code (handover & quote calc still
reference it) — this is a UI removal, not a schema removal. (Confirm it is not
shown elsewhere José still needs.)

### O3 — Per-fee config module on ports/terminals — MISSING FEATURE (M/L)
José wants every port/terminal fee to carry three attributes:
1. **charge basis**: per-day vs per-occurrence;
2. **calculation**: per-day amount, or per-occurrence amount;
3. **required flag**, with this semantics at quote time:
   - required = true → the line is always selected/shown **even if amount = 0**;
   - required = false → shown **only when the fee actually occurs**.

Today terminal `fixedCharges` (`admin-customs.ejs:240-255`) only have
concept/note/tax/group-rates — no basis, no required flag.
**Fix:** extend the terminal-charge model with `basis: 'per_day'|'per_occurrence'`,
`amount`, `required: bool`; add the UI columns; and honor `required` + `basis`
when these fees feed the quote (ties into Q3/Q7/Q8 quote work).

### O3b — Ports cannot be deleted — CONFIRMED BUG (S) [answers O6.3 audit]
There is `terminals/:id/delete` and `yards/:id/delete`, but **no
`/admin/customs/ports/:id/delete`** route or button. José also asked to "全量检查
下后台还有哪里不能删除"; the two confirmed gaps are **(1) handover/customs local
charges (H1)** and **(2) customs ports**.
**Fix:** add port delete (route + button + cascade-remove its terminals).

---

## 4. Logo (其他 §4) — O4 — CONFIRMED, asset swap (S)

`views/partials/header.ejs:33` uses `/dewell-logo.svg`. That SVG
(`public/dewell-logo.svg`, viewBox `0 0 640 280`) is a **hand-drawn approximation**
of the De Well mark (hand-coded `<path>` strokes), which is why José says
"里面的变形了 / 形状长得不一样". image13 is the correct brand logo (red brush swoosh +
blue flag + "DE WELL GROUP ®").
**Fix:** replace `dewell-logo.svg` with the real asset (export image13 as
SVG/PNG); keep `.brand-logo { object-fit: contain }` so aspect ratio is
preserved. Re-check the quote-document logo too (§6 Q1).

---

## 5. 陆运 / Inland (其他 §5–6)

UI = `admin-inland.ejs` + `inland-map.js`; data = `inland-catalog.js`,
`inland-vehicles.js`, `store.js`; routes `server.js:2018-2399`.

### O6.6 — 陆运 status "预留" → "已启用" — CONFIRMED, trivial (S)
Pure label. `i18n.js:55-58` (zh) and `:683-686` (es) hardcode 陆运 `state:"预留"`
/ `Reservado` + "预留中" copy. The module is fully `implemented` (`modules.js`).
**Fix:** change `state` to "已启用"/"Activo" and update the placeholder copy.

### O6.7 — Vehicle types — CONFIRMED + 1 DESIGN POINT (M)
`inland-vehicles.js:8-15` already has 6 tiers:
`light_1_5t, light_3_5t, short_8t, sencillo, full, lowboy`. José's new list is
**1.5吨 / 3.5吨 / 8吨 / 单拖 / 双拖 / 53尺厢式货车**. Five match; the 6th differs —
current `lowboy`(低平板/Cama baja) vs requested **53尺厢式货车 (53ft dry van)**.
- **Fix:** replace `lowboy` with a `box_53` tier (53ft caja seca), update labels
  + admin column (`admin-inland.ejs:178,196`) + i18n + `getVehiclePrice`. No
  price yet → cell blank (José: "没有价格就先空着"). Today blank tiers show
  "Pendiente/待报价" (`inland-map.js:399`); change to truly blank per request.
- **DECISION:** drop `lowboy` entirely, or keep it as a 7th tier? (see Q-list.)
- **[INCIDENTAL_FIX]** `calculate.js:19-20` `VEHICLE_LABEL_KEYS` only maps
  `sencillo/full`; the no-rate / total explanation text mislabels the 4 new
  tiers as "Sencillo". Extend the label map to all tiers.

### O6.1 + O6.2 — Precise points: "save doesn't work" + map doesn't reach point — CONFIRMED BUG (M)
**Root cause is NOT the link resolver.** I traced José's exact short link
`https://maps.app.goo.gl/x2Vo5NDEth7JzZXT8` → it 302-redirects to
`.../@25.7505,-100.1182.../!3d25.7507685!4d-100.1173484` with place name
"CFMOTO MEXICO"; `inland-link-resolver.js` extracts both coords + name
correctly, and image15 shows "春风动力 25.7507685, -100.1173484" **did save**.
The real problems:
1. **Front-end never routes to the precise point.** `inland-map.js`
   `applySelectionLayer()` (`:245-259`) always reads
   `routeForDestination(selectedId)` = the **destination-level** route
   (`${id}|destination|`), ignoring the selected precise point. Clicking a
   precise chip only `flyTo`s (`:557`) — the drawn route still ends at the city
   center. That is José's "保存之后地图路线要能到精确点位".
2. **No auto route refresh for a new precise point.** Adding one
   (`server.js:2254`) saves the point but does not fetch its route;
   `refreshOneInlandRoute` supports `precisePoint` targets but only runs on the
   explicit "刷新路线" (`:2075`). So even when the front-end is fixed, the precise
   route geometry is missing until a manual refresh.
**Fix:** (a) auto-refresh the precise point's route on add; (b) make
`applySelectionLayer` use `routeByKey[`${dest}|precisePoint|${id}`]` when a
precise point is selected; (c) the precise-point chip already exists — also add
a "精确目的地" dropdown under the destination select per José's wording.

### O6.4 — Click each customer in an area → price to each — MISSING FEATURE (M/L)
Precise points carry only name/lat/lng/route — **no price**. Rates
(`rateEntries`) are per-city, not per precise point, and precise points are not
even drawn as clickable map markers (only city dots are, `inland-map.js:104-119`).
**Fix (recommended model):** render precise points as clickable map markers;
each precise point inherits the city's rate by default, plus an **optional
per-point rate override** and its own route distance/time; clicking a marker
shows that point's price + ETA. (Confirm pricing model — see Q-list.)

### O6.5 — Bilingual destination names (中文 + 西语, either optional) — MISSING FEATURE (M)
`destinations[]` has a single `name`. José: keep `nameZh` + `nameEs`; if only one
is filled, always show it; if both, follow system language.
**Fix:** add `nameZh`/`nameEs` (keep `name` as fallback/legacy); resolve display
name by `lang` in the map data prep, the admin form, the select, and the quote.

### O5 — Selectable origin per route — MISSING FEATURE (M/L)
`inland-catalog.js:11-13` has a single origin (Manzanillo); routes always compute
from `origins[0]` (`server.js:2078`). `rateEntries` already carry `originId`, so
the data model is half-ready.
**Fix:** add an origins list (admin-managed), let each route/rate pick its origin,
recompute route cache per (origin, destination). (Confirm which origin ports +
whether rates differ by origin — see Q-list.)

### O6.3 — Destinations deletable — ALREADY EXISTS; verify (S)
Delete button + route already exist (`admin-inland.ejs:100`, `server.js:2239`,
cascades rates + routeCache). Likely José didn't find it, or hit a specific
failure. **Action:** verify it works live; the real gaps from his "全量检查" are
H1 (local charges) and O3b (ports).

---

## 6. 报价 / Quote (报价 §1–11)

UI = `workbench-quote.ejs` + `public/quote.js`; model = `lib/quote.js`; render =
`quote-document.ejs` + `lib/quote-pdf.js`; admin bounce = `server.js:2424`.
Screenshots: image16/23 (target quote), image22 (current quote workbench),
image17-20 (incoterm/transport/container option lists), image21 (UNIT/QTY).

### Q1 — Remove top-right logo — CONFIRMED, easy (S)
`quote-document.ejs:95-97` is the right (De Well) logo box. **Fix:** remove that
box (keep Express Line left). Also relevant: the app header logo is the
distorted one (O4).

### Q2 — Quote needs its own admin config (规则配置→报价 bounces back) — CONFIRMED (M)
`GET/POST /admin/quote/settings` both `res.redirect("/workbench/quote")`
(`server.js:2424,2452`). So 报价 has no admin surface — clicking it in 规则配置
just returns to the workbench. **Fix:** build a quote admin page (its own
`/admin/quote/...`) to manage: number prefix/seq, default header options, the
**remark library (Q11)**, **unit-of-measure list (Q7.3)**, and fee defaults.

### Q3 — Department: add 陆运 — CONFIRMED, easy (S)
`workbench-quote.ejs:52-55` department select = OCEAN/AIR only. **Fix:** add
INLAND/陆运 (and align with the transport-method list, Q5).

### Q4 — Incoterm → dropdown — CONFIRMED, data + UI (S)
`workbench-quote.ejs:57` incoterm is a free `<input>`. image17/18 give the full
Incoterms list (EXW, FCA, FAS, FOB, CFR, CIF, CPT, CIP, DAP, DPU, DDP, DAT, …).
**Fix:** add an `INCOTERM_OPTIONS` constant + `<select>`.

### Q5 — Transport method (运输方式) field — MISSING FEATURE (S)
image19: AIR/SEA/FSA/FAS/ROA/RAI/COU. New header field.
**Fix:** add `transportMode` + `TRANSPORT_MODE_OPTIONS` select; reconcile with
`department`.

### Q6 — Container type (装箱类型) → full dropdown — CONFIRMED, data + UI (S)
`workbench-quote.ejs:63-66` cargoType = FCL/LCL only. image20: FCL/LCL/BLK/LQD/
BBK/BCN/SCN/ROR. **Fix:** expand to a `CARGO_TYPE_OPTIONS` select.

### Q7 — Single-language quote (全中文 OR 全西语) + 4-block layout — MISSING FEATURE / REDESIGN (L)
Today the document is **EN + 中文 side-by-side** (`quote-document.ejs:132-133`
conceptEn/conceptZh; notes en/zh `:191-193`). José wants to **pick one language
and render fully in it** (中文→全中文, 西语→全西语), in four blocks:
1) date + quotation number; 2) general data; 3) charges; 4) notes.
**Fix:** add a `language` selector (see Q-decision on EN/ZH/ES set); render the
chosen language only; add Spanish strings for concepts/units/notes/headers; keep
the 4-block structure already present in `quote-document.ejs`.

### Q7.2 — Block 2 (general data) add/delete fields — MISSING FEATURE (M)
Today general data is a fixed field set. José wants Excel-like add/delete rows.
**Fix:** model general data as ordered key/value rows with add/remove (like the
line-items table), with the standard fields seeded.

### Q7.3 — Charges: split blocks + real UNIT column — MISSING FEATURE (M/L)
- **UNIT vs QTY:** confirmed — `quote.js` `unit` is used as **quantity**
  (`unit × unitPrice`, `:300`); there is no unit-of-measure column. image21 shows
  UNIT (CNTR) **and** QTY as separate columns. José wants a UNIT field with a
  controlled list: **柜 / 提单 / 次 / 个 / 车型 / 天** plus a numeric QTY.
  **Fix:** add `unitOfMeasure` (enum) + keep `qty`; update workbench table, model
  math, and `quote-document.ejs` columns.
- **Two sub-blocks:** add a **"NO MEXICO CHARGES"** section (origin/China-side)
  alongside the existing **"MEXICO LOCAL CHARGES"**. `QUOTE_GROUP_ORDER`
  (`quote.js:9-15`) is Mexico-only today. (CNY support = Q-decision.)

### Q8 — All fees chosen from fee.doc — CONFIRMED direction (M)
`fee.doc` = `docs/reference/fee-codes.csv` (346 codes, EN only), loaded by
`loadFeeCodes()` (`quote.js:227`). Today code is a free `datalist` and concept is
free text (`workbench-quote.ejs:154-158`). **Fix:** bind concept+code to the
fee.doc vocabulary (select, not free text). Needs ZH/ES descriptions for
single-language output (Q-decision).

### Q9 — "从计算器取数" not needed (cost ≠ quote) — CONFIRMED, remove (S)
José: no linkage to modules 1/2. The "Pull from calculators" section
(`workbench-quote.ejs:74-122`, logic `quote.js:394`) should be removed/hidden.
**Fix:** drop the pull section + `calcRef` plumbing from the default flow (keep
code dormant if you want optionality). Simplifies the module.

### Q10 — Fee code change → concept auto-updates — CONFIRMED BUG/UX (S)
`quote.js`(public) `wireCodeAutofill` only fills conceptEn **when empty**
(`:116-118`). José wants the concept to **always follow** the code.
**Fix:** on code change, always set concept (per active language) from fee.doc.

### Q11 — Remark selector (admin list + front-end checkbox + reorder) — MISSING FEATURE (M)
Today `QUOTE_NOTES` is 5 hardcoded constants (`quote.js:168-192`), always all
printed. José wants: admin-configurable remark library; a pre-PDF selector with
checkboxes; selected remarks printed below the quote; reorderable.
**Fix:** move notes into `quoteModule.settings.remarks[]` (admin CRUD, Q2),
render a checkbox + drag-order selector in the workbench, persist the selected
ordered subset into the document.

---

## 7. Open questions / decisions (each with my recommendation)

These are the genuine forks where your or José's input changes the build. I have
already studied the code and propose a default for each.

1. **Production build / merge state.** *Recommendation:* before any deploy,
   `git fetch --all` and confirm what Railway serves; merge batch1→batch2→main
   via stacked PRs rather than assuming `main` is live. (Blocking, §1.)
2. **Vehicle 6th tier.** Replace `lowboy`(低平板) with `53尺厢式货车`?
   *Recommendation:* yes, replace as requested; ask José if 低平板/Cama baja is
   still ever used — if so keep it as a 7th tier instead of dropping.
3. **Quote languages.** José said 西语 + 中文; current build is EN + 中文; the
   sample quote is English. *Recommendation:* support **EN / ZH / ES** as
   selectable single-language outputs (English is already built and likely still
   used for some clients); confirm whether English can be dropped.
4. **fee.doc translations.** Single-language ZH/ES quotes need ZH/ES descriptions
   per code (346 rows, currently EN-only). *Recommendation:* extend the CSV to
   `code,en,zh,es`; confirm who supplies the ZH/ES wording (José vs a translation
   pass I draft for his review).
5. **"NO MEXICO CHARGES" currency.** China-origin charges may be in CNY (raised
   in the prior round). *Recommendation:* ship the new block first using existing
   USD/MXN; add CNY (new FX pair) only if José confirms China-side pricing in CNY
   is actually quoted.
6. **Multi-customer pricing (O6.4).** *Recommendation:* precise points inherit the
   city rate by default + optional per-point override + per-point route ETA;
   clickable map markers show each point's price. Confirm this model fits how
   José quotes a customer cluster (e.g. Apodaca with ~10 customers).
7. **Selectable origin (O5).** *Recommendation:* add origins (e.g. Manzanillo,
   Lázaro Cárdenas, Veracruz, Altamira) in admin; ask José which ports and
   whether inland rates differ by origin (if not, route geometry changes but the
   rate table stays per-city).
8. **Business nature removal (O2).** *Recommendation:* hide from the customs UI
   only and default `customs_only`; keep the enum for handover/quote internals.
   Confirm José doesn't need it anywhere else.
9. **Remove vs hide the calculator pull (Q9).** *Recommendation:* remove from the
   default UI; keep the code path dormant so it can return if cost-linkage is ever
   wanted. Confirm full removal is fine.

---

## 8. Phased implementation plan

Sequenced by risk and dependency. Spec-first per `AI_AGENT_PROJECT_RULES.md`:
each batch ships behind a PR; no direct push to `main`; quote/inland/customs
touch hot files (`server.js`, `store.js`, admin views) so each PR's summary must
state blast radius. **Run the §1 git/deploy check before Batch A.**

**Batch A — quick wins / pure fixes (low risk).** O6.6 status label; O4 logo
swap; Q1 remove right logo; Q3 department +陆运; Q4 incoterm dropdown; Q6 cargo
type dropdown; Q5 transport-mode field; O6.7 vehicle-label `[INCIDENTAL_FIX]` in
`calculate.js`. Verify: smoke test + render each page.

**Batch B — carrier-charge editability (换单).** H1 delete local charge; H2/H3
always-editable group/BL cells + add-with-all-columns + save creates missing
rate objects; H4 demoras add/remove robustness. Verify: edit/add/delete a charge
on a seeded carrier round-trips through save.

**Batch C — customs ports/terminals (港口和码头).** O1 reproduce + fix the 404 +
defensive GET redirect; O2 remove business-nature from UI; O3b port delete; O3
per-fee config (basis / amount / required) — model + UI + quote hook.

**Batch D — inland routes/map (陆运).** O6.1/6.2 precise-point routing
(auto-refresh + front-end use precise route + 精确目的地 dropdown); O6.5 bilingual
names; O6.7 vehicle 6th tier; O5 origin selection; O6.4 multi-customer precise
pricing + clickable markers. Verify: add precise point → route redraws to it;
language switch shows correct name; vehicle switch updates price.

**Batch E — quote redesign (报价).** Q2 quote admin surface; Q9 remove pull; Q8
fee.doc-bound concept/code; Q10 always-follow autofill; Q7.3 UNIT column +
no-mexico/mexico split; Q7.2 add/delete general-data rows; Q11 remark library +
selector; Q7 single-language EN/ZH/ES + 4-block render + ES strings + fee.doc
translations. Verify: generate ZH-only and ES-only PDFs; remark selection +
reorder reflected; totals unchanged for existing MXN/USD math.

---

## 9. Risks & rollback

- **Hot files:** `server.js`, `store.js`, `admin-module.ejs`, `admin-customs.ejs`,
  `quote*.js`, `inland-map.js`. Every batch must list affected
  pages/endpoints/data and run `npm test` + manual browser checks.
- **Data model additions** (vehicle `box_53`, `nameZh/nameEs`, terminal
  `basis/required`, quote `unitOfMeasure`, remark library) flow through the single
  `app_state` blob and the normalizers in `store.js` — add back-compat defaults so
  old data loads without crashing (the existing pattern: normalize fills missing
  fields).
- **No production `db:seed`** without explicit confirmation (it overwrites live
  config). Batch1's burreo needed a post-deploy reseed; the new fields are
  admin-entered and do **not** need a seed.
- **Quote math:** Q7.3/Q9 change the line-item shape; keep the existing
  MXN/USD subtotal + dual-currency logic intact and regression-check totals.
