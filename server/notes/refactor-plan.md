# Refactor Plan: Pipeline as Single Source of Truth

## 目标

消除 `pipeline.ts` 和 `worker.ts` 的重复实现，让 pipeline 成为唯一的业务逻辑层。

## 现状

```
bot.ts ──→ worker.ts (spawnProcessLink) ──→ Absurd task ──→ 自己实现 scrape/analyze/export
web.ts ──→ worker.ts (spawnProcessLink) ──→ 同上
web.ts ──→ pipeline.ts (retryLink)      ──→ 自己实现 scrape/analyze/export（有 Twitter 图片 + OCR）
```

两套实现，功能不一致（worker 缺 Twitter 图片处理 + OCR）。

## 目标架构

```
bot.ts ──→ pipeline.ts (spawnProcessLink)
web.ts ──→ pipeline.ts (spawnProcessLink / retryLink / deleteLinkFull)

pipeline.ts 内部:
  - processUrl()      → upsert link → spawnProcessLink() → Absurd task
  - spawnProcessLink() → getAbsurd().spawn('process-link', ...)
  - startWorker()      → registerTasks() + getAbsurd().startWorker()

  Absurd 'process-link' task:
    step('scrape')  → scrapeStep(linkId, url)
    step('analyze') → analyzeStep(linkId, url, scrapeData)
    step('export')  → exportStep(linkId)

  各 step 函数是 pipeline.ts 内的具体实现（包含 Twitter 图片、OCR 等完整逻辑）
```

## 具体步骤

### Step 1: 把 Worker 的 Absurd 基础设施搬到 pipeline.ts

将以下内容从 `worker.ts` 移到 `pipeline.ts`：
- `getAbsurd()` — Absurd 实例管理
- `spawnProcessLink()` — 公开 API，供 bot/web 调用
- `spawnRefreshRelated()` — 公开 API
- `startWorker()` — 启动 worker，注册 tasks

### Step 2: 重写 Absurd task，调用 pipeline 内部 step 函数

将 pipeline.ts 现有的 `runPipeline()` 拆成三个独立函数：

```ts
// pipeline 内部函数
async function scrapeStep(linkId: number, url: string): Promise<ScrapeStepResult>
async function analyzeStep(linkId: number, url: string, scrapeData: ScrapeStepResult): Promise<void>
async function exportStep(linkId: number): Promise<void>
```

Absurd task 的实现变成薄薄的编排层：
```ts
app.registerTask('process-link', async (params, ctx) => {
  const linkId = resolveOrCreateLink(params);
  const scrapeData = await ctx.step('scrape', () => scrapeStep(linkId, url));
  await ctx.step('analyze', () => analyzeStep(linkId, url, scrapeData));
  await ctx.step('export', () => exportStep(linkId));
});
```

这样：
- 业务逻辑只在 pipeline.ts 的 step 函数里
- Twitter 图片 + OCR 逻辑在 `scrapeStep` 里，只写一次
- OCR 拼接在 `analyzeStep` 里，只写一次

### Step 3: 统一所有调用方

| 调用方 | 现在 | 改后 |
|--------|------|------|
| `bot.ts` handleUrl | `worker.spawnProcessLink()` | `pipeline.spawnProcessLink()` |
| `bot.ts` /reprocess | `worker.spawnProcessLink()` | `pipeline.spawnProcessLink()` |
| `web.ts` POST /api/links | `worker.spawnProcessLink()` | `pipeline.spawnProcessLink()` |
| `web.ts` POST /api/retry | `pipeline.retryLink()` | `pipeline.retryLink()` (不变，但底层改用 spawnProcessLink) |
| `web.ts` POST /api/retry/:id | `pipeline.retryLink()` | 同上 |
| `index.ts` startWorker | `worker.startWorker()` | `pipeline.startWorker()` |

### Step 4: retryLink 改用 spawnProcessLink

`retryLink()` 不再自己跑同步 pipeline，而是：
```ts
export async function retryLink(linkId: number) {
  const link = await getLink(linkId);
  await updateLink(linkId, { status: 'pending', error_message: undefined });
  return spawnProcessLink(link.user_id, link.url, linkId);
}
```

这样 retry 也走 Absurd 持久化，有 checkpoint 和重试。

### Step 5: 标记 worker.ts 为 deprecated

在 `worker.ts` 顶部加 `@deprecated` 注释，清空导出，保留文件作为参考。
所有 import 已切到 pipeline.ts，worker.ts 不再被引用。

### Step 6: 清理 processUrl

`processUrl()` 现在只做 upsert（查重 → 创建或复用 linkId），然后调 `spawnProcessLink()`。不再直接跑 pipeline。

## 不变的部分

- `deleteLinkFull()` — 保持在 pipeline.ts，逻辑不涉及 worker
- `refreshRelated()` — 保持在 pipeline.ts
- Absurd refresh-related task — 搬到 pipeline.ts，调用已有的 `refreshRelated()` 内部逻辑

## 风险点

- **Absurd step checkpoint 的 return value 必须可序列化** — scrapeStep 返回值不能太大，不要把整个 markdown 放进去（现有 worker 已经这么做了，沿用）
- **retryLink 改成异步** — web API 的 `POST /api/retry/:id` 目前是同步等结果返回的，改成异步后需要返回 taskId，前端可能需要适配（或者保留一个同步版本）
