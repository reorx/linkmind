# Linkmind 向量搜索 + 全文搜索实现计划

## 目标

为 `links` 表添加：
1. **向量搜索** — 基于 brief markdown 生成 embedding，存入 PG，支持语义相似搜索
2. **全文搜索** — 对 markdown 字段建全文索引，支持关键词搜索（需考虑中文分词）

---

## 一、向量搜索

### 1.1 Schema 改动

```sql
-- 添加 embedding 列（假设用 OpenAI text-embedding-3-small，维度 1536）
ALTER TABLE links ADD COLUMN embedding vector(1536);

-- 建 HNSW 索引（余弦相似度）
CREATE INDEX idx_links_embedding ON links 
USING hnsw (embedding vector_cosine_ops);
```

### 1.2 Embedding 生成流程

在 `pipeline.ts` 的 `analyzeStep()` 完成后，新增 `embedStep()`：

```
scrapeStep → analyzeStep → embedStep → exportStep
```

`embedStep` 逻辑：
1. 拼接 brief 内容：`${title}\n\n${summary}\n\n${insight}`
2. 调用 Embedding API（OpenAI / DashScope）
3. 将向量存入 `embedding` 列

### 1.3 Embedding 模型选择

| 模型 | 维度 | 价格 | 说明 |
|------|------|------|------|
| OpenAI text-embedding-3-small | 1536 | $0.02/1M tokens | 性价比高，推荐 |
| OpenAI text-embedding-3-large | 3072 | $0.13/1M tokens | 质量更好，维度大 |
| DashScope text-embedding-v3 | 1024 | ¥0.0007/1K tokens | 国内首选，中文优化 |

**建议**：用 DashScope 的 embedding 模型（中文场景 + 国内访问快 + 便宜）

### 1.4 相似搜索查询

```sql
-- 找最相似的 10 条链接
SELECT id, url, og_title, 
       1 - (embedding <=> $1) AS similarity
FROM links
WHERE embedding IS NOT NULL
ORDER BY embedding <=> $1
LIMIT 10;
```

---

## 二、全文搜索（中文）

### 2.1 问题：中文分词

PostgreSQL 原生 tsvector 不支持中文分词（中文没有空格分隔词语）。

**方案对比：**

| 方案 | 优点 | 缺点 | Neon 支持 |
|------|------|------|-----------|
| **zhparser** | 专业中文分词（SCWS） | 需要编译安装 | ❌ 不支持 |
| **pg_jieba** | 结巴分词，准确率高 | 需要编译安装 | ❌ 不支持 |
| **ParadeDB pg_search + ICU** | BM25 排序，多语言 | 中文效果待验证 | ✅ PG17 支持 |
| **pg_trgm (trigram)** | 无需分词，模糊匹配 | 非语义，召回率一般 | ✅ 支持 |
| **应用层分词** | 灵活，可用 jieba-js | 需维护分词逻辑 | N/A |

### 2.2 推荐方案：应用层分词 + tsvector

**经测试验证**（见 `scripts/test-chinese-search.ts`）：
- `pg_trgm` 对中文几乎无效（纯中文查询全部失败）
- `tsvector` 原生按空格分词，对中文无效
- **应用层预分词 + tsvector 效果很好**，所有中文查询都能正确匹配

**推荐方案**：应用层分词 + tsvector
- 使用 `nodejieba` 或 `@panyam/jieba-wasm` 在应用层分词
- 将分词后的文本（空格分隔）存入 `segmented` 列
- 用 `to_tsvector('simple', segmented)` 建索引
- 不依赖任何特殊 PG 扩展，Neon 等托管平台完全支持

**备选**：pg_search (ParadeDB)
- Neon PG17 支持，有 Lindera tokenizer
- 待测试中文效果，如果好可以替代应用层分词

### 2.3 应用层分词 + tsvector 实现（推荐）

```sql
-- 添加分词后的文本列和 tsvector 列
ALTER TABLE links ADD COLUMN segmented TEXT;
ALTER TABLE links ADD COLUMN search_vector tsvector;

-- 创建 GIN 索引
CREATE INDEX idx_links_search_vector ON links USING gin(search_vector);
```

应用层分词逻辑：

```typescript
import Nodejieba from 'nodejieba'; // 或 @panyam/jieba-wasm

// 分词函数
function segmentText(text: string): string {
  // 分词并去重
  const words = Nodejieba.cut(text);
  return words.join(' ');
}

// 写入时分词
const segmented = segmentText(`${title} ${summary} ${markdown}`);
await db.execute(sql`
  UPDATE links 
  SET segmented = ${segmented},
      search_vector = to_tsvector('simple', ${segmented})
  WHERE id = ${linkId}
`);

// 搜索时也需要对查询分词
function searchLinks(query: string) {
  const segmentedQuery = Nodejieba.cut(query).join(' | ');
  return db.execute(sql`
    SELECT id, og_title, ts_rank(search_vector, to_tsquery('simple', ${segmentedQuery})) AS score
    FROM links
    WHERE search_vector @@ to_tsquery('simple', ${segmentedQuery})
    ORDER BY score DESC
    LIMIT 10
  `);
}
```

### 2.4 pg_search (ParadeDB) 备选

如果 Neon 的 pg_search 中文效果好，可以省去应用层分词：

```sql
-- 启用 pg_search (Neon PG17 支持)
CREATE EXTENSION pg_search;

-- 创建 BM25 索引（用 Lindera tokenizer 测试中文）
CREATE INDEX idx_links_bm25 ON links
USING bm25 (
  id,
  og_title,
  markdown
)
WITH (key_field=id);

-- 搜索
SELECT id, og_title, pdb.score(id) AS score
FROM links
WHERE markdown ||| '人工智能'
ORDER BY score DESC
LIMIT 10;
```

---

## 三、实施步骤

### Phase 1: 向量搜索（优先）

1. [ ] 添加 `embedding vector(1536)` 列
2. [ ] 实现 `embedStep()` 调用 DashScope embedding API
3. [ ] 创建 HNSW 索引
4. [ ] 为现有链接批量生成 embedding（backfill）
5. [ ] 实现相似搜索 API endpoint

### Phase 2: 全文搜索

1. [x] 测试 pg_trgm / tsvector / 应用层分词 → **应用层分词效果最好**
2. [ ] 安装 `nodejieba` 或 `@panyam/jieba-wasm`
3. [ ] 添加 `segmented` 和 `search_vector` 列
4. [ ] 在 pipeline 中添加分词步骤
5. [ ] 为现有链接批量生成分词（backfill）
6. [ ] 实现全文搜索 API endpoint
7. [ ] (可选) 在 Neon 上测试 pg_search 中文效果

### Phase 3: Hybrid Search

1. [ ] 实现 RRF (Reciprocal Rank Fusion) 合并向量 + 全文结果
2. [ ] 搜索 API 同时返回两路结果，合并排序

---

## 四、云端部署考量（Neon）

| 功能 | Neon 支持情况 | 中文效果 |
|------|--------------|---------|
| pgvector | ✅ 0.8.0 / 0.8.1 | ✅ 语言无关 |
| tsvector + 应用层分词 | ✅ 内置 | ✅ 测试验证有效 |
| pg_search (ParadeDB BM25) | ✅ PG17 (0.15.26) | ⚠️ 待测试 |
| zhparser / pg_jieba | ❌ 不支持 | N/A |
| pg_trgm | ✅ 支持 | ❌ 测试验证无效 |

**结论**：
- 向量搜索：pgvector，没问题
- 全文搜索：**应用层分词 + tsvector**（已测试验证有效）

---

## 五、待确认

1. Embedding 模型：OpenAI 还是 DashScope？（建议 DashScope）
2. 向量维度：1536 (OpenAI small) 还是 1024 (DashScope v3)？
3. 分词库选择：`nodejieba` (C++ binding) 还是 `@panyam/jieba-wasm` (WASM)？
   - nodejieba: 性能好，但需要编译 native 依赖
   - jieba-wasm: 纯 JS，跨平台，但可能稍慢

## 六、测试脚本

`scripts/test-chinese-search.ts` — 中文搜索方案对比测试
- 测试了 pg_trgm、tsvector、LIKE、应用层分词
- **结论：应用层分词 + tsvector 效果最好**
