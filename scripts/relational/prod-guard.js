// PROD project-isolation guard — the INVERSE of sandbox-guard. assertProd() refuses
// unless DATABASE_URL's project ref == the prod project (polxyashvxbzdkkmxuox, which
// hosts expressline + joyas + punas). Used by the blob→relational PROD cutover
// (Phases 0-4): build + populate the expressline relational tables in production
// WITHOUT touching the running app.
//
// Two isolation layers (see docs/specs/20260622_blob_to_relational_CUTOVER_RUNBOOK.md §2):
//   (a) PROJECT level = this ref assertion (which Supabase project).
//   (b) SCHEMA level  = the restricted `expressline_migrator` role (Phase 1) that has
//       privileges on `expressline` ONLY + an empirical isolation proof. This guard is
//       (a); the role is (b). Both must hold.
//
// extractRef() handles BOTH connection shapes Supabase uses:
//   - direct:  db.<ref>.supabase.co
//   - pooler:  username "<role>.<ref>" (Supavisor splits the tenant on the LAST dot),
//     so it accepts postgres.<ref> AND expressline_migrator.<ref> (the migrator login).
const PROD_REF = "polxyashvxbzdkkmxuox"; // expressline + joyas + punas live here

function extractRef(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("[prod-guard] DATABASE_URL is not set (fail closed)");
  }
  const url = new URL(databaseUrl);
  const direct = url.hostname.match(/^db\.([a-z0-9]{16,})\.supabase\.co$/i);
  if (direct) {
    return direct[1];
  }
  const user = decodeURIComponent(url.username);
  const dot = user.lastIndexOf(".");
  if (dot > 0) {
    const ref = user.slice(dot + 1);
    if (/^[a-z0-9]{16,}$/i.test(ref)) {
      return ref;
    }
  }
  throw new Error(
    `[prod-guard] could not extract a project ref from DATABASE_URL (host=${url.hostname}, user=${url.username})`
  );
}

// Returns the verified prod ref or throws (fail closed).
function assertProd(databaseUrl) {
  const ref = extractRef(databaseUrl);
  if (ref !== PROD_REF) {
    throw new Error(`[prod-guard] REFUSING: DATABASE_URL project ref ${ref} != prod ${PROD_REF}`);
  }
  return ref;
}

module.exports = { assertProd, extractRef, PROD_REF };
