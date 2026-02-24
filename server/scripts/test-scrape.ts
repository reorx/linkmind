import dotenv from 'dotenv';
dotenv.config({ override: true });

import { scrapeUrl } from '../src/scraper.js';

const url = process.argv[2] || 'https://note.mowen.cn/detail/FP0rFh9XewHUSKnjEZhmI';

console.log(`Scraping: ${url}\n`);

try {
  const result = await scrapeUrl(url);
  console.log('Title:', result.title);
  console.log('OG Title:', result.og.title);
  console.log('OG Description:', result.og.description?.slice(0, 100));
  console.log('Markdown length:', result.markdown.length);
  console.log('Markdown preview:', result.markdown.slice(0, 500));
} catch (err) {
  console.error('Scrape failed:', err);
}
