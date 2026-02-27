# PostgreSQL 14 → 18 迁移指南

> **目标受众**：一台仍在运行 PostgreSQL 14 的机器，需要完成：
> 1. PostgreSQL 18 安装
> 2. 数据库迁移（确保数据不丢失）
> 3. 安装 pgvector 和 pg_search 扩展
>
> 本文档覆盖两种场景：
> - **macOS (Homebrew)**：本地开发机直接升级
> - **Docker**：构建包含 pgvector + pg_search 的 PG 18 镜像

---

## 前置检查

在开始之前，先确认当前环境：

```bash
# 确认当前 PG 版本
psql --version
# 预期: psql (PostgreSQL) 14.x

# 查看数据目录位置
psql -U <superuser> -d postgres -t -c "SHOW data_directory;"

# 查看数据库清单和大小
psql -U <superuser> -d postgres -c "\l+"

# 查看所有角色
psql -U <superuser> -d postgres -c "\du"

# 查看已安装的扩展
psql -U <superuser> -d postgres -c "SELECT datname, extname, extversion FROM pg_database d LEFT JOIN pg_extension e ON true WHERE d.datistemplate = false ORDER BY datname, extname;"
```

> 💡 **记录以上输出**，迁移后用于验证数据完整性。

---

## 第一步：全量备份

**这一步是安全网，必须先做。**

### macOS (Homebrew)

```bash
export PATH="/opt/homebrew/opt/postgresql@14/bin:$PATH"

# 全量备份（包括角色、权限、所有数据库）
pg_dumpall -U <superuser> > ~/pg14_full_backup_$(date +%Y%m%d).sql

# 验证备份文件
ls -lh ~/pg14_full_backup_*.sql
head -50 ~/pg14_full_backup_*.sql
```

### Docker (从运行中的 PG 14 容器导出)

```bash
# 如果 PG 14 跑在 Docker 里
docker exec <pg14_container> pg_dumpall -U postgres > ~/pg14_full_backup_$(date +%Y%m%d).sql

# 或者用 pg_dump 单独备份每个数据库（推荐，更灵活）
docker exec <pg14_container> pg_dump -U postgres -Fc <dbname> > ~/backup_<dbname>.dump

# 验证
ls -lh ~/pg14_full_backup_*.sql
```

> ⚠️ 如果某个数据库已安装 pgvector 或 pg_search 扩展，backup 里会包含 `CREATE EXTENSION` 语句。
> 在 restore 时需要**先安装好这些扩展**，否则会报错。

---

## 第二步：构建 PG 18 + pgvector + pg_search Docker 镜像

### Dockerfile

以 `pgvector/pgvector:pg18` 为基础镜像（已包含 PG 18 + pgvector），再安装 pg_search：

```dockerfile
# PG 18 + pgvector + pg_search
# 基础镜像: pgvector/pgvector (official, 基于 postgres:18)
# pgvector 版本随基础镜像更新，当前 0.8.2
ARG PG_MAJOR=18
FROM pgvector/pgvector:pg${PG_MAJOR}

# pg_search 版本（ParadeDB BM25 全文搜索）
ARG PG_SEARCH_VERSION=0.21.9
ARG TARGETARCH

# 安装 pg_search 预编译 deb 包
# 基础镜像基于 Debian bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
    && curl -L "https://github.com/paradedb/paradedb/releases/download/v${PG_SEARCH_VERSION}/postgresql-${PG_MAJOR}-pg-search_${PG_SEARCH_VERSION}-1PARADEDB-bookworm_${ARCH}.deb" \
       -o /tmp/pg_search.deb \
    && apt-get install -y /tmp/pg_search.deb \
    && rm -f /tmp/pg_search.deb \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# 自动创建扩展的初始化脚本
# 放在 /docker-entrypoint-initdb.d/ 下，首次启动时自动执行
COPY docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
```

### 初始化脚本

创建 `docker-entrypoint-initdb.d/10-create-extensions.sql`：

```sql
-- 自动在默认数据库中启用扩展
-- 如果需要在其他数据库启用，在 restore 后手动执行
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
```

### 构建 & 运行

```bash
# 构建（支持 amd64 和 arm64）
docker build -t pg18-with-extensions .

# 多架构构建（如果需要推送到 registry）
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<your-org>/postgres:18-extensions --push .

# 运行
docker run -d \
  --name pg18 \
  -e POSTGRES_PASSWORD=<password> \
  -v pg18-data:/var/lib/postgresql/data \
  -p 5432:5432 \
  pg18-with-extensions
```

### docker-compose.yml 示例

```yaml
services:
  db:
    image: pg18-with-extensions  # 或你推到 registry 的镜像名
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-postgres}
    volumes:
      - pg-data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    # 如果数据量大，增大共享内存（pgvector HNSW 索引构建需要）
    shm_size: 256mb

volumes:
  pg-data:
```

---

## 第三步：数据迁移

### macOS (Homebrew → Homebrew)

两种方案，选一个：

**方案 A：pg_upgrade（推荐，速度快）**

```bash
# 1. 停止 PG 14 和 PG 18
brew services stop postgresql@14
brew services stop postgresql@18

# 2. 运行 pg_upgrade
/opt/homebrew/opt/postgresql@18/bin/pg_upgrade \
  --old-datadir /opt/homebrew/var/postgresql@14 \
  --new-datadir /opt/homebrew/var/postgresql@18 \
  --old-bindir /opt/homebrew/opt/postgresql@14/bin \
  --new-bindir /opt/homebrew/opt/postgresql@18/bin

# 3. 启动 PG 18
brew services start postgresql@18
```

> ⚠️ pg_upgrade 前需要**先安装好扩展文件**（第四步的 macOS 部分），否则会报错。

**方案 B：dump/restore（更安全，适合数据量小）**

我们在 Mac Mini 上用的这个方案（~52 MB，秒级完成）。

```bash
# 1. 停止 PG 14，启动 PG 18
brew services stop postgresql@14
brew services start postgresql@18
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

# 2. 导入全量备份
psql -U <superuser> -d postgres -f ~/pg14_full_backup_*.sql
```

### Docker (PG 14 → PG 18 容器)

```bash
# 1. 启动新的 PG 18 容器（使用上面构建的镜像）
docker run -d \
  --name pg18-new \
  -e POSTGRES_PASSWORD=<password> \
  -v pg18-data:/var/lib/postgresql/data \
  -p 5433:5432 \
  pg18-with-extensions

# 等待初始化完成
docker logs -f pg18-new  # 看到 "database system is ready to accept connections" 即可

# 2. 创建角色和数据库（根据你的 pg_dumpall 备份开头的 CREATE ROLE 语句）
docker exec -i pg18-new psql -U postgres <<'SQL'
-- 示例，按实际情况调整
CREATE ROLE myapp LOGIN PASSWORD 'xxx';
CREATE DATABASE mydb OWNER myapp;
SQL

# 3. 在目标数据库启用扩展
docker exec -i pg18-new psql -U postgres -d mydb <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
SQL

# 4a. 用 pg_dumpall 的全量备份恢复
docker exec -i pg18-new psql -U postgres -d postgres < ~/pg14_full_backup_*.sql

# 4b. 或者用 pg_dump 的单库备份恢复（推荐）
docker exec -i pg18-new pg_restore -U postgres -d mydb --no-owner --no-privileges < ~/backup_mydb.dump

# 5. 验证
docker exec pg18-new psql -U postgres -d mydb -c "\dt"
docker exec pg18-new psql -U postgres -d mydb -c "SELECT count(*) FROM <important_table>;"
```

> 💡 **提示**：如果旧 PG 14 也是 Docker 容器，可以直接 pipe：
> ```bash
> docker exec pg14-old pg_dump -U postgres -Fc mydb | \
>   docker exec -i pg18-new pg_restore -U postgres -d mydb --no-owner
> ```

---

## 第四步：安装扩展（macOS Homebrew 场景）

> Docker 场景下扩展已在镜像中安装，跳过此步。

### pgvector

```bash
brew install pgvector
```

文件位置：
- 库: `/opt/homebrew/lib/postgresql@18/vector.dylib`
- SQL: `/opt/homebrew/share/postgresql@18/extension/vector*`

### pg_search

从 [ParadeDB GitHub Releases](https://github.com/paradedb/paradedb/releases) 下载预编译 `.pkg`：

```bash
PG_SEARCH_VERSION="0.21.9"

# arm64 (Apple Silicon) + macOS Sequoia:
curl -L "https://github.com/paradedb/paradedb/releases/download/v${PG_SEARCH_VERSION}/pg_search@18--${PG_SEARCH_VERSION}.arm64_sequoia.pkg" \
  -o /tmp/pg_search.pkg

# macOS Sonoma 用: ...arm64_sonoma.pkg

# 安装
sudo installer -pkg /tmp/pg_search.pkg -target /
```

文件位置：
- 库: `/opt/homebrew/lib/postgresql@18/pg_search.dylib`（约 70 MB）
- SQL/Control: `/opt/homebrew/share/postgresql@18/extension/pg_search*`

### 启用扩展

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
```

### 关于 shared_preload_libraries

> ✅ **PostgreSQL 17+ 不需要配置**。pg_search 文档明确说明 PG 17+ 不需要 `shared_preload_libraries`。
> 我们在 PG 18 上验证了——`shared_preload_libraries` 为空，pg_search 正常工作。

---

## 第五步：验证

```bash
# 调整为你的连接方式（本地 psql 或 docker exec）
PSQL="psql -U <superuser>"                          # macOS
# PSQL="docker exec pg18-new psql -U postgres"      # Docker

# 1. PG 版本
$PSQL -d postgres -c "SELECT version();"
# 预期: PostgreSQL 18.x

# 2. 数据库完整性
$PSQL -d postgres -c "\l+"

# 3. 角色完整性
$PSQL -d postgres -c "\du"

# 4. 扩展状态
$PSQL -d <your_db> -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
# 预期: vector, pg_search

# 5. 数据抽检
$PSQL -d <your_db> -c "SELECT count(*) FROM <important_table>;"

# 6. pgvector 功能测试
$PSQL -d <your_db> -c "SELECT '[1,2,3]'::vector;"

# 7. pg_search 功能测试
$PSQL -d <your_db> -c "SELECT * FROM paradedb.version();"
```

---

## 第六步：清理

### macOS

```bash
# 确认一切正常后卸载 PG 14
brew uninstall postgresql@14

# 确保 PATH 指向 PG 18
echo 'export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"' >> ~/.zshrc
```

### Docker

```bash
# 停止并移除旧 PG 14 容器
docker stop <pg14_container>
docker rm <pg14_container>

# 可选：清理旧 volume
docker volume rm <pg14_volume>

# 把新容器端口改回 5432（如果之前用的 5433）
# 修改 docker-compose.yml 或重新 run
```

---

## 我们的实际迁移记录

Mac Mini (Apple Silicon, macOS Sequoia) 上完成的迁移状态，供参考：

| 项目 | 值 |
|------|------|
| 迁移前 | PostgreSQL 14.18 (Homebrew) |
| 迁移后 | PostgreSQL 18.1 (Homebrew) |
| 数据目录 | `/opt/homebrew/var/postgresql@18` |
| 迁移方式 | dump/restore（数据量 ~52 MB，秒级完成） |
| pgvector | 0.8.1（`brew install pgvector`） |
| pg_search | 0.21.6（GitHub Releases `.pkg` 安装） |
| pg_trgm | 1.6（PG 内置） |
| shared_preload_libraries | 空（PG 18 不需要配置） |

---

## 常见问题

### Q: pg_upgrade 报错找不到 pgvector/pg_search 扩展？
先安装扩展文件（第四步），再跑 pg_upgrade。pg_upgrade 需要在新集群中能找到旧集群使用的所有扩展。

### Q: dump/restore 时 CREATE EXTENSION 报错？
说明扩展文件还没装。先安装扩展，再重新 restore。或者编辑 dump 文件注释掉 `CREATE EXTENSION` 行，分步处理。

### Q: pg_search 的 BM25 索引数据会迁移吗？
pg_search 的 BM25 索引是派生数据（类似于普通索引），dump/restore 后需要重建。数据本身不会丢失，只是索引需要重新创建。

### Q: Docker 镜像中 pgvector/pg_search 版本怎么升级？
修改 Dockerfile 中的 `PG_SEARCH_VERSION` ARG，重新 build 即可。pgvector 版本随基础镜像 `pgvector/pgvector:pg18` 更新。

### Q: 基础镜像为什么选 pgvector/pgvector 而不是 postgres?
`pgvector/pgvector:pg18` 是 pgvector 官方维护的镜像，基于 `postgres:18`，只多了 pgvector 扩展。省去自己编译 pgvector 的步骤，更可靠。
