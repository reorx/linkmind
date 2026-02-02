/**
 * Search: qmd vsearch for notes and historical links.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { searchLinks, getLink } from './db.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

const log = logger.child({ module: 'search' });

const NOTES_COLLECTION = process.env.QMD_NOTES_COLLECTION || 'notes';
const LINKS_COLLECTION = process.env.QMD_LINKS_COLLECTION || 'links';

export interface SearchResult {
  source: string;
  title: string;
  snippet: string;
  heading?: string;
  path?: string;
  url?: string;
  linkId?: number;
  score?: number;
}

/**
 * Search notes using qmd vsearch.
 * Falls back gracefully if qmd is not installed or no collections configured.
 */
export async function searchNotes(query: string, limit: number = 5): Promise<SearchResult[]> {
  // TEMP DISABLED: QMD notes are not user-scoped yet.
  // In multi-tenant mode, all users would see the same notes (from the admin's vault).
  // Re-enable when per-user note collections are implemented.
  return [];

  // @ts-ignore — unreachable code below kept for when feature is re-enabled
  try {
    const startTime = Date.now();
    log.debug({ query, collection: 'notes' }, '→ qmd vsearch: notes');

    const stdout = await qmdVsearchWithRetry(`qmd vsearch "${escapeShell(query)}" --json -n ${limit * 3}`);

    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];

    // Filter to notes collection only
    const noteResults = parsed
      .filter((item: any) => item.file?.startsWith(`qmd://${NOTES_COLLECTION}/`))
      .slice(0, limit);

    const elapsed = Date.now() - startTime;
    log.info({ elapsed: `${elapsed}ms`, results: noteResults.length, query }, '← qmd vsearch: notes done');

    return noteResults.map((item: any) => {
      const filePath = (item.path || item.file || '').replace(`qmd://${NOTES_COLLECTION}/`, '');
      // Extract filename without extension as title
      const filename = filePath.split('/').pop()?.replace(/\.md$/i, '') || 'Untitled';
      return {
        source: 'notes',
        title: filename,
        heading: item.title || undefined,
        snippet: item.snippet || item.content?.slice(0, 200) || '',
        path: item.path || item.file,
        score: item.score,
      };
    });
  } catch (err: any) {
    log.warn({ query, err: err instanceof Error ? err.message : String(err) }, '← qmd vsearch: notes failed');
    return [];
  }
}

/**
 * Search previously saved links via qmd vsearch.
 * Falls back to SQLite LIKE search if qmd is unavailable.
 */
export async function searchHistoricalLinks(query: string, limit: number = 5): Promise<SearchResult[]> {
  try {
    const startTime = Date.now();
    log.debug({ query, collection: 'links' }, '→ qmd vsearch: links');

    const stdout = await qmdVsearchWithRetry(`qmd vsearch "${escapeShell(query)}" -n ${limit * 3} --json`);

    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      // Filter to links collection only
      const linkResults = parsed
        .filter((item: any) => item.file?.startsWith(`qmd://${LINKS_COLLECTION}/`))
        .slice(0, limit);

      const elapsed = Date.now() - startTime;
      log.info({ elapsed: `${elapsed}ms`, results: linkResults.length, query }, '← qmd vsearch: links done');

      if (linkResults.length > 0) {
        const results: SearchResult[] = [];
        for (const item of linkResults) {
          const filename = item.file?.replace(`qmd://${LINKS_COLLECTION}/`, '') || '';
          const idMatch = filename.match(/^(\d+)-/);
          const linkId = idMatch ? parseInt(idMatch[1], 10) : undefined;
          results.push({
            source: 'links',
            title: item.title || filename || 'Untitled',
            snippet: item.snippet || '',
            url: linkId ? await getLinkUrl(linkId) : undefined,
            linkId,
            score: item.score,
          });
        }
        return results;
      }
    }
  } catch (err) {
    log.warn(
      { query, err: err instanceof Error ? err.message : String(err) },
      '← qmd vsearch: links failed, falling back to SQLite',
    );
  }

  // Fallback: database LIKE search
  const links = await searchLinks(query, limit);
  return links.map((link) => ({
    source: 'links',
    title: link.og_title || link.url,
    snippet: link.summary || link.og_description || '',
    url: link.id ? `/link/${link.id}` : link.url,
    linkId: link.id,
  }));
}

/**
 * Combined search: notes + historical links.
 * Runs sequentially to avoid concurrent qmd processes fighting over SQLite locks.
 */
export async function searchAll(
  query: string,
  limit: number = 5,
): Promise<{ notes: SearchResult[]; links: SearchResult[] }> {
  const notes = await searchNotes(query, limit);
  const links = await searchHistoricalLinks(query, limit);
  return { notes, links };
}

/**
 * Look up the URL for a link by its database ID.
 */
async function getLinkUrl(id: number): Promise<string | undefined> {
  try {
    const link = await getLink(id);
    return link ? `/link/${id}` : undefined;
  } catch {
    return undefined;
  }
}

function escapeShell(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a qmd vsearch command with retry on SQLITE_BUSY errors.
 * Retries up to `maxRetries` times with exponential backoff.
 */
async function qmdVsearchWithRetry(cmd: string, maxRetries: number = 3, baseDelayMs: number = 1000): Promise<string> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout: 30000 });
      return stdout;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const isBusy = lastErr.message.includes('SQLITE_BUSY');
      if (!isBusy || attempt === maxRetries) break;
      const delay = baseDelayMs * 2 ** attempt;
      log.debug({ attempt: attempt + 1, delay }, '[qmd-retry] SQLITE_BUSY, retrying...');
      await sleep(delay);
    }
  }
  throw lastErr;
}
