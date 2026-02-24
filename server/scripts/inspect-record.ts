import dotenv from 'dotenv';
dotenv.config({ path: '.env.prod', override: true });

import { getRecord } from '../src/db/index.js';

const id = parseInt(process.argv[2] || '78', 10);
const r = await getRecord(id);
if (!r) {
  console.log('not found');
  process.exit();
}
console.log('URL:', r.url);
console.log('Title:', r.og_title);
console.log('Status:', r.status);
console.log('Markdown length:', r.markdown?.length);
console.log('---MARKDOWN (first 800)---');
console.log(r.markdown?.slice(0, 800));
console.log('---SUMMARY---');
console.log(r.summary);
console.log('---INSIGHT---');
console.log(r.insight);
process.exit();
