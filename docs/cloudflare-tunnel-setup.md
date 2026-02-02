# Cloudflare Tunnel 部署方案

通过 Cloudflare Tunnel 将 LinkMind 服务（localhost:3456）暴露到外网。

## 前提

- Cloudflare 账号
- 域名已托管在 Cloudflare（如 `linkmind.dev`）
- macOS + Homebrew

## 步骤

### 1. 安装 cloudflared

```bash
brew install cloudflared
```

### 2. 登录 Cloudflare

```bash
cloudflared tunnel login
```

会弹浏览器授权，选择 `linkmind.dev` 所在的域名。授权后凭证保存在 `~/.cloudflared/cert.pem`。

### 3. 创建 Tunnel

```bash
cloudflared tunnel create linkmind
```

输出会显示 Tunnel ID（一串 UUID），同时生成凭证文件 `~/.cloudflared/<TUNNEL_ID>.json`。

### 4. 配置 DNS

```bash
cloudflared tunnel route dns linkmind linkmind.dev
```

自动在 Cloudflare DNS 创建 CNAME 记录指向 tunnel。

### 5. 写配置文件

创建 `~/.cloudflared/config.yml`：

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /Users/reorx/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: linkmind.dev
    service: http://localhost:3456
  - service: http_status:404
```

> 把 `<TUNNEL_ID>` 替换为第 3 步拿到的实际 UUID。

### 6. 测试运行

```bash
cloudflared tunnel run linkmind
```

确认 `https://linkmind.dev` 可以访问。`Ctrl+C` 停止。

### 7. 用 launchd 常驻

创建 `~/Library/LaunchAgents/com.cloudflared.linkmind.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflared.linkmind</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/cloudflared</string>
        <string>tunnel</string>
        <string>run</string>
        <string>linkmind</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/reorx/Code/linkmind/data/cloudflared-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/reorx/Code/linkmind/data/cloudflared-stderr.log</string>
</dict>
</plist>
```

加载服务：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cloudflared.linkmind.plist
```

管理命令：

```bash
# 查看状态
launchctl print gui/$(id -u)/com.cloudflared.linkmind

# 停止
launchctl bootout gui/$(id -u)/com.cloudflared.linkmind

# 重新启动
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cloudflared.linkmind.plist
```

## 备注

- Cloudflare Tunnel 免费，不需要付费计划
- 流量走 Cloudflare CDN，自动 HTTPS
- 如果需要限制访问，可以在 Cloudflare One Dashboard 配置 Access 策略（IP 白名单、邮箱验证等）
- 也可以通过 [Cloudflare One Dashboard](https://one.dash.cloudflare.com) → Networks → Connectors → Create Tunnel 用 Web UI 创建，会给一条安装命令直接跑
