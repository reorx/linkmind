# Plan: 相关链接搜索功能

基于 Summary Embedding 实现相关链接搜索。

---

## 方案概述

**核心思路**：用新链接的 Summary Embedding 去搜索其他链接的 Summary Embedding，纯向量相似度匹配。

**简化决策**：
- ❌ 不用 Hybrid Search（BM25 + Vector）
- ❌ 不考虑 QMD / 相关笔记
- ❌ 去掉 `searchAll` 函数
- ✅ 只做 Summary → Summary 的向量搜索
- ✅ `related_links` 存链接 ID 数组

---

## Pipeline 顺序

```
scrape → summarize → embed summary → related links → analyze (insight)
```

1. **scrape** - 抓取网页内容、OG 元数据
2. **summarize** - LLM 生成摘要 + 标签
3. **embed summary** - 对 summary 生成向量
4. **related links** - 基于 summary embedding 搜索相关链接
5. **analyze (insight)** - 生成 insight（此时已有 related links 作为上下文）

---

## 改动清单

### 1. 数据库 Schema 变更

```sql
ALTER TABLE links RENAME COLUMN embedding TO summary_embedding;
```

### 2. db.ts

- `LinkRecord` 接口：`embedding` → `summary_embedding`
- `LinksTable` 类型同步修改

### 3. search.ts

**新增** `searchRelatedLinks`：

```typescript
/**
 * 搜索相关链接 - 基于 summary embedding 的向量相似度
 * @returns 链接 ID 数组，按相似度排序
 */
export async function searchRelatedLinks(
  summaryEmbedding: number[],
  userId: number,
  excludeLinkId: number,
  limit: number = 5
): Promise<number[]> {
  const vectorStr = `[${summaryEmbedding.join(',')}]`;
  
  const results = await db
    .selectFrom('links')
    .select(['id'])
    .where('user_id', '=', userId)
    .where('status', '=', 'analyzed')
    .where('id', '!=', excludeLinkId)
    .where('summary_embedding', 'is not', null)
    .orderBy(sql`summary_embedding <=> ${vectorStr}::vector`)
    .limit(limit)
    .execute();
  
  return results.map(r => r.id);
}
```

### 4. pipeline.ts

**拆分 analyzeStep** 为：
- `summarizeStep` - 生成摘要 + 标签
- `insightStep` - 生成 insight（在 related links 之后）

**修改 embedStep**：只对 summary 生成 embedding

**新增 relatedStep**：搜索相关链接

```typescript
// Pipeline 任务流程
const scrapeData = await ctx.step('scrape', ...);
await ctx.step('summarize', ...);      // 生成 summary + tags
await ctx.step('embed', ...);          // summary → embedding
await ctx.step('related', ...);        // 搜索相关链接
await ctx.step('insight', ...);        // 生成 insight（有 related 上下文）
await ctx.step('export', ...);
```

### 5. agent.ts

**拆分**：
- `generateSummary(input)` → `{ summary, tags }` （保留）
- `generateInsight(input, summary, relatedLinks)` → `string` （修改入参）

**删除**：
- `searchAll` 导入
- `analyzeArticle` 函数（逻辑移到 pipeline）
- `findRelatedAndInsight` 函数

### 6. 存储格式

`related_links` 字段：
```json
[42, 37, 15, 8, 3]
```
链接 ID 数组，按相似度排序。

---

## 实现步骤

1. 数据库迁移：`embedding` → `summary_embedding`
2. 修改 `db.ts` 类型定义
3. 新增 `search.ts` 的 `searchRelatedLinks`
4. 拆分 `agent.ts`：分离 summarize 和 insight
5. 重构 `pipeline.ts`：新的步骤顺序
6. 测试单条链接处理
7. Backfill：对所有链接重跑完整 pipeline
