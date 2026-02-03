# LinkMind — Project Summary

## What Is This

LinkMind 是一个基于 Telegram Bot 的智能链接收藏和分析工具。用户把链接发给 Bot，自动抓取网页内容、生成中文摘要、通过 QMD 在笔记库中搜索相关内容，生成 insight。附带 Web 界面浏览。

## Tech Stack

- **Runtime**: Node.js >= 22, TypeScript (tsx)
- **Package Manager**: pnpm
- **Bot**: Telegram Bot API
- **Web Scraping**: Playwright + Defuddle
- **Search**: QMD (本地语义搜索引擎)
- **LLM**: OpenAI 兼容 API / Google Gemini
- **Database**: PostgreSQL
- **Web**: 内置 Web Server (时间线 + 详情页)
- **Twitter**: bird CLI (可选)

## Architecture

```
Telegram Bot → Pipeline (scrape → analyze → export) → Web Server
                  ├── Playwright + Defuddle (抓取)
                  ├── LLM 摘要 + insight (分析)
                  ├── QMD 语义搜索 (关联发现)
                  └── Markdown 导出 + QMD 索引更新
```

## Deployment — launchd

LinkMind 通过 macOS launchd 作为 user agent 运行，开机自启 + 崩溃重启。

### plist 文件

**路径**: `~/Library/LaunchAgents/com.linkmind.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.linkmind</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-lc</string>
        <string>cd /Users/reorx/Code/linkmind &amp;&amp; exec npx tsx src/index.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/reorx/Code/linkmind</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/reorx/Code/linkmind/data/launchd-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/reorx/Code/linkmind/data/launchd-stderr.log</string>
</dict>
</plist>
```

### 关键配置说明

- **启动命令**: `bash -lc` 确保加载 login shell 环境（PATH 等）
- **RunAtLoad=true**: 用户登录时自动启动
- **KeepAlive=true**: 进程退出后自动重启
- **PATH**: 包含 `/opt/homebrew/bin` 确保找到 node/npx
- **日志**: stdout/stderr 分别写入 `data/launchd-stdout.log` 和 `data/launchd-stderr.log`

### 管理命令

```bash
# 加载（首次或修改 plist 后）
launchctl load ~/Library/LaunchAgents/com.linkmind.plist

# 卸载
launchctl unload ~/Library/LaunchAgents/com.linkmind.plist

# 启动 / 停止
launchctl start com.linkmind
launchctl stop com.linkmind

# 查看状态
launchctl list | grep linkmind

# 查看日志
tail -f ~/Code/linkmind/data/launchd-stdout.log
tail -f ~/Code/linkmind/data/launchd-stderr.log
```

## 管理脚本

```bash
# 创建邀请码（默认 1 次使用）
cd ~/Code/linkmind && npx tsx scripts/create_invite.ts

# 创建邀请码（指定最大使用次数）
cd ~/Code/linkmind && npx tsx scripts/create_invite.ts --max-uses 10

# 列出所有邀请码
cd ~/Code/linkmind && npx tsx scripts/list_invites.ts
```

⚠️ 不要直接操作数据库，用这些脚本。

### 注意事项

- 修改 plist 后需要先 `unload` 再 `load` 才能生效
- `KeepAlive=true` 意味着 `launchctl stop` 后会自动重启，要彻底停止需 `unload`
- 环境变量在 plist 中单独配置，不会继承 shell 的 `.zshrc` 等（`bash -lc` 会加载 `.bash_profile`）
