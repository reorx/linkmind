# Sentry (GlitchTip) SDK 集成方案

## 依赖

```bash
pnpm add @sentry/node
```

## 初始化

### `server/src/sentry.ts`（新建）

```typescript
import * as Sentry from '@sentry/node';

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // 没配置则跳过，开发环境不强制

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 1.0,  // 小项目全采样
  });
}

export { Sentry };
```

### `server/src/index.ts`

在最顶部（dotenv 之后、其他模块之前）调用 `initSentry()`。Sentry 需要在所有其他模块加载前初始化才能 monkey-patch 异常捕获。

```typescript
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { initSentry } from './sentry.js';
initSentry();

// ... 其他 import
```

## 集成点

### 1. Pipeline task handler（核心）

**位置**: `pipeline.ts` — `registerTasks()` 中的 `process-link` 和 `refresh-related` task handler

**做法**: 只在**最后一次重试失败**或**永久错误**时上报，避免重试中的瞬时错误刷屏。

Absurd 的 `ctx.task` 上有 `attempt`（当前第几次）和 `max_attempts`（最多几次）。

```typescript
// process-link catch 块中增加:
catch (err) {
  const errorMessage = err instanceof Error ? err.message : String(err);
  // ... 原有 updateLink + isPermanent 逻辑不变

  // 只在最后一次尝试或永久错误时上报
  const task = (ctx as any).task;
  const isLastAttempt = task && task.attempt >= (task.max_attempts || 3);
  if (isPermanent || isLastAttempt) {
    Sentry.captureException(err, {
      tags: { task: 'process-link' },
      extra: { linkId, url, userId, attempt: task?.attempt, maxAttempts: task?.max_attempts },
    });
  }

  if (isPermanent) {
    return { linkId, title: undefined, status: 'error' };
  }
  throw err; // 让 Absurd 重试
}
```

```typescript
// refresh-related 也同理:
catch (err) {
  const task = (ctx as any).task;
  const isLastAttempt = task && task.attempt >= (task.max_attempts || 2);
  if (isLastAttempt) {
    Sentry.captureException(err, {
      tags: { task: 'refresh-related' },
      extra: { linkId, attempt: task?.attempt },
    });
  }
  throw err;
}
```

### 2. Absurd worker onError

**位置**: `pipeline.ts` — `startWorker()` 的 `onError` 回调

当前只 log 了 error，增加 Sentry 上报：

```typescript
onError: (err) => {
  log.error({ err: err.message, stack: err.stack }, 'Worker task error');
  Sentry.captureException(err, { tags: { source: 'absurd-worker' } });
},
```

### 3. 各 step 函数的非致命错误

**位置**: `pipeline.ts` 中的 `scrapeStep`（Twitter images 处理）

当前 image 处理失败是 `log.warn` + 吞掉，改为也上报给 Sentry（标记为 warning 级别）：

```typescript
catch (imgErr) {
  log.warn(...);
  Sentry.captureException(imgErr, {
    level: 'warning',
    tags: { step: 'scrape', sub: 'twitter-images' },
    extra: { linkId },
  });
}
```

### 4. Express 全局错误处理

**位置**: `web.ts` — `startWebServer()`

在所有路由之后加 Sentry 的 Express error handler：

```typescript
// 在 app.listen 之前
Sentry.setupExpressErrorHandler(app);
```

### 5. Bot 全局错误

**位置**: `bot.ts` — `bot.catch()`

```typescript
bot.catch((err) => {
  log.error({ err: err.message }, 'Bot error');
  Sentry.captureException(err.error, {
    tags: { source: 'telegram-bot' },
    extra: { ctx: err.ctx?.update },
  });
});
```

### 6. Enqueue cron

**位置**: `enqueue-cron.ts` — catch 块

```typescript
catch (err) {
  log.error(...);
  Sentry.captureException(err, { tags: { source: 'enqueue-cron' } });
}
```

### 7. 进程级兜底

**位置**: `index.ts`

```typescript
process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
});

process.on('uncaughtException', (err) => {
  Sentry.captureException(err);
  // flush 后退出
  Sentry.close(2000).then(() => process.exit(1));
});
```

## 不需要加的地方

- **已经正确处理且上报给用户的错误**（如 bot 命令中的 `ctx.reply('❌ ...')`）— 这些是业务逻辑，不是异常
- **db.ts** — 数据库错误会在调用方（pipeline/web/bot）被捕获，不需要在 db 层重复上报

## 环境变量

```
SENTRY_DSN=https://xxx@glitchtip.example.com/1
```

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `server/src/sentry.ts` | 新建，初始化 + re-export |
| `server/src/index.ts` | 顶部加 initSentry()，底部加 unhandledRejection/uncaughtException |
| `server/src/pipeline.ts` | process-link catch、refresh-related、onError、scrapeStep images |
| `server/src/web.ts` | setupExpressErrorHandler |
| `server/src/bot.ts` | bot.catch 中加 captureException |
| `server/src/enqueue-cron.ts` | catch 块加 captureException |
