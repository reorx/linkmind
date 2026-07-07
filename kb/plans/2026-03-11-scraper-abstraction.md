# Scraper Refactoring: Registry + YouTube Support

## Context

当前 scraper 代码散落在 `server/src/` 下多个平级文件中（`scraper.ts`, `scraper-crawlee.ts`, `scraper-firecrawl.ts`, `scraper-jina.ts`, `scraper-substance.ts`），URL 路由逻辑分散在 `scraper.ts` 和 `pipeline.ts` 的 if/else 中。为了方便添加新的 URL 类型处理（如 YouTube），需要建立清晰的 scraper 抽象：统一接口、注册机制、URL 分发。

本次重构分两个 Phase：
- **Phase 1**（本次执行）：Scraper 抽象层 + 文件重组 + YouTube stub
- **Phase 2**（后续执行）：内容有效性验证机制，将 re-scrape 逻辑从 pipeline 下沉到 scraper 层

---

## Architecture

### 调用链总览

```
                          Pipeline (process-link)
                                 │
                          ┌──────┴──────┐
                          │ findScraper │
                          │   (url)     │
                          └──────┬──────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │ matched          │ matched           │ no match
              ▼                  ▼                   ▼
     ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐
     │ twitterScrp │   │ youtubeScrp  │   │    webScraper    │
     │  .scrape()  │   │  .scrape()   │   │    .scrape()     │
     └──────┬──────┘   └──────┬───────┘   └────────┬─────────┘
            │                 │                     │
            ▼                 ▼                     ▼
     ┌────────────┐   ┌────────────┐    ┌─────────────────────────────┐
     │ Create     │   │ Google API │    │  Internal Fallback Chain    │
     │ ProbeEvent │   │ (stub now) │    │                             │
     │ via ctx    │   └────────────┘    │  Crawlee ──▶ Playwright    │
     └────────────┘                     │     │            │          │
     status:                            │     ▼            ▼          │
     waiting_probe                      │  Substance?  Substance?    │
                                        │  (WeChat/HN)  (WeChat/HN)  │
                                        │     │            │          │
                                        │     ▼            ▼          │
                                        │  Defuddle    Defuddle      │
                                        │                             │
                                        │  ──▶ Jina ──▶ Firecrawl   │
                                        │                             │
                                        │  ──▶ Probe (last resort)   │
                                        └─────────────────────────────┘

返回值: ScrapeStepResult
  │
  ├── { status: 'ok', data: ScrapeResult }
  ├── { status: 'waiting_probe', eventId: string }
  └── { status: 'failed', error: string }
```

### 核心概念

**Scraper = Fetch + Extract 的黑盒**。每个 ScraperModule 内部自行决定如何获取原始内容（Fetch）和如何提取结构化数据（Extract），对外只暴露 `scrape(url, ctx?)` 方法。

**两层 URL 分流机制**：
1. **Pipeline 层**：`findScraper(url)` 按注册顺序匹配，first match wins。matched 的 URL 交给专属 scraper，失败则整体失败（不 fallback 到 web chain）。
2. **Web Scraper 内部**：对于 unmatched 的通用 URL，webScraper 内部维护 Crawlee → Playwright → Jina → Firecrawl 的 fallback chain。在 Crawlee 和 Playwright 的 Extract 阶段，还有一次子分流——Substance extractor 按 URL 匹配特定站点（WeChat、HN），匹配则用专用提取器，否则用 Defuddle 通用提取。

---

## 支持的内容类型

### Twitter/X

**概述**：Twitter 链接通过 probe 机制处理——server 端不直接抓取，而是创建 probe event，由本地 probe daemon 使用 bird CLI（读取 Chrome cookies）抓取后回传结果。

**URL 匹配**：`twitter.com`、`x.com`（含 www 前缀），路径包含 `/status/<id>`。

**处理逻辑**：
```
twitterScraper.scrape(url, ctx)
  │
  ├── ctx 存在（pipeline 调用）
  │     → 创建 probe_event (url_type: 'twitter')
  │     → 更新 record status → waiting_probe
  │     → 推送 SSE 事件到 probe
  │     → 返回 { status: 'waiting_probe', eventId }
  │
  └── ctx 不存在（admin/CLI test-scrape 调用）
        → 返回 { status: 'failed', error: 'Twitter requires probe context' }
```

Probe 端收到事件后：`bird read --json --cookie-source chrome <url>` → 解析 JSON → 构建 markdown（推文文本 + 引用 + 媒体 + 互动数据）→ POST 回 server → `handleProbeResult()` 恢复 pipeline。

**核心代码**：`scraper/twitter.ts`（ScraperModule 包装 + probe event 创建）

### YouTube

**概述**：YouTube 视频链接的专属处理。Phase 1 只注册 stub，Phase 2 接入 Google YouTube Data API 获取视频元数据和字幕。

**URL 匹配**：`youtube.com`、`www.youtube.com`、`m.youtube.com`、`youtu.be`。

**处理逻辑（Phase 1 stub）**：
```
youtubeScraper.scrape(url, ctx?)
  → 返回 { status: 'failed', error: 'YouTube scraper not yet implemented' }
```

**核心代码**：`scraper/youtube.ts`

### Web（通用网页）

**概述**：所有未被其他 ScraperModule 匹配的 URL 走此路径。内部维护多级 fallback chain，逐一尝试直到获得有效内容（≥ 200 字符）。

**URL 匹配**：`match()` 始终返回 `true`，作为 registry 中的最后一个 module（兜底）。

**处理逻辑**：
```
webScraper.scrape(url, ctx?)
  │
  ├── Step 0: Crawlee (PlaywrightCrawler + 指纹轮换)
  │     → 浏览器渲染 → DOM 预处理 → Substance? → Defuddle → markdown
  │
  ├── Step 1: Playwright + Defuddle (直连)
  │     → chromium + stealth → DOM 预处理 → Substance? → Defuddle → markdown
  │
  ├── Step 2: Playwright 重试
  │     → 同 Step 1，应对瞬时失败
  │
  ├── Step 3: Jina Reader API (key 轮换)
  │     → GET https://r.jina.ai/<url> → markdown
  │
  ├── Step 4: Firecrawl API
  │     → POST /v2/scrape → markdown
  │
  └── Step 5: Probe fallback（仅当 ctx 存在时）
        → 创建 probe_event (url_type: 'browser')
        → 返回 { status: 'waiting_probe', eventId }

  每步完成后检查内容有效性（≥ 200 chars），有效则立即返回 { status: 'ok', data }。
  全部失败 → { status: 'failed', error }（或 waiting_probe）
```

**Substance Extractor 子分流**（在 Crawlee 和 Playwright 的 Extract 阶段内部）：
```
拿到浏览器渲染后的 HTML
  │
  ├── hasSubstanceExtractor(url) === true
  │     → extractWithSubstance(html, url)
  │     → 使用 Cheerio + Substance 框架 + 站点专用 Extractor
  │     → 成功则直接返回，失败则 fallthrough 到 Defuddle
  │
  └── 无匹配 extractor
        → Defuddle 通用提取 → htmlToSimpleMarkdown()
```

目前注册的 Substance Extractor：
- **WeChat**（`mp.weixin.qq.com`）：提取 `#js_content` 正文，处理懒加载图片、自定义标签（`<mp-common-profile>`）、公众号元数据
- **Hacker News**（`news.ycombinator.com`）：使用 `@substancejs/common` 内置提取器，长帖自动 condense 评论

**核心代码**：`scraper/web.ts`（Playwright 单次）、`scraper/web-fallback-chain.ts`（完整 fallback chain）、`scraper/substance.ts`（Substance 分发）、`scraper/extractors/wechat.ts`（WeChat 专用）

---

## Phase 1: Scraper 抽象层（本次执行）

### ScraperModule 接口

```typescript
interface ScrapeContext {
  userId: number;
  recordId: number;
}

type ScrapeStepResult =
  | { status: 'ok'; data: ScrapeResult }
  | { status: 'waiting_probe'; eventId: string }
  | { status: 'failed'; error: string };

interface ScraperModule {
  name: string;
  match(url: string): boolean;
  scrape(url: string, ctx?: ScrapeContext): Promise<ScrapeStepResult>;
}
```

- `match` 同步检查 URL 是否匹配
- `scrape` 黑盒方法，内部自行决定 Fetch + Extract 方式
- `ctx` 可选——pipeline 调用时传入，admin/CLI test-scrape 不传
- 注册顺序即优先级，first match wins
- webScraper 作为最后一个注册（`match: () => true`），兜底所有 unmatched URL

### 注册机制

```typescript
const scraperModules: ScraperModule[] = [
  twitterScraper,
  youtubeScraper,
  webScraper,  // 兜底，match 始终返回 true
];
```

### Pipeline 集成

重构后，pipeline 中 scrape step 的路由逻辑简化为：

```typescript
// 之前: if (isTwitterUrl) { probe... } else { scrapeStepWithFallback()... }
// 之后:
const scraper = findScraper(url);  // 一定会命中（webScraper 兜底）
const result = await scraper.scrape(url, { userId, recordId });

switch (result.status) {
  case 'ok':
    // 继续 summarize step
    break;
  case 'waiting_probe':
    // 更新 record status, return
    break;
  case 'failed':
    // 标记失败
    break;
}
```

Twitter 的 probe 逻辑从 pipeline 移入 `twitterScraper.scrape()` 内部。
Web 的 probe fallback 从 pipeline 移入 `webScraper.scrape()` 内部。

### 目录结构

```
server/src/scraper/
├── types.ts              # ScrapeResult, ScrapeStepResult, ScrapeContext, ScraperModule 接口
├── index.ts              # Registry, findScraper(), re-exports
├── twitter.ts            # Twitter scraper (probe event 创建)
├── youtube.ts            # YouTube scraper stub
├── web.ts                # scrapeUrl() - Playwright+Defuddle 单次抓取
├── web-fallback-chain.ts # scrapeWithFallbackChain() 完整 fallback chain
├── crawlee.ts            # Crawlee (PlaywrightCrawler + 指纹)
├── firecrawl.ts          # Firecrawl API
├── jina.ts               # Jina Reader API
├── substance.ts          # Substance extractor 分发
└── extractors/
    └── wechat.ts         # WeChat 专用 extractor
```

### Implementation Steps

#### 1. `core/src/scraper-utils.ts` — 添加 isYouTubeUrl

```typescript
export function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === 'www.youtube.com' ||
      u.hostname === 'youtube.com' ||
      u.hostname === 'm.youtube.com' ||
      u.hostname === 'youtu.be'
    );
  } catch {
    return false;
  }
}
```

#### 2. `core/src/types.ts` — 扩展 UrlType

```typescript
export type UrlType = 'twitter' | 'youtube' | 'web';
```

#### 3. 创建 `server/src/scraper/types.ts`

从 `scraper.ts` 提取，并新增接口：
- `ScraperModule` 接口（新增）
- `ScrapeContext` 接口（新增）
- `ScrapeStepResult` 联合类型（新增）
- `ScrapeResult` 接口
- `ScrapeChainResult` 接口
- `ScrapeTraceEntry` 接口
- `isScrapeContentValid()` 函数
- `MIN_CONTENT_CHARS` 常量
- `decodeUnicodeEscapes()` helper

#### 4. 移动现有文件到 `server/src/scraper/`

按依赖顺序：

| 原文件 | 新文件 | 变更 |
|--------|--------|------|
| `extractors/wechat.ts` | `scraper/extractors/wechat.ts` | 无内容变更 |
| `scraper-substance.ts` | `scraper/substance.ts` | import ScrapeResult from `./types.js`; WechatExtractor from `./extractors/wechat.js` |
| `scraper-crawlee.ts` | `scraper/crawlee.ts` | import from `./substance.js`, `./types.js` |
| `scraper-firecrawl.ts` | `scraper/firecrawl.ts` | 无类型变更 |
| `scraper-jina.ts` | `scraper/jina.ts` | 无类型变更 |

#### 5. 创建 `server/src/scraper/twitter.ts`

从 `scraper.ts` 提取 `scrapeTwitter()` 逻辑，包装为 ScraperModule。

关键变更：probe event 创建逻辑从 pipeline.ts 移入此处。

```typescript
import { isTwitterUrl } from '@linkmind/core/scraper-utils';
import type { ScraperModule, ScrapeStepResult, ScrapeContext } from './types.js';

async function scrapeTwitter(url: string, ctx?: ScrapeContext): Promise<ScrapeStepResult> {
  if (!ctx) {
    return { status: 'failed', error: 'Twitter requires probe context, cannot test directly' };
  }
  // 创建 probe_event, 推送 SSE, 返回 waiting_probe
  // ...原 pipeline.ts 中的 probe event 创建逻辑...
  return { status: 'waiting_probe', eventId };
}

export const twitterScraper: ScraperModule = {
  name: 'twitter',
  match: isTwitterUrl,
  scrape: scrapeTwitter,
};
```

#### 6. 创建 `server/src/scraper/web.ts`

从 `scraper.ts` 提取 `scrapeUrl()` (Playwright+Defuddle 单次抓取)：
- **移除 Twitter 路由**（`if (isTwitterUrl(url))` 分支），只保留 Playwright+Defuddle 逻辑
- Substance extractor 调用保留在内部
- import 从 `./substance.js` 和 `./types.js`

#### 7. 创建 `server/src/scraper/web-fallback-chain.ts`

从 `scraper.ts` 提取 `scrapeWithFallbackChain()`，并包装为 ScraperModule：

```typescript
import type { ScraperModule, ScrapeStepResult, ScrapeContext } from './types.js';

// ... scrapeWithFallbackChain 逻辑不变，但：
// - dynamic import 路径更新为 ./crawlee.js, ./jina.js, ./firecrawl.js
// - scrapeUrl import from ./web.js
// - probe fallback 逻辑：当 ctx 存在时创建 probe_event，否则跳过

export const webScraper: ScraperModule = {
  name: 'web',
  match: () => true,  // 兜底，匹配所有 URL
  scrape: async (url, ctx?) => {
    const result = await scrapeWithFallbackChain(url, ctx);
    // 将 ScrapeChainResult 转换为 ScrapeStepResult
    // ...
  },
};
```

#### 8. 创建 `server/src/scraper/youtube.ts`

```typescript
import { isYouTubeUrl } from '@linkmind/core/scraper-utils';
import type { ScraperModule } from './types.js';

export const youtubeScraper: ScraperModule = {
  name: 'youtube',
  match: isYouTubeUrl,
  scrape: async (url) => {
    return { status: 'failed', error: `YouTube scraper not yet implemented for: ${url}` };
  },
};
```

#### 9. 创建 `server/src/scraper/index.ts`

```typescript
import { twitterScraper } from './twitter.js';
import { youtubeScraper } from './youtube.js';
import { webScraper } from './web-fallback-chain.js';
import type { ScraperModule } from './types.js';

export type { ScrapeResult, ScrapeChainResult, ScrapeTraceEntry, ScraperModule, ScrapeContext, ScrapeStepResult } from './types.js';
export { isScrapeContentValid } from './types.js';

const scraperModules: ScraperModule[] = [twitterScraper, youtubeScraper, webScraper];

export function findScraper(url: string): ScraperModule {
  // webScraper 兜底，一定会命中
  return scraperModules.find(s => s.match(url))!;
}

export { scrapeWithFallbackChain } from './web-fallback-chain.js';
export { scrapeUrl } from './web.js';
export { isTwitterUrl } from '@linkmind/core/scraper-utils';
```

#### 10. 更新 Pipeline 集成

`pipeline.ts` 中的 scrape step 改为：

```typescript
import { findScraper } from './scraper/index.js';

// 替换原有的 if (isTwitterUrl) / else { scrapeStepWithFallback() } 逻辑
const scraper = findScraper(url);
const result = await scraper.scrape(url, { userId, recordId });

switch (result.status) {
  case 'ok':
    scrapeData = result.data;
    break;
  case 'waiting_probe':
    await updateRecord(recordId, { status: 'waiting_probe' });
    return;
  case 'failed':
    // 标记错误
    break;
}
```

需要将 pipeline.ts 中的 probe event 创建代码（`createProbeEvent`、`pushEventToProbe`）提取为可复用函数，供 `twitter.ts` 和 `web-fallback-chain.ts` 调用。

#### 11. 更新 import 引用

| 文件 | 旧 import | 新 import |
|------|-----------|-----------|
| `pipeline.ts` | `from './scraper.js'` | `from './scraper/index.js'` |
| `pipeline.ts` | `from './scraper-firecrawl.js'` | **删除**（未使用的 dead import） |
| `routes/admin.ts` | `from '../scraper.js'` | `from '../scraper/index.js'` |
| `cli/test-scrape.ts` | 多个 scraper 文件 import | 更新到 `../scraper/` 路径 |
| `cli/check-crawlee.ts` | `from '../scraper-crawlee.js'` + `'../scraper.js'` | `from '../scraper/crawlee.js'` + `'../scraper/index.js'` |
| `__tests__/hn-extractor.test.ts` | `from '../scraper-substance.js'` | `from '../scraper/substance.js'` |
| `__tests__/wechat-extractor.test.ts` | `from '../scraper-substance.js'` + `'../extractors/wechat.js'` | `from '../scraper/substance.js'` + `'../scraper/extractors/wechat.js'` |

admin test-scrape 也改为走 `findScraper()` 分流。对于需要 probe 的 URL 类型（如 Twitter），返回提示信息而非抛错。

#### 12. 删除旧文件

- `server/src/scraper.ts`
- `server/src/scraper-crawlee.ts`
- `server/src/scraper-firecrawl.ts`
- `server/src/scraper-jina.ts`
- `server/src/scraper-substance.ts`
- `server/src/extractors/wechat.ts`（及空的 extractors 目录）

#### 13. 构建 core

`core/` 添加了 `isYouTubeUrl` 和 `UrlType` 变更，需要 rebuild：
```bash
pnpm --filter @linkmind/core run build
```

---

## Phase 2: 内容有效性验证（后续执行）

### 问题

当前 pipeline 中，scrape 完成后走 summarize step，如果 LLM 判定 `valid_content=false`，会回退执行 re-scrape（`scrapeStepWithFallback(skipPlaywright=true)`）。这导致：
1. Summarize step 里耦合了 scraper 的重试逻辑
2. 在 Absurd durable execution 中无法真正"回退"，只能在 step 内部 inline 处理
3. 每个 step 不够纯粹

### 方案：ScraperModule.validate()

在 ScraperModule 接口中增加可选的 `validate` 方法，让内容有效性检查在 scraper 层解决：

```typescript
interface ScraperModule {
  name: string;
  match(url: string): boolean;
  scrape(url: string, ctx?: ScrapeContext): Promise<ScrapeStepResult>;
  validate?(data: ScrapeResult): Promise<boolean>;  // Phase 2 新增
}
```

**设计思路**：

1. `scrape()` 内部在返回 `{ status: 'ok' }` 之前，调用自身的 `validate()` 检查结果
2. `webScraper.validate()` 可以调用一个快速 LLM（如 Gemini Flash）做内容有效性判断——替代当前 summarize step 中的 `valid_content` 检查
3. 如果 validate 失败且还有未尝试的 fetch 方法，scraper 内部自动切换到下一个 fetch 方法重试
4. 所有重试在 `scrape()` 内部闭环，pipeline 拿到的永远是最终结果

**好处**：
- Pipeline 中移除 re-scrape 逻辑，每个 step 保持纯粹
- 内容有效性问题在 scraper 层彻底解决，不会"跑到下一步发现有问题还要跑回来"
- 与 Absurd durable execution 的单向流程兼容

**待定事项**：
- validate 使用的 LLM 模型选择（需要快且便宜）
- validate prompt 设计（从 summarize step 中提取 valid_content 判断逻辑）
- 对于 Twitter、YouTube 等类型是否也需要 validate（可能不需要——结构化 API 返回的数据天然有效）

---

## Verification

```bash
# 类型检查
pnpm typecheck

# 测试
pnpm test

# 构建
pnpm build
```
