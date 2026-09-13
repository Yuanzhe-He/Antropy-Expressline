# Expressline resource lifecycle correction

Reduce avoidable memory retention in the existing Expressline service. Keep production data, calculations, quote content, currencies, authentication semantics and existing FX/cache safeguards intact.

## Evidence

- Live process inspection confirms persistent Chromium processes alongside Node; per-process proportional memory should be compared before/after.
- `src/lib/quote-pdf.js` retains its lazy browser after closing individual PDF pages. A local synthetic quote reproduces browser processes remaining after export and disappearing after full close.
- `src/server.js` uses the default unbounded MemoryStore. Language/demo-user middleware modifies each new session, including health checks. Local 1,000 cookie-less health checks retain 1,000 never-expiring sessions.
- Full shipping-data cloning creates transient allocations but has not been identified as the dominant persistent consumer. Do not change this high-impact interface in this patch.

## Implementation

### PDF lifecycle

Change `src/lib/quote-pdf.js`, with a focused helper if it improves independent testing. Reuse one lazily launched browser while jobs overlap. Track reservations before awaits so idle shutdown cannot close a browser about to be used. When the final active export ends, schedule close after three minutes of idle time (safe validated environment override for focused testing). Timer must not keep Node alive. A new reservation cancels pending shutdown. Handle launch failure, disconnect, page creation/PDF errors, concurrent close/new request and explicit close used by existing tests; never share a rejected launch promise forever. Preserve PDF options, fonts, HTML and byte-buffer behavior. Do not interrupt active exports during idle cleanup. Add lifecycle tests for reuse, concurrency, idle cleanup, relaunch and failures; retain real PDF regression coverage.

### Session lifecycle

Change `src/server.js` and add a small bounded in-process session store helper. Preserve existing session cookie and application semantics. Use server-side inactivity expiry (24 hours by default), periodic unref cleanup and a hard entry cap (10,000 by default), with validated configuration. On get/touch/set handle expiry and update recency; evict least-recently-used entries when full. Do not introduce a paid store/database table or log session payloads. Put `/healthz` before session/language/user middleware since that route only returns operational counters. Preserve static middleware precedence, ordinary language preferences, flash and last form behavior. Add deterministic tests for expiration, touch, eviction, callbacks and repeated health probes retaining zero sessions.

### Deployment and evidence

Work in an isolated Git worktree/branch; preserve unrelated local changes. Use existing installed dependencies or reproducible installation without copying .env or credentials. Run focused lifecycle tests plus required full smoke/PDF regression. Review the diff, use the normal PR workflow, then verify the corresponding deployment.

Measure production container memory and process PSS/RSS before and after; avoid claiming all post-restart reduction is caused by the code change. Separately validate PDF lifecycle using synthetic, nonpersisting input and confirm browser processes exit after the configured idle timeout without changing business data. Verify health, workbench and database read paths, unchanged sole runtime service identity and retained data. Do not seed/migrate databases. Keep retained audit counts separate from verification traffic.

Serverless sleep is a separate gated decision after usage findings and FX timer behavior are understood. Do not silently disable the daily FX refresh; enabling sleep requires equivalent freshness behavior and a verified cold-start path. No provider migration, plan change or new paid service is included.

## Blast radius and rollback

Affected runtime: quote PDF browser lifetime, in-process session retention and health middleware placement. Existing page routes, quote layout/formulas, schema and auth roles remain the same. Session inactivity expiry and hard-cap eviction can remove very old/least-recent sessions; thresholds are intentionally generous. If regression occurs, revert the code commit and redeploy the known preceding version; no DB rollback is needed. Report actual measured savings separately from monthly price scenarios and observation duration.
