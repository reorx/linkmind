/**
 * 中文全文搜索方案测试脚本
 *
 * 测试内容：
 * 1. pg_trgm (三元组) - 本地可用
 * 2. native tsvector - 本地可用（对中文效果差）
 * 3. pg_search (ParadeDB BM25) - 需要在 Neon 上测试
 *
 * 运行：npx tsx scripts/test-chinese-search.ts
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://reorx@localhost/linkmind';

// 测试数据：模拟 linkmind 的链接内容
const testDocs = [
  {
    id: 1,
    title: '深度学习在自然语言处理中的应用',
    content: `
      本文介绍了深度学习技术在自然语言处理领域的最新进展。
      包括 Transformer 架构、BERT、GPT 等预训练模型的原理和应用。
      自然语言处理是人工智能的重要分支，涵盖文本分类、情感分析、
      机器翻译、问答系统等多个方向。深度学习的引入大大提升了这些任务的性能。
    `,
  },
  {
    id: 2,
    title: 'PostgreSQL 全文搜索指南',
    content: `
      PostgreSQL 提供了强大的全文搜索功能。通过 tsvector 和 tsquery
      类型，可以实现高效的文本检索。本文介绍了如何创建全文索引、
      配置分词器、以及优化搜索性能的最佳实践。对于中文搜索，
      需要额外安装 zhparser 或 pg_jieba 等分词扩展。
    `,
  },
  {
    id: 3,
    title: '向量数据库与语义搜索',
    content: `
      向量数据库是存储和检索向量嵌入的专用数据库。通过将文本、图像等
      非结构化数据转换为向量表示，可以实现语义级别的相似搜索。
      pgvector 是 PostgreSQL 的向量搜索扩展，支持 HNSW 和 IVFFlat 索引。
      结合传统的关键词搜索，可以构建混合搜索系统。
    `,
  },
  {
    id: 4,
    title: 'React 18 新特性详解',
    content: `
      React 18 引入了并发渲染、自动批处理、Suspense 改进等重要特性。
      useTransition 和 useDeferredValue 钩子帮助开发者优化用户体验。
      新的 createRoot API 替代了 ReactDOM.render，支持并发模式。
      本文将详细介绍这些新特性及其使用场景。
    `,
  },
  {
    id: 5,
    title: '机器学习模型部署最佳实践',
    content: `
      将机器学习模型从实验环境部署到生产环境面临诸多挑战。
      本文讨论了模型序列化、API 设计、性能优化、监控告警等方面的
      最佳实践。介绍了 TensorFlow Serving、TorchServe、Triton 等
      主流部署框架，以及 Docker、Kubernetes 在 ML 部署中的应用。
    `,
  },
];

// 测试查询
const testQueries = [
  '深度学习',
  '自然语言处理',
  'PostgreSQL 搜索',
  '向量数据库',
  '机器学习部署',
  'React',
  '中文分词',
  '语义搜索',
  'BERT GPT',
  '性能优化',
];

async function main() {
  const client = new pg.Client(DATABASE_URL);
  await client.connect();

  console.log('='.repeat(60));
  console.log('中文全文搜索方案测试');
  console.log('='.repeat(60));

  // 创建测试表
  await client.query(`
    DROP TABLE IF EXISTS search_test;
    CREATE TABLE search_test (
      id INT PRIMARY KEY,
      title TEXT,
      content TEXT
    );
  `);

  // 插入测试数据
  for (const doc of testDocs) {
    await client.query(
      'INSERT INTO search_test (id, title, content) VALUES ($1, $2, $3)',
      [doc.id, doc.title, doc.content]
    );
  }
  console.log(`\n✅ 插入 ${testDocs.length} 条测试数据\n`);

  // ============================================
  // 测试 1: pg_trgm (三元组)
  // ============================================
  console.log('-'.repeat(60));
  console.log('测试 1: pg_trgm (三元组匹配)');
  console.log('-'.repeat(60));

  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_search_test_trgm 
    ON search_test USING gin ((title || ' ' || content) gin_trgm_ops)
  `);

  // 降低 pg_trgm 的相似度阈值（默认 0.3 对中文太高）
  await client.query("SET pg_trgm.similarity_threshold = 0.1");

  for (const query of testQueries) {
    const result = await client.query(
      `
      SELECT id, title, 
             similarity(title || ' ' || content, $1) AS score
      FROM search_test
      WHERE (title || ' ' || content) % $1
      ORDER BY score DESC
      LIMIT 3
    `,
      [query]
    );

    console.log(`\n查询: "${query}"`);
    if (result.rows.length === 0) {
      console.log('  (无结果)');
    } else {
      for (const row of result.rows) {
        console.log(`  [${row.score.toFixed(3)}] #${row.id}: ${row.title}`);
      }
    }
  }

  // ============================================
  // 测试 1b: pg_trgm word_similarity (子串匹配)
  // ============================================
  console.log('\n' + '-'.repeat(60));
  console.log('测试 1b: pg_trgm word_similarity (子串匹配)');
  console.log('-'.repeat(60));

  for (const query of testQueries) {
    const result = await client.query(
      `
      SELECT id, title, 
             word_similarity($1, title || ' ' || content) AS score
      FROM search_test
      WHERE $1 <% (title || ' ' || content)
      ORDER BY score DESC
      LIMIT 3
    `,
      [query]
    );

    console.log(`\n查询: "${query}"`);
    if (result.rows.length === 0) {
      console.log('  (无结果)');
    } else {
      for (const row of result.rows) {
        console.log(`  [${row.score.toFixed(3)}] #${row.id}: ${row.title}`);
      }
    }
  }

  // ============================================
  // 测试 2: 原生 tsvector (simple 配置)
  // ============================================
  console.log('\n' + '-'.repeat(60));
  console.log('测试 2: 原生 tsvector (simple 配置 - 按空格分词)');
  console.log('-'.repeat(60));

  await client.query(`
    ALTER TABLE search_test ADD COLUMN IF NOT EXISTS tsv tsvector;
    UPDATE search_test SET tsv = to_tsvector('simple', title || ' ' || content);
    CREATE INDEX IF NOT EXISTS idx_search_test_tsv ON search_test USING gin(tsv);
  `);

  for (const query of testQueries) {
    // simple 配置按空格分词，对中文基本无效
    const tsQuery = query.split(/\s+/).join(' | ');
    const result = await client.query(
      `
      SELECT id, title, ts_rank(tsv, to_tsquery('simple', $1)) AS score
      FROM search_test
      WHERE tsv @@ to_tsquery('simple', $1)
      ORDER BY score DESC
      LIMIT 3
    `,
      [tsQuery]
    );

    console.log(`\n查询: "${query}"`);
    if (result.rows.length === 0) {
      console.log('  (无结果 - 中文没有空格分隔，tsvector 无法分词)');
    } else {
      for (const row of result.rows) {
        console.log(`  [${row.score.toFixed(3)}] #${row.id}: ${row.title}`);
      }
    }
  }

  // ============================================
  // 测试 3: LIKE 模糊匹配 (作为基准)
  // ============================================
  console.log('\n' + '-'.repeat(60));
  console.log('测试 3: LIKE 模糊匹配 (基准对比)');
  console.log('-'.repeat(60));

  for (const query of testQueries) {
    const result = await client.query(
      `
      SELECT id, title
      FROM search_test
      WHERE title || ' ' || content LIKE '%' || $1 || '%'
      LIMIT 3
    `,
      [query]
    );

    console.log(`\n查询: "${query}"`);
    if (result.rows.length === 0) {
      console.log('  (无结果)');
    } else {
      for (const row of result.rows) {
        console.log(`  #${row.id}: ${row.title}`);
      }
    }
  }

  // 清理
  await client.query('DROP TABLE IF EXISTS search_test');

  // ============================================
  // 测试 4: 应用层预分词 + tsvector (模拟 jieba)
  // ============================================
  console.log('\n' + '-'.repeat(60));
  console.log('测试 4: 应用层预分词 + tsvector (模拟分词结果)');
  console.log('-'.repeat(60));

  // 重建表，这次加入预分词的数据
  await client.query('DROP TABLE IF EXISTS search_test');
  await client.query(`
    CREATE TABLE search_test (
      id INT PRIMARY KEY,
      title TEXT,
      content TEXT,
      segmented TEXT  -- 分词后的文本（空格分隔）
    );
  `);

  // 模拟 jieba 分词后的结果（手动分词演示）
  const testDocsWithSegmentation = [
    {
      id: 1,
      title: '深度学习在自然语言处理中的应用',
      content: testDocs[0].content,
      // 模拟分词结果
      segmented:
        '深度 学习 深度学习 自然 语言 处理 自然语言处理 应用 Transformer BERT GPT 预训练 模型 人工智能 文本 分类 情感 分析 机器翻译 问答 系统',
    },
    {
      id: 2,
      title: 'PostgreSQL 全文搜索指南',
      content: testDocs[1].content,
      segmented:
        'PostgreSQL 全文 搜索 全文搜索 指南 tsvector tsquery 文本 检索 索引 分词器 性能 优化 中文 zhparser pg_jieba',
    },
    {
      id: 3,
      title: '向量数据库与语义搜索',
      content: testDocs[2].content,
      segmented:
        '向量 数据库 向量数据库 语义 搜索 语义搜索 嵌入 embedding 非结构化 数据 pgvector HNSW IVFFlat 索引 关键词 混合搜索',
    },
    {
      id: 4,
      title: 'React 18 新特性详解',
      content: testDocs[3].content,
      segmented:
        'React 18 新特性 并发 渲染 自动 批处理 Suspense useTransition useDeferredValue 钩子 用户体验 createRoot API',
    },
    {
      id: 5,
      title: '机器学习模型部署最佳实践',
      content: testDocs[4].content,
      segmented:
        '机器 学习 机器学习 模型 部署 最佳实践 生产环境 序列化 API 设计 性能 优化 监控 告警 TensorFlow Serving TorchServe Triton Docker Kubernetes',
    },
  ];

  for (const doc of testDocsWithSegmentation) {
    await client.query(
      'INSERT INTO search_test (id, title, content, segmented) VALUES ($1, $2, $3, $4)',
      [doc.id, doc.title, doc.content, doc.segmented]
    );
  }

  await client.query(`
    ALTER TABLE search_test ADD COLUMN IF NOT EXISTS tsv tsvector;
    UPDATE search_test SET tsv = to_tsvector('simple', segmented);
    CREATE INDEX IF NOT EXISTS idx_search_test_tsv ON search_test USING gin(tsv);
  `);

  // 测试查询（也需要对查询进行分词，这里手动模拟）
  const segmentedQueries: Record<string, string> = {
    深度学习: '深度 | 学习 | 深度学习',
    自然语言处理: '自然 | 语言 | 处理 | 自然语言处理',
    'PostgreSQL 搜索': 'PostgreSQL | 搜索',
    向量数据库: '向量 | 数据库 | 向量数据库',
    机器学习部署: '机器 | 学习 | 机器学习 | 部署',
    React: 'React',
    中文分词: '中文 | 分词',
    语义搜索: '语义 | 搜索 | 语义搜索',
    'BERT GPT': 'BERT | GPT',
    性能优化: '性能 | 优化',
  };

  for (const [query, tsQuery] of Object.entries(segmentedQueries)) {
    const result = await client.query(
      `
      SELECT id, title, ts_rank(tsv, to_tsquery('simple', $1)) AS score
      FROM search_test
      WHERE tsv @@ to_tsquery('simple', $1)
      ORDER BY score DESC
      LIMIT 3
    `,
      [tsQuery]
    );

    console.log(`\n查询: "${query}" -> "${tsQuery}"`);
    if (result.rows.length === 0) {
      console.log('  (无结果)');
    } else {
      for (const row of result.rows) {
        console.log(`  [${row.score.toFixed(3)}] #${row.id}: ${row.title}`);
      }
    }
  }

  // ============================================
  // 总结
  // ============================================
  console.log('\n' + '='.repeat(60));
  console.log('测试总结');
  console.log('='.repeat(60));
  console.log(`
1. pg_trgm (三元组):
   - 优点: 无需分词，对任何语言都能工作
   - 缺点: 基于字符匹配，不是语义搜索；短查询效果差
   - 适用: 模糊搜索、拼写纠错

2. 原生 tsvector (simple):
   - 优点: PostgreSQL 内置，无需额外扩展
   - 缺点: 按空格分词，对中文几乎无效
   - 适用: 仅适合西文

3. LIKE 模糊匹配:
   - 优点: 简单直接，一定能匹配到
   - 缺点: 性能差（全表扫描），无排序
   - 适用: 仅作为 fallback

4. 应用层预分词 + tsvector:
   - 优点: 可用 jieba-js 等成熟分词库，分词质量高
   - 优点: 不依赖 PG 扩展，Neon 等托管平台都支持
   - 缺点: 需要在应用层维护分词逻辑，写入时多一步
   - 适用: 中文全文搜索的实用方案

⚠️  建议后续在 Neon 上测试 pg_search (ParadeDB):
   - 支持 BM25 排序（比 ts_rank 更准确）
   - 有 ICU/Lindera tokenizer，可能支持中文
   - Neon PG17 已预装

📌 推荐方案（按优先级）:
   1. 向量搜索 (pgvector) - 语义搜索，语言无关
   2. 应用层分词 + tsvector - 关键词搜索，分词质量可控
   3. pg_search (Neon) - 待测试中文效果
`);

  await client.end();
  console.log('\n测试完成。');
}

main().catch(console.error);
