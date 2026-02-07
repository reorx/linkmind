# 多租户 + Auth 设计方案

## 概述

基于 Telegram Bot 的多用户系统，每个用户的数据隔离，网页端通过 Bot 的 /login 命令认证。

## 数据库

### users 表

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL UNIQUE,
    username TEXT,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### links 表改动

```sql
ALTER TABLE links ADD COLUMN user_id INTEGER NOT NULL REFERENCES users(id);
CREATE INDEX idx_links_user_id ON links (user_id);
```

所有 links 查询都按 user_id 过滤，保证数据隔离。

## 认证流程

```
用户在 Bot 发 /login
    ↓
Bot 生成 JWT (payload: {userId, telegramId}, 有效期 5 分钟)
    ↓
Bot 返回 inline button: https://linkmind.dev/auth/callback?token=<jwt>
    ↓
用户点击链接
    ↓
GET /auth/callback?token=<jwt>
  → 验证 JWT
  → 签发 session cookie (httpOnly, 7 天有效, payload: {userId})
  → 重定向到首页
    ↓
后续请求通过 cookie 中的 session token 认证
```

### 页面路由

| 路由 | 认证 | 说明 |
|------|------|------|
| `/login` | 公开 | 登录提示页，引导去 Bot |
| `/auth/callback` | 公开 | 处理 JWT 登录回调 |
| `/logout` | 公开 | 清除 cookie |
| `/` | 需认证 | 首页，只显示当前用户的 links |
| `/link/:id` | 需认证 | 详情页，检查数据归属 |
| `/note` | 需认证 | 笔记页 |
| `/api/*` | 需认证 | 所有 API，返回 401 JSON |

### 安全要点

- Login JWT 有效期 5 分钟，一次性使用
- Session cookie: httpOnly, sameSite=lax, 生产环境 secure
- 所有数据接口检查 `link.user_id === req.userId`
- JWT_SECRET 通过环境变量配置

## Bot 改动

- **自动注册**：收到消息时根据 `ctx.from.id` 查找或创建用户，同时更新 username/display_name
- **数据隔离**：processUrl 传入 userId，链接关联到发送者
- **`/login` 命令**：生成带 JWT 的登录链接

## 依赖

- `jsonwebtoken` — JWT 签发和验证
- `cookie-parser` — Express cookie 解析
- 环境变量 `JWT_SECRET`

## 迁移

运行迁移脚本（已完成）：

```bash
npx tsx scripts/migrate_add_users.ts
```

脚本做的事：
1. 创建 users 表
2. 插入第一个用户（Telegram ID: 69627313）
3. 给 links 表加 user_id 列
4. 把所有现有 links 关联到第一个用户
5. 设置 user_id NOT NULL 约束
