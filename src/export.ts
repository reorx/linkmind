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
 * Render a link record as a Markdown document for QMD indexing.
 * Only includes metadata + summary + full original content.
 * Excludes related content (notes/links/insight) to avoid polluting search results.
 */
function renderMarkdown(link: LinkRecord): string {
  const lines: string[] = [];

  // YAML front matter
  lines.push('---');
  lines.push(`id: ${link.id}`);
  lines.push(`url: "${link.url}"`);
  if (link.og_title) lines.push(`title: "${escapeFm(link.og_title)}"`);
  if (link.og_site_name) lines.push(`site: "${escapeFm(link.og_site_name)}"`);
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

  // Summary
  if (link.summary) {
    lines.push('## 摘要');
    lines.push('');
    lines.push(link.summary);
    lines.push('');
  }

  // Full original content
  if (link.markdown) {
    lines.push('## 原文');
    lines.push('');
    lines.push(link.markdown);
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
 * Delete the exported Markdown file for a link record.
 * Returns true if a file was deleted, false if not found.
 */
export function deleteLinkExport(link: LinkRecord): boolean {
  const filename = buildFilename(link);
  const filepath = path.join(EXPORT_DIR, filename);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    log.info({ path: filepath }, 'Deleted export');
    return true;
  }
  return false;
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
