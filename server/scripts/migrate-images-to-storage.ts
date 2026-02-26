/**
 * Migrate existing records.images (local files) → object storage + record_files.
 *
 * Reads records with non-null images JSON, uploads original files from
 * data/images/{id}/ to storage backend, inserts record_files rows,
 * then nullifies records.images.
 *
 * Usage: npx tsx scripts/migrate-images-to-storage.ts [--dry-run]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getDb } from '../src/db/connection.js';
import { insertRecordFile } from '../src/db/record-files.js';
import { getStorage, recordFileKey } from '../src/storage/index.js';
import { logger } from '../src/logger.js';

const log = logger.child({ module: 'migrate-images' });
const IMAGES_DIR = path.resolve(import.meta.dirname, '../data/images');

interface OldImage {
  original_url: string;
  local_path: string;
  thumbnail_path: string;
  ocr_text?: string;
  width: number;
  height: number;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('🔍 DRY RUN — no changes will be made\n');

  const db = getDb();
  const storage = getStorage();

  // Find records with images JSON
  const records = await db
    .selectFrom('records')
    .select(['id', 'images'])
    .where('images', 'is not', null)
    .execute();

  const toMigrate = records.filter((r) => {
    try {
      const imgs = JSON.parse(r.images as string);
      return Array.isArray(imgs) && imgs.length > 0;
    } catch {
      return false;
    }
  });

  console.log(`Found ${toMigrate.length} records with images to migrate\n`);

  let migrated = 0;
  let errors = 0;
  let filesUploaded = 0;

  for (const record of toMigrate) {
    const images: OldImage[] = JSON.parse(record.images as string);
    const recordDir = path.join(IMAGES_DIR, String(record.id));
    console.log(`[${record.id}] ${images.length} image(s), dir: ${recordDir}`);

    const dirExists = fs.existsSync(recordDir);

    let allOk = true;
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      let data: Buffer;

      // Try local file first, fall back to downloading from original_url
      const localFile = dirExists ? path.join(recordDir, img.local_path) : null;
      if (localFile && fs.existsSync(localFile)) {
        data = fs.readFileSync(localFile);
        console.log(`  [${i}] local: ${img.local_path} (${data.length} bytes)`);
      } else if (img.original_url) {
        console.log(`  [${i}] downloading from ${img.original_url}...`);
        try {
          const resp = await fetch(img.original_url);
          if (!resp.ok) {
            console.log(`  ⚠️  Download failed: ${resp.status} ${resp.statusText}`);
            allOk = false;
            continue;
          }
          data = Buffer.from(await resp.arrayBuffer());
          console.log(`  [${i}] downloaded (${data.length} bytes)`);
        } catch (err) {
          console.log(`  ⚠️  Download error: ${err}`);
          allOk = false;
          continue;
        }
      } else {
        console.log(`  ⚠️  No local file and no original_url, skipping`);
        allOk = false;
        continue;
      }
      const ext = img.local_path.split('.').pop() || 'jpg';
      const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
      const storageKey = recordFileKey(record.id!, i, 'twitter', ext);

      console.log(`  [${i}] ${img.local_path} (${data.length} bytes) → ${storageKey}`);

      if (!dryRun) {
        await storage.put(storageKey, data, mimeType);
        await insertRecordFile({
          record_id: record.id!,
          source: 'twitter_media',
          source_ref: img.original_url,
          storage_provider: process.env.STORAGE_BACKEND ?? 'local',
          storage_key: storageKey,
          mime_type: mimeType,
          size_bytes: data.length,
          width: img.width,
          height: img.height,
          metadata: img.ocr_text ? { ocr_text: img.ocr_text } : undefined,
        });
      }
      filesUploaded++;
    }

    if (allOk && !dryRun) {
      await db.updateTable('records').set({ images: null }).where('id', '=', record.id!).execute();
      console.log(`  ✅ Migrated, cleared records.images`);
    }
    migrated++;
  }

  console.log(`\n─────────────────────────`);
  console.log(`Records migrated: ${migrated}`);
  console.log(`Files uploaded:    ${filesUploaded}`);
  console.log(`Errors:            ${errors}`);
  console.log(dryRun ? '\n🔍 Dry run complete. Re-run without --dry-run to apply.' : '\n✅ Done!');

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
