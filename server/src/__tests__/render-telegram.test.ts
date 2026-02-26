import { describe, it, expect } from 'vitest';

// We need to extract the functions from bot.ts for testing.
// For now, let's copy the logic and test it, then we'll refactor to export.

// Import from a shared module (we'll create this)
import { renderMarkdownTelegram, renderTagsTelegram } from '../telegram-render.js';

const RECORD_86_SUMMARY = `- **核心功能与定位**：Librarium 是一个多供应商深度研究命令行工具 (CLI)，能够并行地将查询分发到多个搜索和 AI API。它旨在收集、规范化并去重 (deduplication) 来自不同来源的研究结果，生成结构化输出。
  - **供应商分层体系 (Provider Tiers)**：系统将 13 个供应商适配器分为三个层级，以平衡研究深度与响应速度：
    - **深度研究 (deep-research)**：如 OpenAI Deep Research，生成详尽报告，耗时较长。
    - **AI 增强搜索 (ai-grounded)**：如 Perplexity Sonar，数秒内返回带引用的合成结果。
    - **原始搜索 (raw-search)**：如 Brave Web Search，提供传统搜索链接和片段。
  - **灵活的执行模式 (Execution Modes)**：支持三种模式以适应不同场景：
    - **混合模式 (mixed)**：默认模式，同步运行快速搜索并异步提交深度研究任务。
    - **同步模式 (sync)**：等待所有供应商（包括深度研究）完成任务。
    - **异步模式 (async)**：提交任务后立即返回，后续通过状态命令 (status) 获取结果。
  - **便捷的工具链与配置**：提供完善的 CLI 命令简化管理流程：
    - **自动初始化 (init --auto)**：自动从环境变量中识别并配置 API 密钥。
    - **分组管理 (Groups)**：内置 \`quick\`、\`deep\` 和 \`comprehensive\` 等预设组，支持自定义分组。
    - **维护工具**：包含健康检查 (doctor)、自动升级 (upgrade) 和清理 (cleanup) 功能。`;

describe('renderMarkdownTelegram', () => {
  it('should handle 3-level nested lists with alternating symbols', () => {
    const result = renderMarkdownTelegram(RECORD_86_SUMMARY);

    // Level 0: bullet •
    expect(result).toContain('• <b>核心功能与定位</b>');

    // Level 1: arrow ‣
    expect(result).toContain('\u2003‣ <b>供应商分层体系 (Provider Tiers)</b>');
    expect(result).toContain('\u2003‣ <b>灵活的执行模式 (Execution Modes)</b>');
    expect(result).toContain('\u2003‣ <b>便捷的工具链与配置</b>');

    // Level 2: bullet • again (alternating)
    expect(result).toContain('\u2003\u2003• <b>深度研究 (deep-research)</b>');
    expect(result).toContain('\u2003\u2003• <b>AI 增强搜索 (ai-grounded)</b>');
    expect(result).toContain('\u2003\u2003• <b>混合模式 (mixed)</b>');
    expect(result).toContain('\u2003\u2003• <b>自动初始化 (init --auto)</b>');

    // Should NOT have any raw markdown list markers
    expect(result).not.toMatch(/^\s*-\s/m);
  });

  it('should handle inline code in markdown', () => {
    const md = '- Use `quick` for fast results';
    const result = renderMarkdownTelegram(md);
    expect(result).toContain('<code>quick</code>');
  });

  it('should handle links in markdown', () => {
    const md = '- Check [this link](https://example.com) for details';
    const result = renderMarkdownTelegram(md);
    expect(result).toContain('<a href="https://example.com">this link</a>');
  });

  it('should handle bold text', () => {
    const md = '- **Important**: this matters';
    const result = renderMarkdownTelegram(md);
    expect(result).toContain('<b>Important</b>');
  });
});

describe('renderTagsTelegram', () => {
  it('should wrap tags in inline code', () => {
    const result = renderTagsTelegram(['cli', 'deep-research', 'ai-search']);
    expect(result).toBe('<code>cli</code> <code>deep-research</code> <code>ai-search</code>\n\n');
  });

  it('should return empty string for empty tags', () => {
    expect(renderTagsTelegram([])).toBe('');
  });
});
