/**
 * Search: qmd vsearch for notes and historical links.
 */

import { execSync } from 'child_process';
import { searchLinks, getLink } from './db.js';

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
export function searchNotes(query: string, limit: number = 5): SearchResult[] {
  try {
    const result = execSync(`qmd vsearch "${escapeShell(query)}" --json -n ${limit * 3}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(result);
    if (!Array.isArray(parsed)) return [];

    // Filter to notes collection only
    const noteResults = parsed
      .filter((item: any) => item.file?.startsWith(`qmd://${NOTES_COLLECTION}/`))
      .slice(0, limit);

    return noteResults.map((item: any) => ({
      source: 'notes',
      title: item.title || item.path || 'Untitled',
      snippet: item.snippet || item.content?.slice(0, 200) || '',
      path: item.path || item.file,
      score: item.score,
    }));
  } catch (err) {
    console.log(`[search] qmd vsearch notes failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Search previously saved links via qmd vsearch.
 * Falls back to SQLite LIKE search if qmd is unavailable.
 */
export function searchHistoricalLinks(query: string, limit: number = 5): SearchResult[] {
  try {
    const result = execSync(`qmd vsearch "${escapeShell(query)}" -n ${limit * 3} --json`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) {
      // Filter to links collection only
      const linkResults = parsed
        .filter((item: any) => item.file?.startsWith(`qmd://${LINKS_COLLECTION}/`))
        .slice(0, limit);

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
    console.log(
      `[search] qmd vsearch links failed, falling back to SQLite: ${err instanceof Error ? err.message : String(err)}`,
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
export function searchAll(query: string, limit: number = 5): { notes: SearchResult[]; links: SearchResult[] } {
  const notes = searchNotes(query, limit);
  const links = searchHistoricalLinks(query, limit);
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
