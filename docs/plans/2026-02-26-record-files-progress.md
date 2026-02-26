# Record Files & Object Storage — Progress

## Commits (in order)

| Commit | Phase | Description |
|--------|-------|-------------|
| `c78a2fa` | 1 | Storage engine: S3Storage + LocalStorage + 006 migration SQL |
| `aef00bf` | 2 | Telegram photo download → storage → record_files |
| `f403184` | 1+ | MinIO backend + refactor R2→S3Storage |
| `cbdbd00` | — | Remove redundant r2.ts |
| `881ab3b` | 2 | Photo storage integration test |
| `ccb140c` | 3 | Twitter images → storage (media-handler.ts replaces image-handler.ts) |
| `c2efd61` | 4 | Web display from record_files + /files/ proxy route |
| `bbf40eb` | 5 | Migration script (old records.images → storage) |

## Phase Status

- ✅ **Phase 1**: Storage engine (S3Storage with R2 + MinIO support, LocalStorage)
- ✅ **Phase 2**: Telegram photo handler → storage → record_files
- ✅ **Phase 3**: Twitter images → storage (media-handler.ts, pipeline.ts updated)
- ✅ **Phase 4**: Web display from record_files, /files/* proxy route
- ✅ **Phase 5**: Migration script `scripts/migrate-images-to-storage.ts`
- ⬜ **Phase 6**: Cleanup (see below)

## Phase 6 TODO: Cleanup

After production migration is complete:

1. **Delete `server/src/image-handler.ts`** — replaced by `media-handler.ts`
2. **Delete `server/src/cli/backfill-images.ts`** — replaced by `migrate-images-to-storage.ts`
3. **Remove `records.images` column** — write migration `007_drop_images_column.sql`:
   ```sql
   ALTER TABLE records DROP COLUMN IF EXISTS images;
   ```
4. **Remove `images` from Kysely types** — `server/src/db/types.ts`
5. **Remove old `/images` static route** — `server/src/web.ts` (line ~29-31)
6. **Remove `safeParseJson(record.images)` calls** — `server/src/routes/pages.ts`
7. **Remove old `images` fallback in template** — `server/src/views/link-detail.ejs` (the `else if (images ...)` block)
8. **Delete `server/data/images/`** — local image files (after verifying migration)
9. **Remove `sips`/OCR binary references** — if any remain

## Production Deployment Checklist

1. [ ] Push code to master
2. [ ] Build new Docker image
3. [ ] Configure R2 env vars in production (or use MinIO if self-hosted)
4. [ ] Run `006_record_files.sql` migration on production DB
5. [ ] Deploy new image
6. [ ] Run `migrate-images-to-storage.ts` in production container
7. [ ] Verify web display works for migrated records
8. [ ] Execute Phase 6 cleanup

## Auto-migration Note

Currently migrations are raw SQL files applied manually via `run-sql` CLI.
Kysely Migrator is set up (`src/db/migrate.ts`) but `src/db/migrations/` is empty.
To enable auto-migrate on startup, either:
- (a) Convert SQL files to Kysely programmatic migrations and call `runMigrations()` on boot
- (b) Add a startup hook that scans `migrations/*.sql` and tracks applied ones in a `_migrations` table
