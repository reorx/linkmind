/**
 * Export: generate Markdown documents from link records.
 * File export is currently disabled; renderMarkdown is kept for future use.
 */

import type { LinkRecord } from './db.js';

/**
 * Render a link record as a Markdown document.
 * Only includes metadata + summary + full original content.
 * Excludes related content (notes/links/insight) to avoid polluting search results.
 */
export function renderMarkdown(link: LinkRecord): string {
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

function escapeFm(s: string): string {
  return s.replace(/"/g, '\\"');
}
