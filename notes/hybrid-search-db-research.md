# Linkmind 云端版数据库选型调研：全文搜索 + 向量搜索

## 需求

Linkmind 云端版需要一个同时支持**全文搜索**和**向量搜索**的数据库，且：
- 数据会快速增长
- 需要第三方托管（免运维）
- 支持混合检索（hybrid search）

---

## 方案一：PostgreSQL (pgvector + 全文搜索)

### 生产案例

| 公司/项目 | 规模 | 说明 |
|-----------|------|------|
| **Supabase** 客户群 | 160万+ embeddings | Supabase 官方推 pgvector，大量 AI 应用在用 hybrid search |
| **Neon** | 托管 PG，原生支持 pgvector 0.8.1 + ParadeDB pg_search | 已有企业客户跑 hybrid search |
| **Berri AI** | 从 AWS RDS 迁移到 Supabase pgvector | 生产环境，提升了性能和开发效率 |
| **Instagram/Discord/Spotify** | 超大规模 | 用 PG 做主数据库（不一定用 pgvector，但说明 PG 在大规模场景的可靠性） |
| **Tiger Data (Timescale)** | benchmark 验证 | pgvector + pgvectorscale 在 99% recall 下吞吐量比 Qdrant 高一个数量级 |

### 全文搜索方案

PostgreSQL 的全文搜索有三个层次：

1. **原生 tsvector/tsquery** — 内置，免费，但排序用 ts_rank，不考虑全局语料统计（无 IDF），排序质量一般
2. **ParadeDB pg_search** — PG 扩展，提供真正的 BM25 索引（和 Elasticsearch 同算法），支持短语匹配、高亮、正则等。Neon 已集成
3. **Timescale pg_textsearch** — 新开源的 BM25 扩展，另一个选择

### Hybrid Search 实现

- pgvector 做语义搜索 + ParadeDB/tsvector 做词法搜索
- 用 **RRF (Reciprocal Rank Fusion)** 合并两路结果
- Supabase 有官方 hybrid search 文档和函数模板
- ParadeDB 有完整的 "Hybrid Search Missing Manual"

### 规模上限

- pgvector 在 **1亿向量以内** 表现优秀
- 超过 1 亿需要专门调优或考虑专用向量库
- **对 linkmind 来说完全够用**（即使百万级链接也远低于上限）

### 托管平台

| 平台 | pgvector | BM25 全文搜索 | 起步价 |
|------|----------|--------------|--------|
| **Neon** | ✅ 0.8.1 | ✅ ParadeDB pg_search | ~$8/月（scale-to-zero） |
| **Supabase** | ✅ | ✅ 原生 tsvector（无 BM25 扩展） | $25/月（Pro） |
| **AWS Aurora PG** | ✅ 0.8.0 | ⚠️ 仅原生 tsvector | ~$30+/月 |
| **Railway** | ✅ | ⚠️ 仅原生 tsvector | ~$5+/月 |

---

## 方案二：Elasticsearch

### 生产案例

| 公司 | 场景 | 规模 |
|------|------|------|
| **Uber** | 应用监控 + 搜索平台 | 专门的 ES 集群 + 专职团队维护 |
| **Shopify** | 商品搜索（但已自研 C++ 引擎替代） | 十亿级查询 |
| **eBay** | 商品搜索 | 超大规模 |
| **GitHub** | 代码搜索 | 数十亿文件 |

### Hybrid Search 能力

- ES 8.x 原生支持 `dense_vector` 字段 + kNN 搜索
- 可通过 `retriever` API 组合 BM25 + vector search
- 内置 ELSER 模型（无需外部 LLM 即可做语义搜索）
- Reciprocal Rank Fusion 原生支持
- **全文搜索是 ES 最强项**，BM25 排序、分词、高亮、聚合都非常成熟

### 规模上限

- **几乎无上限**，为大规模而生
- 向量搜索也支持十亿级
- 但代价是运维复杂度和成本

### 托管平台

| 平台 | 起步价 | 说明 |
|------|--------|------|
| **Elastic Cloud** | ~$95-175/月 | 官方托管，功能最全 |
| **AWS OpenSearch** | ~$20+/月 | ES 分叉，功能略落后 |
| **Bonsai** | ~$10+/月 | 轻量级 ES 托管 |

---

## 对比总结

| 维度 | PostgreSQL + pgvector | Elasticsearch |
|------|----------------------|---------------|
| **全文搜索成熟度** | ⭐⭐⭐ (ParadeDB BM25) / ⭐⭐ (原生 tsvector) | ⭐⭐⭐⭐⭐ (行业标杆) |
| **向量搜索成熟度** | ⭐⭐⭐⭐ (pgvector 0.8.1，百万级很稳) | ⭐⭐⭐⭐ (8.x 原生支持) |
| **Hybrid Search** | ⭐⭐⭐ (需自己拼 RRF，或用 ParadeDB) | ⭐⭐⭐⭐⭐ (原生 retriever API) |
| **架构简单度** | ⭐⭐⭐⭐⭐ (一个数据库搞定一切) | ⭐⭐ (需要额外维护 ES + 主数据库同步) |
| **托管成本** | 💰 低（Neon $8/月起） | 💰💰💰 高（$95+/月起） |
| **数据同步** | ✅ 无需同步，数据就在 PG 里 | ❌ 需要把数据从主库同步到 ES |
| **超大规模 (>1亿)** | ⚠️ 需要专门调优 | ✅ 天生为此设计 |
| **生态 & SQL 兼容** | ✅ 标准 SQL，ORM 友好 | ❌ 自有 DSL，学习曲线 |

---

## 建议：PostgreSQL (Neon)

**理由：**

1. **架构最简**：linkmind 已经用 PG，不需要引入第二个数据存储，省去数据同步的复杂度
2. **规模足够**：linkmind 即使快速增长，百万级链接 pgvector 完全 hold 住，离 1 亿上限很远
3. **成本极低**：Neon scale-to-zero 从 $8/月起，ES Cloud 最低 $95/月
4. **Neon 支持 ParadeDB pg_search**：意味着可以在 PG 里同时拥有 BM25 全文搜索 + pgvector 向量搜索，不逊色于 ES 的 hybrid search
5. **迁移成本低**：本地 PG 18 → Neon PG，schema 直接兼容

**什么时候才需要考虑 ES：**
- 数据量真的到了千万到亿级
- 需要复杂的聚合分析、faceted search
- 全文搜索需要极致的分词和多语言支持

对 linkmind 现阶段和可预见的未来，PG + pgvector + ParadeDB 是最务实的选择。
