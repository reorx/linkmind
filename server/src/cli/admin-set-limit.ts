/**
 * CLI: Set a user's cycle spending limit (USD).
 * Usage: npx tsx src/cli.ts admin-set-limit <user_id|username> <amount_usd>
 */

import { getUserById, getUserByUsername } from '../db/index.js';
import { setUserLimit, getBalance } from '../usage.js';
import { initLogger } from '../logger.js';

initLogger();

async function resolveUserId(arg: string): Promise<number> {
  const user = /^\d+$/.test(arg) ? await getUserById(Number(arg)) : await getUserByUsername(arg);
  if (!user) {
    console.error(`User not found: ${arg}`);
    process.exit(1);
  }
  return user.id!;
}

const userArg = process.argv[2];
const amountArg = process.argv[3];
if (!userArg || !amountArg) {
  console.error('Usage: admin-set-limit <user_id|username> <amount_usd>');
  process.exit(1);
}

const amount = Number(amountArg);
if (!Number.isFinite(amount) || amount < 0) {
  console.error(`Invalid amount: ${amountArg}`);
  process.exit(1);
}

const userId = await resolveUserId(userArg);
await setUserLimit(userId, amount);
const balance = await getBalance(userId);
console.log(
  `User ${userId}: cycle_limit_usd = $${Number(balance!.cycle_limit_usd).toFixed(2)}, ` +
    `current usage = $${Number(balance!.current_cycle_usage_usd).toFixed(4)}`,
);
process.exit(0);
