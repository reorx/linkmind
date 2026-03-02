# Probe QMD 搜索个人笔记方案

## 概览

利用 probe 运行在本地的优势（有 qmd 可用），在 link 分析完成后，通过 probe 搜索相关个人笔记，填充 `related_notes` 字段。

## 流程

```
Pipeline (server)                          Probe (local)
─────────────────                          ─────────────
link analyzed (有 summary)
       │
       ├─ 创建 probe_event (type: note_search)
       ├─ 通过 SSE 推送 note_search_request
       │                                    收到 event
       │                                    │
       │                                    ├─ 用 qmd vsearch "summary 关键内容"
       │                                    ├─ 解析结果
       │                                    └─ POST /api/probe/receive_note_search
       │                                           │
       ◄───────────────────────────────────────────┘
       │
       └─ 更新 link.related_notes
```

## 改动

### 1. Core types (`core/src/types.ts`)

新增事件和结果类型：

```typescript
export type UrlType = 'twitter' | 'web';
export type ProbeEventType = 'scrape' | 'note_search';  // 新增

/** Note search request event from server */
export interface NoteSearchRequestEvent {
  event_id: string;
  link_id: number;
  query: string;  // summary 或提取的关键词
}

/** Single note search result */
export interface NoteSearchResult {
  path: string;      // qmd://notes/...
  title: string;
  heading?: string;
  snippet: string;
  score: string;     // "65%" 等
}

/** Note search result payload sent back to server */
export interface NoteSearchResultPayload {
  event_id: string;
  link_id: number;
  success: boolean;
  notes?: NoteSearchResult[];
  error?: string;
}
```

### 2. Probe daemon (`probe/src/daemon.ts`)

在 SSE 事件处理中新增 `note_search_request`：

```typescript
if (eventType === 'note_search_request') {
  const eventData: NoteSearchRequestEvent = JSON.parse(data);
  processNoteSearch(config, eventData).catch(...);
  return;
}
```

新增 `processNoteSearch` 函数：
- 执行 `qmd vsearch "query"` （子进程）
- 解析输出，提取 path / title / score / snippet
- POST 结果到 `/api/probe/receive_note_search`

### 3. Probe: qmd search 封装 (`probe/src/qmd.ts` 新建)

```typescript
export async function searchNotes(query: string, limit?: number): Promise<NoteSearchResult[]>
```

- 运行 `qmd vsearch "query"` 子进程
- 解析 qmd 输出格式（path, title, score, snippet）
- 过滤低分结果（< 50%）
- 最多返回 5 条

### 4. Server: 新增 API endpoint (`server/src/web.ts`)

```
POST /api/probe/receive_note_search
Body: NoteSearchResultPayload
```

- 需要 probe auth
- 根据 link_id 更新 `related_notes` 字段
- 更新 probe_event 状态

### 5. Server: Pipeline 集成 (`server/src/pipeline.ts`)

在 `relatedStep` 之后（或 `insightStep` 之前），新增一步：

```typescript
// Step 4.5: Request note search from probe (async, non-blocking)
await ctx.step('note-search', async () => {
  await requestNoteSearch(linkId, userId, summaryData.summary);
});
```

`requestNoteSearch` 函数：
- 创建 probe_event（type: `note_search`）
- 通过 SSE pushEventToProbe 发送 `note_search_request`
- **不等待结果**——probe 返回后异步更新 related_notes

问题：如果不等待结果，insight 生成时还没有 related_notes。

**方案 A（推荐）：同步等待 + 超时**
- 创建 probe event 后 polling 等待结果，超时 30s
- 有结果就填入 related_notes，超时就跳过
- 好处：insight 生成时可以包含笔记上下文

**方案 B：异步 + 不影响 insight**
- probe 返回后只更新 related_notes，不影响 insight
- 前端展示相关笔记，但 insight 文本不包含笔记引用
- 好处：不阻塞 pipeline

### 6. Server: probe_events 表

当前 `url_type` 字段可以复用。创建 note_search 事件时：
- `url` 填 link 的 url
- `url_type` 改为通用的 `event_type`？或者新增字段？

**简化方案**：直接用现有表，`url_type = 'note_search'`，result 字段存搜索结果。

## qmd 输出格式解析

`qmd vsearch` 输出格式：

```
qmd://notes/folder/file.md:line #hash
Title: Some Title
Score:  65%

@@ -74,4 @@ (73 before, 3 after)
snippet content here
more lines...

```

每个结果由空行分隔，需要解析 path / title / score / snippet。

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `core/src/types.ts` | 新增 NoteSearchRequestEvent, NoteSearchResult, NoteSearchResultPayload |
| `probe/src/qmd.ts` | 新建，封装 qmd vsearch 调用和输出解析 |
| `probe/src/daemon.ts` | 新增 note_search_request 事件处理 |
| `server/src/web.ts` | 新增 POST /api/probe/receive_note_search |
| `server/src/pipeline.ts` | relatedStep 后触发 note search |

## 待确认

1. **同步还是异步？** 方案 A（等待 probe 返回）还是方案 B（fire-and-forget）？
2. **搜索内容**：用完整 summary 还是提取关键词/tags 作为查询？
3. **qmd 命令**：用 `vsearch`（语义搜索）还是 `search`（BM25 全文）还是 `query`（混合+rerank，但需要下载模型）？
