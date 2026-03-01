# Mobile Tap + Fetch "Load Failed" Bug

**Date:** 2026-03-01
**Commits:** `8978725`, `331fe3b`, `493a26a`
**Affected:** Rerun button on link-detail page, mobile Safari & Chrome

## 症状

- 手机浏览器（Safari iOS + Chrome）点击 Rerun 按钮
- 第一次点击：显示 "Starting..." 后立刻报 "Error: load failed"
- 第二次点击：正常工作，显示 "Queued"
- Desktop Chromium 无法复现

## 排查过程

1. **最初假设 Safari POST 无 body bug** — Safari 对 `fetch(url, { method: 'POST' })` 无 body 时有已知问题。加了 `body: '{}'` + `Content-Type: application/json`。❌ 未解决
2. **假设 cookie 未发送（401）** — 检查了 `requireAuth` middleware，确认 `SameSite=Lax` + `Secure` 对同源 POST 应该带 cookie。加了 HTTP status 检查。❌ 未解决
3. **假设 Telegram in-app browser cookie 隔离** — 用户确认在 Safari 和 Chrome 中都复现，排除 in-app browser 问题。❌ 排除
4. **加了 auto-retry 机制** — TypeError 时自动重试最多 3 次。✅ 可能有效但未确认
5. **用户提出 tap vs click 问题** — 移动端 touch 事件链：`touchstart → touchend → (300ms delay) → click`。第一次 tap 可能被浏览器用于 hover 状态处理或因 layout shift（地址栏动画）导致 fetch abort。

## 根因

移动端 `onclick` 属性绑定依赖 `click` 事件，而 `click` 在移动端会被延迟（等待 double-tap 判定）或被 touch 事件链中的某个环节干扰，导致 fetch 请求在发出后被浏览器 abort，表现为 `TypeError: Load failed`。

## 修复方案

```html
<button id="rerunBtn" style="touch-action:manipulation">Rerun</button>
```

```javascript
(function() {
  const btn = document.getElementById('rerunBtn');
  if (!btn) return;
  let handled = false;
  btn.addEventListener('touchend', function(e) {
    e.preventDefault();       // 阻止后续 ghost click
    if (handled) return;
    handled = true;
    rerunRecord();
    setTimeout(() => { handled = false; }, 1000);
  });
  btn.addEventListener('click', function(e) {
    if (handled) { e.preventDefault(); return; }  // touchend 已处理
    handled = true;
    rerunRecord();
    setTimeout(() => { handled = false; }, 1000);
  });
})();
```

关键点：
1. **`touch-action: manipulation`** — 告诉浏览器不需要等待 double-tap zoom，消除 300ms 点击延迟
2. **`touchend` 优先** — 移动端直接在 touchend 触发，不等 click
3. **`e.preventDefault()` on touchend** — 阻止浏览器产生后续的 ghost click 事件
4. **dedup guard** — 防止 touchend + click 双重触发
5. **保留 click listener** — Desktop 没有 touch 事件，需要 click 作为 fallback
6. **保留 auto-retry** — TypeError 时自动重试，作为 safety net

## 教训

- 移动端不要用 `onclick` 属性做重要交互，用 `addEventListener` 分别处理 touch 和 click
- `fetch` 在移动端的 "Load failed" 错误很难在 Desktop 复现
- "第一次失败第二次成功" 是 mobile touch/click 事件冲突的典型表现
