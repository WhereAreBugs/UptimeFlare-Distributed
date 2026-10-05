# 生产续作记录

2026-10-05，用户要求立即清理旧资源、先彻底切换新代码。本次已经删除旧 Worker、专属 DO、旧 Pages 全部 21 个部署、统一 Worker 的 9 个旧版本及全部可管理的项目备份。域名 `status.catxxp123.top` 仅由新统一 Worker `uptimeflare-distributed` 接管，源码 `33ed1be`（清理入口 `eef0b22`），state-v2。详见 [清理报告](refactor-cleanup.md)。不要重建旧资源、恢复 v1 或重新创建备份。

生产迁移及两台 Go 升级已经完成。剩余端到端验收仍等待 D1 当日额度恢复；下一次自动检查为 2026-10-06 新加坡 08:05（UTC 00:05）。禁止自动升级付费、重复迁移、大导出或循环查询。

## 范围与配置

- 工作区 `/Users/cat/Documents/ChatGPT/light-prober`，服务端子仓库 `UptimeFlare/`，Go 探针独立仓库。
- GitHub：`WhereAreBugs/UptimeFlare-Distributed` 与 `WhereAreBugs/UptimeFlare-Distributed-prober`；CLI 在根 `bin/tools/gh`。
- 活动 D1：`uptimeflare-distributed-d1`；公共 KV：`uptimeflare-distributed-public-status`；DO：新 Worker 的 `Coordinator` 和 `RemoteChecker`。保留当前数据与绑定。
- 私有 `.deployment/cloudflare.json`、admin.json、probes.json、hosts.json、metadata.json、telemetry.json 和 probe-*.env 是当前凭据/配置，保留并禁止输出或提交。
- SSH：`root@45.192.249.191`、`root@45.207.35.75`。两台当前版本 `2b5de8d`，真实 queue.db/config.json 与遥测设置均保留。当前跨平台构建在 `bin/refactor/`。
- 用户 logo 尺寸改动已保留，后续不得覆盖。

## 已完成的生产转换

完整一致性快照、冻结旧写入入口、在途租约排空、严格语义迁移及完整比对均已执行：1340 个完整结果块、1820 个失败事件，共 3160 行。`storage_versions.version=2`，`migration_runs` 中 `state-v2` complete、lease_until=0。原配置、暂停状态、Token 和历史保留。全部迁移快照及回滚备份现已按用户要求删除；不要再重复 apply 或完整导出。

## 剩余续作步骤

1. 先做一次 `SELECT version FROM storage_versions WHERE id=1`。本次元数据查询成功但真实管理请求仍报告 `d1_read_quota`；因此该查询成功后还需一次真实管理员登录与配置读取，不能仅凭单行查询宣布恢复。任一步明确报当日读取额度耗尽时保持新 Cron 暂停、GitHub `CRON_ENABLED=0`/`UNIFIED_DEPLOY_APPROVED=0`，安静等待下一次；独立 Go 继续落盘。不能把所有 7500 误判为额度错误。
2. 返回正常时确认 version=2，再核对 `migration_runs` 的 complete 和 lease_until=0。与记录冲突时调查，不重启旧生产者、不重新迁移。
3. 核对 Git、当前配置和绑定，恢复新统一 Worker 一分钟 Cron，保持 STATE_STORAGE_VERSION=2/MIGRATION_MODE=0。根 `.deployment/refactor-production/unified-quota-paused.json` 是当前无 Cron 配置，恢复前核对源码与实际绑定。
4. 使用根私有 `inspect-probes.py` 核对两台真实队列；该脚本短暂停服务只读检查后确保恢复。SSH agent 本次为 `/var/run/com.apple.launchd.jgwILRXOgf/Listeners`，代理为 `scripts/ssh-physical.py %h %p en5`，变化时重新发现 agent，不读取私钥。验证远程配置、真实新样本、服务端 latest、批次 ACK 和积压消减，不能以 active 或空队列代替新上报证据。
5. 根私有 `verify-production.py` 使用 `settings-fingerprints.json` 的不可恢复 SHA256 核验原配置，不依赖已删除备份。实际完成 HTTP/管理 Token 分组边界/越权/撤销、暂停恢复、维护计数、历史、移动端色带与仅三项页内详情。临时 Token/目标测试后清理，不发送虚构通知给真实 Webhook。
6. 两台 OpenTelemetry 已开启且无导出错误，写入入口 200，但 9999 查询入口 401。使用用户补充的查询地址与本地私有凭据确认后端新数据；不能以空写入成功代替新指标验收。
7. 核对 `D1_VERIFIED_DATABASE_ID`、init.sql hash，GitHub `CRON_ENABLED=1`、`UNIFIED_DEPLOY_APPROVED=1`，按普通快进推送并确认 CI/自动部署成功。工作流固定 v2，不能覆盖用户后续 main 提交。生产临时 Worker 资源测量后保持 METRICS_ENABLED=0，Go 遥测保留。
8. 所有旧资源、旧版本、手动备份已经清理；只需最终复核没有重新出现，保留当前构建、当前凭据和真实队列。Time Travel 自动历史保留 7 天，平台无单个恢复点删除 API。更新生产报告和 TODO，全部验收完成后停止 heartbeat。

凭据只从当前本地私有配置读取，输出仅保留名称、计数、版本、hash 或错误码。独立 zone Workers Routes 列表曾返回 403；旧 Worker/DO/Pages 已通过资源列表验证删除，新域名绑定及 DNS 已确认。若以后确需该独立清单，记录实际权限限制。
