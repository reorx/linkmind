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
2. 未来可以帮助用户通过这个指标，更方便地进行数据关联以及数据推荐


## Bugs

- 观测到 insight 会被截断，有时候会产生不完整的内容

## Rules

- **生产环境禁止裸 SQL 操作**：所有数据维护必须通过脚本（`scripts/admin-*.ts`），先本地测试，再用 `.env.prod` 执行
- 生产操作命令格式：`npx tsx --env-file=.env.prod scripts/admin-xxx.ts <args>`

## Pending

- [ ] 配置 probe 完成 18 条 waiting_probe 的 twitter/x.com 链接抓取（或用 bird CLI 做替代方案）
