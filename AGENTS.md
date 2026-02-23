# AGENTS.md — LinkMind Project Guidelines

## 部署

- 部署配置**不在本仓库**，位于 OpenClaw workspace 的 `deploy/` 目录下
- 使用 **Ansible** 管理所有部署操作，playbook 和 roles 都在 `deploy/ansible/`
- 服务器：hh-hk-01 (103.69.129.33:1122)
- 所有与部署相关的改动都在 workspace 的 `deploy/` 目录进行，不要在本仓库创建部署文件

## 生产数据维护

- **禁止对生产环境执行裸 SQL 操作**
- 所有数据维护必须通过 `server/scripts/admin-*.ts` 脚本完成
- 流程：
  1. 在 `server/scripts/` 下编写 TypeScript 脚本，调用项目内部函数
  2. 先用本地 `.env` 测试
  3. 确认无误后，使用 `.env.prod` 对生产环境执行：
     ```bash
     cd server
     npx tsx --env-file=.env.prod scripts/admin-xxx.ts <args>
     ```
- `.env.prod` 包含生产环境配置，已在 `.gitignore` 中，不会提交到仓库
