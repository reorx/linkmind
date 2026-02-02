/**
 * Export: generate Markdown documents from link records for QAMD indexing.
 */

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { LinkRecord } from './db.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);
const log = logger.child({ module: 'export' });

const EXPORT_DIR = process.env.QMD_LINKS_PATH || path.join(process.env.HOME || '/tmp', 'LocalDocuments/linkmind/links');

/**
 * Generate a slug from a title string.
 */
function slugify(text: string, maxLen: number = 60): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

/**
 * Build the Markdown filename for a link record.
 */
function buildFilename(link: LinkRecord): string {
  const title = link.og_title || new URL(link.url).hostname;
  const slug = slugify(title) || 'untitled';
  return `${link.id}-${slug}.md`;
}

/**
 * Render a link record as a Markdown document.
 */
function renderMarkdown(link: LinkRecord): string {
  const tags: string[] = safeParse(link.tags, []);
  const relatedNotes: any[] = safeParse(link.related_notes, []);
  const relatedLinks: any[] = safeParse(link.related_links, []);

  const lines: string[] = [];

  // YAML front matter
  lines.push('---');
  lines.push(`id: ${link.id}`);
  lines.push(`url: "${link.url}"`);
  if (link.og_title) lines.push(`title: "${escapeFm(link.og_title)}"`);
  if (link.og_site_name) lines.push(`site: "${escapeFm(link.og_site_name)}"`);
  if (tags.length > 0) lines.push(`tags: [${tags.map((t) => `"${escapeFm(t)}"`).join(', ')}]`);
  if (link.created_at) lines.push(`created: "${link.created_at}"`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${link.og_title || link.url}`);
  lines.push('');
  lines.push(`> ${link.url}`);
  lines.push('');

  // Description
  if (link.og_description) {
    lines.push(`**描述:** ${link.og_description}`);
    lines.push('');
  }

  // Tags
  if (tags.length > 0) {
    lines.push(`**标签:** ${tags.join(', ')}`);
    lines.push('');
  }

  // Summary
  if (link.summary) {
    lines.push('## 摘要');
    lines.push('');
    lines.push(link.summary);
    lines.push('');
  }

  // Insight
  if (link.insight) {
    lines.push('## Insight');
    lines.push('');
    lines.push(link.insight);
    lines.push('');
  }

  // Related Notes
  if (relatedNotes.length > 0) {
    lines.push('## 相关笔记');
    lines.push('');
    for (const n of relatedNotes) {
      const title = n.title || n.path || 'Untitled';
      const snippet = n.snippet ? ` — ${n.snippet.slice(0, 120)}` : '';
      lines.push(`- ${title}${snippet}`);
    }
    lines.push('');
  }

  // Related Links
  if (relatedLinks.length > 0) {
    lines.push('## 相关链接');
    lines.push('');
    for (const l of relatedLinks) {
      const title = l.title || l.url || 'Untitled';
      const url = l.url ? ` (${l.url})` : '';
      lines.push(`- ${title}${url}`);
    }
    lines.push('');
  }

  // Article excerpt (first 3000 chars of markdown for richer search)
  if (link.markdown) {
    lines.push('## 原文摘录');
    lines.push('');
    lines.push(link.markdown.slice(0, 3000));
    if (link.markdown.length > 3000) lines.push('\n...(truncated)');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export a single link record to a Markdown file.
 * Returns the file path written.
 */
export function exportLinkMarkdown(link: LinkRecord): string {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const filename = buildFilename(link);
  const filepath = path.join(EXPORT_DIR, filename);
  const content = renderMarkdown(link);

  fs.writeFileSync(filepath, content, 'utf-8');
  log.info({ path: filepath }, 'Written');

  return filepath;
}

/**
 * Export all analyzed links. Useful for initial backfill.
 */
export function exportAllLinks(links: LinkRecord[]): string[] {
  const paths: string[] = [];
  for (const link of links) {
    if (link.status === 'analyzed' && link.id) {
      paths.push(exportLinkMarkdown(link));
    }
  }
  log.info({ count: paths.length, dir: EXPORT_DIR }, 'Exported all links');
  return paths;
}

function safeParse<T>(json: string | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function escapeFm(s: string): string {
  return s.replace(/"/g, '\\"');
}

/**
 * QMD Index Queue: serializes `qmd update` + `qmd embed` calls.
 * Multiple concurrent requests are coalesced — if an update is already running,
 * pending requests merge into a single follow-up run.
 */
class QmdIndexQueue {
  private running = false;
  private pendingCount = 0;

  /**
   * Request a QMD index update. If one is already running, the request is
   * queued and coalesced. Fire-and-forget safe — never rejects.
   */
  async requestUpdate(): Promise<void> {
    if (this.running) {
      this.pendingCount++;
      log.debug({ pendingCount: this.pendingCount }, '[qmd-queue] Queued (already running)');
      return;
    }
    this.running = true;
    try {
      await this.runUpdate();
      while (this.pendingCount > 0) {
        this.pendingCount = 0;
        log.info('[qmd-queue] Running again for coalesced requests');
        await this.runUpdate();
      }
    } finally {
      this.running = false;
    }
  }

  private async runUpdate(): Promise<void> {
    try {
      log.info('[qmd-queue] Running qmd update...');
      const { stdout: updateOut } = await execAsync('qmd update', {
        encoding: 'utf-8',
        timeout: 60_000,
      });
      log.info({ output: updateOut.trim() }, '[qmd-queue] qmd update done');

      log.info('[qmd-queue] Running qmd embed...');
      const { stdout: embedOut } = await execAsync('qmd embed', {
        encoding: 'utf-8',
        timeout: 120_000,
      });
      log.info({ output: embedOut.trim() }, '[qmd-queue] qmd embed done');
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, '[qmd-queue] Failed');
    }
  }
}

export const qmdIndexQueue = new QmdIndexQueue();
