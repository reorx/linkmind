# LinkMind TODO

2026-03-05:
- [ ] 回复消息来进行AI问答,提供调整 insight prompt 和记录个人 memory 的工具.如果用户觉得 insight 内容不够好的话，可以再跟 AI 对话，让他思考，并且在这个过程中去调整 insight 的 prompt，使之后的 insight 分析更加准确。
    regular reply is adding notes, only /ai talks to ai
- [ ] 每个pipelline返回的消息都在下面增加链接按钮，就像 Login 的返回消息那样
- [ ] 对于最终提供内容的那条消息，下面可以增加进行标记或反馈的按钮，比如点赞或点踩。
- [ ] 回复消息的时候使用 delete 命令可以用来删除一个 record
- [ ] 可以对消息进行 reaction, 记录在 record 中

    这样的话：
    1. 用户回头可以通过这种方式来进行筛选
    2. 未来可以帮助用通过这个指标，更方便地进行数据关联以及数据推荐
- [ ] search in web and telegram


2026-03-16:
- [ ] **热门内容预加载 (Pre-fetch Popular Content)**
    - 定期爬取 Hacker News 和 Twitter 上的热门文章，提前完成内容抓取
    - 预先提取正文内容，用户添加链接时直接命中缓存，跳过抓取步骤，大幅提升速度
    - Summary 只需生成一次，存储在专门的预抓取数据表中，多用户复用同一份摘要
    - 一旦有用户触发过摘要生成，后续用户直接复用，不再重复调用 LLM

2026-03-17:
- [ ] **Crawler 能力开放给用户**
    - 基于预抓取表存储的页面内容，将 Crawler 能力作为独立功能暴露
    - **CLI 功能**：类似 PureMD，用户给一个 URL，返回 Markdown 正文内容
    - **开放 API 接口**：类似 Jina Reader API，提供 URL → Markdown 的 HTTP 接口
    - **抓取历史**：用户可以在 Web 界面的 "Crawl History" 导航中查看最近抓取的内容
    - 核心价值：帮用户把任意链接的内容作为 Markdown 下载下来

## Bugs

- 观测到 insight 会被截断，有时候会产生不完整的内容

## Rules

- **生产环境禁止裸 SQL 操作**：所有数据维护必须通过脚本（`scripts/admin-*.ts`），先本地测试，再用 `.env.prod` 执行
- 生产操作命令格式：`npx tsx --env-file=.env.prod scripts/admin-xxx.ts <args>`

## Pending

- [ ] 配置 probe 完成 18 条 waiting_probe 的 twitter/x.com 链接抓取（或用 bird CLI 做替代方案）
