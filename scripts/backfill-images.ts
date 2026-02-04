/**
 * Backfill script: Download images and extract OCR for existing Twitter links.
 *
 * Usage: npx tsx scripts/backfill-images.ts [--dry-run] [--limit N]
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { processTwitterImages } from '../src/image-handler.js';

const execFileAsync = promisify(execFile);

const PG_URL = process.env.DATABASE_URL;
if (!PG_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

interface TwitterMedia {
  type: string;
  url: string;
}

/**
 * Check if a URL is a Twitter/X tweet URL.
 */
function isTwitterUrl(url: string): boolean {
  const u = new URL(url);
  return (
    (u.hostname === 'twitter.com' ||
      u.hostname === 'www.twitter.com' ||
      u.hostname === 'x.com' ||
      u.hostname === 'www.x.com') &&
    /\/status\/\d+/.test(u.pathname)
  );
}

/**
 * Fetch tweet media via bird CLI.
 */
async function fetchTweetMedia(url: string): Promise<TwitterMedia[]> {
  const { stdout } = await execFileAsync('bird', ['read', '--json', '--cookie-source', 'chrome', url], {
    timeout: 30000,
  });
  const tweet = JSON.parse(stdout);
  return tweet.media || [];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) : undefined;

  console.log(`Backfill Twitter images ${dryRun ? '(dry run)' : ''}`);
  if (limit) console.log(`Limiting to ${limit} links`);

  const pool = new pg.Pool({ connectionString: PG_URL });
  const client = await pool.connect();

  try {
    // Find Twitter links without images
    let query = `
      SELECT id, url FROM links
      WHERE status = 'analyzed'
        AND (images IS NULL OR images = '[]')
      ORDER BY id DESC
    `;
    if (limit) query += ` LIMIT ${limit}`;

    const { rows } = await client.query<{ id: number; url: string }>(query);

    // Filter to Twitter URLs only
    const twitterLinks = rows.filter((r) => {
      try {
        return isTwitterUrl(r.url);
      } catch {
        return false;
      }
    });

    console.log(`Found ${twitterLinks.length} Twitter links to process`);

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const link of twitterLinks) {
      console.log(`\n[${link.id}] Processing: ${link.url}`);

      if (dryRun) {
        console.log('  → Skipped (dry run)');
        skipped++;
        continue;
      }

      try {
        // Fetch media from Twitter
        const media = await fetchTweetMedia(link.url);
        const photos = media.filter((m) => m.type === 'photo');

        if (photos.length === 0) {
          console.log('  → No photos found');
          skipped++;
          continue;
        }

        console.log(`  → Found ${photos.length} photos`);

        // Process images
        const images = await processTwitterImages(link.id, media);

        if (images.length > 0) {
          // Update database
          await client.query('UPDATE links SET images = $1, updated_at = NOW() WHERE id = $2', [
            JSON.stringify(images),
            link.id,
          ]);

          const ocrCount = images.filter((img) => img.ocr_text).length;
          console.log(`  → Saved ${images.length} images (${ocrCount} with OCR)`);
          processed++;
        } else {
          console.log('  → Failed to download images');
          skipped++;
        }
      } catch (err) {
        console.error(`  → Error: ${err instanceof Error ? err.message : String(err)}`);
        errors++;
      }
    }

    console.log('\n─────────────────────────');
    console.log(`Processed: ${processed}`);
    console.log(`Skipped:   ${skipped}`);
    console.log(`Errors:    ${errors}`);
    console.log('Done!');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
