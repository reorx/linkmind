# Twitter 图片处理功能设计

## 动机

当前 Twitter 链接只保存第一张图片的 URL 作为 og_image，不保存图片本身。增强功能：

1. **下载保存所有图片** — 本地持久化，不依赖 Twitter CDN
2. **OCR 提取图片文字** — 使用 macOS 内置 OCR 识别图片内文字
3. **摘要增强** — 将 OCR 文字纳入 LLM 分析上下文
4. **展示优化** — 首页缩略图 + 详情页完整图片列表

## 数据模型变更

### 新增 images 字段

在 `LinkRecord` 中新增字段：

```typescript
interface LinkRecord {
  // ... existing fields
  images?: string;  // JSON: ImageInfo[]
}

interface ImageInfo {
  original_url: string;   // 原始 Twitter CDN URL
  local_path: string;     // 本地相对路径: data/images/{link_id}/{index}.jpg
  thumbnail_path: string; // 缩略图路径: data/images/{link_id}/{index}_thumb.jpg
  ocr_text?: string;      // OCR 识别的文字
  width?: number;
  height?: number;
}
```

### 数据库 Migration

```sql
ALTER TABLE links ADD COLUMN images TEXT;
```

## 文件存储结构

```
data/
└── images/
    └── {link_id}/
        ├── 0.jpg
        ├── 0_thumb.jpg
        ├── 1.jpg
        ├── 1_thumb.jpg
        └── ...
```

- 原图: 保持原始分辨率
- 缩略图: 300px 宽度，JPEG 质量 80

## 实现模块

### 1. image-handler.ts（新增）

```typescript
/**
 * 下载并处理 Twitter 图片
 */
export interface ImageResult {
  original_url: string;
  local_path: string;
  thumbnail_path: string;
  ocr_text?: string;
  width: number;
  height: number;
}

/**
 * 处理 Twitter 媒体列表
 */
export async function processTwitterImages(
  linkId: number,
  media: Array<{ type: string; url: string }>
): Promise<ImageResult[]>

/**
 * 下载单张图片
 */
async function downloadImage(url: string, destPath: string): Promise<void>

/**
 * 生成缩略图 (使用 sips 命令)
 */
async function createThumbnail(
  srcPath: string, 
  destPath: string, 
  maxWidth: number = 300
): Promise<void>

/**
 * macOS OCR (使用 shortcuts 或 Vision API via swift)
 */
async function extractText(imagePath: string): Promise<string>
```

### 2. macOS OCR 实现方案

**方案 A: Shortcuts + CLI**

创建一个 Shortcut "OCR Image"，接收文件路径，输出识别文字：
```bash
shortcuts run "OCR Image" -i /path/to/image.jpg
```

**方案 B: Swift 脚本调用 Vision API**

```swift
// scripts/ocr.swift
import Vision
import AppKit

let imagePath = CommandLine.arguments[1]
// ... Vision framework OCR
print(recognizedText)
```

编译后使用：
```bash
./scripts/ocr /path/to/image.jpg
```

**推荐方案 B** — 更稳定，不依赖 Shortcuts app。

### 3. scraper.ts 修改

```typescript
async function scrapeTwitter(url: string): Promise<ScrapeResult> {
  // ... existing code
  
  // 返回 media 信息供 pipeline 处理
  return {
    // ... existing fields
    rawMedia: tweet.media,  // 传递原始 media 数据
  };
}
```

### 4. pipeline.ts 修改

```typescript
async function processScrapeResult(link: LinkRecord, result: ScrapeResult) {
  // ... existing code
  
  // 处理 Twitter 图片
  if (result.rawMedia?.length && isTwitterUrl(link.url)) {
    const images = await processTwitterImages(link.id, result.rawMedia);
    
    // 保存图片信息
    await db.updateLink(link.id, {
      images: JSON.stringify(images),
    });
    
    // 收集 OCR 文字用于分析
    const ocrTexts = images
      .filter(img => img.ocr_text)
      .map(img => img.ocr_text);
    
    // 附加到 markdown 供 LLM 分析
    if (ocrTexts.length) {
      result.markdown += '\n\n---\n**图片文字 (OCR):**\n' + ocrTexts.join('\n\n');
    }
  }
}
```

### 5. Web 展示修改

**首页 (views/index.ejs)**

```html
<!-- 使用第一张缩略图 -->
<% if (link.images?.[0]?.thumbnail_path) { %>
  <img src="/images/<%= link.id %>/<%= link.images[0].thumbnail_path %>" 
       class="thumbnail" loading="lazy">
<% } else if (link.og_image) { %>
  <img src="<%= link.og_image %>" class="thumbnail" loading="lazy">
<% } %>
```

**详情页 (views/detail.ejs)**

```html
<% if (link.images?.length) { %>
  <div class="image-gallery">
    <% for (const img of link.images) { %>
      <figure>
        <a href="/images/<%= link.id %>/<%= img.local_path %>" target="_blank">
          <img src="/images/<%= link.id %>/<%= img.local_path %>" loading="lazy">
        </a>
        <% if (img.ocr_text) { %>
          <figcaption class="ocr-text"><%= img.ocr_text %></figcaption>
        <% } %>
      </figure>
    <% } %>
  </div>
<% } %>
```

**web.ts — 静态文件路由**

```typescript
app.use('/images', express.static(path.join(__dirname, '../data/images')));
```

## 实施步骤

### Phase 1: 基础架构

1. 创建 `scripts/ocr.swift` 并编译
2. 创建 `src/image-handler.ts`
3. 添加数据库 migration (images 字段)

### Phase 2: Pipeline 集成

1. 修改 `scraper.ts` 传递 rawMedia
2. 修改 `pipeline.ts` 调用 image-handler
3. 测试图片下载 + OCR

### Phase 3: Web 展示

1. 添加静态文件路由
2. 修改首页缩略图显示
3. 修改详情页图片画廊

### Phase 4: 回填现有数据

1. 创建 `scripts/backfill-images.ts`
2. 遍历已有 Twitter 链接，下载图片并 OCR

## 依赖

- **sips**: macOS 内置，用于生成缩略图
- **Swift/Vision**: macOS 内置 OCR
- **fetch/node**: 下载图片

无需额外安装依赖。

## 注意事项

1. **磁盘空间** — 需要监控 data/images 大小
2. **Twitter CDN** — 原始 URL 可能失效，本地保存是必要的
3. **OCR 性能** — Vision API 对中英文混合效果好，但可能较慢
4. **错误处理** — 图片下载/OCR 失败不应阻塞整个 pipeline
