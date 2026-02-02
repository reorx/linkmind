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
  path?: string;
  url?: string;
  score?: number;
}

/**
 * Search notes using qmd vsearch.
 * Falls back gracefully if qmd is not installed or no collections configured.
 */
export async function searchNotes(query: string, limit: number = 5): Promise<SearchResult[]> {
  try {
    const startTime = Date.now();
    log.debug({ query, collection: 'notes' }, '→ qmd vsearch: notes');

    const { stdout } = await execAsync(`qmd vsearch "${escapeShell(query)}" --json -n ${limit * 3}`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];

    // Filter to notes collection only
    const noteResults = parsed
      .filter((item: any) => item.file?.startsWith(`qmd://${NOTES_COLLECTION}/`))
      .slice(0, limit);

    const elapsed = Date.now() - startTime;
    log.info({ elapsed: `${elapsed}ms`, results: noteResults.length, query }, '← qmd vsearch: notes done');

    return noteResults.map((item: any) => ({
      source: 'notes',
      title: item.title || item.path || 'Untitled',
      snippet: item.snippet || item.content?.slice(0, 200) || '',
      path: item.path || item.file,
      score: item.score,
    }));
  } catch (err) {
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

    const { stdout } = await execAsync(`qmd vsearch "${escapeShell(query)}" -n ${limit * 3} --json`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      // Filter to links collection only
      const linkResults = parsed
        .filter((item: any) => item.file?.startsWith(`qmd://${LINKS_COLLECTION}/`))
        .slice(0, limit);

      const elapsed = Date.now() - startTime;
      log.info({ elapsed: `${elapsed}ms`, results: linkResults.length, query }, '← qmd vsearch: links done');

      if (linkResults.length > 0) {
        return linkResults.map((item: any) => {
          // Extract link ID from filename (format: {id}-{slug}.md)
          const filename = item.file?.replace(`qmd://${LINKS_COLLECTION}/`, '') || '';
          const idMatch = filename.match(/^(\d+)-/);
          const linkId = idMatch ? parseInt(idMatch[1], 10) : undefined;
          return {
            source: 'links',
            title: item.title || filename || 'Untitled',
            snippet: item.snippet || '',
            url: linkId ? getLinkUrl(linkId) : undefined,
            score: item.score,
          };
        });
      }
    }
  } catch (err) {
    log.warn(
      { query, err: err instanceof Error ? err.message : String(err) },
      '← qmd vsearch: links failed, falling back to SQLite',
    );
  }

  // Fallback: SQLite LIKE search
  const links = searchLinks(query, limit);
  return links.map((link) => ({
    source: 'links',
    title: link.og_title || link.url,
    snippet: link.summary || link.og_description || '',
    url: link.url,
  }));
}

/**
 * Combined search: notes + historical links.
 */
export async function searchAll(
  query: string,
  limit: number = 5,
): Promise<{ notes: SearchResult[]; links: SearchResult[] }> {
  const [notes, links] = await Promise.all([searchNotes(query, limit), searchHistoricalLinks(query, limit)]);
  return { notes, links };
}

/**
 * Look up the URL for a link by its database ID.
 */
function getLinkUrl(id: number): string | undefined {
  try {
    const link = getLink(id);
    return link?.url;
  } catch {
    return undefined;
  }
}

function escapeShell(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}
