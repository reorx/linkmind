# Plan: Jina Reader API 集成 + crawler_api_keys 表

## 背景

- Playwright 对有 paywall 的站点（如 NYT）无法抓取正文内容
- Firecrawl 明确不支持 NYT（403）
- Jina Reader API (`r.jina.ai`) 可以穿透 paywall，成功获取 NYT 全文
- Jina 免费 tier 有 token 限额，需要支持多 API key 轮换

## 目标

1. 接入 Jina Reader API 作为 scrape fallback
2. 建立 `crawler_api_keys` 表管理 crawler 的 API key（支持多种 crawler 类型扩展）
3. 提供 Admin UI 管理 keys

## Fallback Chain（新顺序）

```
Playwright + Defuddle
  → 内容有效？✅ 返回
  → ❌ Jina Reader API（key 池轮换）
    → 内容有效？✅ 返回
    → ❌ Firecrawl API
      → 内容有效？✅ 返回
      → ❌ Probe fallback（推给本地 daemon）
```

## 实现步骤

### Step 1: crawler_api_keys 数据库表

**Migration**: `server/src/db/migrations/2026-02-28T1730-crawler-api-keys.ts`

```sql
CREATE TABLE crawler_api_keys (
  id SERIAL PRIMARY KEY,
  crawler_type TEXT NOT NULL,        -- 'jina', 'firecrawl', etc.
  label TEXT NOT NULL,               -- 人类可读标签，如 'free-account-1'
  api_key TEXT NOT NULL,
  total_credits BIGINT NOT NULL DEFAULT 0,    -- 该 key 的总额度
  used_credits BIGINT NOT NULL DEFAULT 0,     -- 已消耗额度（原子累加）
  exhausted BOOLEAN NOT NULL DEFAULT FALSE,   -- 收到 402 时标记
  enabled BOOLEAN NOT NULL DEFAULT TRUE,      -- 手动启用/禁用
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_crawler_api_keys_type ON crawler_api_keys (crawler_type);
```

**初始数据**（通过 Admin UI 或 migration seed）：

| crawler_type | label | api_key | total_credits |
|---|---|---|---|
| jina | free-account-1 | jina_70b0...8UTG | 10000000 |

### Step 2: crawler_api_keys 数据访问层

**文件**: `server/src/crawler-keys.ts`

```ts
interface CrawlerApiKey {
  id: number;
  crawler_type: string;
  label: string;
  api_key: string;
  total_credits: number;
  used_credits: number;
  exhausted: boolean;
  enabled: boolean;
}

// 获取某类型的下一个可用 key（round-robin，跳过 exhausted 和 disabled）
async function getNextCrawlerKey(type: string): Promise<CrawlerApiKey | null>

// 原子累加 used_credits：UPDATE ... SET used_credits = used_credits + $1, updated_at = NOW()
async function addKeyUsage(keyId: number, credits: number): Promise<void>

// 标记 key 为 exhausted
async function markKeyExhausted(keyId: number): Promise<void>

// 获取某类型的所有 keys（Admin UI 用）
async function getCrawlerKeys(type?: string): Promise<CrawlerApiKey[]>
```

**Round-robin 策略**：
- 进程内维护一个 `lastUsedIndex: Map<string, number>`
- `getNextCrawlerKey('jina')` 从上次用的下一个开始，跳过 `exhausted=true` 或 `enabled=false` 的
- 所有 key 都不可用时返回 null

### Step 3: Jina Reader scraper

**文件**: `server/src/scraper-jina.ts`

参考 `scraper-firecrawl.ts` 的模式：

```ts
export interface JinaResult {
  markdown: string;
  metadata: {
    title?: string;
    description?: string;
    ogImage?: string;
    siteName?: string;
    publishedTime?: string;
  };
  usage: {
    tokens: number;
  };
}

export async function scrapeWithJina(url: string): Promise<JinaResult | null>
```

**Jina API 调用方式**:
```
GET https://r.jina.ai/<url>
Headers:
  Authorization: Bearer <api_key>
  Accept: application/json
```

**返回 JSON 结构**（从实测确认）:
```json
{
  "code": 200,
  "data": {
    "title": "...",
    "description": "...",
    "url": "...",
    "content": "... (markdown)",
    "publishedTime": "...",
    "usage": { "tokens": 2575 }
  }
}
```

**Key 轮换逻辑**:
1. `getNextCrawlerKey('jina')` 获取一个 key
2. 调用 Jina API
3. 成功：从 `data.usage.tokens` 提取消耗，`addKeyUsage(key.id, tokens)` 原子累加
4. 402/429：`markKeyExhausted(key.id)`，尝试下一个 key
5. 最多尝试所有可用 key
6. 全部失败返回 null

**Token 跟踪**（Jina 无余额查询 API，只能被动跟踪）:
- 每次成功调用后，原子操作 `UPDATE crawler_api_keys SET used_credits = used_credits + $tokens WHERE id = $id`
- 无竞争条件，多个并发请求也能正确累加
- Admin UI 可看到每个 key 的 used_credits / total_credits 进度
- key 耗尽（402）时自动标记 exhausted，后续请求跳过

### Step 4: 更新 fallback chain

**文件**: `server/src/scraper.ts` — `scrapeWithFallbackChain()`

在 Playwright retry 和 Firecrawl 之间插入 Jina step：

```ts
// 现有: Playwright → Playwright retry → Firecrawl
// 改为: Playwright → Playwright retry → Jina → Firecrawl
```

trace 新增 step 类型: `'jina'`

```ts
export interface ScrapeTraceEntry {
  step: 'playwright' | 'playwright-retry' | 'jina' | 'firecrawl';
  // ...
}
```

### Step 5: Admin UI — crawler_api_keys 管理页面

**路由**: 在 `server/src/routes/admin.ts` 中新增

- `GET /admin/crawler-keys` — 列表页面，显示所有 key 及状态/消耗进度
- `POST /admin/crawler-keys` — 新增 key
- `POST /admin/crawler-keys/:id/toggle` — 启用/禁用
- `POST /admin/crawler-keys/:id/reset` — 重置 used_credits 和 exhausted 状态
- `POST /admin/crawler-keys/:id/delete` — 删除 key

**模板**: `server/src/views/admin/crawler-keys.ejs`

- 表格展示：type, label, key（遮掩）, used/total credits, 进度条, exhausted 状态, enabled 状态
- 操作按钮：启用/禁用、重置、删除
- 新增表单：type, label, api_key, total_credits

**认证**: 复用现有 `requireAdminPage` middleware

### Step 6: test-scrape CLI 支持 jina mode

**文件**: `server/src/cli/test-scrape.ts`

新增 `jina` mode，方便单独测试 Jina scraper。
注意：test-scrape 的 jina mode 直接用环境变量或传参的 key 测试，不走 crawler_api_keys 表。

### Step 7: Kysely 类型更新

在 DB 类型定义中添加 `crawler_api_keys` 表的类型。

## 文件变更清单

| 文件 | 操作 |
|------|------|
| `server/src/db/migrations/2026-02-28T1730-crawler-api-keys.ts` | 新建 |
| `server/src/crawler-keys.ts` | 新建 |
| `server/src/scraper-jina.ts` | 新建 |
| `server/src/scraper.ts` | 修改（fallback chain + trace 类型） |
| `server/src/routes/admin.ts` | 修改（新增 crawler-keys 路由） |
| `server/src/views/admin/crawler-keys.ejs` | 新建 |
| `server/src/cli/test-scrape.ts` | 修改（新增 jina mode） |
| `server/src/db/types.ts` | 修改（新增 crawler_api_keys 表类型） |

## 测试验证

1. 跑 migration，确认 crawler_api_keys 表创建成功
2. 通过 Admin UI 添加 Jina API key
3. `test-scrape jina <nyt-url>` 验证 Jina 单独能抓取
4. `test-scrape playwright <nyt-url>` 验证 fallback chain 自动走到 Jina 并成功
5. 检查 crawler_api_keys 表中 used_credits 是否正确累加
6. typecheck + 现有测试通过
