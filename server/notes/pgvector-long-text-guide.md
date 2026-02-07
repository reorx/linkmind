# PostgreSQL 向量化存储长文本指南

本文档总结了使用 PostgreSQL + pgvector 对长文本进行向量化存储和搜索的完整方案。

## 概念说明

### 为什么需要 Chunking？

向量 embedding 模型有 **token 限制**（通常 8192 tokens），且对于长文本，单一向量难以捕捉所有语义细节。因此需要将长文本切分成小块（chunks），分别生成 embedding。

### 核心流程

```
原始文本 → Chunking (分块) → Embedding (向量化) → 存储到 pgvector → 相似度搜索
```

### 存储架构

对于长文本的向量化，**推荐使用单独的 chunks 表**，而不是在原表上存储：

```
┌─────────────┐         ┌─────────────────┐
│   links     │ 1 ──> N │  link_chunks    │
├─────────────┤         ├─────────────────┤
│ id          │         │ id              │
│ url         │         │ link_id (FK)    │
│ markdown    │         │ chunk_index     │
│ ...         │         │ chunk_text      │
└─────────────┘         │ embedding       │
                        └─────────────────┘
```

**为什么不存在一个字段？**
- pgvector 的向量是固定维度（如 1024 或 1536）
- 无法把多个向量塞进一个字段并建索引
- 分表后可以独立索引、独立搜索、按块召回

---

## Schema 设计

### 基础表结构

```sql
-- 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- Chunks 表
CREATE TABLE link_chunks (
  id SERIAL PRIMARY KEY,
  link_id INT REFERENCES links(id) ON DELETE CASCADE,
  chunk_index INT,              -- 第几块（用于重建顺序）
  chunk_text TEXT,              -- 原文片段
  embedding vector(1024),       -- 向量 (DashScope: 1024, OpenAI: 1536)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(link_id, chunk_index)
);

-- HNSW 索引 (高召回近似最近邻)
CREATE INDEX idx_chunks_embedding ON link_chunks 
  USING hnsw (embedding vector_cosine_ops);
```

### 索引选择

| 索引类型 | 特点 | 适用场景 |
|---------|------|---------|
| **HNSW** | 高召回率，构建慢，查询快 | 生产环境，数据量大 |
| **IVFFlat** | 构建快，召回率略低 | 数据频繁更新 |
| 无索引 | 精确搜索，最慢 | 小数据量 (<1000) |

---

## Chunking 策略

### 关键参数

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| `chunkSize` | 500-1000 | 每块最大字符/token 数 |
| `chunkOverlap` | 50-100 | 块之间重叠，保持上下文连贯 |
| `separator` | `\n\n`, `\n` | 优先按段落/换行切分 |

### TypeScript 实现 (LangChain)

```typescript
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 50,
  separators: ['\n\n', '\n', '。', '，', ' ', ''],  // 中文友好
});

const chunks = await splitter.splitText(longText);
// chunks: ['第一段内容...', '第二段内容...', ...]
```

### 简易实现 (无依赖)

```typescript
function chunkText(text: string, maxLength: number = 500, overlap: number = 50): string[] {
  const chunks: string[] = [];
  let start = 0;
  
  while (start < text.length) {
    let end = start + maxLength;
    
    // 尝试在句子边界切分
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('。', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxLength / 2) {
        end = breakPoint + 1;
      }
    }
    
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
  }
  
  return chunks.filter(c => c.length > 0);
}
```

---

## Embedding 生成

### DashScope (阿里云)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
});

async function createEmbedding(text: string): Promise<number[]> {
  const response = await client.embeddings.create({
    model: 'text-embedding-v3',  // 1024 维
    input: text,
  });
  return response.data[0].embedding;
}
```

### OpenAI

```typescript
import { embed, embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';

// 单条
const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-small'),  // 1536 维
  value: text,
});

// 批量 (推荐)
const { embeddings } = await embedMany({
  model: openai.embedding('text-embedding-3-small'),
  values: chunks,  // string[]
});
```

---

## 完整 Pipeline 示例

### 入库流程

```typescript
async function ingestDocument(linkId: number, content: string) {
  // 1. 分块
  const chunks = await splitter.splitText(content);
  
  // 2. 批量 embedding (每批 50 条)
  const BATCH_SIZE = 50;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const embeddings = await embedBatch(batch);
    
    // 3. 存入数据库
    for (let j = 0; j < batch.length; j++) {
      const vectorStr = `[${embeddings[j].join(',')}]`;
      await db.query(`
        INSERT INTO link_chunks (link_id, chunk_index, chunk_text, embedding)
        VALUES ($1, $2, $3, $4)
      `, [linkId, i + j, batch[j], vectorStr]);
    }
  }
}
```

### 搜索流程

```typescript
async function searchChunks(query: string, userId: number, limit: number = 5) {
  // 1. Query embedding
  const queryEmbedding = await createEmbedding(query);
  const vectorStr = `[${queryEmbedding.join(',')}]`;
  
  // 2. 相似度搜索，按 link 聚合取最佳匹配
  const results = await db.query(`
    SELECT 
      lc.link_id,
      l.og_title,
      lc.chunk_text,
      1 - (lc.embedding <=> $1::vector) AS similarity
    FROM link_chunks lc
    JOIN links l ON l.id = lc.link_id
    WHERE l.user_id = $2
    ORDER BY lc.embedding <=> $1::vector
    LIMIT $3
  `, [vectorStr, userId, limit]);
  
  return results.rows;
}
```

### 按文档聚合搜索

```typescript
// 找到最相关的文档（而非 chunk）
const results = await db.query(`
  SELECT 
    link_id,
    MIN(embedding <=> $1::vector) AS best_distance
  FROM link_chunks
  GROUP BY link_id
  ORDER BY best_distance
  LIMIT $2
`, [vectorStr, limit]);
```

---

## Hybrid Search (BM25 + Vector)

结合全文搜索和向量搜索，使用 **Reciprocal Rank Fusion (RRF)** 融合排名：

```typescript
const RRF_K = 60;

function calculateRRF(bm25Rank: number | null, vectorRank: number | null): number {
  let score = 0;
  if (bm25Rank !== null) score += 1 / (RRF_K + bm25Rank);
  if (vectorRank !== null) score += 1 / (RRF_K + vectorRank);
  return score;
}

// 两种搜索都排名靠前的结果得分更高
```

---

## 性能优化建议

1. **批量 embedding**: 一次请求多条文本，减少 API 调用
2. **先插数据再建索引**: HNSW 索引构建慢，大量数据时先插入再建索引
3. **适当的 chunk 大小**: 太小丢失上下文，太大语义模糊
4. **使用连接池**: 避免频繁建立数据库连接

---

## References

### 教程文章

1. **Postgres RAG Stack: Embedding, Chunking & Vector Search** (Perficient, 2025.7)
   https://blogs.perficient.com/2025/07/17/postgres-typescript-rag-stack/
   - 完整的 TypeScript + pgvector RAG 实战

2. **Building a RAG Server with PostgreSQL - Part 2: Chunking and Embeddings** (pgEdge)
   https://www.pgedge.com/blog/building-a-rag-server-with-postgresql-part-2-chunking-and-embeddings
   - 专门讲 chunking 策略

3. **pgvector Tutorial: Integrate Vector Search into PostgreSQL** (DataCamp, 2024.8)
   https://www.datacamp.com/tutorial/pgvector-tutorial
   - 从零开始的入门教程

4. **PostgreSQL 数据库向量化的核心：pgvector** (博客园)
   https://www.cnblogs.com/deeplearningmachine/p/18565486
   - 中文基础入门

5. **Embedding content in PostgreSQL using Python** (Fastware)
   https://www.postgresql.fastware.com/blog/embedding-content-in-postgresql-using-python
   - Python 实现，讲 markup chunking + token-aware chunking

### 工具与库

- **pgvector** - PostgreSQL 向量扩展
  https://github.com/pgvector/pgvector

- **pgedge-vectorizer** - PostgreSQL 扩展，自动 chunking + embedding
  https://github.com/pgEdge/pgedge-vectorizer

- **LangChain Text Splitters** - 多种分块策略
  https://js.langchain.com/docs/modules/data_connection/document_transformers/

### Embedding 模型

| 提供商 | 模型 | 维度 | 特点 |
|--------|------|------|------|
| DashScope | text-embedding-v3 | 1024 | 中文优化，便宜 |
| OpenAI | text-embedding-3-small | 1536 | 多语言，质量高 |
| OpenAI | text-embedding-3-large | 3072 | 最高质量 |

---

*Created: 2026-02-06*
