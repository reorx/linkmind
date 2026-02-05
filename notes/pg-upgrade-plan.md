# PostgreSQL 升级 & pgvector 安装计划

## 现状

| 项目 | 值 |
|------|------|
| 当前版本 | PostgreSQL 14.18 (Homebrew `postgresql@14`) |
| 目标版本 | PostgreSQL 18.1 (Homebrew `postgresql@18`) |
| 数据目录 | `/opt/homebrew/var/postgresql@14` |
| 总数据量 | ~52 MB（很小，风险低） |
| pgvector | 未安装，Homebrew `pgvector 0.8.1` 支持 PG 17/18，PG 18 兼容性已验证 |

### 数据库清单

| 数据库 | Owner | 大小 |
|--------|-------|------|
| tenderbuddy_dev | tenderbuddy | 23 MB |
| linkmind | linkmind | 10 MB |
| breeze_dev | breeze | 10 MB |
| postgres | reorx | 9 MB |

### 用户/角色

- `reorx` (superuser)
- `linkmind`
- `tenderbuddy`
- `breeze`

## 为什么选 PG 18

- PG 18 已正式发布（2025-09-25 GA，当前 18.1），不是 beta
- PostgreSQL 每个大版本支持 5 年（无 LTS 概念），PG 18 支持到 ~2030
- pgvector 0.8.1 明确支持 PG 18（Homebrew formula 构建依赖包含 PG 18，Neon 等云厂商已在生产环境运行）
- 既然要升级，不如一步到位

## 升级步骤

### Phase 1: 全量备份

```bash
# 用 pg_dumpall 备份所有数据库 + 角色
pg_dumpall -U reorx > ~/pg14_full_backup_$(date +%Y%m%d).sql

# 验证备份文件
ls -lh ~/pg14_full_backup_*.sql
head -50 ~/pg14_full_backup_*.sql
```

### Phase 2: 安装 PG 18

```bash
# 安装新版本
brew install postgresql@18

# 初始化新数据目录
/opt/homebrew/opt/postgresql@18/bin/initdb \
  --locale=C \
  -E UTF8 \
  /opt/homebrew/var/postgresql@18
```

### Phase 3: 数据迁移

**方案 A: pg_upgrade（推荐，速度快）**

```bash
# 停止 PG 14
brew services stop postgresql@14

# 运行 pg_upgrade
/opt/homebrew/opt/postgresql@18/bin/pg_upgrade \
  --old-datadir /opt/homebrew/var/postgresql@14 \
  --new-datadir /opt/homebrew/var/postgresql@18 \
  --old-bindir /opt/homebrew/opt/postgresql@14/bin \
  --new-bindir /opt/homebrew/opt/postgresql@18/bin
```

**方案 B: dump/restore（更安全，数据量小所以也很快）**

```bash
# 停止 PG 14
brew services stop postgresql@14

# 启动 PG 18
brew services start postgresql@18

# 导入备份
psql -U reorx -d postgres -f ~/pg14_full_backup_*.sql
```

### Phase 4: 启动 PG 18 & 验证

```bash
# 启动 PG 18
brew services start postgresql@18

# 确保 PATH 指向新版本
echo 'export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 验证版本
psql --version  # 应显示 18.x
psql -U reorx -d postgres -c "SELECT version();"

# 验证数据完整
psql -U reorx -d postgres -c "\l+"
psql -U reorx -d linkmind -c "SELECT count(*) FROM links;"
psql -U reorx -d tenderbuddy_dev -c "\dt"
```

### Phase 5: 安装 pgvector

```bash
# 安装 pgvector（Homebrew 会针对 PG 18 编译）
brew install pgvector

# 在需要的数据库中启用
psql -U reorx -d linkmind -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 验证
psql -U reorx -d linkmind -c "SELECT * FROM pg_extension WHERE extname = 'vector';"
```

### Phase 6: 清理

```bash
# 确认一切正常后，卸载旧版本
brew uninstall postgresql@14

# 备份文件保留几天后可删除
# rm ~/pg14_full_backup_*.sql
```

## linkmind 代码改动

升级完成后，代码层面需要做的：

1. **添加 pgvector 相关 schema**（向量列、索引）— 具体取决于要给哪些字段加向量搜索
2. **更新 mykb 或 linkmind 的搜索逻辑**，利用 pgvector 做语义搜索
3. 无需改 `DATABASE_URL`，连接方式不变

## 风险评估

- **风险极低**：数据量才 52 MB，全量备份 + 恢复秒级完成
- **回滚方案**：备份文件在，随时可以重装 PG 14 恢复
- **停机时间**：< 5 分钟

## 注意事项

- 升级前确保没有正在运行的应用连接数据库（linkmind bot、tenderbuddy 等先停掉）
- `pg_upgrade` 要求两个版本的 PG 都已停止
- Homebrew 的 `postgresql@14` 和 `postgresql@18` 可以共存安装，但不能同时运行
