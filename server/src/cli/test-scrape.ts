import { scrapeUrl, isScrapeContentValid } from '../scraper.js';
import { scrapeWithFirecrawl } from '../scraper-firecrawl.js';
import { scrapeWithJina } from '../scraper-jina.js';
import { scrapeWithCrawlee } from '../scraper-crawlee.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const positional = args.filter((a) => !a.startsWith('-'));
const mode = positional[0] || 'playwright';
const url = positional[1] || 'https://note.mowen.cn/detail/FP0rFh9XewHUSKnjEZhmI';

console.log(`Mode: ${mode} | URL: ${url}${verbose ? ' | verbose' : ''}\n`);

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
  } else if (mode === 'crawlee') {
    const result = await scrapeWithCrawlee(url);
    console.log('Title:', result.title);
    console.log('OG:', JSON.stringify(result.og, null, 2));
    console.log('Author:', result.author);
    console.log('Published:', result.published);
    console.log('Markdown length:', result.markdown.length);
    console.log('Valid:', isScrapeContentValid(result.markdown));
    console.log('Markdown preview:', result.markdown.slice(0, 500));
    if (verbose) {
      console.log('\n--- Raw HTML length:', result.rawHtml?.length ?? 0);
      console.log('--- Raw HTML preview (first 2000 chars):');
      console.log(result.rawHtml?.slice(0, 2000) ?? '(none)');
      console.log('\n--- Full Markdown:');
      console.log(result.markdown || '(empty)');
    }
  } else if (mode === 'jina') {
    const result = await scrapeWithJina(url);
    if (!result) {
      console.log('Jina skipped (no API keys available)');
    } else {
      console.log('Title:', result.metadata.title);
      console.log('Markdown length:', result.markdown.length);
      console.log('Tokens used:', result.usage.tokens);
      console.log('Valid:', isScrapeContentValid(result.markdown));
      console.log('Markdown preview:', result.markdown.slice(0, 500));
    }
  } else {
    const result = await scrapeUrl(url);
    console.log('Title:', result.title);
    console.log('OG Title:', result.og.title);
    console.log('OG:', JSON.stringify(result.og, null, 2));
    console.log('Author:', result.author);
    console.log('Published:', result.published);
    console.log('Markdown length:', result.markdown.length);
    console.log('Valid:', isScrapeContentValid(result.markdown));
    console.log('Markdown preview:', result.markdown.slice(0, 500));
    if (verbose) {
      console.log('\n--- Raw HTML length:', result.rawHtml?.length ?? 0);
      console.log('--- Raw HTML preview (first 2000 chars):');
      console.log(result.rawHtml?.slice(0, 2000) ?? '(none)');
      console.log('\n--- Full Markdown:');
      console.log(result.markdown || '(empty)');
    }
  }
} catch (err) {
  console.error('Scrape failed:', err);
}
