/**
 * Telegram Bot: receives links, triggers scraping + analysis pipeline.
 * Handles user registration via invite codes and /login for web auth.
 */

import { Bot, InputFile } from 'grammy';
import jwt from 'jsonwebtoken';
import path from 'path';
import { existsSync } from 'fs';
import {
  getRecord,
  getRecordByUrl,
  getRecordByTelegramMessage,
  insertRecord,
  insertNote,
  updateRecord,
  appendUserNote,
  addDerivation,
  findOrCreateUser,
  getInviteByCode,
  useInvite,
  getUserByTelegramId,
  getRelatedRecords,
} from './db/index.js';
import { spawnProcessLink, spawnProcessNote } from './pipeline.js';
import { Sentry } from './sentry.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'bot' });

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

interface RelatedRecordInfo {
  recordId: number;
  title: string;
  sourceUrl: string; // Original URL
  internalUrl: string; // Our link detail page URL
}

/**
 * Fetch related records from record_relations table with their details.
 */
async function fetchRelatedRecordsInfo(recordId: number, webBaseUrl: string): Promise<RelatedRecordInfo[]> {
  const relatedData = await getRelatedRecords(recordId);
  const results: RelatedRecordInfo[] = [];

  for (const item of relatedData) {
    const related = await getRecord(item.relatedRecordId);
    if (related) {
      results.push({
        recordId: item.relatedRecordId,
        title: related.og_title || related.url || related.summary || 'Untitled',
        sourceUrl: related.url || '',
        internalUrl: `${webBaseUrl}/link/${item.relatedRecordId}`,
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

    const recordId = Number(linkIdStr);
    const record = await getRecord(recordId);

    if (!record) {
      await ctx.reply(`❌ 链接 #${recordId} 不存在`);
      return;
    }

    if (record.user_id !== user.id) {
      await ctx.reply(`❌ 链接 #${recordId} 不属于你`);
      return;
    }

    // Spawn reprocess task
    const { taskId } = await spawnProcessLink(user.id!, record.url!, recordId);
    log.info({ recordId, taskId }, 'Reprocess triggered');

    const statusMsg = await ctx.reply(`🔄 开始重新处理链接 #${recordId}\n\n处理完成后会通知你。`);

    // Start polling for completion in background
    pollAndNotify(ctx, recordId, record.url!, statusMsg, webBaseUrl).catch((err) => {
      log.error({ recordId, err: err instanceof Error ? err.message : String(err) }, 'pollAndNotify error');
    });
  });

  // Handle all text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
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

    // 1. Reply detection: append user_note to the original record
    if (ctx.message.reply_to_message) {
      handleReply(ctx, user.id!, text, webBaseUrl).catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'handleReply error');
      });
      return;
    }

    // 2. Message classification
    const urls = text.match(URL_REGEX) || [];
    const trimmedText = text.trimStart();
    const firstUrl = urls[0] as string | undefined;
    const startsWithUrl = firstUrl !== undefined && trimmedText.startsWith(firstUrl);

    if (startsWithUrl) {
      // Link mode: first URL is the main link
      const mainUrl = firstUrl;
      const afterUrl = text.slice(text.indexOf(mainUrl) + mainUrl.length).trim();
      const userNote = afterUrl || undefined;
      const otherUrls = urls.slice(1);

      handleLinkMessage(ctx, user.id!, mainUrl, userNote, otherUrls, webBaseUrl).catch((err) => {
        log.error({ url: mainUrl, err: err instanceof Error ? err.message : String(err) }, 'handleLinkMessage error');
      });
    } else if (text.trim().length > 0) {
      // Note mode: everything that doesn't start with a URL
      handleNoteMessage(ctx, user.id!, text, urls, webBaseUrl).catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'handleNoteMessage error');
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

/**
 * Handle reply to a previous message — append user_note to the original record.
 */
async function handleReply(ctx: any, userId: number, text: string, webBaseUrl: string): Promise<void> {
  const replyMsg = ctx.message.reply_to_message;
  if (!replyMsg) return;

  const chatId = ctx.message.chat.id;
  const messageId = replyMsg.message_id;

  const record = await getRecordByTelegramMessage(chatId, messageId);
  if (!record || !record.id) {
    // Not a tracked message, ignore silently
    return;
  }

  await appendUserNote(record.id, text);
  log.info({ recordId: record.id, userId }, 'User note appended via reply');
  await ctx.reply('📝 备注已添加', { reply_to_message_id: ctx.message.message_id });
}

/**
 * Handle a message that starts with a URL — treat as link submission.
 */
async function handleLinkMessage(
  ctx: any,
  userId: number,
  mainUrl: string,
  userNote: string | undefined,
  otherUrls: string[],
  webBaseUrl: string,
): Promise<void> {
  const existing = await getRecordByUrl(userId, mainUrl);
  const isDuplicate = !!existing;
  let recordId: number;

  if (existing?.id) {
    recordId = existing.id;
    // Update user_note if provided
    if (userNote) {
      await appendUserNote(recordId, userNote);
    }
  } else {
    recordId = await insertRecord(userId, {
      type: 'link',
      url: mainUrl,
      user_note: userNote,
      telegram_chat_id: ctx.message.chat.id,
    });
  }

  // Spawn the durable task
  await spawnProcessLink(userId, mainUrl, recordId);

  const statusMsg = await ctx.reply(
    isDuplicate ? `🔄 该链接已存在，已加入处理队列...` : `🔗 收到链接，已加入处理队列...`,
    { link_preview_options: { is_disabled: true } },
  );

  // Create derived link records for other URLs
  for (const url of otherUrls) {
    const existingDerived = await getRecordByUrl(userId, url);
    if (!existingDerived) {
      const derivedId = await insertRecord(userId, { type: 'link', url, added_by_user: false });
      await addDerivation(recordId, derivedId);
      spawnProcessLink(userId, url, derivedId).catch((err) => {
        log.error({ url, err: err instanceof Error ? err.message : String(err) }, 'Failed to spawn derived link');
      });
    }
  }

  // Poll for completion
  pollAndNotify(ctx, recordId, mainUrl, statusMsg, webBaseUrl).catch((err) => {
    log.error({ recordId, err: err instanceof Error ? err.message : String(err) }, 'pollAndNotify error');
  });
}

/**
 * Handle a message that doesn't start with a URL — treat as note.
 */
async function handleNoteMessage(
  ctx: any,
  userId: number,
  text: string,
  urls: string[],
  webBaseUrl: string,
): Promise<void> {
  // Detect forwarded message for source_url
  let sourceUrl: string | undefined;
  const forwardOrigin = (ctx.message as any).forward_origin;
  if (forwardOrigin?.type === 'channel') {
    const chat = forwardOrigin.chat;
    if (chat?.username) {
      sourceUrl = `https://t.me/${chat.username}/${forwardOrigin.message_id}`;
    }
  }

  const noteId = await insertNote(userId, text, {
    sourceUrl,
    telegramChatId: ctx.message.chat.id,
  });

  log.info({ noteId, userId, urlCount: urls.length, hasSourceUrl: !!sourceUrl }, 'Note created');

  // Create derived link records for URLs found in the note
  for (const url of urls) {
    const existingLink = await getRecordByUrl(userId, url);
    if (!existingLink) {
      const derivedId = await insertRecord(userId, { type: 'link', url, added_by_user: false });
      await addDerivation(noteId, derivedId);
      spawnProcessLink(userId, url, derivedId).catch((err) => {
        log.error(
          { url, err: err instanceof Error ? err.message : String(err) },
          'Failed to spawn derived link from note',
        );
      });
    }
  }

  // Spawn note processing pipeline
  spawnProcessNote(userId, noteId).catch((err) => {
    log.error({ noteId, err: err instanceof Error ? err.message : String(err) }, 'Failed to spawn process-note');
  });

  const statusMsg = await ctx.reply(sourceUrl ? `📝 收到转发笔记，正在处理...` : `📝 收到笔记，正在处理...`, {
    link_preview_options: { is_disabled: true },
  });

  // Poll for note completion
  pollNoteAndNotify(ctx, noteId, statusMsg, webBaseUrl).catch((err) => {
    log.error({ noteId, err: err instanceof Error ? err.message : String(err) }, 'pollNoteAndNotify error');
  });
}

/**
 * Poll for link record completion and send result notification.
 */
async function pollAndNotify(
  ctx: any,
  recordId: number,
  url: string,
  statusMsg: any,
  webBaseUrl: string,
): Promise<void> {
  const maxWait = 300_000;
  const interval = 3_000;
  const start = Date.now();
  let notifiedScraping = false;

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, interval));

    const record = await getRecord(recordId);
    if (!record) continue;

    if (record.status === 'scraped' && !notifiedScraping) {
      notifiedScraping = true;
      await editMessage(ctx, statusMsg, '🤖 正在分析内容...');
    }

    if (record.status === 'analyzed') {
      const tags: string[] = safeParseJson(record.tags);
      const relatedNotes: any[] = safeParseJson(record.related_notes);
      const relatedRecords = await fetchRelatedRecordsInfo(recordId, webBaseUrl);
      const images: any[] = safeParseJson(record.images);
      const permanentLink = `${webBaseUrl}/link/${recordId}`;

      const resultText = formatResult({
        title: record.og_title || url,
        url,
        summary: record.summary || '',
        insight: record.insight || '',
        tags,
        relatedNotes,
        relatedRecords,
        permanentLink,
      });

      // Check if we have a local image to send
      const firstImage = images[0];
      const imagePath = firstImage?.local_path
        ? path.resolve(import.meta.dirname, '../data/images', String(recordId), firstImage.local_path)
        : null;

      let botMsgId: number;
      if (imagePath && existsSync(imagePath)) {
        try {
          await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
        } catch {
          // Ignore delete errors
        }
        const sent = await ctx.api.sendPhoto(ctx.chat.id, new InputFile(imagePath), {
          caption: resultText,
          parse_mode: 'HTML',
        });
        botMsgId = sent.message_id;
      } else {
        const sent = await editMessage(ctx, statusMsg, resultText, true);
        botMsgId = sent?.message_id || statusMsg.message_id;
      }

      // Store bot reply message_id for future reply detection
      await updateRecord(recordId, {
        telegram_message_id: botMsgId,
        telegram_chat_id: ctx.chat.id,
      });
      return;
    }

    if (record.status === 'error') {
      await editMessage(ctx, statusMsg, `❌ 处理失败: ${(record.error_message || '').slice(0, 200)}`);
      return;
    }
  }

  await editMessage(ctx, statusMsg, '⏰ 处理超时，请稍后在网页端查看结果。');
}

/**
 * Poll for note record completion and send result notification.
 */
async function pollNoteAndNotify(ctx: any, noteId: number, statusMsg: any, webBaseUrl: string): Promise<void> {
  const maxWait = 300_000;
  const interval = 3_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, interval));

    const record = await getRecord(noteId);
    if (!record) continue;

    if (record.status === 'analyzed') {
      const tags: string[] = safeParseJson(record.tags);
      let msg = `📝 <b>笔记已处理完成</b>\n\n`;
      if (tags.length > 0) {
        msg += tags.map((t) => `#${t.replace(/\s+/g, '_')}`).join(' ') + '\n\n';
      }
      if (record.summary && record.summary !== record.content) {
        msg += `<b>摘要</b>\n${escHtml(record.summary)}\n\n`;
      }
      if (record.insight) {
        msg += `<b>💡 Insight</b>\n${escHtml(record.insight)}\n`;
      }

      const sent = await editMessage(ctx, statusMsg, msg, true);
      const botMsgId = sent?.message_id || statusMsg.message_id;

      // Store bot reply message_id for future reply detection
      await updateRecord(noteId, {
        telegram_message_id: botMsgId,
        telegram_chat_id: ctx.chat.id,
      });
      return;
    }

    if (record.status === 'error') {
      await editMessage(ctx, statusMsg, `❌ 笔记处理失败: ${(record.error_message || '').slice(0, 200)}`);
      return;
    }
  }

  await editMessage(ctx, statusMsg, '⏰ 处理超时，请稍后查看结果。');
}

function formatResult(data: {
  title: string;
  url: string;
  summary: string;
  insight: string;
  tags: string[];
  relatedNotes: any[];
  relatedRecords: RelatedRecordInfo[];
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

  if (data.relatedRecords.length > 0) {
    msg += `\n<b>🔗 相关链接</b>\n`;
    for (const l of data.relatedRecords.slice(0, 3)) {
      msg += `• <a href="${escHtml(l.internalUrl)}">${escHtml(truncate(l.title, 45))}</a> (<a href="${escHtml(l.sourceUrl)}">Source</a>)\n`;
    }
  }

  msg += `\n🔍 完整分析: ${escHtml(data.permanentLink)}`;

  return msg;
}

async function editMessage(ctx: any, statusMsg: any, text: string, parseHtml: boolean = false): Promise<any> {
  try {
    const opts: Record<string, any> = {
      link_preview_options: { is_disabled: true },
    };
    if (parseHtml) {
      opts.parse_mode = 'HTML';
    }
    return await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, text, opts);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'editMessage failed');
    return null;
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
