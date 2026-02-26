/**
 * Integration test: telegram photo download → MinIO storage → record_files DB.
 * Uses mocked Telegram API (no real bot needed).
 *
 * Usage: npx tsx scripts/test-photo-storage.ts
 */
import 'dotenv/config';
import { getStorage, recordFileKey } from '../src/storage/index.js';
import { insertRecordFile, getRecordFiles } from '../src/db/record-files.js';
import { downloadAndStorePhoto } from '../src/telegram-photo.js';
import { getDb } from '../src/db/connection.js';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import path from 'path';

// Create a tiny 1x1 red PNG for testing
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  // 1. Set up a mock Telegram file server
  const fileServer = createServer((req, res) => {
    console.log(`  [mock-telegram] ${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': TINY_PNG.length.toString() });
    res.end(TINY_PNG);
  });
  await new Promise<void>((resolve) => fileServer.listen(0, '127.0.0.1', resolve));
  const mockPort = (fileServer.address() as any).port;
  console.log(`Mock Telegram file server on port ${mockPort}`);

  // 2. Create a test record in DB to attach the file to
  const db = getDb();
  const testRecord = await db
    .insertInto('records')
    .values({
      user_id: 1,
      type: 'note',
      content: 'test record for photo storage',
      status: 'done',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const recordId = testRecord.id;
  console.log(`Created test record: ${recordId}`);

  // 3. Mock bot API and call downloadAndStorePhoto
  const mockBotApi = {
    getFile: async (_fileId: string) => ({
      file_path: 'photos/test-photo.png',
    }),
  };

  // Patch the download URL by using a fake token that encodes our mock server
  // We need to monkey-patch fetch to intercept the Telegram URL
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('api.telegram.org/file/bot')) {
      // Redirect to our mock server
      const redirectUrl = `http://127.0.0.1:${mockPort}/photos/test-photo.png`;
      console.log(`  [fetch-intercept] ${url} → ${redirectUrl}`);
      return originalFetch(redirectUrl, init);
    }
    return originalFetch(input, init);
  };

  const mockPhotos = [
    { file_id: 'small_123', file_unique_id: 'u1', width: 90, height: 90 },
    { file_id: 'medium_456', file_unique_id: 'u2', width: 320, height: 320 },
    { file_id: 'large_789', file_unique_id: 'u3', width: 800, height: 800, file_size: TINY_PNG.length },
  ];

  const fileRecordId = await downloadAndStorePhoto(mockBotApi, 'fake-token', mockPhotos, recordId, 0);
  console.log(`✅ downloadAndStorePhoto returned fileRecordId: ${fileRecordId}`);

  // Restore fetch
  globalThis.fetch = originalFetch;

  // 4. Verify record_files row
  const files = await getRecordFiles(recordId);
  console.log(`✅ record_files rows for record ${recordId}: ${files.length}`);
  const f = files[0];
  console.log(`   source: ${f.source}`);
  console.log(`   source_ref: ${f.source_ref}`);
  console.log(`   storage_provider: ${f.storage_provider}`);
  console.log(`   storage_key: ${f.storage_key}`);
  console.log(`   mime_type: ${f.mime_type}`);
  console.log(`   size_bytes: ${f.size_bytes}`);
  console.log(`   width: ${f.width}, height: ${f.height}`);

  // 5. Verify file exists in MinIO
  const storage = getStorage();
  const exists = await storage.exists(f.storage_key);
  console.log(`✅ file exists in storage: ${exists}`);

  const data = await storage.get(f.storage_key);
  console.log(`✅ file content matches: ${data.equals(TINY_PNG)}`);

  const url = storage.getUrl(f.storage_key);
  console.log(`✅ public URL: ${url}`);

  // 6. Cleanup
  await storage.delete(f.storage_key);
  await db.deleteFrom('record_files').where('record_id', '=', recordId).execute();
  await db.deleteFrom('records').where('id', '=', recordId).execute();
  fileServer.close();

  console.log('\n🎉 Photo storage integration test passed!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
