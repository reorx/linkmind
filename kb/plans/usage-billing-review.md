# Usage Billing Design Review

## Critical

1. **Budget enforcement is race-prone (TOCTOU between check and spend)**
- `checkUsageLimit()` runs before enqueue/start, but actual charges are recorded later and possibly in multiple async steps.
- Concurrent requests can all pass the pre-check and overspend the same limit by a large margin.
- **Recommendation:** enforce limit in the same DB transaction as charge posting (or implement a reservation/hold mechanism). For hard limits, use row-level lock on `user_balances` (`SELECT ... FOR UPDATE`) and reject when `current_cycle_usage_usd + pending/new_charge > monthly_limit_usd`.

2. **No idempotency strategy for `recordTransaction()` under retries/replays**
- Pipeline steps can retry (network issues, worker restart, duplicate delivery), which would double-charge.
- **Recommendation:** add an idempotency key (e.g. `task_id + step + attempt_group` or provider request id) with a unique index in `usage_transactions`; make insert upsert-safe.

3. **Concurrent lazy reset can corrupt/archive inconsistently**
- Multiple workers calling `checkUsageLimit()` for same user may both try to rotate cycle and insert `usage_cycles` row.
- Current design has `UNIQUE(user_id, cycle_start)`, so one path may fail and break request flow unless explicitly handled.
- **Recommendation:** perform cycle rotation in a transaction with `FOR UPDATE` lock on `user_balances`; use deterministic upsert for `usage_cycles` and re-read state after conflict.

4. **`resetUserCycle()` (payment event) can race with in-flight usage writes**
- If payment reset runs while pipeline steps still charge old cycle, you can lose/duplicate usage attribution across cycles.
- **Recommendation:** serialize per-user billing mutations (same locking strategy), and define ordering: reset must atomically archive old state and move anchor before accepting further writes.

5. **No guarantee that `current_cycle_usage_usd` matches transaction ledger**
- Design keeps both aggregate (`user_balances.current_cycle_usage_usd`) and detail rows (`usage_transactions`), but no reconciliation plan.
- Drift can happen from partial failures or manual fixes.
- **Recommendation:** treat transaction insert + balance increment as one atomic transaction; add periodic reconciliation job/CLI (`SUM(usage_transactions)` vs balance) and repair tooling.

6. **Time boundary semantics are underspecified and error-prone**
- Uses `DATE` + “today >= next_cycle_start”, but user timezone vs server timezone not defined.
- Around UTC/local midnight, users can be billed into wrong cycle.
- **Recommendation:** store billing timezone per user (or system-wide explicit timezone), compute boundaries with `TIMESTAMPTZ` instants, and clearly define interval as `[cycle_start, next_cycle_start)`.

## Important

1. **Hard cap is only checked at entry, not during pipeline execution**
- Long pipelines can continue charging after crossing limit.
- **Recommendation:** decide policy explicitly:
  - `soft cap`: allow current job to finish, block new jobs.
  - `hard cap`: check budget before each chargeable step and abort remaining steps when exceeded.

2. **Pricing model/versioning is missing**
- Prices are hardcoded and can change; Jina is “estimated”.
- Re-running historical cost calc with updated constants becomes inconsistent.
- **Recommendation:** snapshot unit price and FX used into each transaction metadata (`unit_price`, `currency`, `fx_rate`, `price_version`, `billed_at`).

3. **Floating-point risk in app-layer cost math**
- JS `number` can accumulate precision error.
- **Recommendation:** calculate in integer micros/cents in code, or use decimal library, then persist as `NUMERIC`.

4. **Schema constraints are too loose**
- `type` and `provider` are free text; `amount_usd` can be negative unless constrained.
- **Recommendation:** add CHECK constraints / enums:
  - `type IN ('llm','crawler','embedding')`
  - provider whitelist (or provider table FK)
  - `amount_usd >= 0`
  - `monthly_limit_usd >= 0`

5. **Cycle archival semantics need exact definition**
- `cycle_end` currently appears inclusive in examples, while reset trigger uses next cycle start.
- **Recommendation:** define one model globally:
  - store `cycle_start` and `cycle_end_exclusive` (preferred), or
  - if inclusive `DATE`, document exactly how transaction timestamps map.

6. **Missing behavior for absent/partial provider usage data**
- Some API responses may omit usage (errors/streaming edge cases).
- **Recommendation:** define fallback policy: estimate, defer charge, or mark transaction as `pending_estimate` with later reconciliation.

7. **User creation path assumptions may be incomplete**
- Design says create balance on `useInvite`, but not all user creation flows may go through this path.
- **Recommendation:** enforce via DB trigger/default bootstrap path or central `ensureUserBillingProfile()` called from all auth/onboarding paths.

8. **Testing plan lacks concurrency and failure-injection cases**
- Current tests focus on happy path/date edges.
- **Recommendation:** add tests for:
  - concurrent `checkUsageLimit` + `recordTransaction`
  - duplicate retry with same idempotency key
  - reset during in-flight charge
  - transaction failure between ledger insert and balance update

## Minor

1. **`monthly_limit_usd` naming mismatch**
- Actual cycle is anchor-based monthly-ish period, not necessarily calendar month.
- **Suggestion:** rename to `cycle_limit_usd` to reduce ambiguity.

2. **Potential hot-path index improvement**
- If frequently querying current-cycle totals from ledger, index `(user_id, created_at DESC)` is okay but may still scan large ranges.
- **Suggestion:** consider partitioning or BRIN for long-term growth, or rely on maintained aggregate as source of truth.

3. **Metadata shape is informal**
- JSONB is flexible but can become inconsistent.
- **Suggestion:** define JSON schema per `type`, validate in app layer, and include mandatory fields (`model`, `label`, etc.) where applicable.

4. **File path section appears inconsistent with repo conventions**
- “`db/migrations/...`” vs likely `server/src/db/migrations/...`.
- **Suggestion:** align doc paths to actual monorepo layout to reduce implementation drift.

## Nice-to-have

1. **Quota reservation API**
- Introduce `reserveBudget(userId, amount)` + `commit/release` for better hard-limit guarantees before expensive calls.

2. **Billing audit trail for admin actions**
- Record who changed limit/reset cycle and why (`actor`, `reason`, `old_value`, `new_value`).

3. **Operational dashboards/alerts**
- Add metrics for over-limit rejects, idempotency conflicts, reconciliation drift, and pricing-version distribution.

4. **Backfill/recompute utility**
- CLI to recompute charges for a date range under a fixed `price_version` (for audits/migrations), without mutating historical billed rows unless explicitly requested.

