/**
 * Test embedding API functionality.
 * Run: npx tsx scripts/test-embedding.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { createEmbedding } from '../src/llm.js';

async function main() {
  const text = '这是一个测试文本，用于验证 DashScope embedding API 是否正常工作。深度学习是人工智能的重要分支。';
  
  console.log('Testing embedding API...');
  console.log('Input text length:', text.length);
  
  const embedding = await createEmbedding(text);
  
  console.log('✅ Embedding created successfully');
  console.log('Dimensions:', embedding.length);
  console.log('First 5 values:', embedding.slice(0, 5));
  console.log('Vector format sample:', `[${embedding.slice(0, 3).join(',')}...]`);
}

main().catch(console.error);
