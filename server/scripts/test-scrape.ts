import dotenv from 'dotenv';
dotenv.config({ override: true });

import { scrapeUrl, isScrapeContentValid } from '../src/scraper.js';
import { scrapeWithFirecrawl } from '../src/scraper-firecrawl.js';

const mode = process.argv[2] || 'playwright';
const url = process.argv[3] || 'https://note.mowen.cn/detail/FP0rFh9XewHUSKnjEZhmI';

console.log(`Mode: ${mode} | URL: ${url}\n`);

try {
  if (mode === 'firecrawl') {
    const result = await scrapeWithFirecrawl(url);
    if (!result) {
      console.log('Firecrawl skipped (no API key)');
    } else {
      console.log('Title:', result.metadata.title);
      console.log('Markdown length:', result.markdown.length);
      console.log('Valid:', isScrapeContentValid(result.markdown));
      console.log('Markdown preview:', result.markdown.slice(0, 500));
    }
  } else {
    const result = await scrapeUrl(url);
    console.log('Title:', result.title);
    console.log('OG Title:', result.og.title);
    console.log('Markdown length:', result.markdown.length);
    console.log('Valid:', isScrapeContentValid(result.markdown));
    console.log('Markdown preview:', result.markdown.slice(0, 500));
  }
} catch (err) {
  console.error('Scrape failed:', err);
}
