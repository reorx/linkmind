# 邀请码注册系统

## 概述

用户必须通过邀请码注册才能使用 LinkMind。邀请码通过 CLI 脚本生成，只有管理员可以操作。

## 数据库

### invites 表

```sql
CREATE TABLE invites (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### users 表改动

```sql
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE users ADD COLUMN invite_id INTEGER REFERENCES invites(id);
```

- `status`: `pending`（未注册）/ `active`（已注册）
- `invite_id`: 使用的邀请码

## 注册流程

```
管理员运行脚本生成邀请码
    ↓
得到 deep link: https://t.me/<bot_username>?start=invite_<code>
    ↓
管理员把链接发给目标用户
    ↓
用户点击链接，Telegram 打开 Bot 并发送 /start invite_<code>
    ↓
Bot 验证邀请码:
  - 邀请码存在？
  - used_count < max_uses？
    ↓
验证通过:
  → 创建用户 status=active, invite_id=invites.id
  → invites.used_count += 1
  → 返回欢迎消息
    ↓
验证失败:
  → 返回"邀请码无效或已用完"
```

## Bot 行为变化

| 场景 | 行为 |
|------|------|
| `/start invite_<code>` | 验证邀请码，注册用户 |
| `/start`（无参数）| 未注册用户：提示需要邀请链接；已注册：显示欢迎 |
| `/login` | 仅 active 用户可用 |
| 发送链接 | 仅 active 用户可用，否则提示"请先注册" |

## CLI 脚本

### 生成邀请码

```bash
npx tsx scripts/create_invite.ts [--max-uses N]
```

- 默认 max_uses=1（单人使用）
- 输出邀请码和 deep link
- 示例输出：
  ```
  邀请码: abc123def
  链接: https://t.me/linkmind_bot?start=invite_abc123def
  最大使用次数: 1
  ```

### 查看邀请码列表

```bash
npx tsx scripts/list_invites.ts
```

- 列出所有邀请码及其使用情况

## 现有用户迁移

迁移脚本将第一个用户（Xiao）的 status 设为 active。
