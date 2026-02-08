/**
 * Telegram Bot: receives links, triggers scraping + analysis pipeline.
 * Handles user registration via invite codes and /login for web auth.
 */

import { Bot, InputFile } from 'grammy';
import jwt from 'jsonwebtoken';
import path from 'path';
import { existsSync } from 'fs';
import {
  getLink,
  getLinkByUrl,
  findOrCreateUser,
  getInviteByCode,
  useInvite,
  getUserByTelegramId,
  getRelatedLinks,
} from './db.js';
import { spawnProcessLink } from './pipeline.js';
import { Sentry } from './sentry.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'bot' });

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

interface RelatedLinkInfo {
  linkId: number;
  title: string;
  sourceUrl: string; // Original URL
  internalUrl: string; // Our link detail page URL
}

/**
 * Fetch related links from link_relations table with their details.
 */
async function fetchRelatedLinksInfo(linkId: number, webBaseUrl: string): Promise<RelatedLinkInfo[]> {
  const relatedLinkData = await getRelatedLinks(linkId);
  const results: RelatedLinkInfo[] = [];

  for (const item of relatedLinkData) {
    const relatedLink = await getLink(item.relatedLinkId);
    if (relatedLink) {
      results.push({
        linkId: item.relatedLinkId,
        title: relatedLink.og_title || relatedLink.url,
        sourceUrl: relatedLink.url,
        internalUrl: `${webBaseUrl}/link/${item.relatedLinkId}`,
      });
    }
  }

  return results;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return secret;
}

export function startBot(token: string, webBaseUrl: string): Bot {
  const bot = new Bot(token);

  // /start command — handle invite deep links and plain start
  bot.command('start', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const payload = ctx.match; // text after /start
    const user = await findOrCreateUser(
      from.id,
      from.username,
      [from.first_name, from.last_name].filter(Boolean).join(' '),
    );

    // Handle invite deep link: /start invite_<code>
    if (payload && payload.startsWith('invite_')) {
      if (user.status === 'active') {
        await ctx.reply('你已经注册过了 ✅ 直接发链接给我就行！');
        return;
      }

      const code = payload.slice('invite_'.length);
      const invite = await getInviteByCode(code);

      if (!invite || !invite.id) {
        await ctx.reply('❌ 邀请码无效');
        return;
      }

      if (invite.used_count >= invite.max_uses) {
        await ctx.reply('❌ 该邀请码已用完');
        return;
      }

      const ok = await useInvite(invite.id, user.id!);
      if (!ok) {
        await ctx.reply('❌ 邀请码使用失败，请重试');
        return;
      }

      log.info({ userId: user.id, telegramId: from.id, inviteCode: code }, 'User registered via invite');
      await ctx.reply(
        '🎉 注册成功！欢迎使用 LinkMind！\n\n发送任意链接，我会自动抓取、分析并保存。\n\n命令：\n/login — 获取网页登录链接',
      );
      return;
    }

    // Plain /start
    if (user.status !== 'active') {
      await ctx.reply('🔒 LinkMind 目前为邀请制，请通过邀请链接注册。');
      return;
    }

    await ctx.reply('🧠 欢迎回来！\n\n发送任意链接，我会自动抓取、分析并保存。\n\n命令：\n/login — 获取网页登录链接');
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

    if (user.status !== 'active') {
      await ctx.reply('🔒 请先通过邀请链接注册后再使用。');
      return;
    }

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

  // /reprocess command — re-run full pipeline on a link
  bot.command('reprocess', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await getUserByTelegramId(from.id);
    if (!user || user.status !== 'active') {
      await ctx.reply('🔒 请先通过邀请链接注册后再使用。');
      return;
    }

    const linkIdStr = ctx.match?.trim();
    if (!linkIdStr || !/^\d+$/.test(linkIdStr)) {
      await ctx.reply('❌ 用法: /reprocess <link_id>\n例如: /reprocess 58');
      return;
    }

    const linkId = Number(linkIdStr);
    const link = await getLink(linkId);

    if (!link) {
      await ctx.reply(`❌ 链接 #${linkId} 不存在`);
      return;
    }

    if (link.user_id !== user.id) {
      await ctx.reply(`❌ 链接 #${linkId} 不属于你`);
      return;
    }

    // Spawn reprocess task
    const { taskId } = await spawnProcessLink(user.id!, link.url, linkId);
    log.info({ linkId, taskId }, 'Reprocess triggered');

    await ctx.reply(`🔄 开始重新处理链接 #${linkId}\n\n处理完成后会通知你。`);

    // Start polling for completion in background
    pollAndNotify(ctx, linkId, link.url, webBaseUrl).catch((err) => {
      log.error({ linkId, err: err instanceof Error ? err.message : String(err) }, 'pollAndNotify error');
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

    const user = await findOrCreateUser(
      from.id,
      from.username,
      [from.first_name, from.last_name].filter(Boolean).join(' '),
    );

    if (user.status !== 'active') {
      await ctx.reply('🔒 请先通过邀请链接注册后再使用 LinkMind。');
      return;
    }

    for (const url of urls) {
      handleUrl(ctx, url, webBaseUrl, user.id!).catch((err) => {
        log.error({ url, err: err instanceof Error ? err.message : String(err) }, 'handleUrl uncaught error');
      });
    }
  });

  // Set bot commands menu
  bot.api
    .setMyCommands([
      { command: 'login', description: '获取网页登录链接' },
      { command: 'reprocess', description: '重新处理链接 (用法: /reprocess <id>)' },
      { command: 'start', description: '开始使用 / 查看帮助' },
    ])
    .catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to set bot commands');
    });

  bot.catch((err) => {
    log.error({ err: err.message }, 'Bot error');
    Sentry.captureException(err.error, {
      tags: { source: 'telegram-bot' },
      extra: { ctx: err.ctx?.update },
    });
  });

  bot.start();
  log.info('Telegram bot started');

  return bot;
}

async function pollAndNotify(ctx: any, linkId: number, url: string, webBaseUrl: string): Promise<void> {
  const maxWait = 300_000;
  const interval = 3_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, interval));

    const link = await getLink(linkId);
    if (!link) continue;

    if (link.status === 'analyzed') {
      const tags: string[] = safeParseJson(link.tags);
      const relatedNotes: any[] = safeParseJson(link.related_notes);
      const relatedLinks = await fetchRelatedLinksInfo(linkId, webBaseUrl);
      const images: any[] = safeParseJson(link.images);
      const permanentLink = `${webBaseUrl}/link/${linkId}`;

      const resultText = formatResult({
        title: link.og_title || url,
        url,
        summary: link.summary || '',
        insight: link.insight || '',
        tags,
        relatedNotes,
        relatedLinks,
        permanentLink,
      });

      // Check if we have a local image to send
      const firstImage = images[0];
      const imagePath = firstImage?.local_path
        ? path.resolve(import.meta.dirname, '../data/images', String(linkId), firstImage.local_path)
        : null;

      if (imagePath && existsSync(imagePath)) {
        await ctx.api.sendPhoto(ctx.chat.id, new InputFile(imagePath), {
          caption: resultText,
          parse_mode: 'HTML',
        });
      } else {
        await ctx.reply(resultText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      }
      return;
    }

    if (link.status === 'error') {
      await ctx.reply(`❌ 重新处理失败: ${(link.error_message || '').slice(0, 200)}`);
      return;
    }
  }

  await ctx.reply('⏰ 处理超时，请稍后在网页端查看结果。');
}

async function handleUrl(ctx: any, url: string, webBaseUrl: string, userId: number): Promise<void> {
  const existing = await getLinkByUrl(userId, url);
  const isDuplicate = !!existing;

  // Spawn the durable task — it will be picked up by the worker
  const { taskId } = await spawnProcessLink(userId, url, existing?.id);

  const statusMsg = await ctx.reply(
    isDuplicate ? `🔄 该链接已存在，已加入处理队列...` : `🔗 收到链接，已加入处理队列...`,
    { link_preview_options: { is_disabled: true } },
  );

  // Poll for completion (check every 3s, up to 5 minutes)
  const maxWait = 300_000;
  const interval = 3_000;
  const start = Date.now();
  let notifiedScraping = false;
  let notifiedAnalyzing = false;

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, interval));

    // Check link status in DB
    const linkId = existing?.id || (await getLinkByUrl(userId, url))?.id;
    if (!linkId) continue;

    const link = await getLink(linkId);
    if (!link) continue;

    if (link.status === 'scraped' && !notifiedScraping) {
      notifiedScraping = true;
      await editMessage(ctx, statusMsg, '🤖 正在分析内容...');
    }

    if (link.status === 'analyzed') {
      const tags: string[] = safeParseJson(link.tags);
      const relatedNotes: any[] = safeParseJson(link.related_notes);
      const relatedLinks = await fetchRelatedLinksInfo(linkId, webBaseUrl);
      const images: any[] = safeParseJson(link.images);
      const permanentLink = `${webBaseUrl}/link/${linkId}`;

      const resultText = formatResult({
        title: link.og_title || url,
        url,
        summary: link.summary || '',
        insight: link.insight || '',
        tags,
        relatedNotes,
        relatedLinks,
        permanentLink,
      });

      // Check if we have a local image to send (Twitter links with images)
      const firstImage = images[0];
      const imagePath = firstImage?.local_path
        ? path.resolve(import.meta.dirname, '../data/images', String(linkId), firstImage.local_path)
        : null;

      if (imagePath && existsSync(imagePath)) {
        // Delete the status message and send a new photo message
        try {
          await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
        } catch {
          // Ignore delete errors
        }
        await ctx.api.sendPhoto(ctx.chat.id, new InputFile(imagePath), {
          caption: resultText,
          parse_mode: 'HTML',
        });
      } else {
        await editMessage(ctx, statusMsg, resultText, true);
      }
      return;
    }

    if (link.status === 'error') {
      await editMessage(ctx, statusMsg, `❌ 处理失败: ${(link.error_message || '').slice(0, 200)}`);
      return;
    }
  }

  await editMessage(ctx, statusMsg, '⏰ 处理超时，请稍后在网页端查看结果。');
}

function formatResult(data: {
  title: string;
  url: string;
  summary: string;
  insight: string;
  tags: string[];
  relatedNotes: any[];
  relatedLinks: RelatedLinkInfo[];
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
      msg += `• <a href="${escHtml(l.internalUrl)}">${escHtml(truncate(l.title, 45))}</a> (<a href="${escHtml(l.sourceUrl)}">Source</a>)\n`;
    }
  }

  msg += `\n🔍 完整分析: ${escHtml(data.permanentLink)}`;

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
