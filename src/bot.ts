/**
 * Telegram Bot: receives links, triggers scraping + analysis pipeline.
 * Handles user registration and /login for web auth.
 */

import { Bot } from 'grammy';
import jwt from 'jsonwebtoken';
import { getLink, findOrCreateUser } from './db.js';
import { processUrl } from './pipeline.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'bot' });

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return secret;
}

export function startBot(token: string, webBaseUrl: string): Bot {
  const bot = new Bot(token);

  // /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '🧠 欢迎使用 LinkMind！\n\n发送任意链接，我会自动抓取、分析并保存。\n\n命令：\n/login — 获取网页登录链接',
    );
  });

  // /login command — generate a temporary JWT link for web auth
  bot.command('login', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await findOrCreateUser(
      from.id,
      from.username,
      [from.first_name, from.last_name].filter(Boolean).join(' '),
    );

    const loginToken = jwt.sign({ userId: user.id, telegramId: from.id }, getJwtSecret(), {
      expiresIn: '5m',
    });

    const loginUrl = `${webBaseUrl}/auth/callback?token=${loginToken}`;

    await ctx.reply('🔑 点击下方按钮登录 LinkMind 网页版：', {
      reply_markup: {
        inline_keyboard: [[{ text: '🌐 登录网页版', url: loginUrl }]],
      },
    });
  });

  // Handle messages with URLs
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const urls = text.match(URL_REGEX);

    if (!urls || urls.length === 0) {
      return;
    }

    const from = ctx.from;
    if (!from) return;

    // Register/update user
    const user = await findOrCreateUser(
      from.id,
      from.username,
      [from.first_name, from.last_name].filter(Boolean).join(' '),
    );

    // Fire and forget: don't block the handler so grammY can process next message
    for (const url of urls) {
      handleUrl(ctx, url, webBaseUrl, user.id!).catch((err) => {
        log.error({ url, err: err instanceof Error ? err.message : String(err) }, 'handleUrl uncaught error');
      });
    }
  });

  bot.catch((err) => {
    log.error({ err: err.message }, 'Bot error');
  });

  bot.start();
  log.info('Telegram bot started');

  return bot;
}

async function handleUrl(ctx: any, url: string, webBaseUrl: string, userId: number): Promise<void> {
  const isDuplicate = !!(await import('./db.js').then((db) => db.getLinkByUrl(userId, url)));
  const statusText = isDuplicate ? `🔄 该链接已存在，正在重新抓取、更新和分析...` : `🔗 收到链接，正在处理...`;

  const statusMsg = await ctx.reply(statusText, {
    link_preview_options: { is_disabled: true },
  });

  const result = await processUrl(userId, url, async (stage) => {
    if (stage === 'scraping') {
      await editMessage(ctx, statusMsg, isDuplicate ? `🔄 正在重新抓取网页内容...` : `⏳ 正在抓取网页内容...`);
    } else if (stage === 'analyzing') {
      await editMessage(ctx, statusMsg, isDuplicate ? `🔄 正在重新分析内容...` : `🤖 正在分析内容...`);
    }
  });

  if (result.status === 'error') {
    await editMessage(ctx, statusMsg, `❌ 处理失败: ${(result.error || '').slice(0, 200)}`);
    return;
  }

  const link = await getLink(result.linkId);
  if (!link) return;

  const tags: string[] = safeParseJson(link.tags);
  const relatedNotes: any[] = safeParseJson(link.related_notes);
  const relatedLinks: any[] = safeParseJson(link.related_links);
  const permanentLink = `${webBaseUrl}/link/${result.linkId}`;

  const resultText = formatResult({
    title: result.title,
    url: result.url,
    summary: link.summary || '',
    insight: link.insight || '',
    tags,
    relatedNotes,
    relatedLinks,
    permanentLink,
  });

  log.debug({ html: resultText }, 'Sending Telegram message');
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
    msg += data.tags.map((t) => `#${t.replace(/\s+/g, '_')}`).join(' ') + '\n\n';
  }

  msg += `<b>📝 摘要</b>\n${escHtml(data.summary)}\n\n`;
  msg += `<b>💡 Insight</b>\n${escHtml(data.insight)}\n`;

  if (data.relatedNotes.length > 0) {
    msg += `\n<b>📓 相关笔记</b>\n`;
    for (const n of data.relatedNotes.slice(0, 3)) {
      const noteTitle = n.title || n.path || '';
      msg += `• ${escHtml(noteTitle)}\n`;
    }
  }

  if (data.relatedLinks.length > 0) {
    msg += `\n<b>🔗 相关链接</b>\n`;
    for (const l of data.relatedLinks.slice(0, 3)) {
      msg += `• <a href="${escHtml(l.url || '')}">${escHtml(truncate(l.title || l.url || '', 50))}</a>\n`;
    }
  }

  msg += `\n<a href="${escHtml(data.permanentLink)}">🔍 查看完整分析</a>`;

  return msg;
}

async function editMessage(ctx: any, statusMsg: any, text: string, parseHtml: boolean = false): Promise<void> {
  try {
    const opts: Record<string, any> = {
      link_preview_options: { is_disabled: true },
    };
    if (parseHtml) {
      opts.parse_mode = 'HTML';
    }
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, text, opts);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'editMessage failed');
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
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
