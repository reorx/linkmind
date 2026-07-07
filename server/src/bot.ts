/**
 * Telegram Bot: receives links, triggers scraping + analysis pipeline.
 * Handles user registration via invite codes and /login for web auth.
 */

import { Bot, InputFile } from 'grammy';
import { renderMarkdownTelegram, renderTagsTelegram, formatResultTelegram, escHtml } from './telegram-render.js';
import { setNotifier, fetchRelatedRecordsInfo } from './notify.js';
import { getProbeWaitTtlHours } from './probe-timeout-cron.js';
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
} from './db/index.js';
import { spawnProcessLink, spawnProcessNote } from './pipeline.js';
import { checkAndGetBudget } from './usage.js';
import { downloadAndStorePhoto } from './telegram-photo.js';
import { Sentry } from './sentry.js';
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

  // Register the notify channel so pipeline / cron code can message users
  setNotifier(async (chatId, text, opts) => {
    const sendOpts: Record<string, any> = { link_preview_options: { is_disabled: true } };
    if (opts?.html) sendOpts.parse_mode = 'HTML';
    if (opts?.recordUrl) sendOpts.reply_markup = makeRecordButtons(opts.recordUrl);
    await bot.api.sendMessage(chatId, text, sendOpts);
  });

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

  // /home command — link to web homepage
  bot.command('home', async (ctx) => {
    await ctx.reply(`🏠 <a href="${escHtml(webBaseUrl)}">打开 LinkMind 首页</a>`, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
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

    // Budget check
    const budget = await checkAndGetBudget(user.id!);
    if (!budget.allowed) {
      await replyBudgetExceeded(ctx, budget);
      return;
    }

    // Spawn reprocess task
    const { taskId } = await spawnProcessLink(user.id!, record.url!, recordId);
    log.info({ recordId, taskId }, 'Reprocess triggered');

    const recordUrl = `${webBaseUrl}/link/${recordId}`;
    const recordButtons = makeRecordButtons(recordUrl);
    const statusMsg = await ctx.reply(`🔄 开始重新处理链接 #${recordId}`, {
      link_preview_options: { is_disabled: true },
      reply_markup: recordButtons,
    });

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

    // 2. Forwarded channel message detection: treat as link with pre-filled content
    const forwardOrigin = (ctx.message as any).forward_origin;
    if (forwardOrigin?.type === 'channel') {
      const chat = forwardOrigin.chat;
      const msgId = forwardOrigin.message_id;
      if (chat?.username) {
        // Public channel — treat as link with ingested content
        handleForwardedChannelMessage(ctx, user.id!, text, chat, msgId, webBaseUrl).catch((err) => {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'handleForwardedChannelMessage error');
        });
        return;
      }
      // Private channel (no username) — fall through to note handling
    }

    // 3. Message classification
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

  // Handle photo messages (with caption as text)
  bot.on('message:photo', async (ctx) => {
    const text = ctx.message.caption || '';
    const photos = ctx.message.photo;
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

    if (!text.trim()) {
      await ctx.reply('📷 收到图片，但没有附带文字。请在图片说明中附上链接或文字内容。');
      return;
    }

    // Helper: store photo after record is created
    const storePhoto = (recordId: number) => {
      downloadAndStorePhoto(ctx.api, token, photos, recordId).catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err), recordId }, 'Photo storage failed');
      });
    };

    // Reply detection
    if (ctx.message.reply_to_message) {
      handleReply(ctx, user.id!, text, webBaseUrl).catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'handleReply error (photo)');
      });
      // handleReply doesn't create a new record, so no photo storage
      return;
    }

    // Forwarded channel message detection
    const forwardOrigin = (ctx.message as any).forward_origin;
    if (forwardOrigin?.type === 'channel') {
      const chat = forwardOrigin.chat;
      const msgId = forwardOrigin.message_id;
      if (chat?.username) {
        handleForwardedChannelMessage(ctx, user.id!, text, chat, msgId, webBaseUrl)
          .then((recordId) => {
            if (recordId) storePhoto(recordId);
          })
          .catch((err) => {
            log.error(
              { err: err instanceof Error ? err.message : String(err) },
              'handleForwardedChannelMessage error (photo)',
            );
          });
        return;
      }
    }

    // Message classification (same as text handler)
    const urls = text.match(URL_REGEX) || [];
    const trimmedText = text.trimStart();
    const firstUrl = urls[0] as string | undefined;
    const startsWithUrl = firstUrl !== undefined && trimmedText.startsWith(firstUrl);

    if (startsWithUrl) {
      const mainUrl = firstUrl;
      const afterUrl = text.slice(text.indexOf(mainUrl) + mainUrl.length).trim();
      const userNote = afterUrl || undefined;
      const otherUrls = urls.slice(1);

      handleLinkMessage(ctx, user.id!, mainUrl, userNote, otherUrls, webBaseUrl)
        .then((recordId) => storePhoto(recordId))
        .catch((err) => {
          log.error(
            { url: mainUrl, err: err instanceof Error ? err.message : String(err) },
            'handleLinkMessage error (photo)',
          );
        });
    } else if (text.trim().length > 0) {
      handleNoteMessage(ctx, user.id!, text, urls, webBaseUrl)
        .then((recordId) => storePhoto(recordId))
        .catch((err) => {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'handleNoteMessage error (photo)');
        });
    }
  });

  // Catch-all: unsupported message types
  bot.on('message', async (ctx) => {
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

    // Determine message type for feedback
    const msgTypes = [];
    if (ctx.message.video) msgTypes.push('视频');
    if (ctx.message.document) msgTypes.push('文件');
    if (ctx.message.audio) msgTypes.push('音频');
    if (ctx.message.voice) msgTypes.push('语音');
    if (ctx.message.sticker) msgTypes.push('贴纸');
    if (ctx.message.animation) msgTypes.push('GIF');
    if (ctx.message.contact) msgTypes.push('联系人');
    if (ctx.message.location) msgTypes.push('位置');
    if (ctx.message.poll) msgTypes.push('投票');
    const typeDesc = msgTypes.length > 0 ? msgTypes.join('/') : '该类型';

    await ctx.reply(`⚠️ 暂不支持${typeDesc}消息。目前支持：文字消息、链接、带文字说明的图片。`);
  });

  // Set bot commands menu
  bot.api
    .setMyCommands([
      { command: 'home', description: '打开 LinkMind 首页' },
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
 * Handle a forwarded public channel message — treat as link with pre-filled content.
 */
async function handleForwardedChannelMessage(
  ctx: any,
  userId: number,
  text: string,
  chat: { username: string; title?: string },
  messageId: number,
  webBaseUrl: string,
): Promise<number | null> {
  const sourceUrl = `https://t.me/${chat.username}/${messageId}`;

  // Deduplicate by URL
  const existing = await getRecordByUrl(userId, sourceUrl);
  if (existing?.id) {
    const recordUrl = `${webBaseUrl}/link/${existing.id}`;
    await ctx.reply(`🔄 该频道消息已存在`, {
      link_preview_options: { is_disabled: true },
      reply_markup: makeRecordButtons(recordUrl),
    });
    return existing.id;
  }

  const recordId = await insertRecord(userId, {
    type: 'link',
    url: sourceUrl,
    content: text,
    markdown: text,
    og_site_name: chat.title,
    ingested_with_content: true,
    telegram_chat_id: ctx.message.chat.id,
  });

  log.info({ recordId, userId, sourceUrl, channel: chat.title }, 'Forwarded channel message saved as link');

  // Budget check
  const budget = await checkAndGetBudget(userId);
  if (!budget.allowed) {
    await replyBudgetExceeded(ctx, budget);
    return recordId;
  }

  await spawnProcessLink(userId, sourceUrl, recordId);

  const recordUrl = `${webBaseUrl}/link/${recordId}`;
  const recordButtons = makeRecordButtons(recordUrl);
  const statusMsg = await ctx.reply(`📨 收到频道转发，已加入处理队列...`, {
    link_preview_options: { is_disabled: true },
    reply_markup: recordButtons,
  });

  // Extract URLs from forwarded text and create derived links
  const urls = text.match(URL_REGEX) || [];
  for (const url of urls) {
    const existingLink = await getRecordByUrl(userId, url);
    if (!existingLink) {
      const derivedId = await insertRecord(userId, { type: 'link', url, added_by_user: false });
      await addDerivation(recordId, derivedId);
      spawnProcessLink(userId, url, derivedId).catch((err) => {
        log.error(
          { url, err: err instanceof Error ? err.message : String(err) },
          'Failed to spawn derived link from forwarded message',
        );
      });
    }
  }

  // Poll for completion
  pollAndNotify(ctx, recordId, sourceUrl, statusMsg, webBaseUrl).catch((err) => {
    log.error({ recordId, err: err instanceof Error ? err.message : String(err) }, 'pollAndNotify error');
  });

  return recordId;
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
): Promise<number> {
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

  // Budget check
  const budget = await checkAndGetBudget(userId);
  if (!budget.allowed) {
    await replyBudgetExceeded(ctx, budget);
    return recordId;
  }

  // Spawn the durable task
  await spawnProcessLink(userId, mainUrl, recordId);

  const recordUrl = `${webBaseUrl}/link/${recordId}`;
  const recordButtons = makeRecordButtons(recordUrl);
  const statusMsg = await ctx.reply(
    isDuplicate ? `🔄 该链接已存在，已加入处理队列...` : `🔗 收到链接，已加入处理队列...`,
    { link_preview_options: { is_disabled: true }, reply_markup: recordButtons },
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

  return recordId;
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
): Promise<number> {
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

  // Budget check
  const budget = await checkAndGetBudget(userId);
  if (!budget.allowed) {
    await replyBudgetExceeded(ctx, budget);
    return noteId;
  }

  // Spawn note processing pipeline
  spawnProcessNote(userId, noteId).catch((err) => {
    log.error({ noteId, err: err instanceof Error ? err.message : String(err) }, 'Failed to spawn process-note');
  });

  const noteUrl = `${webBaseUrl}/link/${noteId}`;
  const noteButtons = makeRecordButtons(noteUrl);
  const statusMsg = await ctx.reply(sourceUrl ? `📝 收到转发笔记，正在处理...` : `📝 收到笔记，正在处理...`, {
    link_preview_options: { is_disabled: true },
    reply_markup: noteButtons,
  });

  // Poll for note completion
  pollNoteAndNotify(ctx, noteId, statusMsg, webBaseUrl).catch((err) => {
    log.error({ noteId, err: err instanceof Error ? err.message : String(err) }, 'pollNoteAndNotify error');
  });

  return noteId;
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
  const recordButtons = makeRecordButtons(`${webBaseUrl}/link/${recordId}`);

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, interval));

    const record = await getRecord(recordId);
    if (!record) continue;

    if (record.status === 'scraped' && !notifiedScraping) {
      notifiedScraping = true;
      await editMessage(ctx, statusMsg, '🤖 正在分析内容...', false, recordButtons);
    }

    if (record.status === 'waiting_probe') {
      // Ensure chat id is stored so probe completion / timeout notifications can reach the user
      await updateRecord(recordId, { telegram_chat_id: ctx.chat.id });
      await editMessage(
        ctx,
        statusMsg,
        `🛰 此链接需要通过你的本地 Probe 抓取（如 Twitter/X）。\n` +
          `已进入等待队列——如果你的 probe 在线会自动处理并回复结果；\n` +
          `尚未安装请看教程：${webBaseUrl}/probe\n` +
          `超过 ${getProbeWaitTtlHours()} 小时未处理将自动标记失败。`,
        false,
        recordButtons,
      );
      return;
    }

    if (record.status === 'analyzed') {
      const tags: string[] = safeParseJson(record.tags);
      const relatedNotes: any[] = safeParseJson(record.related_notes);
      const relatedRecords = await fetchRelatedRecordsInfo(recordId, webBaseUrl);
      const images: any[] = safeParseJson(record.images);
      const permanentLink = `${webBaseUrl}/link/${recordId}`;

      const resultText = formatResultTelegram({
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
      await editMessage(
        ctx,
        statusMsg,
        `❌ 处理失败: ${(record.error_message || '').slice(0, 200)}`,
        false,
        recordButtons,
      );
      return;
    }
  }

  await editMessage(ctx, statusMsg, '⏰ 处理超时，请稍后在网页端查看结果。', false, recordButtons);
}

/**
 * Poll for note record completion and send result notification.
 */
async function pollNoteAndNotify(ctx: any, noteId: number, statusMsg: any, webBaseUrl: string): Promise<void> {
  const maxWait = 300_000;
  const interval = 3_000;
  const start = Date.now();
  const noteButtons = makeRecordButtons(`${webBaseUrl}/link/${noteId}`);

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, interval));

    const record = await getRecord(noteId);
    if (!record) continue;

    if (record.status === 'analyzed') {
      const tags: string[] = safeParseJson(record.tags);
      let msg = `📝 <b>笔记已处理完成</b>\n\n`;
      msg += renderTagsTelegram(tags);
      if (record.summary && record.summary !== record.content) {
        msg += `<b>摘要</b>\n${renderMarkdownTelegram(record.summary)}\n\n`;
      }
      if (record.insight) {
        msg += `<b>💡 Insight</b>\n${renderMarkdownTelegram(record.insight)}\n`;
      }
      const noteDetailUrl = `${webBaseUrl}/link/${noteId}`;
      msg += `\n🔍 <a href="${escHtml(noteDetailUrl)}">查看详情</a>`;

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
      await editMessage(
        ctx,
        statusMsg,
        `❌ 笔记处理失败: ${(record.error_message || '').slice(0, 200)}`,
        false,
        noteButtons,
      );
      return;
    }
  }

  await editMessage(ctx, statusMsg, '⏰ 处理超时，请稍后查看结果。', false, noteButtons);
}

function makeRecordButtons(webUrl: string) {
  return {
    inline_keyboard: [[{ text: '🔍 查看详情', url: webUrl }]],
  };
}

async function editMessage(
  ctx: any,
  statusMsg: any,
  text: string,
  parseHtml: boolean = false,
  reply_markup?: { inline_keyboard: { text: string; url: string }[][] },
): Promise<any> {
  try {
    const opts: Record<string, any> = {
      link_preview_options: { is_disabled: true },
    };
    if (parseHtml) {
      opts.parse_mode = 'HTML';
    }
    if (reply_markup) {
      opts.reply_markup = reply_markup;
    }
    return await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, text, opts);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'editMessage failed');
    return null;
  }
}

function formatDateMMDD(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${m}-${d}`;
}

async function replyBudgetExceeded(
  ctx: any,
  budget: { usedUsd: number; limitUsd: number; cycleStart: Date; cycleEnd: Date },
): Promise<void> {
  const startStr = formatDateMMDD(budget.cycleStart);
  const endStr = formatDateMMDD(budget.cycleEnd);
  await ctx.reply(
    `⚠️ 本周期用量已达上限\n已使用: $${budget.usedUsd.toFixed(2)} / 限额: $${budget.limitUsd.toFixed(2)}\n当前周期: ${startStr} ~ ${endStr}\n请联系管理员提升额度。`,
  );
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
