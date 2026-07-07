/**
 * CLI: Show probe_events backlog and waiting_probe records.
 * Usage: npx tsx src/cli.ts admin-probe-stats [--list]
 */

import pg from 'pg';

const PG_URL = process.env.DATABASE_URL;
if (!PG_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const listEvents = process.argv.includes('--list');

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });

  try {
    const { rows: eventStats } = await pool.query(
      `SELECT status, url_type, COUNT(*) as count, MIN(created_at) as oldest
       FROM probe_events
       GROUP BY status, url_type
       ORDER BY status, url_type`,
    );

    console.log(`\nprobe_events by status × url_type:`);
    console.log(`${'Status'.padEnd(12)} ${'UrlType'.padEnd(10)} ${'Count'.padEnd(7)} Oldest`);
    console.log('-'.repeat(60));
    for (const r of eventStats) {
      console.log(
        `${r.status.padEnd(12)} ${r.url_type.padEnd(10)} ${String(r.count).padEnd(7)} ${new Date(r.oldest).toISOString()}`,
      );
    }

    const { rows: recordStats } = await pool.query(
      `SELECT status, COUNT(*) as count FROM records GROUP BY status ORDER BY status`,
    );

    console.log(`\nrecords by status:`);
    for (const r of recordStats) {
      console.log(`  ${r.status.padEnd(15)} ${r.count}`);
    }

    if (listEvents) {
      const { rows: pending } = await pool.query(
        `SELECT id, user_id, link_id, url_type, status, created_at, url
         FROM probe_events
         WHERE status IN ('pending', 'sent')
         ORDER BY created_at ASC`,
      );
      console.log(`\npending/sent probe_events (${pending.length}):`);
      for (const r of pending) {
        console.log(
          `  ${r.id}  user=${r.user_id} link=${r.link_id ?? '-'} ${r.url_type} ${r.status} ${new Date(r.created_at).toISOString().slice(0, 16)} ${r.url.slice(0, 60)}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
