---
created: 2026-07-13
tags:
  - session
  - handoff
  - launch
  - record-files
---

# Handoff — P0-2 Phase 6 图片清理 + 生产收尾

> 承接 [before-launch plan](../plans/2026-07-07-before-launch.md) 的 **P0-2 剩余**。本 session 完成了 Phase 6 的**全部代码 + 本地验证**;**生产 migration + 部署未做**,需下个 session 接手。给新 session 的自洽交接。
>
> **✅ 2026-07-13 已全部完成**:Step 1 预演(实际重复行 #41/#56/#58 共 5 组,比预期多 #56)→ Step 2 生产 migration(部署前直连 Neon,无窗口期)→ Step 3 push + CD 部署(含 redesign,用户拍板一起上)。上线抽查通过,唯一遗留:用户从 Telegram 发带图链接验证 bot 发图新路径。结果详见 plan P0-2 清单末条。

## 一、这个 session 做了什么(已完成)

**P0-2 Phase 6:从遗留本地图片系统(`records.images` + `data/images/`)彻底切到 `record_files` + 对象存储(R2)。** 两个 commit 已落 master(未 push):

- `8d7f8f2` refactor(images):代码主体
- `4124bf6` docs(kb):plan 勾选更新

### 改动清单(commit `8d7f8f2`)

**遗留清理**
- 删 `server/src/image-handler.ts`(本地下载/缩略图/OCR)+ 其唯一调用方 `server/src/cli/backfill-images.ts`(已 stale——查的是不存在的 `links` 表)
- 移除 `/images` 静态路由(`web.ts`)、`RecordEntry/RecordsTable.images` 类型(`db/types.ts`)、`db/helpers.ts` mapper 字段、`routes/pages.ts` 详情页+分享页的 `images` 变量与 renderPage 参数、模板 fallback(`views/link-detail.ejs` 的 else 分支、`views/admin/record-detail.ejs` 的 Images 段)
- migration `server/src/db/migrations/2026-07-10T0013-drop-records-images.ts`:`DROP COLUMN records.images`(全库无任何写入方,已 grep 确认)

**bot 发图漏网项**(record-files-progress 清单当初漏了这处)
- `bot.ts` `pollAndNotify` 的 analyzed 分支:从读 `data/images/<id>/<local_path>` 发本地 `InputFile`,改为 `getRecordFiles(recordId)` → `getStorage().get(storage_key)` 取首图 buffer 发送;取不到/失败回退纯文本。顺带删掉只此处用到的 `path`/`existsSync` import

**record_files 去重防重**(retry 场景同 key 重复插入,生产 #58/#41 已现重复行)
- migration `2026-07-10T0012-record-files-dedup.ts`:`DELETE` 重复行(保留每个 `(record_id, storage_key)` 的最小 id)+ 加 `UNIQUE (record_id, storage_key)` 约束(`record_files_record_storage_uniq`)
- `db/record-files.ts` `insertRecordFile`:改 `onConflict((oc)=>oc.columns(['record_id','storage_key']).doUpdateSet(...))` upsert(同 key 重跑刷新元数据而非新增行)
- 新增 `src/__tests__/record-files.test.ts`(TDD,2 tests)

**附带加固**:`server/.gitignore` 加 `.env.prod.*`(防密钥备份被误提交)

### 本地验证(全绿)
- `pnpm typecheck`(server + probe)✓
- 新 dedup test ✓;全量 73 tests **71 过**,2 个失败是 `search.test.ts` 的 BM25——本地没装 `pg_search`(既有环境限制,非本次引入,已确认没动 search 文件)
- dev DB `linkmind_new` 实跑 `migrate` ✓:`records.images` 列已删、`record_files_record_storage_uniq` 约束已建

## 二、下一个要做什么:生产收尾

### ⚠️ 决定顺序的三个事实(务必先理解)
1. **migration 文件打包进镜像**,`index.ts` 启动不自动 migrate(`CMD` = `node dist/index.js`)——必须手动跑。
2. **新代码 `insertRecordFile` 的 `onConflict` 硬依赖 `record_files_record_storage_uniq` 约束**。约束不存在时 `ON CONFLICT` 对**每一次** insert 报错(不只重复插入)。所以"先部署代码、后 migrate"会有窗口期,期间**所有带图记录**的 insert 都失败(会被 media-handler/telegram-photo 的调用方 try/catch 吞掉→丢图不崩,但仍应避免)。
3. 生产库是 **Neon(外部,本地可直连)**;`cli.ts` 正确处理 `--env-file`(`if (!process.env.DATABASE_URL)` 才 load dotenv,不会被 cwd `.env` 反向覆盖打到 dev 库)。

**⇒ 最优顺序:先从本地直连 Neon 跑 migration,再部署代码。** 约束在新代码上线前就存在,**无窗口期**;且旧代码对迁移后的库容错,所以 migration 可现在先跑、与未验证的 redesign 部署**解耦**。

为什么旧代码扛得住迁移后的库:
- 列删掉:旧代码 `safeParseJson(record.images)` → `undefined` → `[]`,`selectAll` 是 `SELECT *` 少列无碍。
- 加约束:旧代码无 `onConflict`,仅在**重跑同一条已存图 record**(retry,罕见)时撞约束→被调用方 try/catch 吞→丢图不崩;首次处理不冲突。

### Step 1 — 本地生产副本预演(对生产纯只读)
唯一目的:验证 0012 的 `DELETE` 能清掉 #58/#41(及未知重复行)、清完 `UNIQUE` 能建成。bootstrap 测试库是干净的,证明不了这点。流程见 [before-launch plan](../plans/2026-07-07-before-launch.md) 的「生产 Migration 安全验证流程」或本 session 对话里给过的完整命令:`pg_dump` 生产 → 建本地 `linkmind_pro_YYYYMMDD` → restore → 迁移前看重复行 → `DATABASE_URL=<副本> npx tsx src/cli.ts migrate` → 迁移后验证 dup=0 / 约束在 / images 列没了。

### Step 2 — 生产库 migration(从本地直连 Neon,**部署前**)
```bash
cd /Users/reorx/Code/linkmind/server
npx tsx --env-file=.env.prod src/cli.ts migrate   # 只应用 0012 + 0013(先确认无其它 pending)
```
跑完只读抽查:#58/#41 去重、约束在、`records` 无 images 列。此后生产旧代码继续正常跑,DB 已就绪。

### Step 3 — 部署代码(redesign 就绪后)
`git push origin master` → CD 构建镜像 → webhook 自动 `pull && up`。新代码 `onConflict` 命中已存在约束、不再读 images 列。部署后抽查一条新带图 record(bot 发图走 record_files buffer)+ Web 详情页图片展示。

## 三、需要用户决定什么

1. **是否授权跑 Step 1 预演**(纯只读 dump + 本地副本,零生产写入)。建议先跑,把 #58/#41 去重前后实况给用户确认,再进 Step 2。
2. **redesign(`03520b5`,plan 标注"未验证")是否随本次一起部署。** `git push master` 会把它和其它未推 commit 一并上线。若未走查,可先只做 Step 1+2(DB 迁移与部署解耦),Step 3 等 redesign 走查(并入 P0-6)后再推。
3. (plan 既有未决项,顺带)默认用量限额是否维持 $1.00/周期(P0-5);上线范围是否含搜索 P1-11;域名/品牌名(影响落地页 + R2 公开域名)。

## 四、给新 session 的关键提醒(gotchas)

- **未推 commit 共 12 个**(`origin/master`=`16b9afb` → `HEAD`=`4124bf6`),含**未验证的 web redesign `03520b5`**。push master 即全量上线,注意别无意中把 redesign 带上去。
- **本地不跑任何 Docker**(见 memory `no-docker-on-local-mac`);容器操作一律远端。但本次生产 migration 走 **本地直连 Neon**,不需要 Docker/ssh。
- **禁止对生产裸 SQL 写操作**;migration 走 Kysely migrator(sanctioned),只读验证可用 psql。
- **`.env.prod` 密钥文件**:工作区里还有未跟踪的 `server/.env.prod.bak-20260707`(生产密钥备份),之前差点被 `git add -A` 误纳入,已排除未提交;`.gitignore` 已加 `.env.prod.*`。建议用户确认后删除或移出仓库。`tmp/`、`server/tmp/` 下的调研脚本也保持未跟踪,留给用户处理。
- 0012 的 `DELETE` 保留**最小 id**(最早)那行;图片同 storage_key 内容一致,保留哪行无实质差别,修复后未来重跑 upsert 同一行。
- bot 发图用 buffer(`getStorage().get()`)而非公开 URL:更 robust(本地 dev / WEB_BASE_URL 不可达也能发),代价是生产 ~1Mbps 带宽下多一次 R2→server 下载(单图几百 KB,可接受)。R2 公开域名尚未配置(plan 未决项 #4),故没走 URL 方案。
- notify 路径(`notify.ts` `notifyRecordProcessed`,probe 恢复的 twitter record 走这条)**是纯文本、不发图**——本次未改(超出 Phase 6 范围)。若日后要给 probe 恢复的 twitter record 发图,是新工作项。

## 五、plan 里 Phase 6 之后的顺序(供接手参考)
1. 本次生产收尾(Step 1→3)
2. LLM Gateway 落地(deploy workspace,不在本仓库):tc-sg-01 部署 gateway → `llm.ts` 加 `GEMINI_API_BASE` env 覆盖 → 生产切回 gemini
3. P1 功能:评分(9)→ insight thinking/脚注(10)→ 落地页(8)→ 搜索(11,范围待拍板)
4. 收官:P0-6 端到端走查 → P0-7 运维基线(Sentry DSN、备份确认、部署演练)→ 上线
