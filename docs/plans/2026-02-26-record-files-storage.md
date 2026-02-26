# Record Files & Object Storage 方案

## 目标

1. 新建 `record_files` 表，关联文件到 record
2. 实现通用对象存储引擎（可切换 provider：Cloudflare R2、S3 等）
3. Telegram 图片消息 → 下载 → 存入对象存储 → 记录到 `record_files`
4. 替换现有本地文件存储（`data/images/`）为新的存储层
5. 在 record 详情页展示关联图片

## 一、数据库设计

### `record_files` 表

```sql
CREATE TABLE record_files (
  id SERIAL PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  -- 文件来源
  source TEXT NOT NULL,            -- 'telegram_photo' | 'twitter_media' | 'og_image' | 'scrape'
  source_ref TEXT,                 -- 来源标识，如 telegram file_id、twitter media URL
  -- 存储信息
  storage_provider TEXT NOT NULL,  -- 'r2' | 's3' | 'local'
  storage_key TEXT NOT NULL,       -- 对象存储中的 key (路径)，如 'records/42/0.jpg'
  -- 文件元数据
  mime_type TEXT,                  -- 'image/jpeg' | 'image/png' 等
  size_bytes INTEGER,              -- 文件大小
  width INTEGER,                   -- 图片宽度 (px)
  height INTEGER,                  -- 图片高度 (px)
  -- 扩展数据
  metadata JSONB DEFAULT '{}',     -- OCR 文本、缩略图 key 等可扩展字段
  -- 时间
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_record_files_record_id ON record_files (record_id);
CREATE INDEX idx_record_files_storage_key ON record_files (storage_key);
```

**设计要点：**
- `source` + `source_ref` 追踪文件来源，便于去重和溯源
- `storage_provider` + `storage_key` 解耦存储后端，支持混合存储
- `metadata` JSONB 扩展字段，存 OCR 文本、thumbnail key 等非通用数据
- 不在 `records` 表存图片信息，`records.images` 字段后续废弃

## 二、对象存储引擎

> **参考实现：** `vocalflow-rt/server/src/lib/storage/` — 已有完整的 StorageBackend 接口 + R2 实现，直接复用模式。

### 接口设计（沿用 vocalflow-rt 的 StorageBackend）

```typescript
// server/src/storage/types.ts
export interface StorageBackend {
  /** Upload a file, returns the storage key */
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** Download a file by key */
  get(key: string): Promise<Buffer>;
  /** Delete a file by key */
  delete(key: string): Promise<void>;
  /** Check if a file exists */
  exists(key: string): Promise<boolean>;
}
```

新增 `getUrl()` 方法（vocalflow-rt 没有，linkmind 需要生成公开访问 URL）：

```typescript
export interface StorageBackend {
  // ... 上述方法
  /** 生成公开访问 URL */
  getUrl(key: string): string;
}
```

### Provider 实现

```
server/src/storage/
├── types.ts          -- StorageBackend 接口（基于 vocalflow-rt，增加 getUrl）
├── index.ts          -- getStorage() 单例工厂（同 vocalflow-rt 模式）
├── r2.ts             -- Cloudflare R2（复用 vocalflow-rt 实现，增加 getUrl）
└── local.ts          -- 本地文件系统（开发用，vocalflow-rt 没有，需新写）
```

### R2 实现要点（基于 vocalflow-rt）

- 直接复用 `@aws-sdk/client-s3` 的 `PutObjectCommand` / `GetObjectCommand` / `DeleteObjectCommand` / `HeadObjectCommand`
- 环境变量沿用 vocalflow-rt 命名：`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
- 新增 `R2_PUBLIC_URL` 用于 `getUrl()` 生成公开链接
- 新增 `LocalStorage` 类用于开发环境

### 配置

```env
# .env（开发）
STORAGE_BACKEND=local
STORAGE_LOCAL_DIR=./data/files

# .env.prod（生产）
STORAGE_BACKEND=r2
R2_ACCOUNT_ID=xxx
R2_ACCESS_KEY_ID=xxx
R2_SECRET_ACCESS_KEY=xxx
R2_BUCKET_NAME=linkmind
R2_PUBLIC_URL=https://files.linkmind.reorx.com
```

### Key 命名规范

```
records/{record_id}/{index}_{source}.{ext}
```

示例：
- `records/42/0_telegram.jpg` — Telegram 图片
- `records/42/1_twitter.jpg` — Twitter 媒体
- `records/42/0_twitter_thumb.jpg` — 缩略图

## 三、Telegram 图片处理流程

### 3.1 Photo 消息处理

当收到 `message:photo` 时：

```
1. 提取 caption → 走现有文本处理逻辑（链接/笔记/转发）
2. 获取 photo 数组 → 取最大尺寸的 file_id
3. 通过 Telegram Bot API 下载图片
4. 上传到对象存储 → 获得 storage_key
5. 创建 record_files 记录（source='telegram_photo', source_ref=file_id）
6. 关联到对应 record
```

### 3.2 时序问题

Photo handler 中创建 record 和下载图片可能有时序问题：
- record 在 `handleLinkMessage` / `handleNoteMessage` / `handleForwardedChannelMessage` 中创建
- 图片需要 record_id 才能写 `record_files`

**方案：** 在上述 handler 中增加可选的 `photoFileId?: string` 参数。handler 创建 record 后，如果有 photoFileId，异步调用图片下载+存储流程。

## 四、迁移：替换现有本地存储

### 需要改动的地方

| 文件 | 当前行为 | 改为 |
|---|---|---|
| `image-handler.ts` | 下载到 `data/images/{id}/` | 上传到 StorageEngine，写 `record_files` |
| `pipeline.ts` | 调用 `processTwitterImages` 写本地 | 调用新的存储层 |
| `bot.ts` | 从本地读 `images[0].local_path` 发图 | 从 `record_files` 获取 URL 或下载发图 |
| `web.ts` | `express.static('/images', ...)` | 从 `record_files` 获取 URL |
| `routes/pages.ts` | `safeParseJson(record.images)` | 查询 `record_files` 表 |
| `cli/backfill-images.ts` | 写本地文件 | 使用新存储层 |
| `records.images` 字段 | JSON 存图片元数据 | 废弃，后续 migration 删除 |

### 迁移步骤

1. 实现 StorageEngine + R2 provider + local provider
2. 创建 `record_files` 表 (Kysely migration)
3. 改造 `image-handler.ts` → 使用 StorageEngine
4. 改造 `pipeline.ts` 中 Twitter 图片处理
5. 改造 `bot.ts` photo handler → 下载 Telegram 图片并存储
6. 改造 `bot.ts` 结果回复 → 从 `record_files` 获取图片
7. 改造 web 路由 → 从 `record_files` 获取图片 URL
8. 编写数据迁移脚本：将 `records.images` JSON 数据迁移到 `record_files` + 上传本地文件到对象存储
9. 验证完成后，后续 migration 删除 `records.images` 字段

## 五、Web 展示

Record 详情页新增图片展示区：

```typescript
// 查询 record 关联的文件
const files = await db
  .selectFrom('record_files')
  .where('record_id', '=', recordId)
  .where('mime_type', 'like', 'image/%')
  .orderBy('created_at', 'asc')
  .selectAll()
  .execute();

// 生成访问 URL
const imageUrls = files.map(f => storage.getUrl(f.storage_key));
```

详情页模板中渲染图片列表（支持点击放大）。

## 六、推荐的 Provider：Cloudflare R2

- **免费额度**：10GB 存储 + 1000万次 Class A 操作/月 + 1000万次 Class B 操作/月
- **S3 兼容 API**：用 `@aws-sdk/client-s3` 即可
- **无出站流量费用**
- **可绑定自定义域名**用于公开访问

## 七、实施顺序

1. **Phase 1 — 基础设施**：StorageEngine 接口 + local provider + R2 provider + `record_files` 表
2. **Phase 2 — Telegram 图片**：photo handler 下载图片 → 存储 → 关联 record
3. **Phase 3 — 替换 Twitter 图片**：改造 image-handler + pipeline
4. **Phase 4 — Web 展示**：详情页展示 record_files 中的图片
5. **Phase 5 — 数据迁移**：旧 `records.images` 数据迁移到 `record_files`
6. **Phase 6 — 清理**：删除 `records.images` 字段、移除本地存储代码、清理 `data/images/`
