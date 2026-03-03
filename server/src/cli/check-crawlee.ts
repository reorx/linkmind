import { spawnSync } from 'node:child_process';
import { scrapeWithCrawlee } from '../scraper-crawlee.js';
import { isScrapeContentValid } from '../scraper.js';

const url = process.argv[2] || 'https://mp.weixin.qq.com/s/LWcRabPmQy6kd1qqv9MmXA';

function checkPsCommand(): { ok: boolean; location: string } {
  const res = spawnSync('sh', ['-lc', 'command -v ps || true'], { encoding: 'utf-8' });
  const location = (res.stdout || '').trim();
  return { ok: Boolean(location), location: location || '(not found)' };
}

console.log('[check-crawlee] environment');
console.log(`- node: ${process.version}`);
console.log(`- platform: ${process.platform} ${process.arch}`);
console.log(`- pid: ${process.pid}`);

const ps = checkPsCommand();
console.log(`- ps: ${ps.ok ? 'ok' : 'missing'} (${ps.location})`);

console.log(`[check-crawlee] scraping: ${url}`);

try {
  const result = await scrapeWithCrawlee(url);
  const valid = isScrapeContentValid(result.markdown);

  console.log('[check-crawlee] success');
  console.log(`- title: ${result.title || '(empty)'}`);
  console.log(`- author: ${result.author || '(empty)'}`);
  console.log(`- published: ${result.published || '(empty)'}`);
  console.log(`- markdown length: ${result.markdown.length}`);
  console.log(`- valid: ${valid}`);
  console.log(`- preview: ${result.markdown.slice(0, 280).replace(/\s+/g, ' ').trim()}`);
} catch (err) {
  console.error('[check-crawlee] failed');
  console.error(err);
  process.exit(1);
}
