import fs from 'fs';
import pg from 'pg';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: linkmind run-sql <sql-file>');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const sql = fs.readFileSync(filePath, 'utf-8');
const client = new pg.Client(process.env.DATABASE_URL);

await client.connect();
console.log(`Executing ${filePath}...`);
await client.query(sql);
console.log('Done.');
await client.end();
