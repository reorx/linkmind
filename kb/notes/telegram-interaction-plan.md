# Telegram 交互增强方案

## 概览

重构 bot 消息处理逻辑，支持三种消息类型识别 + 回复关联，新增「笔记」实体。

## 消息分类逻辑

```
收到消息
  │
  ├─ 是否是对某条消息的回复？ (reply_to_message)
  │     ├─ 是 → 查找原消息对应的 link 或 note → 追加备注
  │     └─ 否 → 继续判断
  │
  ├─ 消息以链接开头？
  │     ├─ 是 → 类型 A: 链接消息
  │     │     ├─ 提取第一个 URL 作为主链接
  │     │     └─ URL 后面的文本作为 user_note（备注）
  │     └─ 否 → 类型 B: 笔记消息
  │           ├─ 整段文本作为笔记内容
  │           ├─ 提取文本中的所有 URL → 关联到 links 表
  │           └─ 检查是否为转发消息 → 生成 source_url
  │
```

## 数据模型

### 新增 `notes` 表

```sql
CREATE TABLE notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,               -- 笔记正文
  source_url TEXT,                     -- 转发消息的原始 Telegram 链接
  telegram_message_id BIGINT,          -- 原始消息 ID，用于回复关联
  telegram_chat_id BIGINT,             -- 原始 chat ID
  user_notes TEXT,                     -- 用户通过回复追加的备注（多条用 \n--- 分隔）
  summary TEXT,                        -- LLM 生成的摘要
  tags TEXT,                           -- JSON string
  status TEXT NOT NULL DEFAULT 'pending', -- pending | analyzed | error
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 新增 `note_links` 关联表

```sql
CREATE TABLE note_links (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, link_id)
);
```

### `links` 表新增字段

```sql
ALTER TABLE links ADD COLUMN telegram_message_id BIGINT;
ALTER TABLE links ADD COLUMN telegram_chat_id BIGINT;
ALTER TABLE links ADD COLUMN user_note TEXT;  -- 用户备注（链接开头消息的后续文本 + 回复追加的内容）
```

## 消息处理详细逻辑

### 类型 A: 链接消息（以 URL 开头）

判断条件：`text.trimStart()` 以 `http://` 或 `https://` 开头

处理流程：
1. 提取第一个 URL
2. URL 后的文本 → `user_note`
3. 创建/更新 link 记录，保存 `telegram_message_id` 和 `telegram_chat_id`
4. 如果有 `user_note`，保存到 link 的 `user_note` 字段
5. spawn pipeline 处理链接
6. 反馈消息给用户（现有逻辑）

### 类型 B: 笔记消息（非链接开头）

判断条件：不以 URL 开头的文本消息

处理流程：
1. 整段文本作为 `content` 创建 note 记录
2. 保存 `telegram_message_id` 和 `telegram_chat_id`
3. 检查转发：
   - `ctx.message.forward_origin` 存在 → 是转发消息
   - 如果 `forward_origin.type === 'channel'`，拼接 source_url：
     `https://t.me/c/${channel_id}/${message_id}` （私有频道）
     或 `https://t.me/${username}/${message_id}` （公开频道）
   - 如果 `forward_origin.type === 'user'` / `'hidden_user'`，source_url 为空（无法生成链接）
4. 提取文本中的所有 URL
5. 每个 URL → insertLink + spawnProcessLink（如果不存在）
6. 创建 note_links 关联
7. 对笔记本身进行分析（新的 note pipeline，见下方）
8. 反馈：`📝 已保存笔记，包含 N 个链接`

### 回复消息（对已有消息的回复）

判断条件：`ctx.message.reply_to_message` 存在

处理流程：
1. 获取被回复消息的 `message_id` 和 `chat_id`
2. 在 links 表和 notes 表中查找对应记录
3. 找到 → 将当前消息文本追加到 `user_note` / `user_notes` 字段
   - 格式：已有内容 + `\n---\n` + 新内容
4. 反馈：`✅ 已添加备注`
5. 如果回复的消息同时包含 URL，也按类型 A/B 正常处理

### 优先级

回复检测优先于类型判断。处理顺序：
1. 先检查是否是回复 → 处理备注追加
2. 再判断消息本身是类型 A 还是类型 B → 正常处理

这样可以处理「回复一条链接消息，同时发了新的链接」的情况——既追加备注，又处理新链接。

## 笔记 Pipeline（简化版）

笔记不需要 scrape，但需要分析：

```
Note Pipeline:
  1. summarize — 生成笔记摘要 + tags（用 LLM）
  2. embed — 对摘要生成 embedding（可选，未来做笔记间关联）
```

暂时可以更简单：只提取 tags，不生成摘要（笔记本身就是内容）。或者生成一句话摘要用于搜索。

## Bot 回复格式

### 链接消息回复（现有，增加备注显示）

```
🔗 收到链接，已加入处理队列...
📝 备注已记录
```

### 笔记消息回复

```
📝 已保存笔记
   ├ 包含 2 个链接，已加入处理队列
   └ 来源: https://t.me/channel/123  (如果是转发)
```

### 回复追加备注

```
✅ 已为链接 #42 添加备注
```
或
```
✅ 已为笔记 #7 添加备注
```

## Telegram Source URL 生成

转发消息的 `forward_origin` 类型：

| type | 可否生成 source_url | 格式 |
|------|---------------------|------|
| `channel` | ✅ | `https://t.me/{username}/{message_id}` (公开) 或 `https://t.me/c/{channel_id}/{message_id}` (私有) |
| `user` | ❌ | 个人消息无公开链接 |
| `hidden_user` | ❌ | 隐藏转发者 |
| `chat` | 可能 | 群组消息，类似 channel |

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `server/migrations/004_notes.sql` | 新建 notes + note_links 表，links 表加字段 |
| `server/src/db.ts` | 新增 NoteRecord 类型、notes CRUD、links 新字段、按 telegram_message_id 查询 |
| `server/src/bot.ts` | 重构消息处理：分类逻辑、回复检测、笔记创建、转发识别 |
| `server/src/agent.ts` | 新增 generateNoteSummary（可选） |
| `server/src/pipeline.ts` | 新增 note pipeline（可选，或直接在 bot 中处理） |
| `server/src/web.ts` | 新增笔记列表 / 详情页（可后续做） |

## 实施建议

分两步：

**Phase 1（核心）：**
- 消息分类 + 链接备注 + 回复追加备注
- links 表加 `telegram_message_id`, `telegram_chat_id`, `user_note`
- 重构 bot.ts 消息处理逻辑

**Phase 2（笔记）：**
- notes 表 + note_links 表
- 笔记创建 + 转发识别
- 笔记中链接的提取和处理
- 笔记 pipeline（摘要/tags）
- Web 端笔记展示
