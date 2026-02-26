# Kysely Migration System Design

## Goal

Replace manual SQL execution with Kysely's built-in migration framework. Provide a single entry script for running migrations, compatible with Docker deployment.

## Key Decisions

- **Migration format**: TypeScript files wrapping raw SQL (`sql`...`.execute(db)`)
- **No rollback**: `down()` functions are empty stubs (forward-only)
- **Runtime**: `tsx` (same as existing server runtime, no compile step needed)
- **Existing SQL files**: Kept as historical baseline, not managed by Kysely

## Structure

```
server/
├── src/db/
│   ├── connection.ts          # Existing, unchanged
│   ├── migrate.ts             # NEW: migration runner logic
│   └── migrations/            # NEW: Kysely migration files
│       └── YYYY-MM-DDTHH-description.ts
├── scripts/
│   └── migrate.ts             # NEW: CLI entry point
├── migrations/                # Existing SQL files, kept as-is
│   ├── 001_init.sql
│   └── ...005_share_records.sql
```

## Components

### `src/db/migrate.ts`

- Uses Kysely `Migrator` + `FileMigrationProvider`
- Points to `src/db/migrations/` directory
- Exports `runMigrations()` function
- Calls `migrator.migrateToLatest()`, prints results per migration

### `src/db/migrations/*.ts`

- Naming: `YYYY-MM-DDTHH-description.ts` (Kysely sorts alphabetically)
- Each file exports `up(db)` with raw SQL and empty `down(db)`

### `scripts/migrate.ts`

- CLI entry: calls `runMigrations()`, prints results, exits with appropriate code

### `package.json`

- New script: `"migrate": "tsx scripts/migrate.ts"`

## Execution

```bash
# Local
cd server
pnpm run migrate                                  # uses .env
npx tsx --env-file=.env.prod scripts/migrate.ts    # uses .env.prod

# Docker (production)
docker compose exec server pnpm --filter @linkmind/server run migrate
```

## New Database Init (two-phase)

1. Execute `server/migrations/001-005` SQL files manually (historical baseline)
2. Run `pnpm run migrate` (Kysely picks up from empty migration table)

## What Changes in CLAUDE.md

Update the "Database Migration" section to document the new workflow and two-phase init process.

## Verification

- Create an empty test database
- Run SQL baseline (001-005)
- Run Kysely migrations
- Execute project test suite against the test database
