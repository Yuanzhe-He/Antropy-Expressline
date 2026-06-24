// Hard PROJECT-LEVEL isolation guard for the blob→relational migration work.
//
// The production Supabase project (ref polxyashvxbzdkkmxuox) hosts THREE apps in
// one project — expressline (schema `expressline`), joyas (public.joyas_*), and
// punas (public.punas_*). So the schema name is NOT isolation (prod also uses
// `expressline`); isolation must be at the PROJECT level. Every DDL/migration/
// write script must call assertSandbox() FIRST and refuse to run unless the live
// DATABASE_URL points at the designated throwaway sandbox project and at NONE of
// the forbidden projects. Fails CLOSED: a missing SANDBOX_REF aborts.
//
// SANDBOX_REF and FORBIDDEN_REFS come from the gitignored .env.sandbox so no
// project refs are committed.

// Pull the Supabase project ref out of a DATABASE_URL, supporting both the
// direct host (db.<ref>.supabase.co) and the Supavisor pooler username
// (postgres.<ref>@...pooler.supabase.com). Throws if no ref can be found
// (fail closed — never let an unrecognised URL through).
function extractProjectRef(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("[sandbox-guard] DATABASE_URL is not set");
  }
  const url = new URL(databaseUrl);
  const directHost = url.hostname.match(/^db\.([a-z0-9]{16,})\.supabase\.co$/i);
  if (directHost) {
    return directHost[1];
  }
  const poolerUser = decodeURIComponent(url.username).match(
    /^postgres\.([a-z0-9]{16,})$/i
  );
  if (poolerUser) {
    return poolerUser[1];
  }
  throw new Error(
    `[sandbox-guard] could not extract a project ref from DATABASE_URL (host=${url.hostname}, user=${url.username})`
  );
}

// Refuse to proceed unless DATABASE_URL's project ref === SANDBOX_REF and is not
// in FORBIDDEN_REFS. Returns the verified ref on success.
function assertSandbox() {
  const ref = extractProjectRef(process.env.DATABASE_URL);
  const expected = String(process.env.SANDBOX_REF || "").trim();
  const forbidden = String(process.env.FORBIDDEN_REFS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!expected) {
    throw new Error(
      "[sandbox-guard] SANDBOX_REF is not set — refusing to run (fail closed)"
    );
  }
  if (forbidden.includes(ref)) {
    throw new Error(
      `[sandbox-guard] REFUSING: DATABASE_URL project ref ${ref} is in the FORBIDDEN set (prod/other apps)`
    );
  }
  if (ref !== expected) {
    throw new Error(
      `[sandbox-guard] REFUSING: DATABASE_URL project ref ${ref} != sandbox ref ${expected}`
    );
  }
  return ref;
}

module.exports = { extractProjectRef, assertSandbox };
