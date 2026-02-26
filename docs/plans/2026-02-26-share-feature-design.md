# Share Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to publicly share individual records via NanoID-based URLs, with toggle to stop sharing.

**Architecture:** New `share_records` table maps NanoID → record_id (1:1). Two API endpoints (create/delete share) and one public page route (`/shared/:nanoid`). The existing `link-detail.ejs` template gains an `isShared` flag to control what's visible in shared vs. owner mode.

**Tech Stack:** nanoid (new dependency), Kysely (existing ORM), Express routes, EJS template

---

### Task 1: Add nanoid dependency

**Step 1: Install nanoid**

Run: `cd /Users/reorx/Code/linkmind && pnpm --filter @linkmind/server add nanoid`

**Step 2: Verify it's in package.json**

Check that `server/package.json` now includes `"nanoid"` in dependencies.

---

### Task 2: Database migration + types

**Files:**
- Create: `server/migrations/005_share_records.sql`
- Modify: `server/src/db/types.ts`
- Modify: `server/src/db/index.ts`

**Step 1: Create migration file**

```sql
-- 005_share_records.sql
CREATE TABLE share_records (
  id SERIAL PRIMARY KEY,
  nanoid VARCHAR(21) UNIQUE NOT NULL,
  record_id INTEGER UNIQUE NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_share_records_nanoid ON share_records (nanoid);
CREATE INDEX idx_share_records_record_id ON share_records (record_id);
```

**Step 2: Add application type to `server/src/db/types.ts`**

After `RecordRelation` interface, add:

```typescript
export interface ShareRecord {
  id?: number;
  nanoid: string;
  record_id: number;
  user_id: number;
  created_at?: string;
}
```

**Step 3: Add Kysely table type to `server/src/db/types.ts`**

After `AgentEventsTable`, add:

```typescript
export interface ShareRecordsTable {
  id: Generated<number>;
  nanoid: string;
  record_id: number;
  user_id: number;
  created_at: Generated<Date>;
}
```

**Step 4: Register table in `Database` interface**

Add to the `Database` interface in `server/src/db/types.ts`:

```typescript
share_records: ShareRecordsTable;
```

---

### Task 3: Database query functions

**Files:**
- Create: `server/src/db/share.ts`
- Modify: `server/src/db/index.ts`

**Step 1: Create `server/src/db/share.ts`**

```typescript
import { getDb } from './connection.js';
import type { ShareRecord } from './types.js';

function toShareRecord(row: any): ShareRecord {
  return {
    id: row.id,
    nanoid: row.nanoid,
    record_id: row.record_id,
    user_id: row.user_id,
    created_at: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

export async function getShareByRecordId(recordId: number): Promise<ShareRecord | undefined> {
  const row = await getDb()
    .selectFrom('share_records')
    .selectAll()
    .where('record_id', '=', recordId)
    .executeTakeFirst();
  return row ? toShareRecord(row) : undefined;
}

export async function getShareByNanoid(nanoid: string): Promise<ShareRecord | undefined> {
  const row = await getDb()
    .selectFrom('share_records')
    .selectAll()
    .where('nanoid', '=', nanoid)
    .executeTakeFirst();
  return row ? toShareRecord(row) : undefined;
}

export async function createShare(nanoid: string, recordId: number, userId: number): Promise<ShareRecord> {
  const row = await getDb()
    .insertInto('share_records')
    .values({ nanoid, record_id: recordId, user_id: userId })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toShareRecord(row);
}

export async function deleteShareByRecordId(recordId: number): Promise<boolean> {
  const result = await getDb()
    .deleteFrom('share_records')
    .where('record_id', '=', recordId)
    .executeTakeFirst();
  return (result?.numDeletedRows ?? 0n) > 0n;
}
```

**Step 2: Re-export from `server/src/db/index.ts`**

Add line:
```typescript
export * from './share.js';
```

---

### Task 4: Share API endpoints

**Files:**
- Modify: `server/src/routes/api.ts`

**Step 1: Add imports**

Add to the imports at top of `server/src/routes/api.ts`:

```typescript
import { nanoid } from 'nanoid';
import {
  getShareByRecordId,
  createShare,
  deleteShareByRecordId,
} from '../db/index.js';
```

**Step 2: Add POST `/api/links/:id/share` endpoint**

Add before the closing `}` of `registerApiRoutes`:

```typescript
// POST /api/links/:id/share — create or return existing share link
router.post('/api/links/:id/share', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid ID' });
    return;
  }
  const record = await getRecord(id);
  if (!record || record.user_id !== req.userId) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Idempotent: return existing share if already shared
  const existing = await getShareByRecordId(id);
  if (existing) {
    res.json({ nanoid: existing.nanoid, url: `/shared/${existing.nanoid}` });
    return;
  }

  const share = await createShare(nanoid(), id, req.userId!);
  log.info({ recordId: id, nanoid: share.nanoid }, 'Share created');
  res.json({ nanoid: share.nanoid, url: `/shared/${share.nanoid}` });
});

// DELETE /api/links/:id/share — stop sharing
router.delete('/api/links/:id/share', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid ID' });
    return;
  }
  const record = await getRecord(id);
  if (!record || record.user_id !== req.userId) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const deleted = await deleteShareByRecordId(id);
  if (deleted) {
    log.info({ recordId: id }, 'Share deleted');
  }
  res.json({ success: true });
});
```

---

### Task 5: Public shared page route

**Files:**
- Modify: `server/src/routes/pages.ts`

**Step 1: Add imports**

Add to imports in `server/src/routes/pages.ts`:

```typescript
import { getShareByRecordId, getShareByNanoid } from '../db/index.js';
```

**Step 2: Add GET `/shared/:nanoid` route**

Add after the `/link/:id` route handler, inside `registerPageRoutes`. This route does NOT use `requireAuth` — it's public.

```typescript
// GET /shared/:nanoid — public shared record page
router.get('/shared/:nanoid', async (req: Request, res: Response) => {
  const { nanoid } = req.params;
  const share = await getShareByNanoid(nanoid);
  if (!share) {
    res.status(404).send('Not found');
    return;
  }

  const record = await getRecord(share.record_id);
  if (!record) {
    res.status(404).send('Not found');
    return;
  }

  const tags = safeParseJson(record.tags);
  const images = safeParseJson(record.images);

  // Related links: title + sourceUrl only (no internal link)
  const relatedLinkData = await getRelatedRecords(record.id!);
  const relatedLinks: {
    linkId: number;
    title: string;
    url: string;
    sourceUrl: string;
    tags: string[];
    score: number;
  }[] = [];
  for (const item of relatedLinkData) {
    const relatedRecord = await getRecord(item.relatedRecordId);
    if (relatedRecord) {
      relatedLinks.push({
        linkId: item.relatedRecordId,
        title: relatedRecord.og_title || relatedRecord.url || '',
        url: '',  // no internal link in shared mode
        sourceUrl: relatedRecord.url || '',
        tags: safeParseJson(relatedRecord.tags),
        score: item.score,
      });
    }
  }

  const detailTitle = record.type === 'note'
    ? '笔记 — LinkMind'
    : `${record.og_title || record.url} — LinkMind`;

  const html = await renderPage('link-detail', {
    pageTitle: detailTitle,
    link: record,
    tags,
    images,
    relatedNotes: [],  // hide related notes in shared mode
    relatedLinks,
    agentSession: null,
    agentEvents: [],
    isAdmin: false,
    isShared: true,
    user: null,
    summaryHtml: renderMarkdown(record.summary),
    insightHtml: renderMarkdown(record.insight),
    markdownHtml: renderMarkdown(record.markdown),
    contentHtml: record.type === 'note' ? renderMarkdown(record.content) : '',
  });
  res.type('html').send(html);
});
```

Also add `Request` to the type import at line 1:

```typescript
import type { Router, Request, Response } from 'express';
```

**Step 3: Pass `isShared` and `shareNanoid` in the existing `/link/:id` route**

In the existing `/link/:id` handler, before the `renderPage` call, look up the share status and pass it:

```typescript
const shareRecord = await getShareByRecordId(record.id!);
```

Then add to the `renderPage` data object:

```typescript
isShared: false,
shareNanoid: shareRecord?.nanoid || null,
```

---

### Task 6: Template changes — Share button and shared mode

**Files:**
- Modify: `server/src/views/link-detail.ejs`

**Step 1: Add Share/Stop Sharing button in the detail-header area**

After the `<h1>` title line for links (line 362: `<h1><%= link.og_title || 'Untitled' %></h1>`), add the share button. This should appear for both note and link types, but only when NOT in shared mode.

Insert right after the `<div class="detail-main">` line (line 327), before the `<% if (link.type === 'note') { %>`:

```ejs
<% if (typeof isShared === 'undefined' || !isShared) { %>
<div class="share-bar">
  <% if (typeof shareNanoid !== 'undefined' && shareNanoid) { %>
    <button class="btn-share btn-share--active" id="shareBtn" onclick="stopSharing()">Stop Sharing</button>
    <span class="share-url" id="shareUrl"><a href="/shared/<%= shareNanoid %>" target="_blank">/shared/<%= shareNanoid %></a></span>
  <% } else { %>
    <button class="btn-share" id="shareBtn" onclick="shareRecord()">Share</button>
  <% } %>
</div>
<% } %>
```

**Step 2: Add CSS for share button**

Add in the `<style>` section (after the rerun button styles, around line 256):

```css
/* Share button */
.share-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.btn-share {
  background: var(--green);
  color: #fff;
  border: none;
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}
.btn-share:hover { opacity: 0.9; }
.btn-share--active {
  background: var(--dim);
}
.share-url {
  font-size: 0.85rem;
}
.share-url a {
  color: var(--accent);
}
```

**Step 3: Modify related links rendering for shared mode**

Replace the related links section (lines 459-471) to handle `isShared`:

```ejs
<% if (relatedLinks.length > 0) { %>
<div class="section">
  <div class="section-title">相关链接</div>
  <% for (const l of relatedLinks) { %>
  <div class="related-item">
    <% if (typeof isShared !== 'undefined' && isShared) { %>
      🔗 <%= l.title || l.sourceUrl || '' %> (<a href="<%= l.sourceUrl %>" target="_blank">Source</a>)
    <% } else { %>
      🔗 <a href="<%= l.url %>"><%= l.title || l.url || '' %></a> (<a href="<%= l.sourceUrl %>" target="_blank">Source</a>)<% if (l.score) { %><span class="related-score">[<%= l.score %>]</span><% } %>
      <% if (l.tags && l.tags.length > 0) { %>
      <br><span class="related-tags"><%= l.tags.map(t => '#' + t).join(' ') %></span>
      <% } %>
    <% } %>
  </div>
  <% } %>
</div>
<% } %>
```

**Step 4: Add JavaScript for share/unshare actions**

Add at the bottom of the template (before the admin script block at line 545), a script block that's only rendered when NOT in shared mode:

```ejs
<% if (typeof isShared === 'undefined' || !isShared) { %>
<script>
  function shareRecord() {
    if (!confirm('确认公开分享此链接？')) return;
    const btn = document.getElementById('shareBtn');
    btn.disabled = true;
    btn.textContent = 'Sharing...';

    fetch('/api/links/<%= link.id %>/share', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        // Copy full URL to clipboard
        const fullUrl = location.origin + data.url;
        navigator.clipboard.writeText(fullUrl).then(() => {
          alert('分享链接已复制到剪贴板：\n' + fullUrl);
        }).catch(() => {
          alert('分享链接：\n' + fullUrl);
        });
        // Reload to show updated button state
        location.reload();
      })
      .catch(err => {
        btn.disabled = false;
        btn.textContent = 'Share';
        alert('分享失败：' + err.message);
      });
  }

  function stopSharing() {
    if (!confirm('确认停止分享？停止后分享链接将不可访问。')) return;
    const btn = document.getElementById('shareBtn');
    btn.disabled = true;
    btn.textContent = 'Stopping...';

    fetch('/api/links/<%= link.id %>/share', { method: 'DELETE' })
      .then(r => r.json())
      .then(() => {
        location.reload();
      })
      .catch(err => {
        btn.disabled = false;
        btn.textContent = 'Stop Sharing';
        alert('操作失败：' + err.message);
      });
  }
</script>
<% } %>
```

---

### Task 7: Run migration on local database

**Step 1: Run migration**

Run the migration against local database:

```bash
cd /Users/reorx/Code/linkmind/server
npx tsx -e "const pg=require('pg');const fs=require('fs');const c=new pg.Client(process.env.DATABASE_URL);c.connect().then(()=>c.query(fs.readFileSync('migrations/005_share_records.sql','utf8'))).then(()=>{console.log('Done');c.end()}).catch(e=>{console.error(e);process.exit(1)})"
```

Or using dotenv:

```bash
cd /Users/reorx/Code/linkmind/server
npx tsx --env-file=.env -e "import pg from 'pg'; import fs from 'fs'; const c = new pg.Client(process.env.DATABASE_URL); await c.connect(); await c.query(fs.readFileSync('migrations/005_share_records.sql','utf8')); console.log('Done'); await c.end();"
```

---

### Task 8: Typecheck and manual test

**Step 1: Run typecheck**

```bash
cd /Users/reorx/Code/linkmind && pnpm typecheck
```

Fix any type errors.

**Step 2: Manual test**

Start dev server and test:
1. Visit a link detail page → see "Share" button
2. Click Share → confirm → link copied to clipboard, button changes to "Stop Sharing"
3. Open the shared URL in incognito → page renders without auth, no Rerun button, related links show title + Source only
4. Click "Stop Sharing" → confirm → shared URL returns 404

---

### Task 9: Commit

```bash
git add server/migrations/005_share_records.sql server/src/db/types.ts server/src/db/share.ts server/src/db/index.ts server/src/routes/api.ts server/src/routes/pages.ts server/src/views/link-detail.ejs server/package.json server/pnpm-lock.yaml
git commit -m "feat: add share functionality for record detail pages"
```
