# Forward Message as Link — Implementation Plan

## 目标

支持将 Telegram 频道转发消息作为 link 类型 record 处理。转发消息自带完整内容，无需 scrape，直接进入 summarize → embed → related → insight 流程。

## 设计原则

- 新增 `ingested_with_content` boolean 字段标记"入口时已携带内容"
- 这是一个不可变标记：rerun/reprocess 时仍然跳过 scrape（因为内容来源不是 URL 抓取）
- 不绑定具体来源（Telegram 转发），未来其他带内容的入口也可复用
- 私有频道转发（无 username，无法构造 URL）→ 按 note 处理，不走本流程
- 本期只处理纯文字转发消息

## 改动清单

### 1. DB Migration

新增 `records.ingested_with_content` 字段：

```sql
-- server/migrations/NNN_ingested_with_content.sql
ALTER TABLE records ADD COLUMN ingested_with_content BOOLEAN NOT NULL DEFAULT false;
```

### 2. Type 定义 (server/src/db/types.ts)

- `RecordEntry` 加 `ingested_with_content: boolean`
- `RecordsTable` 加 `ingested_with_content: boolean`

### 3. DB Records (server/src/db/records.ts)

- `insertRecord` 的 data 参数支持 `ingested_with_content?: boolean`
- 插入时传入该字段

### 4. Bot 层 (server/src/bot.ts)

在 `bot.on('message:text')` 中，reply 检测之后、URL 分类之前，加转发消息检测：

```
if (ctx.message.forward_origin?.type === 'channel') {
  const chat = ctx.message.forward_origin.chat;
  const msgId = ctx.message.forward_origin.message_id;
  
  // 构造 source URL
  const sourceUrl = chat.username
    ? `https://t.me/${chat.username}/${msgId}`
    : undefined;  // 私有频道无 username，URL 可为空
  
  // 频道名作为 site_name
  const channelTitle = chat.title;
  
  // 创建 record
  const recordId = await insertRecord(userId, {
    type: 'link',
    url: sourceUrl,           // 可能为 undefined（私有频道）
    content: text,
    markdown: text,
    og_site_name: channelTitle,
    ingested_with_content: true,
    telegram_chat_id: ctx.message.chat.id,
  });
  
  // 走 process-link pipeline
  await spawnProcessLink(userId, sourceUrl || '', recordId);
  
  // poll + 通知
  ...
}
```

**注意事项：**
- 私有频道没有 `username`，此时 `url` 可以为空或用 `tg://` 格式
- 需要处理 `forward_origin.type === 'channel'` 和可能的 `'chat'` 类型（群组转发）
- 消息中如果也包含 URL，这些 URL 可以作为 derived links 处理

### 5. Pipeline 层 (server/src/pipeline.ts)

`process-link` task 中，scrape 阶段之前加判断：

```typescript
// 在 "Step 1: Scrape" 分支逻辑的最前面
if (params.scrapeData) {
  // ... 现有 probe data 逻辑
} else if (record.ingested_with_content) {
  // Content provided at ingest — skip scrape entirely
  const scrapeStart = Date.now();
  await emitter.emitStepStart('scrape', { url, source: 'ingest' });
  scrapeData = {
    title: record.og_title || undefined,
    ogDescription: record.og_description || undefined,
    siteName: record.og_site_name || undefined,
    markdownLength: record.markdown?.length || 0,
    ocrTexts: [],
  };
  // 确保 status 推进到 scraped
  await updateRecord(recordId, { status: 'scraped' });
  await emitter.emitStepEnd('scrape', { source: 'ingest', chars: scrapeData.markdownLength }, Date.now() - scrapeStart);
} else if (isTwitterUrl(url)) {
  // ... 现有 Twitter 逻辑
} else {
  // ... 现有 normal scrape 逻辑
}
```

**rerun 行为：** `ingested_with_content` 是持久标记，rerun 时仍跳过 scrape，但 summarize/embed/related/insight 会重新执行。这是正确的，因为内容来源不是 URL。

### 6. Summarize 步骤适配

当前 `summarizeStep` 依赖 `scrapeData.title`。对于转发消息：
- `title` 可能为空（频道消息通常没有标题）
- summarize prompt 需要能处理无 title 的情况（检查现有 prompt 是否已兼容）
- LLM 可以从内容中提取标题，写入 `og_title`

### 7. Bot 回复格式

转发消息处理完成后的回复格式，复用现有 `formatResult`，但：
- `title` 来自 LLM summarize 或内容前 N 个字
- `url` 可能为 Telegram 链接或空

## 边界情况

1. **私有频道转发**：无 `username`，无法构造公开 URL → `url` 存空或 `null`
2. **转发消息含 URL**：消息体中的 URL 作为 derived links 提取处理
3. **转发消息含图片/媒体**：本期只处理文字消息（`message:text`），后续可扩展
4. **重复检测**：如果同一频道消息被转发两次，需要通过 `url` 去重（有 URL 时）或通过 content hash 去重

## 测试要点

- [ ] 转发公开频道消息 → 创建 link record，scrape 跳过，正常走完 pipeline
- [ ] 转发私有频道消息 → 同上但 url 为空
- [ ] reprocess 转发的 record → scrape 仍跳过
- [ ] 转发消息中包含 URL → derived links 正常创建
- [ ] 普通消息（非转发）→ 行为不变
