/**
 * CLI: Audit LLM output token usage for truncation signs.
 *
 * Groups usage_transactions (type=llm) by step × model, shows output_tokens
 * distribution and flags calls that hit the max_tokens cap (default 2048).
 * For flagged insight/summary calls, prints the tail of the stored text so
 * truncation can be eyeballed.
 *
 * Usage: npx tsx src/cli.ts admin-llm-audit [--days N] [--cap N] [--list]
 */

import pg from 'pg';

const PG_URL = process.env.DATABASE_URL;
if (!PG_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

function argValue(name: string, fallback: number): number {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = Number(process.argv[idx + 1]);
  if (!Number.isFinite(v)) {
    console.error(`Invalid value for ${name}`);
    process.exit(1);
  }
  return v;
}

const days = argValue('--days', 30);
const cap = argValue('--cap', 2048);
const listAll = process.argv.includes('--list');

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });

  try {
    const { rows: stats } = await pool.query(
      `SELECT step,
              metadata->>'model' AS model,
              COUNT(*) AS calls,
              ROUND(AVG((metadata->>'output_tokens')::int)) AS avg_out,
              MAX((metadata->>'output_tokens')::int) AS max_out,
              COUNT(*) FILTER (WHERE (metadata->>'output_tokens')::int >= $2) AS at_cap
       FROM usage_transactions
       WHERE type = 'llm' AND created_at > now() - make_interval(days => $1)
       GROUP BY step, metadata->>'model'
       ORDER BY step, model`,
      [days, cap],
    );

    console.log(`\nLLM calls in last ${days} days (cap threshold: ${cap} output tokens):`);
    console.log(
      `${'Step'.padEnd(14)} ${'Model'.padEnd(20)} ${'Calls'.padEnd(6)} ${'AvgOut'.padEnd(7)} ${'MaxOut'.padEnd(7)} AtCap`,
    );
    console.log('-'.repeat(64));
    for (const r of stats) {
      console.log(
        `${(r.step ?? '-').padEnd(14)} ${(r.model ?? '-').padEnd(20)} ${String(r.calls).padEnd(6)} ${String(r.avg_out ?? '-').padEnd(7)} ${String(r.max_out ?? '-').padEnd(7)} ${r.at_cap}`,
      );
    }

    const { rows: capped } = await pool.query(
      `SELECT t.id, t.record_id, t.step, t.created_at,
              (t.metadata->>'output_tokens')::int AS output_tokens,
              r.url, r.status,
              RIGHT(r.summary, 60) AS summary_tail,
              RIGHT(r.insight, 60) AS insight_tail
       FROM usage_transactions t
       LEFT JOIN records r ON r.id = t.record_id
       WHERE t.type = 'llm'
         AND t.created_at > now() - make_interval(days => $1)
         AND (t.metadata->>'output_tokens')::int >= $2
       ORDER BY t.created_at DESC`,
      [days, cap],
    );

    console.log(`\nCalls at/over cap (${capped.length}):`);
    for (const r of capped) {
      console.log(
        `  tx=${r.id} record=${r.record_id ?? '-'} step=${r.step} out=${r.output_tokens} status=${r.status ?? '-'} ${new Date(r.created_at).toISOString().slice(0, 16)}`,
      );
      if (r.url) console.log(`    url: ${String(r.url).slice(0, 80)}`);
      const tail = r.step === 'insight' ? r.insight_tail : r.summary_tail;
      if (tail) console.log(`    ${r.step} tail: …${tail.replace(/\n/g, '\\n')}`);
    }

    if (listAll) {
      const { rows: recent } = await pool.query(
        `SELECT t.record_id, t.step, (t.metadata->>'output_tokens')::int AS output_tokens,
                t.created_at, RIGHT(r.insight, 40) AS insight_tail
         FROM usage_transactions t
         LEFT JOIN records r ON r.id = t.record_id
         WHERE t.type = 'llm' AND t.created_at > now() - make_interval(days => $1)
         ORDER BY t.created_at DESC
         LIMIT 100`,
        [days],
      );
      console.log(`\nRecent LLM calls (${recent.length}):`);
      for (const r of recent) {
        console.log(
          `  record=${r.record_id ?? '-'} ${String(r.step ?? '-').padEnd(12)} out=${String(r.output_tokens).padEnd(6)} ${new Date(r.created_at).toISOString().slice(0, 16)}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main();
