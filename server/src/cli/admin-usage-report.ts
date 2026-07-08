/**
 * CLI: Usage report — all users' balances, or one user's breakdown by step/type.
 * Usage: npx tsx src/cli.ts admin-usage-report [user_id|username] [--limit N]
 */

import { getUserById, getUserByUsername } from '../db/index.js';
import { getBalance } from '../usage.js';
import { getAllBalancesWithUsers, getTransactionsByUserId } from '../db/usage.js';
import { initLogger } from '../logger.js';

initLogger();

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const limitIdx = process.argv.indexOf('--limit');
const txLimit = limitIdx !== -1 ? Number(process.argv[limitIdx + 1]) : 500;

async function reportAll() {
  const balances = await getAllBalancesWithUsers();
  console.log(`\nUser balances (${balances.length}):`);
  console.log(
    `${'ID'.padEnd(5)} ${'Username'.padEnd(20)} ${'Used'.padEnd(10)} ${'Limit'.padEnd(8)} ${'Cycle start'.padEnd(12)} Anchor`,
  );
  console.log('-'.repeat(70));
  for (const b of balances) {
    console.log(
      `${String(b.user_id).padEnd(5)} ${(b.username ?? '-').padEnd(20)} ` +
        `$${Number(b.current_cycle_usage_usd).toFixed(4).padEnd(9)} ` +
        `$${Number(b.cycle_limit_usd).toFixed(2).padEnd(7)} ` +
        `${b.current_cycle_start.toISOString().slice(0, 10).padEnd(12)} ` +
        `${b.cycle_anchor.toISOString().slice(0, 10)}`,
    );
  }
}

async function reportUser(userArg: string) {
  const user = /^\d+$/.test(userArg) ? await getUserById(Number(userArg)) : await getUserByUsername(userArg);
  if (!user) {
    console.error(`User not found: ${userArg}`);
    process.exit(1);
  }

  const balance = await getBalance(user.id!);
  console.log(`\nUser ${user.id} (${user.username ?? '-'})`);
  if (!balance) {
    console.log('No balance row — user has no usage yet.');
    return;
  }
  console.log(
    `Cycle: ${balance.current_cycle_start.toISOString().slice(0, 10)} (anchor ${balance.cycle_anchor.toISOString().slice(0, 10)})`,
  );
  console.log(
    `Usage: $${Number(balance.current_cycle_usage_usd).toFixed(4)} / $${Number(balance.cycle_limit_usd).toFixed(2)}`,
  );

  const txs = await getTransactionsByUserId(user.id!, txLimit);
  const inCycle = txs.filter((t) => new Date(t.created_at) >= balance.current_cycle_start);

  const byKey = new Map<string, { count: number; usd: number }>();
  for (const t of inCycle) {
    const key = `${t.type}/${t.step ?? '-'}`;
    const agg = byKey.get(key) ?? { count: 0, usd: 0 };
    agg.count += 1;
    agg.usd += Number(t.amount_usd);
    byKey.set(key, agg);
  }

  console.log(`\nCurrent cycle breakdown (${inCycle.length} transactions):`);
  console.log(`${'Type/Step'.padEnd(24)} ${'Count'.padEnd(6)} USD`);
  console.log('-'.repeat(44));
  for (const [key, agg] of [...byKey.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`${key.padEnd(24)} ${String(agg.count).padEnd(6)} $${agg.usd.toFixed(6)}`);
  }
}

if (args.length === 0) {
  await reportAll();
} else {
  await reportUser(args[0]);
}
process.exit(0);
