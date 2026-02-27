# PostgreSQL 14 → 18 迁移指南

> **目标受众**：一台仍在运行 PostgreSQL 14 的机器，需要完成：
> 1. PostgreSQL 18 安装
> 2. 数据库迁移（确保数据不丢失）
> 3. 安装 pgvector 和 pg_search 扩展
>
> 本文档基于我们在 Mac Mini（Homebrew）上的实际迁移经验编写，同时覆盖 Ubuntu 24.04（apt）场景。

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

### Ubuntu (apt)

```bash
# 全量备份
sudo -u postgres pg_dumpall > ~/pg14_full_backup_$(date +%Y%m%d).sql

# 验证
ls -lh ~/pg14_full_backup_*.sql
head -50 ~/pg14_full_backup_*.sql
```

> ⚠️ 如果某个数据库已安装 pgvector 或 pg_search 扩展，backup 里会包含 `CREATE EXTENSION` 语句。
> 在 restore 时需要**先安装好这些扩展**，否则会报错。

---

## 第二步：安装 PostgreSQL 18

### macOS (Homebrew)

```bash
# 安装 PG 18
brew install postgresql@18

# 初始化数据目录
/opt/homebrew/opt/postgresql@18/bin/initdb \
  --locale=C \
  -E UTF8 \
  /opt/homebrew/var/postgresql@18
```

### Ubuntu 24.04 (apt)

```bash
# 1. 添加 PostgreSQL 官方 APT 源
sudo apt install -y curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc

. /etc/os-release
sudo sh -c "echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main' > /etc/apt/sources.list.d/pgdg.list"

sudo apt update

# 2. 安装 PG 18
sudo apt install -y postgresql-18

# PG 18 会自动初始化数据目录并启动
# 数据目录: /var/lib/postgresql/18/main
# 配置文件: /etc/postgresql/18/main/postgresql.conf
```

> 📝 **Ubuntu 注意**：`apt install postgresql-18` 会自动创建 `postgres` 系统用户、初始化数据库集群并启动服务。PG 14 和 PG 18 可以共存（不同端口），PG 14 默认 5432，PG 18 默认 5433。

---

## 第三步：数据迁移

有两种方案，根据你的情况选择：

### 方案 A：pg_upgrade（推荐，速度快，保留 OID）

适用于数据量较大或需要保持最短停机时间的场景。

#### macOS

```bash
# 1. 停止 PG 14
brew services stop postgresql@14

# 2. 确保 PG 18 也是停止状态
brew services stop postgresql@18

# 3. 运行 pg_upgrade
/opt/homebrew/opt/postgresql@18/bin/pg_upgrade \
  --old-datadir /opt/homebrew/var/postgresql@14 \
  --new-datadir /opt/homebrew/var/postgresql@18 \
  --old-bindir /opt/homebrew/opt/postgresql@14/bin \
  --new-bindir /opt/homebrew/opt/postgresql@18/bin

# 4. 启动 PG 18
brew services start postgresql@18
```

#### Ubuntu

```bash
# 1. 停止两个 PG 实例
sudo systemctl stop postgresql@14-main
sudo systemctl stop postgresql@18-main

# 2. 以 postgres 用户运行 pg_upgrade
sudo -u postgres /usr/lib/postgresql/18/bin/pg_upgrade \
  --old-datadir /var/lib/postgresql/14/main \
  --new-datadir /var/lib/postgresql/18/main \
  --old-bindir /usr/lib/postgresql/14/bin \
  --new-bindir /usr/lib/postgresql/18/bin \
  --old-options '-c config_file=/etc/postgresql/14/main/postgresql.conf' \
  --new-options '-c config_file=/etc/postgresql/18/main/postgresql.conf'

# 3. 启动 PG 18
sudo systemctl start postgresql@18-main
```

> ⚠️ **pg_upgrade 前提**：如果旧数据库使用了 pgvector 或 pg_search 扩展，新版 PG 18 上**必须先安装好这些扩展的 .so/.dylib 文件**，否则 pg_upgrade 会失败。可以先跳到第四步安装扩展文件，再回来执行 pg_upgrade。

### 方案 B：dump/restore（更安全，适合数据量小的场景）

我们在 Mac Mini 上就是用这个方案（数据总量才 ~52 MB，秒级完成）。

#### macOS

```bash
# 1. 停止 PG 14
brew services stop postgresql@14

# 2. 启动 PG 18
brew services start postgresql@18

# 3. 更新 PATH 指向 PG 18
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

# 4. 恢复前，先创建必要的角色（pg_dumpall 的 SQL 可能依赖角色存在）
# 查看备份文件开头的 CREATE ROLE 语句确认需要哪些角色

# 5. 导入全量备份
psql -U <superuser> -d postgres -f ~/pg14_full_backup_*.sql

# 注: pg_search/pgvector 相关的 CREATE EXTENSION 可能报错
# 如果报错，先安装扩展（第四步），再重新导入
```

#### Ubuntu

```bash
# 1. 停止 PG 14
sudo systemctl stop postgresql@14-main
sudo systemctl disable postgresql@14-main

# 2. 确保 PG 18 运行中（默认端口 5433，改成 5432）
# 编辑 /etc/postgresql/18/main/postgresql.conf，设 port = 5432
sudo sed -i 's/^port = 5433/port = 5432/' /etc/postgresql/18/main/postgresql.conf
sudo systemctl restart postgresql@18-main

# 3. 导入全量备份
sudo -u postgres psql -d postgres -f ~/pg14_full_backup_*.sql
```

---

## 第四步：安装 pgvector

### macOS (Homebrew)

```bash
brew install pgvector
```

Homebrew 的 pgvector 会自动针对已安装的 PG 版本编译。安装后文件位于：
- 库文件: `/opt/homebrew/lib/postgresql@18/vector.dylib`
- SQL 文件: `/opt/homebrew/share/postgresql@18/extension/vector*`

### Ubuntu (apt)

```bash
# pgvector 在 PostgreSQL 官方 APT 源中可用
sudo apt install -y postgresql-18-pgvector
```

### 启用扩展

```sql
-- 连接到需要 pgvector 的数据库
CREATE EXTENSION IF NOT EXISTS vector;

-- 验证
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
```

---

## 第五步：安装 pg_search（ParadeDB BM25 全文搜索）

pg_search 不在标准 APT/Homebrew 源中，需要从 [ParadeDB GitHub Releases](https://github.com/paradedb/paradedb/releases) 下载预编译包。

### 查看最新版本

```bash
# 获取最新版本号
curl -s https://api.github.com/repos/paradedb/paradedb/releases/latest | grep tag_name
# 当前: v0.21.9
```

### macOS (Homebrew PG 18)

```bash
PG_SEARCH_VERSION="0.21.9"

# 下载 macOS pkg（根据你的 macOS 版本选择 sequoia 或 sonoma）
# arm64 (Apple Silicon):
curl -L "https://github.com/paradedb/paradedb/releases/download/v${PG_SEARCH_VERSION}/pg_search@18--${PG_SEARCH_VERSION}.arm64_sequoia.pkg" \
  -o /tmp/pg_search.pkg

# 安装
sudo installer -pkg /tmp/pg_search.pkg -target /
```

安装后文件位于：
- 库文件: `/opt/homebrew/lib/postgresql@18/pg_search.dylib`（约 70 MB）
- SQL/Control: `/opt/homebrew/share/postgresql@18/extension/pg_search*`

### Ubuntu 24.04 (Noble, amd64)

```bash
PG_SEARCH_VERSION="0.21.9"

# 下载 deb 包
curl -L "https://github.com/paradedb/paradedb/releases/download/v${PG_SEARCH_VERSION}/postgresql-18-pg-search_${PG_SEARCH_VERSION}-1PARADEDB-noble_amd64.deb" \
  -o /tmp/pg_search.deb

# 安装
sudo apt-get install -y /tmp/pg_search.deb
```

> 📝 **其他平台的包名格式**：
> - Ubuntu 22.04: `...-jammy_amd64.deb`
> - Debian 12: `...-bookworm_amd64.deb`
> - Debian 13: `...-trixie_amd64.deb`
> - RHEL 9: `pg_search_18-0.21.9-1PARADEDB.el9.x86_64.rpm`
> - ARM64: 把 `amd64` 换成 `arm64`

### 配置 shared_preload_libraries（PG < 17 才需要）

> ✅ **PostgreSQL 17+ 不需要这一步**。pg_search 文档明确说明：如果你的 PG 版本是 17 或更高，不需要添加 `shared_preload_libraries`。我们在 PG 18 上验证了这一点——`shared_preload_libraries` 为空，pg_search 正常工作。

如果你碰到 PG 14~16 的场景（不推荐，直接升 18），需要：

```bash
# 编辑 postgresql.conf
# macOS: /opt/homebrew/var/postgresql@XX/postgresql.conf
# Ubuntu: /etc/postgresql/XX/main/postgresql.conf

shared_preload_libraries = 'pg_search'

# 重启 PostgreSQL
```

### 启用扩展

```sql
-- 连接到需要 pg_search 的数据库
CREATE EXTENSION pg_search;

-- 验证
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_search';
```

---

## 第六步：验证

完成所有步骤后，逐项验证：

```bash
# 1. PG 版本
psql -U <superuser> -d postgres -c "SELECT version();"
# 预期: PostgreSQL 18.x

# 2. 数据库完整性
psql -U <superuser> -d postgres -c "\l+"
# 对比迁移前的输出，确认所有数据库都在

# 3. 角色完整性
psql -U <superuser> -d postgres -c "\du"

# 4. 扩展状态
psql -U <superuser> -d <your_db> -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
# 预期看到: vector, pg_search, 以及其他原有扩展

# 5. 数据抽检
psql -U <superuser> -d <your_db> -c "SELECT count(*) FROM <important_table>;"
# 对比迁移前的行数

# 6. pgvector 功能验证
psql -U <superuser> -d <your_db> -c "SELECT '[1,2,3]'::vector;"

# 7. pg_search 功能验证
psql -U <superuser> -d <your_db> -c "SELECT * FROM paradedb.version();"
```

---

## 第七步：清理

```bash
# macOS - 确认一切正常后卸载 PG 14
brew uninstall postgresql@14

# Ubuntu - 卸载 PG 14
sudo apt remove -y postgresql-14
sudo rm -rf /var/lib/postgresql/14  # 数据目录（确认备份在手再删）

# 确保 PATH/环境变量指向 PG 18
# macOS: ~/.zshrc 中 export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
# Ubuntu: PG 18 的 bin 默认在 /usr/lib/postgresql/18/bin/

# 备份文件保留几天确认无问题后可删除
```

---

## 我们的实际迁移记录

以下是在 Mac Mini (Apple Silicon, macOS Sequoia) 上完成的迁移状态，供参考：

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
先安装扩展文件（第四、五步），再跑 pg_upgrade。pg_upgrade 需要在新集群中能找到旧集群使用的所有扩展。

### Q: Ubuntu 上 PG 14 和 PG 18 端口冲突？
两个版本默认使用不同端口（14→5432, 18→5433）。迁移完成后，停掉 PG 14 并把 PG 18 端口改回 5432。

### Q: dump/restore 时 CREATE EXTENSION 报错？
说明扩展文件还没装。先执行第四、五步安装扩展，再重新 restore。可以编辑 dump 文件暂时注释掉 `CREATE EXTENSION` 行，分步处理。

### Q: pg_search 的 BM25 索引数据会迁移吗？
pg_search 的 BM25 索引是派生数据（类似于普通索引），dump/restore 后需要重建。数据本身不会丢失，只是索引需要重新创建。
