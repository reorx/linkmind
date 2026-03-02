# 导出/导入链接 + Settings 页面方案

## 概览

新增 Settings 页面，提供链接的 CSV 导出和导入功能。

## CSV 格式

```csv
url,title,created_at
https://example.com,Example Title,2026-02-01T12:00:00.000Z
https://foo.bar,Foo Bar,2026-01-15T08:30:00.000Z
```

字段说明：
- `url`（必须）— 链接地址
- `title`（可选）— `og_title`，仅导出时填充，导入时忽略
- `created_at`（必须）— ISO 8601 格式，导入时用于设置 link 的 `created_at`

导出时按 `created_at desc` 排序，包含所有状态的链接。

## 后端 API

### `GET /api/settings/export`

- 需要 auth
- 查询该用户所有 links，生成 CSV 返回
- Response: `Content-Type: text/csv`, `Content-Disposition: attachment; filename=linkmind-export-YYYY-MM-DD.csv`

### `POST /api/settings/import`

- 需要 auth
- 接收 CSV 文件（`multipart/form-data`，field name: `file`）
- 解析 CSV，逐行处理：
  - 跳过已存在的 URL（`getLinkByUrl`）
  - 新 URL → `insertLink`（带 `created_at`）→ `spawnProcessLink`
- Response: `{ imported: number, skipped: number, errors: string[] }`

## 前端 Settings 页面

### 路由
- `GET /settings` — 渲染 settings 页面

### 页面内容
- **导出**：一个按钮「Export All Links (CSV)」，点击触发 `GET /api/settings/export` 下载
- **导入**：文件选择 + 上传按钮「Import Links from CSV」，上传后显示结果（imported/skipped/errors）

### 导航
- 在 home 页面（或 layout）加一个 Settings 链接入口

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `server/src/db.ts` | 新增 `getAllUserLinks(userId)`, `insertLinkWithCreatedAt()` |
| `server/src/web.ts` | 新增 `GET /settings`, `GET /api/settings/export`, `POST /api/settings/import` |
| `server/src/views/settings.ejs` | 新建 settings 页面模板 |
| `server/src/views/layout.ejs` | 导航栏加 Settings 链接 |
| `server/package.json` | 可能需要加 `csv-parse`（CSV 解析库）或手写简单 parser |

## 依赖

CSV 解析：用 `csv-parse`（`csv` npm 包的子模块），成熟稳定。或者因为格式简单，手写 parser 也可以。

CSV 生成：手写即可，三个字段很简单。
