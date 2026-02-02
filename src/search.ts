/**
 * Search: qmd for notes, SQLite for historical links.
 */

import { execSync } from "child_process";
import { searchLinks } from "./db.js";

export interface SearchResult {
  source: string;
  title: string;
  snippet: string;
  path?: string;
  url?: string;
  score?: number;
}

/**
 * Search notes using qmd CLI.
 * Falls back gracefully if qmd is not installed or no collections configured.
 */
export function searchNotes(query: string, limit: number = 5): SearchResult[] {
  try {
    const result = execSync(`qmd search "${escapeShell(query)}" --json -n ${limit}`, {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parsed = JSON.parse(result);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((item: any) => ({
      source: "notes",
      title: item.title || item.path || "Untitled",
      snippet: item.snippet || item.content?.slice(0, 200) || "",
      path: item.path,
      score: item.score,
    }));
  } catch (err) {
    // qmd not installed, no collections, or search failed — that's okay
    console.log(`[search] qmd search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Search previously saved links from the database.
 */
export function searchHistoricalLinks(query: string, limit: number = 5): SearchResult[] {
  const links = searchLinks(query, limit);
  return links.map((link) => ({
    source: "links",
    title: link.og_title || link.url,
    snippet: link.summary || link.og_description || "",
    url: link.url,
  }));
}

/**
 * Combined search: notes + historical links.
 */
export function searchAll(
  query: string,
  limit: number = 5,
): { notes: SearchResult[]; links: SearchResult[] } {
  const notes = searchNotes(query, limit);
  const links = searchHistoricalLinks(query, limit);
  return { notes, links };
}

function escapeShell(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}
