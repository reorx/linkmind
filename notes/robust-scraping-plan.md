# Plan: Robust Scraping with Fallback Chain

## 背景

当前 `scrapeUrl()` 使用 Playwright + Defuddle 抓取网页内容。对于 SPA/PWA 类网站（如 `note.mowen.cn`），虽然能拿到 title，但提取不到正文内容（`chars: 0`），导致 pipeline 在 summarize 步骤因 `markdown` 为空而失败。

### 失败案例
- URL: `https://note.mowen.cn/detail/FP0rFh9XewHUSKnjEZhmI`
- scrape 阶段拿到了 title，但 `chars: 0`
- 错误: `Record markdown not found after scrape`
- Absurd 重试 3 次均失败

## 目标

在 `scrapeStep` 中实现 fallback chain，使内容获取更加 robust：

```
Playwright + Defuddle (现有)
    ↓ 内容为空或过短
Firecrawl API
    ↓ 失败或内容为空
Probe (用户本地设备)
```

## 方案设计

### 1. 内容质量判定

在 `scraper.ts` 中新增判定函数，判断 scrape 结果是否有效：

```typescript
function isScrapeContentValid(markdown: string, minChars = 50): boolean {
  return markdown.trim().length >= minChars;
}
```

### 2. Firecrawl 抓取模块

新建 `server/src/scraper-firecrawl.ts`：

```typescript
// POST https://api.firecrawl.dev/v2/scrape
// Authorization: Bearer <FIRECRAWL_API_KEY>
// Body: { url, formats: ["markdown"], onlyMainContent: true }
// 返回: { success, data: { markdown, metadata: { title, description, ogImage, ... } } }
```

**接口要点：**
- Endpoint: `POST https://api.firecrawl.dev/v2/scrape`
- Auth: Bearer token（环境变量 `FIRECRAWL_API_KEY`）
- 请求体: `{ url, formats: ["markdown"], onlyMainContent: true }`
- 响应: `{ success: true, data: { markdown, metadata: { title, description, sourceURL, ... } } }`
- 无需额外依赖，直接用 `fetch` 调用

### 3. 修改 scrapeStep 中的 fallback 逻辑

改造 `pipeline.ts` 中现有 scrape 流程。目前的结构是：

```
if (params.scrapeData)     → 使用 probe 提供的数据
else if (isTwitterUrl)     → 创建 probe event，等待 probe
else                       → scrapeStep() 直接 Playwright 抓取
```

改造后的 **else 分支**（非 Twitter、非 probe 数据的普通 URL）：

```
1. Playwright + Defuddle 抓取
2. 判断内容是否有效 (isScrapeContentValid)
   ├─ 有效 → 继续 pipeline
   └─ 无效 →
       3. 尝试 Firecrawl API
       4. 判断 Firecrawl 结果是否有效
          ├─ 有效 → 用 Firecrawl 结果更新 record，继续 pipeline
          └─ 无效 →
              5. 创建 probe event，等待 probe 回传
              （与现有 Twitter probe 机制复用）
```

**关键设计点：**

- **Fallback 在 scrapeStep 内部完成**，对 pipeline 其他步骤透明
- 每层 fallback 结果都走同一个 `updateRecord()` 路径
- 添加 `scrape_source` 字段到 record（值: `playwright` | `firecrawl` | `probe`），方便追踪
- Firecrawl 失败不算致命错误，只 log warning 继续走 probe

### 4. 扩展 Probe fallback 到所有 URL 类型

当前 probe 只用于 Twitter URL。改造后：
- 任何 URL 在 Playwright + Firecrawl 都拿不到内容时，都可以 fallback 到 probe
- `createProbeEvent` 的 `url_type` 扩展：`twitter` | `web`（新增）
- probe 端无需修改（已经支持通用网页抓取）

### 5. 文件改动清单

| 文件 | 改动 |
|------|------|
| `server/src/scraper-firecrawl.ts` | **新建** — Firecrawl API 调用封装 |
| `server/src/scraper.ts` | 导出 `isScrapeContentValid` 函数 |
| `server/src/pipeline.ts` | 改造 scrapeStep，加入 fallback chain |
| `server/.env.example` | 添加 `FIRECRAWL_API_KEY` |
| DB migration | 添加 `scrape_source` 字段到 records 表（可选，后续再加） |

### 6. 环境变量

```env
FIRECRAWL_API_KEY=fc-xxx  # Firecrawl API Key
```

Firecrawl 不配置时跳过该层 fallback，直接进 probe。

## 不在本次范围

- Firecrawl 的 `actions`（浏览器操作）功能——先用默认抓取，效果已经足够好
- 抓取重试策略调整——Absurd 自带 exponential backoff 已够用
- `scrape_source` DB migration——先用日志追踪，后续有需要再加字段
