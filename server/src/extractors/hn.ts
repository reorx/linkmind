// @ts-nocheck — Substance's Extractor callback signatures use untyped parameters.
/**
 * Hacker News discussion extractor for Substance.
 *
 * Handles news.ycombinator.com/item?id=xxx pages — parses the discussion tree
 * (title, metadata, comments) and renders as structured markdown.
 *
 * Comment parsing logic ported from @vibe-reader/core (hn-parser.ts).
 */

import type { Extractor } from '@substancejs/common';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { Element } from 'domhandler';

/* ── Comment types ── */

interface HNComment {
  id: string;
  author: string;
  text: string;
  indent: number;
  children: HNComment[];
}

/* ── Comment text extraction (ported from vibe-reader-hn) ── */

function extractTextFromElement($: CheerioAPI, element: Cheerio<Element>): string {
  function extractFromElement(el: Element | null, inPreBlock = false): string {
    if (!el) return '';

    const texts: string[] = [];
    const isPreBlock = el.tagName?.toLowerCase() === 'pre';

    for (const child of el.children) {
      if (child.type === 'text') {
        let textData = (child as unknown as { data: string }).data || '';
        if (!inPreBlock && !isPreBlock && /^\s*\n\s*$/.test(textData)) {
          textData = textData.replace(/\n +/g, '\n');
        }
        texts.push(textData);
      } else if (child.type === 'tag') {
        const childEl = child as Element;
        const tagName = childEl.tagName.toLowerCase();

        if (tagName === 'p') {
          if (texts.length > 0 && texts[texts.length - 1] !== '\n\n') {
            texts.push('\n\n');
          }
          texts.push(extractFromElement(childEl, inPreBlock || isPreBlock));
          texts.push('\n\n');
        } else if (tagName === 'br') {
          texts.push('\n');
        } else if (['a', 'i', 'b', 'code', 'pre', 'span', 'font'].includes(tagName)) {
          texts.push(extractFromElement(childEl, inPreBlock || isPreBlock || tagName === 'pre'));
        } else {
          texts.push(extractFromElement(childEl, inPreBlock || isPreBlock));
        }
      }
    }

    let result = texts.join('');
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
  }

  return extractFromElement(element.get(0) || null, false);
}

/* ── Comment filtering ── */

function isFlaggedComment($: CheerioAPI, commentDiv: Cheerio<Element>): boolean {
  const commtext = commentDiv.find('div.commtext');
  return commtext.length > 0 && commtext.hasClass('c73');
}

function isDeletedComment($: CheerioAPI, commentDiv: Cheerio<Element>): boolean {
  const commtext = commentDiv.find('div.commtext');
  if (commtext.length) {
    const text = commtext.text().trim();
    if (['[deleted]', '[dead]', '[flagged]'].includes(text)) {
      return true;
    }
  }
  const comhead = commentDiv.find('span.comhead');
  return comhead.length > 0 && !commtext.length;
}

/* ── Parse flat comment list ── */

function parseComments($: CheerioAPI): HNComment[] {
  const flatComments: HNComment[] = [];
  const commentRows = $('tr.athing.comtr');

  commentRows.each((_, row) => {
    const $row = $(row);
    const id = $row.attr('id') || '';

    const indentEl = $row.find('td.ind img');
    const indent = indentEl.length ? parseInt(indentEl.attr('width') || '0') : 0;

    const commentDiv = $row.find('td.default div.comment');
    if (!commentDiv.length) return;

    if (isFlaggedComment($, commentDiv)) return;
    if (isDeletedComment($, commentDiv)) return;

    const commentAuthor = $row.find('a.hnuser').text() || 'unknown';

    const commtext = commentDiv.find('div.commtext');
    const text = commtext.length ? extractTextFromElement($, commtext) : '';

    if (!text) return;

    flatComments.push({ id, author: commentAuthor, text, indent, children: [] });
  });

  return flatComments;
}

/* ── Build comment tree ── */

function buildCommentTree(flatComments: HNComment[]): HNComment[] {
  if (flatComments.length === 0) return [];

  const rootComments: HNComment[] = [];
  const stack: HNComment[] = [];

  for (const comment of flatComments) {
    while (stack.length > 0 && stack[stack.length - 1].indent >= comment.indent) {
      stack.pop();
    }

    if (stack.length > 0) {
      stack[stack.length - 1].children.push(comment);
    } else {
      rootComments.push(comment);
    }

    stack.push(comment);
  }

  return rootComments;
}

/* ── Descendant count ── */

function descendantCount(comment: HNComment): number {
  let count = comment.children.length;
  for (const child of comment.children) {
    count += descendantCount(child);
  }
  return count;
}

/* ── Render markdown ── */

function formatCommentText(text: string, indentStr: string): string {
  const lines = text.split('\n');
  const resultLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      resultLines.push(lines[i]);
    } else if (lines[i].trim()) {
      resultLines.push(indentStr + '  ' + lines[i]);
    } else {
      resultLines.push('');
    }
  }

  return resultLines.join('\n');
}

function renderMarkdown(comments: HNComment[], depth = 0): string {
  const lines: string[] = [];
  const indentStr = '  '.repeat(depth);

  for (const comment of comments) {
    const descCount = descendantCount(comment);
    const countStr = descCount > 0 ? ` [+${descCount}]` : '';

    const formattedText = formatCommentText(comment.text, indentStr);
    const line = `${indentStr}- @${comment.author}${countStr}: ${formattedText}`;
    lines.push(line);

    if (comment.children.length > 0) {
      const childMd = renderMarkdown(comment.children, depth + 1);
      lines.push(childMd);
    }
  }

  return lines.join('\n');
}

/* ── Condense (trim low-weight leaf comments) ── */

function commentWeight(comment: HNComment): number {
  return ((descendantCount(comment) + 1) * comment.text.length) / 10;
}

function deepCloneComments(comments: HNComment[]): HNComment[] {
  return comments.map((c) => ({
    ...c,
    children: deepCloneComments(c.children),
  }));
}

interface LeafInfo {
  leaf: HNComment;
  parent: HNComment | null;
  siblings: HNComment[];
}

function getAllLeaves(comments: HNComment[], parent: HNComment | null = null): LeafInfo[] {
  const leaves: LeafInfo[] = [];
  for (const comment of comments) {
    if (comment.children.length === 0) {
      leaves.push({ leaf: comment, parent, siblings: comments });
    } else {
      leaves.push(...getAllLeaves(comment.children, comment));
    }
  }
  return leaves;
}

function findDepth(comments: HNComment[], target: HNComment, depth = 0): number {
  for (const c of comments) {
    if (c === target) return depth;
    if (c.children.length > 0) {
      const result = findDepth(c.children, target, depth + 1);
      if (result >= 0) return result;
    }
  }
  return -1;
}

function condenseComments(comments: HNComment[], targetRate: number, stepSize = 4): HNComment[] {
  const result = deepCloneComments(comments);
  const originalMd = renderMarkdown(result);
  const originalLength = originalMd.length;

  if (originalLength === 0) return result;

  while (true) {
    const currentMd = renderMarkdown(result);
    const currentLength = currentMd.length;
    const currentRate = currentLength / originalLength;

    if (currentRate <= targetRate) break;

    const leaves = getAllLeaves(result);
    if (leaves.length === 0) break;

    leaves.sort((a, b) => {
      const weightA = commentWeight(a.leaf);
      const weightB = commentWeight(b.leaf);
      if (weightA !== weightB) return weightA - weightB;

      const depthA = findDepth(result, a.leaf);
      const depthB = findDepth(result, b.leaf);
      return depthB - depthA;
    });

    let removedCount = 0;
    for (let i = 0; i < Math.min(stepSize, leaves.length); i++) {
      const { leaf, siblings } = leaves[i];
      const idx = siblings.indexOf(leaf);
      if (idx >= 0) {
        siblings.splice(idx, 1);
        removedCount++;
      }
    }

    if (removedCount === 0) break;
  }

  return result;
}

/* ── Count all comments in tree ── */

function countComments(comments: HNComment[]): number {
  let count = comments.length;
  for (const c of comments) {
    count += countComments(c.children);
  }
  return count;
}

/* ── Substance Extractor ── */

/** Max markdown length before condensing (roughly ~12k chars to fit LLM context) */
const MAX_MARKDOWN_LENGTH = 12000;
/** Condense target rate when markdown exceeds max length */
const CONDENSE_TARGET_RATE = 0.6;

export const HNExtractor: Extractor = {
  match: {
    domain: /^news\.ycombinator\.com$/,
    selectors: ['tr.athing.comtr'],
  },

  options: {},

  content: {
    selectors: ['table.comment-tree'],

    clean: [],
    transforms: {},

    // No-op processElement — required by ExtractManager before it reaches the markdown hook
    processElement: () => {},

    // Bypass turndown entirely — produce markdown directly from the parsed comment tree
    markdown: ($, $content, _turndownService, state) => {
      const flatComments = parseComments($);
      const tree = buildCommentTree(flatComments);
      const totalComments = countComments(tree);

      // Parse post metadata
      const titleEl = $('tr.athing.submission span.titleline a').first();
      const title = titleEl.text() || '';
      const originalUrl = titleEl.attr('href') || '';

      const scoreEl = $('.score').first();
      const points = scoreEl.length ? parseInt(scoreEl.text() || '0') : 0;

      const authorEl = $('tr.athing.submission').next().find('.hnuser').first();
      const author = authorEl.text() || '';

      // Build header
      const headerParts: string[] = [];
      headerParts.push(`# ${title}\n`);
      if (originalUrl && !originalUrl.startsWith('item?id=')) {
        headerParts.push(`Original: ${originalUrl}`);
      }
      headerParts.push(`Points: ${points} | Author: ${author} | Comments: ${totalComments}`);
      headerParts.push('---\n');

      // Render comments, condense if too long
      let commentsMd = renderMarkdown(tree);
      if (commentsMd.length > MAX_MARKDOWN_LENGTH) {
        const condensed = condenseComments(tree, CONDENSE_TARGET_RATE);
        commentsMd = renderMarkdown(condensed);
      }

      return headerParts.join('\n') + '\n' + commentsMd;
    },
  },

  title: {
    selectors: ['tr.athing.submission span.titleline a'],
  },

  author: {
    selectors: ['td.subtext a.hnuser'],
  },

  extraData: ($, _state) => {
    const extraData: Record<string, unknown> = {};

    const scoreEl = $('.score').first();
    extraData.points = scoreEl.length ? parseInt(scoreEl.text() || '0') : 0;

    const authorEl = $('td.subtext a.hnuser').first();
    extraData.author = authorEl.text() || '';

    const titleEl = $('tr.athing.submission span.titleline a').first();
    extraData.originalUrl = titleEl.attr('href') || '';

    // Count comments
    const flatComments = parseComments($);
    const tree = buildCommentTree(flatComments);
    extraData.commentCount = countComments(tree);

    return extraData;
  },
};
