# Scrape Tools 调研

linkmind 项目相关的抓取工具整理。

## Scraper / Crawler API

托管服务，提供 API 直接获取网页内容。

- **[ScrapeNinja](https://scrapeninja.net/)** — Web scraping API，处理反爬和 JS 渲染
- **[Firecrawl](https://www.firecrawl.dev/)** — 将网页转为 LLM-ready markdown，linkmind 已在用作 fallback
- **[Tavily](https://tavily.com/)** — AI 优化的搜索和抓取 API，专为 agent 设计
- **[Jina Reader](https://r.jina.ai/)** — `r.jina.ai/<url>` 直接返回 markdown，简单好用
- **[pure.md](https://pure.md/)** — 类似 Jina Reader，URL 前缀式调用返回干净 markdown
- **[MediumAPI](https://mediumapi.com/)** — Medium 文章专用 API，获取文章内容和元数据
- **[Crawl4AI](https://github.com/unclecode/crawl4ai)** — 开源，可自部署的 AI 友好爬虫，支持 LLM 提取

## Headless Browser API

云端浏览器实例，适合需要完整浏览器环境的场景（JS 渲染、登录态、反爬）。

- **[Steel](https://steel.dev/)** — 云端浏览器 API，专为 AI agent 设计，提供 session 管理
- **[Stagehand](https://github.com/browserbase/stagehand)** — Browserbase 出品，AI 驱动的浏览器自动化框架
- **[Kernel](https://www.kernel.sh/)** — 云端浏览器，支持 stealth 模式和 session 持久化
- **[Hyperbrowser](https://www.hyperbrowser.ai/)** — AI agent 专用的云端浏览器平台


## 库

本地运行的爬虫/自动化库。

- **[Crawlee](https://github.com/apify/crawlee)** — Apify 出品的 Node.js 爬虫框架，支持 Playwright/Puppeteer/Cheerio 多种后端
  - [Crawler Plugins 示例](https://crawlee.dev/js/docs/examples/crawler-plugins)
- **[Scrapling](https://github.com/D4Vinci/Scrapling)** — Python 爬虫库，自动适应网站变化，智能选择器
  - https://scrapling.readthedocs.io/en/latest/ai/mcp-server.html?h=stea#stealth-scraping
  - https://github.com/shirenchuang/web-content-fetcher/blob/main/scripts/fetch.py
- **[undetected-chromedriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver)** — 绕过 Cloudflare 等反爬检测的 Chrome driver，Python

## X / Twitter
- https://github.com/rohunvora/x-research-skill
- https://github.com/reorx/bird

---

## Gemini research

这篇报告详细评估了当前市场上用于将网页内容转换为大语言模型（LLM）友好格式（如 Markdown 和 JSON）的 API 工具，特别是作为 Firecrawl 替代品的各类解决方案。以下是报告的核心内容总结：

**1. 行业背景与 Firecrawl 的局限性**
在 RAG（检索增强生成）和 AI 代理架构中，直接向模型输入原始 HTML 会导致 Token 严重浪费、触发上下文限制并引发模型幻觉。因此，将网页清洗为结构化的 Markdown 或 JSON 已成为必要的前置流程。Firecrawl 是该领域的基准工具，但它存在两个主要局限：一是采用“按页计费”模式，在处理大量短内容网页时不够经济；二是其开源版本受限于严格的 AGPL-3.0 协议，为企业的内部私有化部署带来了合规壁垒。

**2. 核心替代方案分类**
报告根据不同的架构和业务需求，将 Firecrawl 的替代方案划分为以下几大阵营：

* **Token 优化与多模态解析（Jina AI Reader）**：
打破了按页计费的传统，采用**按输出 Token 计费**的模式，在处理短网页或高频搜索时成本大幅降低。它内置了视觉语言模型（VLM），能自动为网页图片生成文本描述（Alt tag），让 LLM 能“看懂”视觉上下文。此外，其开源组件采用友好的 Apache-2.0 协议。
* **高性能异步开源框架（Crawl4AI）**：
深受开发者欢迎的 Python 开源库，提供极速的异步抓取能力，允许完全控制本地环境以绕过反爬机制并保护数据隐私。它的云服务提供极低成本的微学分（Micro-Credit）计费，并具备 `fit_markdown` 功能，可强力压缩无关内容，进一步减少传递给 LLM 的 Token 负载。
* **AI 代理与提示词驱动（JigsawStack & ScrapeGraphAI）**：
这类工具抛弃了传统且脆弱的 CSS 选择器，允许开发者直接用自然语言（如“提取套餐价格和标题”）下达指令。依靠内置的 LLM 引擎，即便目标网站的 UI 发生大幅重构，它们也能智能自适应并稳定返回结构化的 JSON 数据，极大降低了爬虫维护成本。
* **算力计费与极致横向扩展（Apify）**：
专为企业级超大规模爬取设计。Apify 采用无服务器（Serverless）架构，按照实际消耗的计算单元（运行时间与内存）进行计费。它拥有庞大的代理网络、成熟的生态系统（Actors）以及无缝的云端数据导出能力，适合每月处理数十万至数百万页面的重量级任务。
* **搜索与提取一体化（Tavily & Exa）**：
专门为需要自主调研的 AI 代理（Agents）设计。Tavily 专注于极低延迟的实时搜索与提取，并内置了语义重排功能，确保只将最相关的信息片段喂给大模型；Exa 则利用基于嵌入向量的神经搜索来理解语义，并提供成本极低的网页全文提取接口。
* **高吞吐量传统爬虫（WebCrawlerAPI, Spider 等）**：
专注于提供强大的反爬虫绕过能力和高并发吞吐量。它们通常采用按使用量付费（如按万次成功请求计费）的模式，经济模型非常直观，适合那些不需要 AI 介入解析，只追求大规模获取纯净 Markdown 数据的企业管道。

**3. 最终架构建议**
报告总结指出，最佳工具的选择取决于具体的数据管道约束：

* **实时搜索代理**：首选 **Tavily** 或 **Exa**。
* **应对频繁改版的网站结构**：首选基于提示词的 **ScrapeGraphAI** 或 **JigsawStack**。
* **海量短文档/注重 Token 成本及多模态**：首选 **Jina AI Reader**。
* **追求极致速度、完全控制权及本地开源部署**：首选 **Crawl4AI**。
* **超大规模、需要无限扩展能力的企业级聚合**：首选 **Apify**。
