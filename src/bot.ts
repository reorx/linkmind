/**
 * Telegram Bot: receives links, triggers scraping + analysis pipeline.
 */

import { Bot } from "grammy";
import { getLink } from "./db.js";
import { processUrl } from "./pipeline.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "bot" });

const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || "Obsidian-Base";
const QMD_NOTES_COLLECTION = process.env.QMD_NOTES_COLLECTION || "notes";

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

export function startBot(token: string, webBaseUrl: string): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const urls = text.match(URL_REGEX);

    if (!urls || urls.length === 0) {
      return;
    }

    for (const url of urls) {
      await handleUrl(ctx, url, webBaseUrl);
    }
  });

  bot.catch((err) => {
    log.error({ err: err.message }, "Bot error");
  });

  bot.start();
  log.info("Telegram bot started");

  return bot;
}

async function handleUrl(ctx: any, url: string, webBaseUrl: string): Promise<void> {
  const statusMsg = await ctx.reply(`🔗 收到链接，正在处理...\n${url}`);

  const result = await processUrl(url, async (stage) => {
    if (stage === "scraping") {
      await editMessage(ctx, statusMsg, `⏳ 正在抓取网页内容...`);
    } else if (stage === "analyzing") {
      await editMessage(ctx, statusMsg, `🤖 正在分析内容...`);
    }
  });

  if (result.status === "error") {
    await editMessage(ctx, statusMsg, `❌ 处理失败: ${(result.error || "").slice(0, 200)}`);
    return;
  }

  const link = getLink(result.linkId);
  if (!link) return;

  const tags: string[] = safeParseJson(link.tags);
  const relatedNotes: any[] = safeParseJson(link.related_notes);
  const relatedLinks: any[] = safeParseJson(link.related_links);
  const permanentLink = `${webBaseUrl}/link/${result.linkId}`;

  const resultText = formatResult({
    title: result.title,
    url: result.url,
    summary: link.summary || "",
    insight: link.insight || "",
    tags,
    relatedNotes,
    relatedLinks,
    permanentLink,
  });

  log.debug({ html: resultText }, "Sending Telegram message");
  await editMessage(ctx, statusMsg, resultText, true);
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
      const noteTitle = n.title || n.path || "";
      const obsidianUrl = buildObsidianUrl(n.path || n.file);
      if (obsidianUrl) {
        msg += `• <a href="${escHtml(obsidianUrl)}">${escHtml(noteTitle)}</a>\n`;
      } else {
        msg += `• ${escHtml(noteTitle)}\n`;
      }
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
    const opts: Record<string, any> = {};
    if (parseHtml) {
      opts.parse_mode = "HTML";
      opts.link_preview_options = { is_disabled: true };
    }
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, text, opts);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "editMessage failed");
  }
}

/**
 * Build an obsidian:// URL from a qmd file path.
 */
function buildObsidianUrl(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const prefix = `qmd://${QMD_NOTES_COLLECTION}/`;
  let notePath = filePath;
  if (notePath.startsWith(prefix)) {
    notePath = notePath.slice(prefix.length);
  }
  if (notePath.endsWith(".md")) {
    notePath = notePath.slice(0, -3);
  }
  return `obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT)}&file=${encodeURIComponent(notePath)}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function safeParseJson(s?: string): any[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
