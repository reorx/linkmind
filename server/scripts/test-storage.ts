/**
 * Quick smoke test for storage backend.
 * Usage: npx tsx scripts/test-storage.ts
 */
import 'dotenv/config';
import { getStorage, recordFileKey } from '../src/storage/index.js';

async function main() {
  const storage = getStorage();
  const key = recordFileKey(99999, 0, 'test', 'txt');
  const data = Buffer.from('hello linkmind storage test');

  console.log(`Backend: ${process.env.STORAGE_BACKEND}`);
  console.log(`Key: ${key}`);

  // Put
  await storage.put(key, data, 'text/plain');
  console.log('✅ put OK');

  // Exists
  const exists = await storage.exists(key);
  console.log(`✅ exists: ${exists}`);

  // Get
  const got = await storage.get(key);
  console.log(`✅ get OK, content: "${got.toString()}"`);

  // GetUrl
  const url = storage.getUrl(key);
  console.log(`✅ url: ${url}`);

  // Delete
  await storage.delete(key);
  console.log('✅ delete OK');

  // Verify deleted
  const gone = await storage.exists(key);
  console.log(`✅ exists after delete: ${gone}`);

  console.log('\n🎉 All storage tests passed!');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
