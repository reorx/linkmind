/**
 * Test script: run the full pipeline on a URL without the Telegram bot.
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import { insertLink, updateLink, getLink } from "./db.js";
import { scrapeUrl } from "./scraper.js";
import { analyzeArticle } from "./agent.js";
import { exportLinkMarkdown } from "./export.js";

const testUrl = process.argv[2];
if (!testUrl) {
  console.error("Usage: tsx src/test.ts <url>");
  process.exit(1);
}

async function main() {
  console.log(`\n🔗 Testing pipeline with: ${testUrl}\n`);

  // Step 1: Insert
  const linkId = insertLink(testUrl);
  console.log(`[db] Created link id=${linkId}`);

  // Step 2: Scrape
  console.log(`[scrape] Fetching...`);
  const t0 = Date.now();
  const scrapeResult = await scrapeUrl(testUrl);
  console.log(`[scrape] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  Title: ${scrapeResult.og.title}`);
  console.log(`  Site: ${scrapeResult.og.siteName}`);
  console.log(`  Markdown: ${scrapeResult.markdown.length} chars`);

  updateLink(linkId, {
    og_title: scrapeResult.og.title,
    og_description: scrapeResult.og.description,
    og_image: scrapeResult.og.image,
    og_site_name: scrapeResult.og.siteName,
    og_type: scrapeResult.og.type,
    markdown: scrapeResult.markdown,
    status: "scraped",
  });

  // Step 3: Analyze
  console.log(`\n[agent] Analyzing...`);
  const t1 = Date.now();
  const analysis = await analyzeArticle({
    url: testUrl,
    title: scrapeResult.og.title,
    ogDescription: scrapeResult.og.description,
    siteName: scrapeResult.og.siteName,
    markdown: scrapeResult.markdown,
  });
  console.log(`[agent] Done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  updateLink(linkId, {
    summary: analysis.summary,
    insight: analysis.insight,
    tags: JSON.stringify(analysis.tags),
    related_notes: JSON.stringify(analysis.relatedNotes),
    related_links: JSON.stringify(analysis.relatedLinks),
    status: "analyzed",
  });

  // Print results
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📄 ${scrapeResult.og.title || testUrl}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\n🏷️  Tags: ${analysis.tags.join(", ")}`);
  console.log(`\n📝 摘要:\n${analysis.summary}`);
  console.log(`\n💡 Insight:\n${analysis.insight}`);

  if (analysis.relatedNotes.length > 0) {
    console.log(`\n📓 相关笔记:`);
    for (const n of analysis.relatedNotes) {
      console.log(`  - ${n.title || n.path}`);
    }
  }

  if (analysis.relatedLinks.length > 0) {
    console.log(`\n🔗 相关链接:`);
    for (const l of analysis.relatedLinks) {
      console.log(`  - ${l.title} (${l.url})`);
    }
  }

  console.log(`\n🔍 Permanent link: http://localhost:3456/link/${linkId}`);

  // Export markdown for qmd
  const fullLink = getLink(linkId);
  if (fullLink) {
    const exportPath = exportLinkMarkdown(fullLink);
    console.log(`\n[export] Written: ${exportPath}`);
  }

  // Verify DB
  const saved = getLink(linkId);
  console.log(`\n[db] Status: ${saved?.status}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
