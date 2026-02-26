# Kysely Migration System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace manual SQL execution with Kysely's built-in Migrator framework, with a CLI entry script and Docker compatibility.

**Architecture:** Create `src/db/migrate.ts` (runner logic using Kysely `Migrator` + `FileMigrationProvider`) and `scripts/migrate.ts` (CLI entry). Future migrations go in `src/db/migrations/` as TypeScript files wrapping raw SQL. Existing `server/migrations/*.sql` are preserved as historical baseline.

**Tech Stack:** Kysely Migrator, tsx, PostgreSQL, pg

---

### Task 1: Create the migration runner module

**Files:**
- Create: `server/src/db/migrate.ts`

**Step 1: Write `src/db/migrate.ts`**

This module exports `runMigrations()` which uses Kysely's `Migrator` + `FileMigrationProvider`.

```typescript
import * as path from 'path'
import { promises as fs } from 'fs'
import { Migrator, FileMigrationProvider } from 'kysely'
import { getDb } from './connection.js'

export async function runMigrations() {
  const db = getDb()

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, 'migrations'),
    }),
  })

  const { error, results } = await migrator.migrateToLatest()

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`migration "${it.migrationName}" was executed successfully`)
    } else if (it.status === 'Error') {
      console.error(`failed to execute migration "${it.migrationName}"`)
    }
  })

  if (error) {
    console.error('failed to migrate')
    console.error(error)
    process.exit(1)
  }

  return results
}
```

**Step 2: Commit**

```bash
git add server/src/db/migrate.ts
git commit -m "feat: add Kysely migration runner module"
```

---

### Task 2: Create the CLI entry script

**Files:**
- Create: `server/scripts/migrate.ts`
- Modify: `server/package.json` (add `"migrate"` script)

**Step 1: Write `scripts/migrate.ts`**

```typescript
import dotenv from 'dotenv'
dotenv.config({ override: true })

import { runMigrations } from '../src/db/migrate.js'
import { getDb } from '../src/db/connection.js'

async function main() {
  console.log('Running migrations...')
  const results = await runMigrations()

  if (!results || results.length === 0) {
    console.log('No pending migrations.')
  }

  await getDb().destroy()
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
```

**Step 2: Add npm script to `server/package.json`**

Add to `"scripts"` section (line 6-10 of `server/package.json`):

```json
"migrate": "tsx scripts/migrate.ts"
```

**Step 3: Commit**

```bash
git add server/scripts/migrate.ts server/package.json
git commit -m "feat: add migration CLI entry script and npm command"
```

---

### Task 3: Create the migrations directory with a placeholder

**Files:**
- Create: `server/src/db/migrations/.gitkeep`

**Step 1: Create directory with `.gitkeep`**

The directory must exist for `FileMigrationProvider` to find it. An empty directory won't be tracked by git, so add `.gitkeep`.

```bash
mkdir -p server/src/db/migrations
touch server/src/db/migrations/.gitkeep
```

**Step 2: Commit**

```bash
git add server/src/db/migrations/.gitkeep
git commit -m "feat: add Kysely migrations directory"
```

---

### Task 4: Update CLAUDE.md — Database Migration section

**Files:**
- Modify: `CLAUDE.md` (lines 143-162, the "Database Migration" section)

**Step 1: Replace the Database Migration section**

Replace lines 143-162 of `CLAUDE.md` with the new content:

```markdown
## Database Migration

使用 Kysely 的 Migrator 框架管理数据库 schema 变更。

**历史基线：** `server/migrations/` 下的 SQL 文件（001-005）是项目早期的手动 migration，不受 Kysely 管理。对于全新数据库，必须先执行这些 SQL 文件建立基线 schema，然后再运行 Kysely migration。

**新 migration 写法：** 在 `server/src/db/migrations/` 下创建 TypeScript 文件，命名格式 `YYYY-MM-DDTHHMM-description.ts`，使用 raw SQL：

```ts
import { type Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE records ADD COLUMN foo TEXT`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  // forward-only, no rollback
}
```

**执行 migration：**

```bash
# 本地（使用 .env）
cd server
pnpm run migrate

# 本地（使用 .env.prod 对生产执行）
npx tsx --env-file=.env.prod scripts/migrate.ts

# Docker（生产服务器）
docker compose exec server pnpm --filter @linkmind/server run migrate
```

**新数据库初始化（两步）：**

1. 手动执行 `server/migrations/` 下的 SQL 文件（001_init.sql 到 005_share_records.sql），注意 002_bm25_index.sql 是可选的（需要 ParadeDB 扩展）
2. 运行 `pnpm run migrate`（Kysely 自动创建 migration 追踪表并执行所有新 migration）
3. 执行 Absurd SQL：`server/sql/absurd.sql`，然后 `SELECT absurd.create_queue('linkmind')`
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update Database Migration section for Kysely Migrator"
```

---

### Task 5: Verify — create empty test database and run full flow

**Files:**
- No new files. This is a manual verification task.

This task uses a local PostgreSQL database to verify the entire two-phase init works.

**Step 1: Create a fresh test database**

```bash
psql -U reorx -d postgres -c "DROP DATABASE IF EXISTS linkmind_migrate_test"
psql -U reorx -d postgres -c "CREATE DATABASE linkmind_migrate_test OWNER linkmind"
```

**Step 2: Run the SQL baseline files (001-005, skipping 002 which needs ParadeDB)**

```bash
cd server
psql -U linkmind -d linkmind_migrate_test -f migrations/001_init.sql
psql -U linkmind -d linkmind_migrate_test -f migrations/003_agent_events.sql
psql -U linkmind -d linkmind_migrate_test -f migrations/004_ingested_with_content.sql
psql -U linkmind -d linkmind_migrate_test -f migrations/005_share_records.sql
```

Note: `002_bm25_index.sql` is skipped because it requires the `pg_search` (ParadeDB) extension which is not available on local PostgreSQL. This is documented as optional.

**Step 3: Run Kysely migrations against the test database**

```bash
cd server
DATABASE_URL="postgresql://linkmind@localhost:5432/linkmind_migrate_test" npx tsx scripts/migrate.ts
```

Expected output: "No pending migrations." (since there are no migration files in `src/db/migrations/` yet, only `.gitkeep`). This verifies the Migrator initializes correctly and creates the `kysely_migration` tracking table.

**Step 4: Verify the schema is correct**

```bash
psql -U linkmind -d linkmind_migrate_test -c "\dt"
```

Expected: all tables from 001-005 + `kysely_migration` + `kysely_migration_lock` (Kysely auto-creates these).

**Step 5: Run the project test suite against the test database**

```bash
cd server
DATABASE_URL="postgresql://linkmind@localhost:5432/linkmind_migrate_test" pnpm test
```

Verify tests pass (some tests may be skipped if they need mocks/fixtures not related to schema).

**Step 6: Clean up**

```bash
psql -U reorx -d postgres -c "DROP DATABASE IF EXISTS linkmind_migrate_test"
```

---

### Task 6: Final commit — squash or group if needed

Review all changes, ensure typecheck passes:

```bash
cd server
pnpm typecheck
```

If all good, the work is complete. Summary of files changed:

- **Created:** `server/src/db/migrate.ts` — migration runner
- **Created:** `server/scripts/migrate.ts` — CLI entry
- **Created:** `server/src/db/migrations/.gitkeep` — migrations directory
- **Modified:** `server/package.json` — added `migrate` script
- **Modified:** `CLAUDE.md` — updated Database Migration docs
