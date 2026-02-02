/**
 * Telegram Bot: receives links, triggers scraping + analysis pipeline.
 */

import { Bot } from "grammy";
import { insertLink, updateLink, getLink } from "./db.js";
import { scrapeUrl } from "./scraper.js";
import { analyzeArticle } from "./agent.js";
import { exportLinkMarkdown } from "./export.js";

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

export function startBot(token: string, webBaseUrl: string): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const urls = text.match(URL_REGEX);

    if (!urls || urls.length === 0) {
      // Not a link, ignore
      return;
    }

    for (const url of urls) {
      await processUrl(ctx, url, webBaseUrl);
    }
  });

  bot.catch((err) => {
    console.error("[bot] Error:", err.message);
  });

  bot.start();
  console.log("[bot] Telegram bot started");

  return bot;
}

async function processUrl(
  ctx: any,
  url: string,
  webBaseUrl: string,
): Promise<void> {
  const statusMsg = await ctx.reply(`🔗 收到链接，正在处理...\n${url}`);

  try {
    // Step 1: Insert into DB
    const linkId = insertLink(url);
    console.log(`[bot] Processing URL: ${url} (id=${linkId})`);

    // Step 2: Scrape
    await editMessage(ctx, statusMsg, `⏳ 正在抓取网页内容...`);
    const scrapeResult = await scrapeUrl(url);

    updateLink(linkId, {
      og_title: scrapeResult.og.title,
      og_description: scrapeResult.og.description,
      og_image: scrapeResult.og.image,
      og_site_name: scrapeResult.og.siteName,
      og_type: scrapeResult.og.type,
      markdown: scrapeResult.markdown,
      status: "scraped",
    });

    console.log(
      `[bot] Scraped: ${scrapeResult.og.title || url} (${scrapeResult.markdown.length} chars)`,
    );

    // Step 3: Analyze with Agent
    await editMessage(ctx, statusMsg, `🤖 正在分析内容...`);
    const analysis = await analyzeArticle({
      url,
      title: scrapeResult.og.title,
      ogDescription: scrapeResult.og.description,
      siteName: scrapeResult.og.siteName,
      markdown: scrapeResult.markdown,
    });

    updateLink(linkId, {
      summary: analysis.summary,
      insight: analysis.insight,
      tags: JSON.stringify(analysis.tags),
      related_notes: JSON.stringify(analysis.relatedNotes),
      related_links: JSON.stringify(analysis.relatedLinks),
      status: "analyzed",
    });

    console.log(`[bot] Analyzed: ${scrapeResult.og.title || url}`);

    // Step 3.5: Export to Markdown for QAMD indexing
    const fullLink = getLink(linkId);
    if (fullLink) {
      try {
        exportLinkMarkdown(fullLink);
      } catch (exportErr) {
        console.error(`[bot] Export failed:`, exportErr);
      }
    }

    // Step 4: Send result
    const permanentLink = `${webBaseUrl}/link/${linkId}`;
    const resultText = formatResult({
      title: scrapeResult.og.title || url,
      url,
      summary: analysis.summary,
      insight: analysis.insight,
      tags: analysis.tags,
      relatedNotes: analysis.relatedNotes,
      relatedLinks: analysis.relatedLinks,
      permanentLink,
    });

    await editMessage(ctx, statusMsg, resultText, true);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[bot] Error processing ${url}:`, errMsg);

    // Try to update DB with error
    try {
      const link = (await import("./db.js")).getLinkByUrl(url);
      if (link?.id) {
        updateLink(link.id, { status: "error", error_message: errMsg });
      }
    } catch {}

    await editMessage(ctx, statusMsg, `❌ 处理失败: ${errMsg.slice(0, 200)}`);
  }
}

function formatResult(data: {
  title: string;
  url: string;
  summary: string;
  insight: string;
  tags: string[];
  relatedNotes: any[];
  relatedLinks: any[];
  permanentLink: string;
}): string {
  let msg = `📄 <b>${escHtml(data.title)}</b>\n`;
  msg += `<a href="${escHtml(data.url)}">${escHtml(truncate(data.url, 60))}</a>\n\n`;

  if (data.tags.length > 0) {
    msg += data.tags.map((t) => `#${t.replace(/\s+/g, "_")}`).join(" ") + "\n\n";
  }

  msg += `<b>📝 摘要</b>\n${escHtml(data.summary)}\n\n`;
  msg += `<b>💡 Insight</b>\n${escHtml(data.insight)}\n`;

  if (data.relatedNotes.length > 0) {
    msg += `\n<b>📓 相关笔记</b>\n`;
    for (const n of data.relatedNotes.slice(0, 3)) {
      msg += `• ${escHtml(n.title || n.path || "")}\n`;
    }
  }

  if (data.relatedLinks.length > 0) {
    msg += `\n<b>🔗 相关链接</b>\n`;
    for (const l of data.relatedLinks.slice(0, 3)) {
      msg += `• <a href="${escHtml(l.url || "")}">${escHtml(truncate(l.title || l.url || "", 50))}</a>\n`;
    }
  }

  msg += `\n<a href="${escHtml(data.permanentLink)}">🔍 查看完整分析</a>`;

  return msg;
}

async function editMessage(
  ctx: any,
  statusMsg: any,
  text: string,
  parseHtml: boolean = false,
): Promise<void> {
  try {
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      text,
      parseHtml ? { parse_mode: "HTML", link_preview_options: { is_disabled: true } } : undefined,
    );
  } catch {
    // Edit might fail if message is the same, ignore
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
