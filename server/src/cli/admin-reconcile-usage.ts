/**
 * CLI: Reconcile usage — compare SUM(usage_transactions) in the current cycle
 * against user_balances.current_cycle_usage_usd and report drift.
 * Usage: npx tsx src/cli.ts admin-reconcile-usage [user_id|username]
 */

import { getUserById, getUserByUsername } from '../db/index.js';
import { reconcileUsage } from '../usage.js';
import { initLogger } from '../logger.js';

initLogger();

const userArg = process.argv[2];
let userId: number | undefined;
if (userArg) {
  const user = /^\d+$/.test(userArg) ? await getUserById(Number(userArg)) : await getUserByUsername(userArg);
  if (!user) {
    console.error(`User not found: ${userArg}`);
    process.exit(1);
  }
  userId = user.id!;
}

const rows = await reconcileUsage(userId);
const EPSILON = 0.000001;

console.log(`\nReconciliation (${rows.length} user(s)):`);
console.log(
  `${'ID'.padEnd(5)} ${'Username'.padEnd(20)} ${'TxSum'.padEnd(11)} ${'Balance'.padEnd(11)} ${'Diff'.padEnd(11)} Status`,
);
console.log('-'.repeat(72));
let driftCount = 0;
for (const r of rows) {
  const drifted = Math.abs(r.diffUsd) > EPSILON;
  if (drifted) driftCount++;
  console.log(
    `${String(r.userId).padEnd(5)} ${(r.username ?? '-').padEnd(20)} ` +
      `$${r.txSumUsd.toFixed(6).padEnd(10)} $${r.balanceUsd.toFixed(6).padEnd(10)} ` +
      `${(r.diffUsd >= 0 ? '+' : '') + r.diffUsd.toFixed(6)}`.padEnd(12) +
      (drifted ? ' ⚠️ DRIFT' : ' ok'),
  );
}
console.log(
  driftCount === 0 ? `\nAll ${rows.length} balance(s) in sync.` : `\n${driftCount}/${rows.length} balance(s) drifted.`,
);
process.exit(0);
