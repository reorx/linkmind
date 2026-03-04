import { bootstrapDatabase } from '../db/bootstrap.js';

interface CliArgs {
  databaseUrl?: string;
  adminDatabaseUrl?: string;
  owner?: string;
  dropIfExists: boolean;
  includeBm25: boolean;
  queueName?: string;
}

function printUsage(): void {
  console.log(`Usage: linkmind init-db [options]

Options:
  --database-url <url>    Target app database URL (default: $DATABASE_URL)
  --admin-url <url>       Superuser URL to create DB/extensions (required)
  --owner <role>          Owner for CREATE DATABASE (default: username from database-url)
  --drop                  Drop target database first (DROP DATABASE ... WITH FORCE)
  --skip-bm25             Skip optional baseline SQL 002_bm25_index.sql
  --queue <name>          Also install absurd.sql and ensure queue exists
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dropIfExists: false,
    includeBm25: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--database-url') {
      args.databaseUrl = argv[++i];
    } else if (arg === '--admin-url') {
      args.adminDatabaseUrl = argv[++i];
    } else if (arg === '--owner') {
      args.owner = argv[++i];
    } else if (arg === '--drop') {
      args.dropIfExists = true;
    } else if (arg === '--skip-bm25') {
      args.includeBm25 = false;
    } else if (arg === '--queue') {
      args.queueName = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (or pass --database-url)');
  }

  const adminDatabaseUrl = args.adminDatabaseUrl ?? process.env.ADMIN_DATABASE_URL;
  if (!adminDatabaseUrl) {
    throw new Error('Superuser URL is required (pass --admin-url or set ADMIN_DATABASE_URL)');
  }

  console.log(`Bootstrapping database: ${new URL(databaseUrl).pathname.replace(/^\//, '')}`);
  console.log(`Using admin connection: ${new URL(adminDatabaseUrl).pathname.replace(/^\//, '')}`);

  await bootstrapDatabase({
    databaseUrl,
    adminDatabaseUrl,
    owner: args.owner,
    dropIfExists: args.dropIfExists,
    includeOptionalBm25Migration: args.includeBm25,
    absurdQueueName: args.queueName,
  });

  console.log('Database bootstrap completed.');
}

main().catch((err) => {
  printUsage();
  console.error(err);
  process.exit(1);
});
