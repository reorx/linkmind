---
created: 2026-03-04
tags:
  - durable-execution
  - idempotency
  - architecture
  - billing
---

# Durable Execution and Idempotency of Side Effects

## Core Insight

All side effects (DB writes, API calls, emails, etc.) inside durable execution workflow steps must be idempotent. This is true regardless of which engine you use — Absurd, Inngest, Temporal, Durable Objects, etc.

## Why

Durable execution engines guarantee **at-least-once** execution of steps, not exactly-once. The engine's "exactly-once" guarantee only applies to its own internal state (step memoization/checkpointing). Your application's side effects are outside that boundary.

The critical window:

```
1. Step callback starts
2. ... do work ...
3. Your DB transaction commits (side effect)
4. Step callback returns
5. Engine checkpoints the step result (separate write)
```

If the process crashes between step 3 and 5 — your DB write committed, but the engine didn't checkpoint. On replay, the engine re-runs the entire step, causing a duplicate side effect.

This is fundamentally a **two-system commit problem**: your DB and the engine's checkpoint store are two separate systems. No matter how you arrange the operations, there's a window where one succeeds and the other doesn't.

## Standard Solution

Use idempotency keys with unique constraints:

```sql
-- Example: unique index for pipeline step billing
CREATE UNIQUE INDEX idx_usage_tx_idempotent
  ON usage_transactions (record_id, step)
  WHERE record_id IS NOT NULL AND step IS NOT NULL;
```

In application code:

```sql
INSERT INTO usage_transactions (...) VALUES (...)
ON CONFLICT (record_id, step) DO NOTHING
RETURNING id;
-- Only increment balance if insert succeeded (id returned)
```

## Key Nuance

Even if `recordTransaction` is the **last** operation in a step, and uses a DB transaction, the problem persists — because the DB transaction and the engine's checkpoint are still two separate operations. Being last in the step minimizes the window but doesn't eliminate it.

## Authoritative Sources

- **Temporal** (official blog): "Temporal recommends Activities be idempotent... Activity execution is not atomic due to factors such as failures, timeouts, environment failure, or other conditions that lead to partial success." — [Understanding idempotency in distributed systems](https://temporal.io/blog/idempotency-and-durable-execution)
- **Inngest** (official docs): "Re-running a step upon error requires its code to be idempotent, which means that running the same code multiple times won't have any side effect." — [Handling idempotency](https://www.inngest.com/docs/guides/handling-idempotency)
- **Inngest** (blog): Completed steps are skipped via memoization, but the currently executing step runs again in full — including any DB writes it already made. — [Principles of Durable Execution](https://www.inngest.com/blog/principles-of-durable-execution)

## Practical Considerations

For low-throughput systems (e.g., concurrency 2, ~10 users), the crash-in-the-exact-window probability is near-zero. The idempotency index is cheap insurance (one line of DDL + `ON CONFLICT DO NOTHING`), not a critical requirement. But it's the correct engineering practice.
