/**
 * Web server: serves permanent link pages for analyzed articles.
 */

import express from "express";
import { getLink } from "./db.js";

export function startWebServer(port: number): void {
  const app = express();

  app.get("/link/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).send("Invalid ID");
      return;
    }

    const link = getLink(id);
    if (!link) {
      res.status(404).send("Not found");
      return;
    }

    const relatedNotes = safeParseJson(link.related_notes);
    const relatedLinks = safeParseJson(link.related_links);
    const tags = safeParseJson(link.tags);

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(link.og_title || link.url)} — LinkMind</title>
<style>
  :root { --bg: #0f0f0f; --surface: #1a1a1a; --border: #2a2a2a; --text: #e0e0e0; --dim: #888; --accent: #4ea8de; --green: #4ecca3; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); padding: 40px 20px; line-height: 1.7; }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  .meta { color: var(--dim); font-size: 0.85rem; margin-bottom: 24px; }
  .meta a { color: var(--accent); text-decoration: none; }
  .section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .section-title { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); margin-bottom: 10px; font-weight: 600; }
  .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
  .tag { background: var(--border); color: var(--dim); padding: 2px 10px; border-radius: 12px; font-size: 0.8rem; }
  .insight { border-left: 3px solid var(--green); padding-left: 16px; color: var(--text); }
  .related-item { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
  .related-item:last-child { border-bottom: none; }
  .related-item a { color: var(--accent); text-decoration: none; }
  .content { font-size: 0.95rem; white-space: pre-wrap; word-break: break-word; max-height: 600px; overflow-y: auto; }
  .og-image { width: 100%; border-radius: 6px; margin-bottom: 16px; }
</style>
</head>
<body>
<div class="container">
  <h1>${esc(link.og_title || "Untitled")}</h1>
  <div class="meta">
    <a href="${esc(link.url)}" target="_blank">${esc(link.url)}</a>
    ${link.og_site_name ? `· ${esc(link.og_site_name)}` : ""}
    · ${esc(link.created_at || "")}
  </div>

  ${link.og_image ? `<img class="og-image" src="${esc(link.og_image)}" alt="">` : ""}

  ${tags.length > 0 ? `<div class="tags">${tags.map((t: string) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}

  ${link.summary ? `<div class="section"><div class="section-title">摘要</div><div>${esc(link.summary)}</div></div>` : ""}

  ${link.insight ? `<div class="section"><div class="section-title">Insight</div><div class="insight">${esc(link.insight)}</div></div>` : ""}

  ${relatedNotes.length > 0 ? `<div class="section"><div class="section-title">相关笔记</div>${relatedNotes.map((n: any) => `<div class="related-item">📝 ${esc(n.title || n.path || "")}<br><span style="color:var(--dim);font-size:0.8rem">${esc((n.snippet || "").slice(0, 150))}</span></div>`).join("")}</div>` : ""}

  ${relatedLinks.length > 0 ? `<div class="section"><div class="section-title">相关链接</div>${relatedLinks.map((l: any) => `<div class="related-item">🔗 <a href="${esc(l.url || "")}" target="_blank">${esc(l.title || l.url || "")}</a><br><span style="color:var(--dim);font-size:0.8rem">${esc((l.snippet || "").slice(0, 150))}</span></div>`).join("")}</div>` : ""}

  ${link.markdown ? `<div class="section"><div class="section-title">原文内容</div><div class="content">${esc(link.markdown)}</div></div>` : ""}
</div>
</body>
</html>`;

    res.type("html").send(html);
  });

  app.listen(port, () => {
    console.log(`[web] Server listening on http://localhost:${port}`);
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeParseJson(s?: string): any[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
