# Database Schema

## Current status

- Source: `README.md`; project can use Supabase Postgres and can continue using JSON fallback before DB migration.
- Source: `docs/env-setup.md`; production DB schema name is `expressline`.
- Source: `docs/env-setup.md`; seed writes repository `data/shipping-lines.json` and `data/users.json` into `expressline.app_state`.
- Inferred; needs review: exact table definitions should be verified in `scripts/db-migrate.js` before changing schema or persistence behavior.

## Persistence mode distinction

- Current documented options:
  - JSON fallback / local prototype storage: `data/shipping-lines.json`.
  - Temporary no-database deployment fallback: `STORAGE_DRIVER=json` and `DATA_DIR=/app/runtime-data` on Railway Volume.
  - Production DB target: Railway + Supabase Postgres with `DATABASE_SCHEMA=expressline`.
- Default/local fallback if documented:
  - README and bulk-upload docs identify `data/shipping-lines.json` as the current prototype data source.
- Production target if documented:
  - `docs/env-setup.md` says production DB mode uses Supabase Postgres and should not set `STORAGE_DRIVER=json`.
- Unresolved:
  - The existing docs do not prove which persistence mode the currently deployed production instance is using.

## Safety rules

- Do not print or store real `DATABASE_URL`, database passwords, Supabase service keys, session secrets, cookies, or API keys.
- Do not run `npm run db:seed` against production without explicit confirmation, because existing docs say it can overwrite online configuration with repository seed data.
- Keep this project inside `DATABASE_SCHEMA=expressline` unless a reviewed migration plan says otherwise.

## Migration commands

- `npm run db:migrate`
- `npm run db:seed`
- `npm run db:check`

## Open questions

- Inferred; needs review: whether production currently uses JSON fallback or Supabase Postgres.
- Inferred; needs review: whether `expressline.app_state` is the only persistent table after current migrations.
