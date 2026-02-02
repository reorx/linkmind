/**
 * Test script: separately test scraping and LLM analysis with detailed error output.
 *
 * Usage: npx tsx src/test-pipeline.ts <url> [--scrape-only] [--analyze-only]
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { initLogger } from './logger.js';
initLogger();

import { scrapeUrl } from './scraper.js';
import { getLLM } from './llm.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: npx tsx src/test-pipeline.ts <url> [--scrape-only] [--analyze-only]');
  process.exit(1);
}

const scrapeOnly = process.argv.includes('--scrape-only');
const analyzeOnly = process.argv.includes('--analyze-only');

async function testScrape() {
  console.log('\n━━━ SCRAPE TEST ━━━');
  console.log(`URL: ${url}\n`);

  try {
    const start = Date.now();
    const result = await scrapeUrl(url);
    const elapsed = Date.now() - start;

    console.log(`✅ Scrape succeeded (${elapsed}ms)`);
    console.log(`  Title:       ${result.title}`);
    console.log(`  OG Title:    ${result.og.title}`);
    console.log(`  OG Desc:     ${(result.og.description || '').slice(0, 100)}`);
    console.log(`  OG Image:    ${result.og.image || '(none)'}`);
    console.log(`  OG Site:     ${result.og.siteName || '(none)'}`);
    console.log(`  Author:      ${result.author || '(none)'}`);
    console.log(`  Published:   ${result.published || '(none)'}`);
    console.log(`  Content len: ${result.markdown.length} chars`);
    console.log(`\n  First 500 chars of content:`);
    console.log(`  ${result.markdown.slice(0, 500).replace(/\n/g, '\n  ')}`);

    return result;
  } catch (err) {
    console.error(`\n❌ Scrape FAILED`);
    if (err instanceof Error) {
      console.error(`  Error: ${err.message}`);
      console.error(`  Stack: ${err.stack}`);
    } else {
      console.error(`  Error: ${String(err)}`);
    }
    return null;
  }
}

async function testLLM(markdown?: string) {
  console.log('\n━━━ LLM TEST ━━━');

  const llm = getLLM();
  console.log(`Provider: ${llm.name}\n`);

  const testContent = markdown?.slice(0, 2000) || 'This is a test article about web development and AI tools.';

  try {
    console.log('Testing basic chat...');
    const start = Date.now();
    const result = await llm.chat(
      [
        { role: 'system', content: '用中文回答，简洁明了。' },
        { role: 'user', content: `请用一句话概括这段内容:\n${testContent.slice(0, 500)}` },
      ],
      { maxTokens: 256 },
    );
    const elapsed = Date.now() - start;
    console.log(`✅ Basic chat succeeded (${elapsed}ms)`);
    console.log(`  Response: ${result.slice(0, 200)}`);
  } catch (err) {
    console.error(`\n❌ Basic chat FAILED`);
    if (err instanceof Error) {
      console.error(`  Error: ${err.message}`);
      console.error(`  Stack: ${err.stack}`);
    } else {
      console.error(`  Error: ${String(err)}`);
    }
  }

  try {
    console.log('\nTesting JSON mode...');
    const start = Date.now();
    const result = await llm.chat(
      [
        {
          role: 'system',
          content: '以 JSON 格式输出: {"summary": "一句话摘要", "tags": ["tag1"]}',
        },
        { role: 'user', content: `概括:\n${testContent.slice(0, 500)}` },
      ],
      { maxTokens: 256, jsonMode: true },
    );
    const elapsed = Date.now() - start;
    console.log(`✅ JSON mode succeeded (${elapsed}ms)`);
    console.log(`  Response: ${result.slice(0, 200)}`);

    // Verify it's valid JSON
    const parsed = JSON.parse(result);
    console.log(`  Parsed OK: ${JSON.stringify(parsed).slice(0, 200)}`);
  } catch (err) {
    console.error(`\n❌ JSON mode FAILED`);
    if (err instanceof Error) {
      console.error(`  Error: ${err.message}`);
      console.error(`  Stack: ${err.stack}`);
    } else {
      console.error(`  Error: ${String(err)}`);
    }
  }
}

async function main() {
  let scrapeResult = null;

  if (!analyzeOnly) {
    scrapeResult = await testScrape();
  }

  if (!scrapeOnly) {
    await testLLM(scrapeResult?.markdown);
  }

  console.log('\n━━━ DONE ━━━\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
