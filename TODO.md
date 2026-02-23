# LinkMind TODO

## Rules

- **生产环境禁止裸 SQL 操作**：所有数据维护必须通过脚本（`scripts/admin-*.ts`），先本地测试，再用 `.env.prod` 执行
- 生产操作命令格式：`npx tsx --env-file=.env.prod scripts/admin-xxx.ts <args>`

## Pending

- [ ] 配置 probe 完成 18 条 waiting_probe 的 twitter/x.com 链接抓取（或用 bird CLI 做替代方案）
