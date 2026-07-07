/**
 * Telegram-friendly rendering utilities for markdown content.
 */

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Convert markdown inline formatting to Telegram HTML.
 * Handles: bold, italic, strikethrough, inline code, links.
 *
 * Strategy: escape HTML first, then convert markdown syntax to HTML tags.
 * This avoids the complexity of escaping around already-inserted tags.
 */
export function mdInlineToTelegramHtml(text: string): string {
  // Step 1: Extract and protect inline code spans (they should not be further processed)
  const codeSpans: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\x00CODE${codeSpans.length - 1}\x00`;
  });

  // Step 2: Extract and protect links
  const links: { text: string; url: string }[] = [];
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    links.push({ text: linkText, url });
    return `\x00LINK${links.length - 1}\x00`;
  });

  // Step 3: Escape HTML on the remaining text
  text = escHtml(text);

  // Step 4: Convert markdown formatting to HTML tags
  // Bold: **text** → <b>text</b>
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic: *text* → <i>text</i> (but not **)
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');

  // Italic: _text_ → <i>text</i>
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~ → <s>text</s>
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Step 5: Restore code spans and links with proper HTML
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, idx) => {
    return `<code>${escHtml(codeSpans[Number(idx)])}</code>`;
  });

  text = text.replace(/\x00LINK(\d+)\x00/g, (_, idx) => {
    const link = links[Number(idx)];
    return `<a href="${escHtml(link.url)}">${escHtml(link.text)}</a>`;
  });

  return text;
}

/**
 * Render markdown text for Telegram display.
 * Converts multi-level lists to Telegram-friendly format with inline formatting support.
 *
 * List symbols alternate by level:
 *   Level 0: •
 *   Level 1: ‣ (with em-space indent)
 *   Level 2: • (with double em-space indent)
 *   Level 3: ‣ (with triple em-space indent)
 *   ... and so on
 */
export function renderMarkdownTelegram(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // Match list items: capture leading whitespace + marker (-, *, •)
    const listMatch = line.match(/^(\s*)([-•])\s+(.*)/);
    if (listMatch) {
      const indent = listMatch[1];
      const content = listMatch[3];
      // Determine nesting level: every 2 spaces (or 4) = one level
      const level = Math.floor(indent.length / 2);
      const symbol = level % 2 === 0 ? '•' : '‣';
      const emIndent = '\u2003'.repeat(level);

      result.push(`${emIndent}${symbol} ${mdInlineToTelegramHtml(content)}`);
    } else {
      // Check for * as list marker (but not **bold**)
      const starListMatch = line.match(/^(\s*)\*\s+(.*)/);
      if (starListMatch && !starListMatch[2].startsWith('*')) {
        const indent = starListMatch[1];
        const content = starListMatch[2];
        const level = Math.floor(indent.length / 2);
        const symbol = level % 2 === 0 ? '•' : '‣';
        const emIndent = '\u2003'.repeat(level);

        result.push(`${emIndent}${symbol} ${mdInlineToTelegramHtml(content)}`);
      } else {
        result.push(mdInlineToTelegramHtml(line));
      }
    }
  }

  return result.join('\n');
}

/**
 * Render tags for Telegram display as inline code to avoid hashtag parsing issues.
 */
export function renderTagsTelegram(tags: string[]): string {
  if (tags.length === 0) return '';
  return tags.map((t) => `<code>${escHtml(t)}</code>`).join(' ') + '\n\n';
}

export interface RelatedRecordInfo {
  recordId: number;
  title: string;
  sourceUrl: string; // Original URL
  internalUrl: string; // Our link detail page URL
}

/**
 * Format the final processing result message for a link record (Telegram HTML).
 * Shared by bot polling and pipeline completion notification.
 */
export function formatResultTelegram(data: {
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

  msg += renderTagsTelegram(data.tags);

  msg += `<b>📝 摘要</b>\n${renderMarkdownTelegram(data.summary)}\n\n`;
  msg += `<b>💡 Insight</b>\n${renderMarkdownTelegram(data.insight)}\n`;

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

  msg += `\n🔍 <a href="${escHtml(data.permanentLink)}">查看详情</a>`;

  return msg;
}
