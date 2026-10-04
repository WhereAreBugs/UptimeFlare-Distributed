# 统一 Worker 与 state-v2

本改造以根目录 `TODO.md` 为验收清单。原引用的两份 UPSTREAM 指南不在工作区，具体实现按 TODO 中列出的约束执行。默认周期仍为 300 秒，默认超时仍为 5000 毫秒。网页管理、管理 Token、探针鉴权、分组、暂停、维护、通知模板和旧 API 路径保留。

## 请求与版本

静态文件来自 Next.js `out/`；`worker/src/index.ts` 同时处理静态资源、API、Cron、RemoteChecker 和 Coordinator。构建使用 `npm run build && npm run build:worker`，不再依赖 Pages adapter。

| 接口或协议 | 版本与行为 |
| --- | --- |
| `/api/data`、`/api/badge`、`/api/incidents` | 保留原路径；公共字段重新白名单投影 |
| `/api/state` | 外层 version=1、wire=2；直接返回已物化摘要，标签共享、目标和分组用紧凑元组关联 |
| `/api/history?id=…&from=…&to=…` | 单目标，默认最近 12 小时，单次范围最多 12 小时；只允许当前公开目标 |
| `/api/admin/*`、`/api/manage/*` | 保留管理员会话及分组授权 Token；未鉴权请求在读库前拒绝 |
| `/api/probes/config`、`/api/probes/ingest` | Go 协议 version=1，gzip、最多 200 个结果、稳定 batch_id 与持久化后 ACK 保持兼容 |
| 区域 RPC | version=1，runId、完整配置 SHA256、明确结果集合；可乱序，不允许重复、遗漏或非法数值 |
| 协调 RPC | version=1，schema=2、regional=1、probe=1；稳定对象 `state-v2`，支持提交查询及重放 |
| 存储选择 | `STATE_STORAGE_VERSION=1` 保留旧生产者；2 使用热冷表，必须先完成验证迁移 |

公开 DTO 不含目标地址、请求方法、请求头、正文、代理凭据、通知配置或管理凭据。显示名称、公开链接、分组和必要的内部关联 ID 可进入公共协议；ID 不显示在 UI。公开链接拒绝 userinfo/危险协议，并过滤敏感查询参数。错误按阶段/代码重建安全文案；私有完整探针错误只存放在原始块中。目标、代理、位置查询、Globalping API 和 Webhook 均禁止自动重定向。HTTP/代理正文限 1 MiB，超时覆盖必要的正文读取，结束或超时后释放流。

`generatedAt`/`snapshotAt` 表示探测或投影时间；`materializedAt` 表示生成摘要时间；`cachedAt` 表示写入缓存时间。公共快照最长 180 秒，目标按各自间隔的两倍判断失联。离线探针从可达比例分母中排除，不将汇总变黄；全部无新数据时显示未知。暂停目标继续计入“关闭”，暂停的组不挂载到首页。

## 预约、提交与通知

1. Cron 按目标周期、配置指纹、scheduledTime 和租约所有者预约测量；网络请求不占状态提交租约。
2. 区域 DO 只测量。每个区域使用固定对象名 `region:<hint>`，每次最多 40 个目标、共享并发 5、最多 160 个排队目标、配置缓存最多 4 份。实际位置查询成功后缓存，失败冷却 60 秒，对象重建重新查询。
3. Coordinator 串行合并状态；队列最多 64 个待办。测量完成后获取 30 秒提交租约，配置 revision 和所有者共同保护全部写入。
4. D1 `batch` 原子提交热态、历史、通知观察、outbox、调度游标和稳定提交 receipt。条件更新零行表示过期所有权，不等同 SQL 错误，也不确认批次。
5. 根 Worker 在提交后投递 Webhook，使用独立的 120 秒投递租约。状态提交租约及时释放。

区域协议或代理系统错误形成采样空缺；其他独立目标和探针的有效结果继续保存。历史补传只增加历史/加权汇总，不覆盖更晚热态，也不重新触发当前告警。响应丢失后使用相同 runId/batch_id 重试或查询 receipt，禁止切换到另一写入路径猜测提交结果。

通知事件由目标、模板、状态、样本时间、故障起点和原因身份生成稳定 SHA256。每个 Webhook 目的地按完整推送配置生成身份，已成功目的地不重复投递。保留宽限、维护、暂停、原因变化和恢复规则；恢复后要等待新样本，多个已分配探针都要越过恢复游标。混合或无结果会重置尚未通知的宽限观察。相同样本的稳定轮次不重复写观察状态。

根执行每轮最多领取 2 个通知作业、最多尝试 6 个尚未成功的目的地，留出数据库与外部请求预算；成功的部分进展不消耗失败重试次数。失败指数退避，最多自动尝试 8 次，耗尽后保留 outbox 元数据供管理员排查。普通 Webhook 成功而本地 receipt 丢失仍可能重复；`Idempotency-Key` 可帮助支持幂等的接收端，不承诺严格只投递一次。代码 callbacks 保留尽力执行的原语义，不属于持久化投递保证。

## 数据模型与资源界限

| 数据 | 热态/历史布局 |
| --- | --- |
| 原生热态 | `native_hot`：最新时间、状态、延迟、位置、错误、开放事故、首次观察与序列 |
| 原生事故 | `native_incidents` 与 `native_incident_reasons`，按目标/起点以及结束时间索引；开放事故不清理 |
| 原生延迟 | `native_latency_blocks`：目标 + 5 分钟窗口，小块更新，不重编码完整历史 |
| 探针完整结果 | `probe_result_blocks`：探针 + 5 分钟窗口 + chunk，完整保留定义的协议字段 |
| 探针摘要 | latest、5 分钟 buckets、UTC days、阶段统计及 totals；平均值由总和/样本数计算 |
| 提交/通知 | commit_leases、commit_runs、notification_observations/state/outbox/deliveries |

配置最多 500 个目标、33 个探针和 1650 个目标探针分配。单批仍是 200 个样本/512 KiB；完整块最多 32 KiB UTF-8、40 个样本，每个窗口最多 128 块。批次去重窗口读取最多 2048 行/8 MiB。先检查 receipt，再批量读取去重和写入；不同批次中相同探针/目标/时间采用首次持久化结果。

公开 wire 摘要最多 256 KiB，超限先移除非必要展示字段及历史统计，保留当前状态、分组和维护语义。历史独立读取，单响应最多 1 MiB；超限返回 413，要求缩小时间范围。原生历史单次最多 1500 个延迟块、200 个事故、4000 个原因；事故页最多 100 条，游标使用原始事故起点，跨查询起点的事故不因显示裁剪而重复。

清理按小时领取槽位，用索引和有限批次：原始块每表最多 128 个，失败/原因/receipt 相关行最多 1000。原始历史保留 90 天，提交 receipt 保留 97 天；未过期去重、开放事故和待投递目的地 receipt 不被提前清理。实际删除会因积压延迟，保留期是清理阈值，不是固定磁盘容量承诺。清理失败释放槽位以便重试。

归档使用 `python3 deploy/archive_v2.py PRIVATE.sqlite --before UNIX_SECONDS --output NEW-private.jsonl.gz`。只读 SQLite 快照、输出权限 0600、每次最多 64 MiB 未压缩数据，仅导出已关闭事故及对应原因和历史块；不会删除源数据。超过预算需分割快照/时间范围，不能静默截断。

## 执行预算与观测

根 Worker 外部探测预算 30，区域预算每区域 40，总预约上限 200；HTTP proxy 按 2、Globalping 按 20 计，Globalping 初始调用加轮询最多 20 次。区域 fallback 预先占用根预算。所有成本按实际执行位置计，不能用一个固定目标数量表达所有部署容量。500 个目标不意味着 500 个直接检查能在免费配额中每分钟运行；按最旧完成游标公平分批，容量需要结合 Go 探针/区域分布和周期规划。

批量写入将 200 个通知目标或跨 200 个窗口控制为固定 SQL 数。Cloudflare 当前 D1 每次执行免费上限 50 个查询、付费 1000 个；外部与内部服务子请求分别有自己的限制。见 [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) 与 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。这不是当日额度保证，配置规模仍需按实际读写指标选择套餐。

`METRICS_ENABLED=1` 输出数值资源计数：SQL 次数、D1 `rows_read/rows_written`、返回行、根 DO 请求数、RPC 墙钟耗时和执行墙钟耗时。不开启时不做代理计数；日志不包含 SQL、绑定参数、URL、凭据或原始响应。Worker CPU 需由 Cloudflare 线上遥测取得，墙钟时间不能当 CPU 时间。Go OpenTelemetry 开关及既有低开销配置保持兼容。

## 迁移与回滚

禁止部署时自动转换格式。先停生产者并完整备份，再添加 `migrations/0008_state_v2.sql` 的兼容表，之后转换、独立验证，最后激活 schema2。未知版本、压缩/RLE 错误、时间关系异常、源数据漂移及无解释目标数据会停止操作。

离线演练：

```sh
python3 deploy/state_v2.py PRIVATE.sqlite --dry-run --plan NEW-private-plan.json
python3 deploy/state_v2.py PRIVATE.sqlite --apply --backup NEW-full.sqlite
python3 deploy/state_v2.py PRIVATE.sqlite --rollback --backup NEW-pre-rollback.sqlite
python3 deploy/state_v2.py PRIVATE.sqlite --restore NEW-full.sqlite
```

`--apply`/`--rollback` 自动在修改前创建全库备份；全库恢复覆盖配置、Token、outbox、历史和其他表。SQLite 转换在单写事务中完成，租约续期且异常回滚；plain/compact/gzip 源格式完整校验，转换比较全部字段与稀疏元数据。回滚版本是**本次改造代码 + STATE_STORAGE_VERSION=1**，不是任意旧二进制。回滚展开 v2 样本及稀疏字段；若新原生延迟无法由旧 16-bit 整数无损表达，拒绝数据回滚，应使用完整备份恢复。回滚后可识别并重新迁移。

D1 操作工具：

```sh
node scripts/migrate-d1.mjs --plan NEW-private-plan.json --database-id UUID --dry-run
STATE_MIGRATION_APPROVED=1 node scripts/migrate-d1.mjs \
  --plan NEW-private-plan.json --database-id UUID --apply \
  --writers-paused --backup NEW-full-export.sql
```

凭据只从环境读取。`--apply` 先用 Wrangler 导出全库，再使用独立 REST 请求，避免把整个大迁移塞入一个 Worker 执行；Cloudflare API 的 batch 请求形状见 [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)。每段续期、条件写入并核对行数与完整语义，全部成功前不激活版本；失败可用相同计划重跑，receipt 和版本不会伪报成功。计划最多 16 MiB，段最多 128 行/1 MiB，迁移接口没有安装到网页 API。D1 全库 SQL 导出应先在私有 SQLite 文件中载入，以生成经过校验的计划；禁止手工只导出 state 一行代替全库备份。

生产切换步骤和当前授权记录见 `docs/refactor-deployment.md`。删除备份后失去本地回滚来源；本次用户要求在新部署验证成功后删除本项目所有备份，自动任务按此顺序执行。
