---
created: 2026-03-06
tags:
  - feature
  - telegram-bot
  - rating
  - related-links
---

# Record Rating (👍/👎)

## Overview

为最终结果消息增加 👍 / 👎 inline button，用户可以对 record 进行评分。评分会影响"相关链接"搜索结果的权重排序。

## 1. Database Migration

新建 `server/src/db/migrations/2026-03-06T0030-record-rating.ts`：

```sql
ALTER TABLE records ADD COLUMN rating SMALLINT NOT NULL DEFAULT 0;
```

值域：`-1`（👎）、`0`（默认）、`1`（👍）

## 2. Bot: Final Result Buttons

在最终结果消息（link + note）的底部，加两个 inline button：

```
[👍] [👎]
```

- 与现有的 `🔍 查看详情` 文本链接共存（文本链接在消息正文，按钮在消息下方）
- callback_data 格式：`rate:<recordId>:1` / `rate:<recordId>:-1`

## 3. Bot: Callback Query Handler

注册 `bot.callbackQuery(/^rate:/)` handler：

1. 解析 `recordId` 和 `rating` 值
2. 验证 record 属于当前用户（通过 telegram_id 查 user）
3. 更新 `records.rating`：
   - 重复点同一个按钮 → 取消评分（设回 0）
   - 点击另一个按钮 → 切换评分
4. `answerCallbackQuery` 反馈（"👍 已点赞" / "👎 已点踩" / "已取消评分"）
5. 更新按钮样式：选中的按钮加 ✓ 标记（如 `👍✓`），通过 `editMessageReplyMarkup` 更新

## 4. Related Links 权重调整

修改 `server/src/search.ts` 的 `searchRelatedRecords()`：

- 查询结果额外 select `rating` 字段
- 后处理中，对 similarity score 加权：
  - `rating = 1` → `score × 1.2`（正向加权 20%）
  - `rating = -1` → `score × 0.6`（负向降权 40%）
  - `rating = 0` → 不变
- 重新排序后返回

## 5. 涉及文件

| 文件 | 改动 |
|------|------|
| `server/src/db/migrations/2026-03-06T0030-record-rating.ts` | **新建** migration |
| `server/src/bot.ts` | 加 callback handler + 结果消息加按钮 |
| `server/src/search.ts` | `searchRelatedRecords` 加权逻辑 |
| `server/src/db.ts` | 确认 `updateRecord` 支持 rating 字段 |

## Notes

- 加权系数（1.2 / 0.6）为初始值，后续可根据实际效果调整
- 按钮只出现在最终结果消息，中间状态消息保持现有的 `🔍 查看详情` 按钮不变
