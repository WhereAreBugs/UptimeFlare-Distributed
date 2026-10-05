# 旧资源清理与代码切换

2026-10-05。用户明确要求立即移除旧资源并先彻底切换新代码，本次已执行。此清理结果与仍受 D1 额度影响的端到端监控验收分开记录。

## 已删除

| 项目 | 实际结果 |
| --- | --- |
| 旧 Worker `uptimeflare-distributed-worker` | 删除，列表复核不存在 |
| 旧专属 `RemoteChecker` DO namespace | 删除，列表复核不存在 |
| 旧 Pages `uptimeflare-distributed` | 项目及 21 个部署全部删除 |
| 新统一 Worker 中已替代的版本 | 删除 9 个，仅保留当前活动版本 |
| 旧 GitHub Actions 构建归档 | 两仓库共 13 个，911208993 字节 |
| 本地迁移、配置、二进制备份及旧构建产物 | 187 项，449854657 字节 |
| 两台探针旧二进制备份 | 共 6 个，91210700 字节 |
| 源码旧部署入口 | Pages API adapters、Terraform、Pages Wrangler 配置、旧初始化脚本及专用测试删除 |

本地完整 SQL、SQLite、迁移计划、before/after 配置快照、公共恢复快照、旧 Pages 构建产物均已删除。保留的验收指纹只有 SHA256 和数量，不能恢复原配置，不是配置备份。没有 GitHub Releases 归档需要清理。后续 CI 的当前构建产物只保留一天，供任务传递或下载。

## 当前唯一部署

- 新 Worker：`uptimeflare-distributed`，域名：`status.catxxp123.top`。
- 已发布源码提交：`33ed1be`（清理入口为 `eef0b22`）；活动 Worker version：`1119f492-6d24-4405-bd18-966e85b40a01`，100% 流量，版本列表仅余此项。
- `STATE_STORAGE_VERSION=2`、`MIGRATION_MODE=0`、`METRICS_ENABLED=0`。新 Cron 仍暂停；GitHub `CRON_ENABLED=0`、`UNIFIED_DEPLOY_APPROVED=0` 等待额度恢复。
- 项目只保留一个活动 D1 `uptimeflare-distributed-d1`、一个公共 KV `uptimeflare-distributed-public-status` 和新 Worker 的两个 DO；没有本项目旧 Pages 或旧 Worker。
- 管理员密码、会话密钥、探针令牌、当前运行配置与所有真实 `queue.db/config.json` 保留。两台探针 active，仍运行 `2b5de8d`，活动二进制 hash 与升级记录一致。
- logo 尺寸改动保留。首页、`/admin`、`/api/state` 实际返回 200，未鉴权 `/api/admin/config`、`/api/probes/config` 返回 401。

独立 zone Workers Routes 列表 API 返回 403，无法单独列举该类路由；已通过账号 Worker/DO/Pages/DNS/域名绑定列表确认旧服务消失、新服务接管，DNS 中没有旧 Pages 指向。不把未取得的独立路由清单写成检查通过。

## 验证及平台限制

193 项 Worker 测试及类型检查、11 项 Python 测试、41 项 util 测试、lint、静态构建和统一 Worker 构建通过；真实本地入口验证空库自动使用 v2，显式 v1、已有 v1 和缺少版本标记的历史库均拒绝启动。管理产物测试 70 项 HTTP 断言、公开缓存 522 项断言、500 目标/1500 分配容量、真实 Coordinator/区域 DO 测试通过。容量测试一次并发运行出现本地 socket 中断，单独复测通过；不将该首次失败隐藏为成功。

Cloudflare D1 Time Travel 自动开启，免费计划保留 7 天，没有单个恢复点删除 API。已删除所有可管理的本项目手动备份；平台自动历史须按平台保留窗口过期，未声称物理清除。参见 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。Worker 旧版本则已通过 [版本删除 API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/delete/) 实际删除。

新存储错误分类日志的生产实测确认管理请求仍为 `d1_read_quota`；轻量元数据查询曾成功，但不能据此视为额度恢复。D1 当日额度故障尚需恢复后的生产验收。独立探针持续采样落盘；不删除队列，不重新创建旧资源，不重复完整迁移或导出。续作步骤见 [部署记录](refactor-deployment.md)。

2026-10-05 后续部署检查：最新代码 `5f2743f`，唯一活动版本 `87990f65-ac18-48a4-bf96-57ece4e96435`，100% 流量；期间三次新版本均清理掉被替代项，累计已删除 12 个旧版本。PACKED_PROBE_COUNTERS=1、v2/MIGRATION_MODE=0、空 Cron；当前凭据/数据保留，公开 200/未鉴权 401 复核通过。没有新增手动备份、旧 Worker、Pages 或 D1/KV。
