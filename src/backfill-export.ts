/**
 * Backfill: export all analyzed links as Markdown files.
 */

import { getDb } from "./db.js";
import { exportAllLinks } from "./export.js";
import type { LinkRecord } from "./db.js";

const db = getDb();
const links = db.prepare("SELECT * FROM links WHERE status = 'analyzed'").all() as LinkRecord[];
console.log(`Found ${links.length} analyzed links`);
const paths = exportAllLinks(links);
console.log(`Done. Exported ${paths.length} files.`);
