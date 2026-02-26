import dotenv from 'dotenv';
// Only load .env if key env var is not already set (compatible with --env-file and Docker)
if (!process.env.DATABASE_URL) {
  dotenv.config({ override: true });
}

import fs from 'fs';

const command = process.argv[2];
// Remove command name so subcommands see clean argv
process.argv.splice(2, 1);

if (!command) {
  const dir = new URL('./cli/', import.meta.url);
  const files = fs.readdirSync(dir);
  console.log('Available commands:');
  for (const f of files) {
    if (f.endsWith('.js') || f.endsWith('.ts')) {
      console.log(`  ${f.replace(/\.(js|ts)$/, '')}`);
    }
  }
  process.exit(0);
}

try {
  // Try .js first (compiled), then .ts (tsx dev)
  try {
    await import(`./cli/${command}.js`);
  } catch (err: any) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      await import(`./cli/${command}.ts`);
    } else {
      throw err;
    }
  }
} catch (err: any) {
  if (err.code === 'ERR_MODULE_NOT_FOUND' && err.message?.includes(`./cli/${command}`)) {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
  throw err;
}
