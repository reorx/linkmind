/**
 * CLI: Manually reset a user's billing cycle (zero usage, anchor = today).
 * Usage: npx tsx src/cli.ts admin-reset-cycle <user_id|username>
 */

import { getUserById, getUserByUsername } from '../db/index.js';
import { resetUserCycle, getBalance, getCurrentDate } from '../usage.js';
import { initLogger } from '../logger.js';

initLogger();

const userArg = process.argv[2];
if (!userArg) {
  console.error('Usage: admin-reset-cycle <user_id|username>');
  process.exit(1);
}

const user = /^\d+$/.test(userArg) ? await getUserById(Number(userArg)) : await getUserByUsername(userArg);
if (!user) {
  console.error(`User not found: ${userArg}`);
  process.exit(1);
}

const before = await getBalance(user.id!);
if (!before) {
  console.error(`User ${user.id} has no balance row (never consumed anything); nothing to reset`);
  process.exit(1);
}

await resetUserCycle(user.id!, getCurrentDate());
const after = await getBalance(user.id!);
console.log(
  `User ${user.id} (${user.username ?? '-'}): usage $${Number(before.current_cycle_usage_usd).toFixed(4)} → $${Number(after!.current_cycle_usage_usd).toFixed(4)}, ` +
    `new cycle starts ${after!.current_cycle_start.toISOString().slice(0, 10)}`,
);
process.exit(0);
