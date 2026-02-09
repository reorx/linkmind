# 统一 Record 模型方案

## 概览

参考 intake 的 Record 设计，将 `links` 表重命名为 `records`，增加 `type` 字段支持多种数据类型。当前支持三种 type：`link`、`note`、`image`。

## 数据库迁移

### Migration: `004_unified_records.sql`

```sql
-- 1. Rename table
ALTER TABLE links RENAME TO records;

-- 2. Add new columns
ALTER TABLE records ADD COLUMN type TEXT NOT NULL DEFAULT 'link';
ALTER TABLE records ADD COLUMN content TEXT;               -- note/image 的正文内容
ALTER TABLE records ADD COLUMN source_url TEXT;             -- 来源 URL（如 Telegram 转发消息链接）
ALTER TABLE records ADD COLUMN user_note TEXT;              -- 用户备注（通过回复追加）
ALTER TABLE records ADD COLUMN added_by_user BOOLEAN NOT NULL DEFAULT TRUE;  -- 用户主动添加 vs 派生
ALTER TABLE records ADD COLUMN telegram_message_id BIGINT;  -- 关联 Telegram 消息
ALTER TABLE records ADD COLUMN telegram_chat_id BIGINT;

-- 3. Update existing records (all existing links are user-added)
UPDATE records SET type = 'link', added_by_user = TRUE;

-- 4. Rename link_relations table references
ALTER TABLE link_relations RENAME COLUMN link_id TO record_id;
ALTER TABLE link_relations RENAME COLUMN related_link_id TO related_record_id;
ALTER TABLE link_relations RENAME TO record_relations;

-- 5. Record derivations (many-to-many: who derived whom)
CREATE TABLE record_derivations (
  source_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  derived_record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_record_id, derived_record_id)
);

-- 6. Indexes
CREATE INDEX idx_records_type ON records(type);
CREATE INDEX idx_records_added_by_user ON records(added_by_user);
CREATE INDEX idx_records_telegram_msg ON records(telegram_chat_id, telegram_message_id);
CREATE INDEX idx_derivations_derived ON record_derivations(derived_record_id);
```

## 类型定义

### RecordType

```typescript
type RecordType = 'link' | 'note' | 'image';
```

### Record 接口

```typescript
export interface RecordEntry {
  id?: number;
  user_id: number;
  type: RecordType;
  // 通用字段
  url?: string;                  // link 必填，note/image 可选
  content?: string;              // note 正文，image 描述
  source_url?: string;           // 转发来源
  user_note?: string;            // 用户备注
  added_by_user: boolean;        // true=用户主动添加, false=从其他 record 派生
  summary?: string;
  insight?: string;
  tags?: string;                 // JSON string
  summary_embedding?: string;
  status: 'enqueued' | 'pending' | 'scraped' | 'analyzed' | 'error' | 'waiting_probe';
  error_message?: string;
  // link 专有（对 note/image 为 null）
  og_title?: string;
  og_description?: string;
  og_image?: string;
  og_site_name?: string;
  og_type?: string;
  markdown?: string;
  images?: string;               // JSON string
  // 关联
  related_notes?: string;        // JSON string
  related_links?: string;        // JSON string
  // Telegram
  telegram_message_id?: number;
  telegram_chat_id?: number;
  // 时间
  created_at?: string;
  updated_at?: string;
}
```

## 代码重命名映射

| 旧名称 | 新名称 |
|--------|--------|
| `LinkRecord` | `RecordEntry` |
| `LinksTable` | `RecordsTable` |
| `links` (SQL table) | `records` |
| `link_relations` | `record_relations` |
| `getLink(id)` | `getRecord(id)` |
| `insertLink(userId, url)` | `insertRecord(userId, data)` |
| `updateLink(id, data)` | `updateRecord(id, data)` |
| `getLinkByUrl(userId, url)` | `getRecordByUrl(userId, url)` |
| `getAllUserLinks(userId)` | `getAllUserRecords(userId, type?)` |
| `getRecentLinks(userId)` | `getRecentRecords(userId, type?)` |
| `getPaginatedLinks(...)` | `getPaginatedRecords(..., type?)` |
| `getFailedLinks(userId)` | `getFailedRecords(userId, type?)` |
| `getAllAnalyzedLinks()` | `getAllAnalyzedRecords(type?)` |
| `deleteLink(id)` | `deleteRecord(id)` |
| `LinkRelation` | `RecordRelation` |
| `getRelatedLinks(id)` | `getRelatedRecords(id)` |
| `saveRelatedLinks(...)` | `saveRelatedRecords(...)` |
| `removeFromRelatedLinks(id)` | `removeFromRelatedRecords(id)` |
| `insertLinkWithCreatedAt(...)` | `insertRecordWithCreatedAt(...)` |
| `getAllUserLinks(userId)` | `getAllUserRecords(userId, type?)` |
| `getEnqueuedLinks(perUser)` | `getEnqueuedRecords(perUser)` |

## 新增 DB 函数

```typescript
// 通过 Telegram 消息 ID 查找记录
export async function getRecordByTelegramMessage(
  chatId: number, messageId: number
): Promise<RecordEntry | undefined>

// 插入笔记
export async function insertNote(
  userId: number, content: string, opts?: {
    sourceUrl?: string;
    telegramMessageId?: number;
    telegramChatId?: number;
    parentRecordId?: number;
  }
): Promise<number>

// 追加用户备注
export async function appendUserNote(recordId: number, note: string): Promise<void>
```

## 派生链接的简化 Pipeline

从笔记中提取的链接（`added_by_user = false`）走简化 pipeline，只做基础内容获取：

```
Derived Link Pipeline:
  1. scrape — 获取 og_title, og_description, og_image, markdown
  Done. status → 'scraped' (不继续到 analyzed)
```

不做 summarize / embed / related / insight。状态停在 `scraped`。

如果该链接后来被用户主动添加（`added_by_user` 改为 true），则触发完整 pipeline 重新处理。

## 派生关系 DB 函数

```typescript
// 记录派生关系
export async function addDerivation(sourceRecordId: number, derivedRecordId: number): Promise<void>

// 查询某 record 的所有派生来源
export async function getDerivationSources(recordId: number): Promise<number[]>

// 查询某 record 派生出的所有 records
export async function getDerivedRecords(recordId: number): Promise<number[]>
```

## 受影响的文件

| 文件 | 改动量 | 说明 |
|------|--------|------|
| `server/src/db.ts` | **大** | 接口重命名、表名改、新增函数 |
| `server/src/pipeline.ts` | **大** | LinkRecord → RecordEntry，所有 db 调用改名 |
| `server/src/web.ts` | **中** | 路由中的变量名 + db 调用 |
| `server/src/bot.ts` | **大** | 重构消息处理 + 新增笔记逻辑 |
| `server/src/search.ts` | **小** | 函数名 |
| `server/src/export.ts` | **小** | 类型名 |
| `server/src/enqueue-cron.ts` | **小** | 函数名 |
| `server/src/agent.ts` | **小** | 可能需要新增 note summarize prompt |
| `server/src/views/*.ejs` | **小** | 变量名适配 |
| `core/src/types.ts` | **无** | scrape 类型不变 |

## 实施步骤

### Step 1: DB 迁移 + 类型重命名
- 创建 migration SQL
- db.ts 中重命名所有接口和函数
- 确保 typecheck 通过

### Step 2: Pipeline + 其他模块适配
- pipeline.ts、web.ts、search.ts、export.ts 全部改用新名称
- 所有查询加 `type` 过滤（默认 `link`，保持现有行为不变）

### Step 3: Bot 消息分类 + 笔记支持
- 重构 bot.ts 消息处理
- 实现消息分类逻辑
- 回复检测 + 备注追加
- 笔记创建 + 转发识别

### Step 4: 笔记 Pipeline
- 笔记的 summarize/tag 生成
- 笔记中链接的提取和处理

### Step 5: Web 端适配
- 首页支持显示不同类型的 records
- 笔记详情页
