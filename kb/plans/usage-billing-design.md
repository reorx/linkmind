# Usage Billing Design

## 概述

为每个用户追踪资源消费（LLM、Crawler、Embedding），以 USD 计费。基于用户自定义计费周期（非自然月）进行用量限制，采用**软限额**策略：超限时阻止新 pipeline 入队，但允许已在执行的 pipeline 完成（避免浪费已消费的资源）。

## 设计决策

基于系统实际规模（invite-only、~10 用户、Absurd worker concurrency=2）做出的关键决策：

1. **软限额而非硬限额** — 入口检查用量，超限不入队。已在执行的 pipeline 允许完成，单次 pipeline 成本 ~$0.001-0.003，过限金额可忽略。
2. **不做 `SELECT FOR UPDATE` 锁** — concurrency 2 + 2 records/user/minute 的限流下，TOCTOU 竞争窗口极小，不值得加锁复杂度。
3. **不建 `usage_cycles` 归档表** — 历史用量可从 `usage_transactions` 按日期范围直接查询，<1000 rows/month，无性能问题。周期重置只需清零余额，不需归档步骤。
4. **Absurd step 级幂等** — 通过 `(record_id, step)` 唯一索引 + `ON CONFLICT DO NOTHING` 防止 Absurd replay 导致的重复计费。
5. **原子事务保证一致性** — `usage_transactions` 插入 + `user_balances` 余额递增在同一 DB 事务中完成，避免漂移。
6. **`recordTransaction` 内部计算费用** — 调用方传入原始用量数据（tokens、provider、model），费用计算集中在一处，减少出错可能。
7. **固定时区计算周期边界** — 使用 `BILLING_TIMEZONE` 环境变量（默认 `Asia/Shanghai`），不做 per-user 时区。

## 数据库设计

### 表 1: `user_balances` — 用户计费状态

```sql
CREATE TABLE user_balances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  cycle_limit_usd NUMERIC(10,4) NOT NULL DEFAULT 1.0000,
  cycle_anchor DATE NOT NULL DEFAULT CURRENT_DATE,
  current_cycle_usage_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  current_cycle_start DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cycle_limit_usd >= 0)
);
```

| 字段 | 说明 |
|------|------|
| `cycle_limit_usd` | 周期限额（USD），默认 $1.00 |
| `cycle_anchor` | 计费周期锚点日期，即用户首次激活/付费的日期，决定每月几号重置 |
| `current_cycle_start` | 当前周期的起始日期 |
| `current_cycle_usage_usd` | 当前周期已消费金额，随每笔 transaction 原子递增 |

### 表 2: `usage_transactions` — 消费明细

```sql
CREATE TABLE usage_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  record_id INTEGER REFERENCES records(id),
  step TEXT,
  type TEXT NOT NULL CHECK (type IN ('llm', 'crawler', 'embedding')),
  provider TEXT NOT NULL,
  amount_usd NUMERIC(10,6) NOT NULL CHECK (amount_usd >= 0),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_tx_user_created ON usage_transactions (user_id, created_at);
CREATE INDEX idx_usage_tx_record ON usage_transactions (record_id);

-- 幂等索引：防止 Absurd replay 导致同一 record 的同一 step 重复计费
CREATE UNIQUE INDEX idx_usage_tx_idempotent
  ON usage_transactions (record_id, step)
  WHERE record_id IS NOT NULL AND step IS NOT NULL;
```

| 字段 | 说明 |
|------|------|
| `step` | Pipeline step 标识: `scrape` \| `summary` \| `embed` \| `insight` 等，用于幂等控制 |
| `type` | 消费类型: `llm` \| `crawler` \| `embedding`（CHECK 约束） |
| `provider` | 供应商: `qwen` \| `gemini` \| `firecrawl` \| `jina` \| `voyage` \| `dashscope` |
| `amount_usd` | 消费金额（USD），由 `recordTransaction` 内部计算，非负（CHECK 约束） |
| `metadata` | 扩展信息，结构因 type 而异（见下方） |

**metadata 结构示例：**

```jsonc
// type: llm
{
  "model": "qwen-plus",
  "input_tokens": 1520,
  "output_tokens": 380
}

// type: embedding
{
  "model": "text-embedding-v3",
  "input_tokens": 256
}

// type: crawler
{
  "url": "https://example.com"
}
```

**幂等机制说明：**

Absurd durable execution 在 crash 后会 replay 未 checkpoint 的 step。如果 `recordTransaction` 的 DB 事务已提交但 Absurd checkpoint 未完成，replay 时会再次调用 `recordTransaction`。唯一索引 `(record_id, step)` + `INSERT ... ON CONFLICT DO NOTHING` 确保：
- 重复插入被静默跳过
- 余额不会重复递增（事务内：插入成功才递增）

## 计费周期逻辑

### 周期计算

锚点日 `cycle_anchor` 决定每月几号重置。例如 `cycle_anchor = 2026-01-15`：

```
周期 1: 01-15 → 02-15
周期 2: 02-15 → 03-15
周期 3: 03-15 → 04-15
...
```

周期区间定义为 **左闭右开** `[cycle_start, next_cycle_start)`。

**月末边界处理：** 锚点日为 31 号时，短月份自动取月末最后一天（如 2 月取 28/29 号）。

**关键：始终用 `cycle_anchor` 的原始日期（anchor day）计算下一周期，不能用 `current_cycle_start` 的日期。** 否则 31号锚点经过 2月29日后，会永远变成 29 号。

```
getNextCycleStart(currentCycleStart: Date, anchorDay: number): Date
  1. targetMonth = currentCycleStart 的下一个月
  2. lastDay = targetMonth 的最后一天
  3. day = min(anchorDay, lastDay)
  4. return targetMonth 的 day 日

示例（anchorDay = 31）：
  01-31 → Feb, min(31,29) = 29 → 02-29
  02-29 → Mar, min(31,31) = 31 → 03-31  ← 回到31，不会卡在29
  03-31 → Apr, min(31,30) = 30 → 04-30
  04-30 → May, min(31,31) = 31 → 05-31  ← 又回到31
```

### 重置触发

不用 cron，采用**惰性重置**：每次 `checkAndGetBudget()` 时检查是否需要重置。

```
checkAndGetBudget(userId):
  1. getOrCreate user_balances 记录（懒初始化）
  2. 计算 next_cycle_start = getNextCycleStart(current_cycle_start, anchorDay)
  3. if today >= next_cycle_start:
     a. 更新 current_cycle_start = next_cycle_start
     b. 清零 current_cycle_usage_usd
     c. (若跨了多个月，循环处理)
  4. 比较 current_cycle_usage_usd vs cycle_limit_usd
  5. 返回 { allowed, usedUsd, limitUsd, cycleStart, cycleEnd }
```

跨多月场景（用户长期未登录）：循环推进 `current_cycle_start`，每次推进一个月，直到 `next_cycle_start > today`。中间周期的历史数据保留在 `usage_transactions` 中，可按日期范围查询。

### 时区

周期边界使用固定时区计算，通过环境变量 `BILLING_TIMEZONE` 配置，默认 `Asia/Shanghai`。

`usage.ts` 中 `getCurrentDate()` 返回的是该时区下的当前日期（DATE 类型），用于与 `current_cycle_start` 比较。`usage_transactions.created_at` 使用 `TIMESTAMPTZ`，不受此影响。

## USD 定价表

基于各 API 官方定价：

### LLM

| Provider | Model | Input (per 1M tokens) | Output (per 1M tokens) |
|----------|-------|----------------------|----------------------|
| DashScope (Qwen) | qwen-plus | ¥0.8 → ~$0.11 | ¥2.0 → ~$0.27 |
| DashScope (Qwen) | qwen-max | ¥2.0 → ~$0.27 | ¥6.0 → ~$0.82 |
| Google | gemini-2.0-flash | $0.10 | $0.40 |

> 汇率按 ¥7.3 = $1 计算，通过环境变量 `CNY_USD_RATE` 可调。

### Embedding

| Provider | Model | Input (per 1M tokens) |
|----------|-------|----------------------|
| DashScope | text-embedding-v3 | ¥0.7 → ~$0.096 |
| Voyage | voyage-4 | $0.03 |

### Crawler

| Provider | 单次调用费用 |
|----------|------------|
| Firecrawl | $0.001 (1 credit) |
| Jina Reader | $0.001 (估算) |

> 实际定价可能变动，通过代码常量定义，便于调整。

## Pipeline 集成

### 入口检查

在 `spawnProcessLink()` 和 `spawnProcessNote()` 调用前，先检查用量：

```
bot.ts / routes/api.ts:
  → checkAndGetBudget(userId)
  → if not allowed: 返回错误提示，不入队
```

**Bot 提示文案：**
```
⚠️ 本周期用量已达上限
已使用: $0.95 / 限额: $1.00
当前周期: 03-15 ~ 04-15
请联系管理员提升额度。
```

### 软限额策略

采用软限额：**入口拦截，执行不中断**。

- 新 pipeline 入队前检查 `checkAndGetBudget()`，超限则拒绝入队
- 已在执行的 pipeline 不做中途检查，允许完成所有 step
- 单次 pipeline 成本 ~$0.001-0.003，超出限额的金额可忽略
- Pipeline 内每个 step 完成后正常调用 `recordTransaction` 记录消费

### 消费记录点

Pipeline 中需要记录消费的位置（每个 step 调用一次 `recordTransaction`）：

```
process-link task:
  ├─ scrapeStepWithFallback
  │   ├─ [crawler] Firecrawl API 调用后 → recordTransaction(step='scrape', type='crawler', ...)
  │   └─ [crawler] Jina API 调用后 → recordTransaction(step='scrape', type='crawler', ...)
  ├─ summarizeStep
  │   └─ [llm] generateSummary / generateHNSummary 后 → recordTransaction(step='summary', type='llm', ...)
  ├─ embedStep
  │   └─ [embedding] createEmbedding 后 → recordTransaction(step='embed', type='embedding', ...)
  └─ insightStep
      └─ [llm] generateInsight 后 → recordTransaction(step='insight', type='llm', ...)

process-note task:
  ├─ noteSummarizeStep
  │   └─ [llm] → recordTransaction(step='summary', type='llm', ...)
  ├─ embedStep
  │   └─ [embedding] → recordTransaction(step='embed', type='embedding', ...)
  └─ noteInsightStep
      └─ [llm] → recordTransaction(step='insight', type='llm', ...)
```

**多次 LLM 调用的 step（如 HN condense retry）：** 同一 step 内若有多次 API 调用，累加 inputTokens 和 outputTokens 后调用一次 `recordTransaction`。费用与 token 成线性关系，合并计算结果一致。

### 缺失用量处理

部分 API 响应可能不包含 token 用量（错误、超时等）：

- 如果 `inputTokens` / `outputTokens` 缺失，传 0 给 `recordTransaction`，费用计算为 $0
- 调用方在传 0 时应同时 log 一条 warning，便于排查
- 不阻断 pipeline 执行

## LLM 层改造

`llm.ts` 中 `chat()` 和 `createEmbedding()` 需要返回 usage 信息：

```typescript
// chat() 返回值改为：
interface ChatResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
  };
}

// createEmbedding() 返回值改为：
interface EmbeddingResult {
  embedding: number[];
  usage?: {
    inputTokens: number;
    model: string;
  };
}
```

OpenAI 兼容 API 和 Gemini API 的 response 都包含 token 用量，直接提取。

## 新模块: `usage.ts`

```typescript
// === 核心函数 ===

// 统一入口：懒初始化 balance + 惰性周期重置 + 限额检查
checkAndGetBudget(userId: number): Promise<{
  allowed: boolean;
  usedUsd: number;
  limitUsd: number;
  cycleStart: Date;
  cycleEnd: Date;
}>

// 记录消费（内部计算费用，原子事务：insert + balance increment）
// 通过 (record_id, step) 幂等，Absurd replay 安全
recordTransaction(params: {
  userId: number;
  recordId?: number;
  step?: string;
} & (
  | { type: 'llm'; provider: string; model: string; inputTokens: number; outputTokens: number; }
  | { type: 'embedding'; provider: string; model: string; inputTokens: number; }
  | { type: 'crawler'; provider: string; url?: string; }
)): Promise<void>

// 付费订阅：重置周期，设置新的锚点日
resetUserCycle(userId: number, newAnchorDate: Date): Promise<void>

// === USD 计算辅助（内部使用，也 export 供测试） ===

calculateLLMCost(provider: string, model: string, inputTokens: number, outputTokens: number): number
calculateEmbeddingCost(provider: string, model: string, inputTokens: number): number
calculateCrawlerCost(provider: string): number

// === 内部辅助 ===

getOrCreateBalance(userId: number): Promise<UserBalance>
getCurrentDate(): Date  // 可 mock，按 BILLING_TIMEZONE 返回当前日期
getNextCycleStart(currentCycleStart: Date, anchorDay: number): Date
```

**`recordTransaction` 内部流程：**

```
1. 根据 type 调用对应的 calculateXCost() 得到 amountUsd
2. 构造 metadata（从 type-specific 字段提取：model、tokens、url 等）
3. 开启 DB 事务：
   a. INSERT INTO usage_transactions ... ON CONFLICT (record_id, step) DO NOTHING RETURNING id
   b. 如果插入成功（有返回 id）：
      UPDATE user_balances SET current_cycle_usage_usd = current_cycle_usage_usd + $amountUsd
4. 事务提交
```

## 用户 Balance 生命周期

### 时机 1: 用户创建（useInvite 激活后）

通过 `getOrCreateBalance()` 懒初始化，首次调用 `checkAndGetBudget()` 时自动创建：

```
cycle_anchor        = 注册日（getCurrentDate()）
current_cycle_start = 注册日
cycle_limit_usd     = 环境变量 DEFAULT_CYCLE_LIMIT_USD 或默认 $1.00
current_cycle_usage_usd = 0
```

也可在 `useInvite` 后主动调用 `getOrCreateBalance()` 提前创建。

### 时机 2: 用户付费订阅

调用 `resetUserCycle(userId, paymentDate)`：

```
1. cycle_anchor        = 付费日
2. current_cycle_start = 付费日
3. current_cycle_usage_usd = 0
4. （可选）cycle_limit_usd 可提升为付费档位
```

`cycle_anchor` 决定"每月几号重置"，付费后锚点跟着付费日走。旧周期的消费明细保留在 `usage_transactions` 中，可按日期范围查询。

**中途付费示例：** 用户 1月15日注册、1月25日付费 → 新周期从25号开始，此后每月25号自动重置。1月15日~25日的用量仍在 `usage_transactions` 中可查。

### 时机 3: 惰性周期重置（checkAndGetBudget 触发）

每次检查限额时自动判断是否跨周期（见上方"重置触发"章节），无需额外操作。

## 管理接口

CLI 命令：
- `set-limit <user_id> <amount>` — 调整用户周期限额
- `usage-report [user_id]` — 查看用量报告
- `reset-cycle <user_id>` — 手动重置周期
- `reconcile-usage [user_id]` — 对账：比较 `SUM(usage_transactions)` vs `current_cycle_usage_usd`，报告差异

## 测试方案

### 测试文件

`server/src/__tests__/usage.test.ts`

使用 test DB（`linkmind_test`），与 pipeline.test.ts 相同的 bootstrap 模式。不跑真实 pipeline，直接调用 `usage.ts` 的函数验证计费逻辑。

### 时间模拟

通过依赖注入或 `vi.useFakeTimers()` 控制当前日期。`usage.ts` 中获取当前日期统一通过一个可 mock 的函数：

```typescript
// usage.ts
export function getCurrentDate(): Date {
  return new Date();
}
```

测试中 mock 这个函数来模拟不同日期。

### 辅助函数

需要一个管理函数用于"付费重置"场景：

```typescript
// 付费订阅：重置周期，设置新的锚点日
resetUserCycle(userId: number, newAnchorDate: Date): Promise<void>
```

该函数：更新 `cycle_anchor` → 更新 `current_cycle_start` → 清零 `current_cycle_usage_usd`。

### 测试用例：完整计费生命周期

模拟 2028 年（闰年，2 月有 29 天）的场景。

```typescript
describe('Usage billing lifecycle', () => {
  // 测试用户，在 beforeAll 中创建
  let userId: number;

  beforeAll(async () => {
    // bootstrap test DB, create user, create user_balances
    // 初始状态：
    //   cycle_anchor = 2028-01-01 (默认注册日)
    //   cycle_limit_usd = 1.00
    //   current_cycle_start = 2028-01-01
    //   current_cycle_usage_usd = 0
  });

  it('Phase 1: 1月31日 — 首次使用产生用量', async () => {
    // 模拟当前日期 = 2028-01-31
    mockCurrentDate(new Date('2028-01-31'));

    // 检查限额 — 应该允许（用量=0，限额=1.00）
    const check1 = await checkAndGetBudget(userId);
    expect(check1.allowed).toBe(true);
    expect(check1.usedUsd).toBe(0);

    // 模拟一次 pipeline 的消费（recordTransaction 内部计算费用）：

    // 1. Firecrawl 抓取: calculateCrawlerCost('firecrawl') = $0.001
    await recordTransaction({
      userId,
      recordId: 1,
      step: 'scrape',
      type: 'crawler',
      provider: 'firecrawl',
      url: 'https://example.com/article1',
    });

    // 2. LLM summarize (qwen-plus): 1500 input + 400 output tokens
    //    cost = calculateLLMCost('qwen', 'qwen-plus', 1500, 400) ≈ $0.000273
    await recordTransaction({
      userId,
      recordId: 1,
      step: 'summary',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-plus',
      inputTokens: 1500,
      outputTokens: 400,
    });

    // 3. Embedding (dashscope): 200 tokens
    //    cost = calculateEmbeddingCost('dashscope', 'text-embedding-v3', 200) ≈ $0.0000192
    await recordTransaction({
      userId,
      recordId: 1,
      step: 'embed',
      type: 'embedding',
      provider: 'dashscope',
      model: 'text-embedding-v3',
      inputTokens: 200,
    });

    // 4. LLM insight (qwen-plus): 800 input + 300 output tokens
    //    cost = calculateLLMCost('qwen', 'qwen-plus', 800, 300) ≈ $0.000169
    await recordTransaction({
      userId,
      recordId: 1,
      step: 'insight',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-plus',
      inputTokens: 800,
      outputTokens: 300,
    });

    // Assert: balance 应该是所有 transaction 费用的总和（内部计算）
    const expectedUsage =
      calculateCrawlerCost('firecrawl') +
      calculateLLMCost('qwen', 'qwen-plus', 1500, 400) +
      calculateEmbeddingCost('dashscope', 'text-embedding-v3', 200) +
      calculateLLMCost('qwen', 'qwen-plus', 800, 300);

    const check2 = await checkAndGetBudget(userId);
    expect(check2.allowed).toBe(true);
    expect(check2.usedUsd).toBeCloseTo(expectedUsage, 6);
    expect(check2.cycleStart).toEqual(new Date('2028-01-01'));

    // 验证 user_balances 表的 current_cycle_usage_usd 也是同步更新的
    const balance = await getBalance(userId);
    expect(Number(balance.current_cycle_usage_usd)).toBeCloseTo(expectedUsage, 6);
  });

  it('Phase 2: 1月31日 — 用户付款订阅，用量立刻重置', async () => {
    // 模拟当前日期仍然是 2028-01-31
    mockCurrentDate(new Date('2028-01-31'));

    // 执行"付款订阅"操作：重置周期，以付费日为新锚点
    await resetUserCycle(userId, new Date('2028-01-31'));

    // Assert: 用量归零
    const check = await checkAndGetBudget(userId);
    expect(check.allowed).toBe(true);
    expect(check.usedUsd).toBe(0);
    expect(check.cycleStart).toEqual(new Date('2028-01-31'));

    // Assert: balance 表更新
    const balance = await getBalance(userId);
    expect(Number(balance.current_cycle_usage_usd)).toBe(0);
    expect(balance.cycle_anchor).toEqual(new Date('2028-01-31'));
    expect(balance.current_cycle_start).toEqual(new Date('2028-01-31'));
  });

  it('Phase 3: 1月31日 — 重置后再次使用资源', async () => {
    mockCurrentDate(new Date('2028-01-31'));

    // 再跑一次 pipeline
    await recordTransaction({
      userId,
      recordId: 2,
      step: 'scrape',
      type: 'crawler',
      provider: 'jina',
      url: 'https://example.com/article2',
    });

    await recordTransaction({
      userId,
      recordId: 2,
      step: 'summary',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-plus',
      inputTokens: 2000,
      outputTokens: 500,
    });

    const expectedUsage =
      calculateCrawlerCost('jina') +
      calculateLLMCost('qwen', 'qwen-plus', 2000, 500);

    const check = await checkAndGetBudget(userId);
    expect(check.allowed).toBe(true);
    expect(check.usedUsd).toBeCloseTo(expectedUsage, 6);
    // 周期起始日还是 1月31日
    expect(check.cycleStart).toEqual(new Date('2028-01-31'));
  });

  it('Phase 4: 2月29日 — 跨周期自动重置（闰年月末边界）', async () => {
    // 锚点日是 1月31日，下一个周期应该从 2月29日开始（2028是闰年，2月只有29天）
    // 模拟日期 = 2028-02-29
    mockCurrentDate(new Date('2028-02-29'));

    // 调用 checkAndGetBudget 触发惰性重置
    const check = await checkAndGetBudget(userId);

    // Assert: 自动重置，用量归零
    expect(check.usedUsd).toBe(0);
    expect(check.allowed).toBe(true);
    // 新周期的起始日应该是 2028-02-29（锚点31号在2月变为月末29号）
    expect(check.cycleStart).toEqual(new Date('2028-02-29'));

    // 旧周期的消费明细仍可从 usage_transactions 按日期查询
  });

  it('Phase 4 续: 2月29日 — 重置后产生新用量，然后超限', async () => {
    mockCurrentDate(new Date('2028-02-29'));

    // 大量消费，逼近限额
    await recordTransaction({
      userId,
      recordId: 3,
      step: 'summary',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-max',
      inputTokens: 50000,
      outputTokens: 10000,
    });

    // 还没超限
    let check = await checkAndGetBudget(userId);
    expect(check.allowed).toBe(true);
    const summaryCost = calculateLLMCost('qwen', 'qwen-max', 50000, 10000);
    expect(check.usedUsd).toBeCloseTo(summaryCost, 4);

    // 再消费一笔，超过 $1.00 限额
    await recordTransaction({
      userId,
      recordId: 3,
      step: 'insight',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-max',
      inputTokens: 50000,
      outputTokens: 10000,
    });

    // 超限了
    check = await checkAndGetBudget(userId);
    expect(check.allowed).toBe(false);
    const totalCost = summaryCost + calculateLLMCost('qwen', 'qwen-max', 50000, 10000);
    expect(check.usedUsd).toBeCloseTo(totalCost, 4);
    expect(check.limitUsd).toBe(1.0);
  });

  it('Phase 5: 幂等 — 重复 recordTransaction 不会重复计费', async () => {
    mockCurrentDate(new Date('2028-02-29'));

    const beforeBalance = await getBalance(userId);
    const beforeUsage = Number(beforeBalance.current_cycle_usage_usd);

    // 重复调用 Phase 4 中已记录的 transaction（相同 record_id + step）
    await recordTransaction({
      userId,
      recordId: 3,
      step: 'summary',
      type: 'llm',
      provider: 'qwen',
      model: 'qwen-max',
      inputTokens: 50000,
      outputTokens: 10000,
    });

    // Assert: 余额没有变化
    const afterBalance = await getBalance(userId);
    expect(Number(afterBalance.current_cycle_usage_usd)).toBe(beforeUsage);
  });
});
```

### 单元测试：周期计算边界

```typescript
describe('Cycle date calculation', () => {
  it('anchor day 31 → Feb 28 (non-leap year)', () => {
    // 2027 不是闰年
    const next = getNextCycleStart(new Date('2027-01-31'), 31);
    expect(next).toEqual(new Date('2027-02-28'));
  });

  it('anchor day 31 → Feb 29 (leap year)', () => {
    // 2028 是闰年
    const next = getNextCycleStart(new Date('2028-01-31'), 31);
    expect(next).toEqual(new Date('2028-02-29'));
  });

  it('anchor day 31 → Mar 31 (back to normal)', () => {
    const next = getNextCycleStart(new Date('2028-02-29'), 31);
    expect(next).toEqual(new Date('2028-03-31'));
  });

  it('anchor day 15 → always 15th', () => {
    const next1 = getNextCycleStart(new Date('2028-01-15'), 15);
    expect(next1).toEqual(new Date('2028-02-15'));

    const next2 = getNextCycleStart(new Date('2028-02-15'), 15);
    expect(next2).toEqual(new Date('2028-03-15'));
  });

  it('anchor day 29 → Feb 28 (non-leap) / Feb 29 (leap)', () => {
    const nonLeap = getNextCycleStart(new Date('2027-01-29'), 29);
    expect(nonLeap).toEqual(new Date('2027-02-28'));

    const leap = getNextCycleStart(new Date('2028-01-29'), 29);
    expect(leap).toEqual(new Date('2028-02-29'));
  });

  it('multi-month skip: if 3 months elapsed, should advance 3 cycles', () => {
    // 用户 3 个月没登录，checkAndGetBudget 应该连续推进 3 个周期
    let date = new Date('2028-01-31');
    date = getNextCycleStart(date, 31);  // → 02-29
    date = getNextCycleStart(date, 31);  // → 03-31
    date = getNextCycleStart(date, 31);  // → 04-30
    expect(date).toEqual(new Date('2028-04-30'));
  });
});
```

### 单元测试：USD 计算

```typescript
describe('Cost calculation', () => {
  it('calculateLLMCost: qwen-plus', () => {
    const cost = calculateLLMCost('qwen', 'qwen-plus', 1000, 500);
    // input: 1000/1M * ¥0.8 / 7.3 ≈ $0.0001096
    // output: 500/1M * ¥2.0 / 7.3 ≈ $0.0001370
    // total ≈ $0.0002466
    expect(cost).toBeCloseTo(0.0002466, 5);
  });

  it('calculateLLMCost: gemini-2.0-flash', () => {
    const cost = calculateLLMCost('gemini', 'gemini-2.0-flash', 1000, 500);
    // input: 1000/1M * $0.10 = $0.0001
    // output: 500/1M * $0.40 = $0.0002
    expect(cost).toBeCloseTo(0.0003, 6);
  });

  it('calculateEmbeddingCost: dashscope', () => {
    const cost = calculateEmbeddingCost('dashscope', 'text-embedding-v3', 500);
    // 500/1M * ¥0.7 / 7.3 ≈ $0.0000479
    expect(cost).toBeCloseTo(0.0000479, 6);
  });

  it('calculateCrawlerCost: firecrawl', () => {
    expect(calculateCrawlerCost('firecrawl')).toBe(0.001);
  });

  it('calculateCrawlerCost: jina', () => {
    expect(calculateCrawlerCost('jina')).toBe(0.001);
  });

  it('zero tokens → zero cost', () => {
    expect(calculateLLMCost('qwen', 'qwen-plus', 0, 0)).toBe(0);
    expect(calculateEmbeddingCost('dashscope', 'text-embedding-v3', 0)).toBe(0);
  });
});
```

### 运行方式

```bash
cd server && npx vitest run src/__tests__/usage.test.ts
```

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `server/src/db/migrations/YYYY-MM-DDTHHMM-usage-billing.ts` | 新建 2 张表（`user_balances`, `usage_transactions`） |
| `server/src/db/types.ts` | 新增表类型定义 + Database 注册 |
| `server/src/db/usage.ts` | **新建** — DB 操作层（CRUD、事务） |
| `server/src/usage.ts` | **新建** — 业务逻辑层（`checkAndGetBudget`、`recordTransaction`、USD 计算） |
| `server/src/llm.ts` | `chat()` 和 `createEmbedding()` 返回 usage 元数据 |
| `server/src/agent.ts` | 各 generate 函数透传 usage 信息 |
| `server/src/scraper-firecrawl.ts` | 返回值标记 provider |
| `server/src/scraper-jina.ts` | 返回值标记 provider |
| `server/src/pipeline.ts` | 每个 step 后调用 `recordTransaction`；入口加 `checkAndGetBudget` |
| `server/src/bot.ts` | pipeline 入口前检查限额，超限返回提示 |
| `server/src/__tests__/usage.test.ts` | **新建** — 计费逻辑测试 |
