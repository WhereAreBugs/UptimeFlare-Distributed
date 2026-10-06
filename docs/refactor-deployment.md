# 生产续作记录

2026-10-05，用户要求立即清理旧资源、先彻底切换新代码。本次已经删除旧 Worker、专属 DO、旧 Pages 全部 21 个部署、统一 Worker 的 9 个旧版本及全部可管理的项目备份。域名 `status.catxxp123.top` 仅由新统一 Worker `uptimeflare-distributed` 接管，源码 `33ed1be`（清理入口 `eef0b22`），state-v2。详见 [清理报告](refactor-cleanup.md)。不要重建旧资源、恢复 v1 或重新创建备份。

生产迁移及两台 Go 升级已经完成。2026-10-06 的 D1、配置读写、新 Cron 与 GitHub 自动部署已恢复；新样本、ACK、管理边界和手机交互均已验证。两台已配置独立的 OpenObserve 写入令牌，后端检测、上传及运行指标的新数据验收通过；令牌查询返回 401 是预期权限限制。生产验收完成，原自动续作已停止，详见生产报告文末。禁止自动升级付费、重复迁移、大导出或循环查询。

当前服务端运行代码为 `e806660`，两台 Go 探针为 `f0d45d6`；v2 数据语义保持，新增 SRE 运行指标及栈追踪。详情见 [SRE 说明](sre-observability.md) 和生产报告文末。2026-10-06 已恢复每分钟 Cron，STATE_STORAGE_VERSION=2/PACKED_PROBE_COUNTERS=1/MIGRATION_MODE=0。短窗口计数通过活动版本设置开启后关闭，最终 METRICS_ENABLED=0；活动版本 ID 以私有生产续作记录与平台当前部署为准，不恢复已替代版本。两套服务端 CI 已通过；一项既有 5 秒测试超时在单次失败作业重跑后通过，部署验证中暂停显示元数据的旧断言已修正。

D1 行数优化与相同失败合并均保留，参见 [D1 行数验收](d1-row-budget.md)、[失败合并验收](packed-failures.md)。新格式不需 schema 迁移或全表重写，不得降级到忽略累计文档/合并失败格式的代码。额度恢复后核对合并失败的逐次时间、阶段累计、去重和 ACK。最新本地页面配套不增加云端状态上报/存储；两台 Go 已升级 `f0d45d6`，不再重复升级。已删除本次替代版本，当前平台只保留一个活动版本；旧 CI 归档和 `bin/refactor/` 的被替代构建已清理。

## 范围与配置

- 工作区 `/Users/cat/Documents/ChatGPT/light-prober`，服务端子仓库 `UptimeFlare/`，Go 探针独立仓库。
- GitHub：`WhereAreBugs/UptimeFlare-Distributed` 与 `WhereAreBugs/UptimeFlare-Distributed-prober`；CLI 在根 `bin/tools/gh`。
- 活动 D1：`uptimeflare-distributed-d1`；公共 KV：`uptimeflare-distributed-public-status`；DO：新 Worker 的 `Coordinator` 和 `RemoteChecker`。保留当前数据与绑定。
- 私有 `.deployment/cloudflare.json`、admin.json、probes.json、hosts.json、metadata.json、telemetry.json、telemetry-write-tokens.json 和 probe-*.env 是当前凭据/配置，保留并禁止输出或提交。telemetry.json 的通用 headers 不含鉴权；probe_headers 按探针保存独立写入鉴权，不能跨探针覆盖。
- SSH：`root@45.192.249.191`、`root@45.207.35.75`。两台当前运行版本 `f0d45d6`，真实 queue.db/config.json 与遥测设置均保留。当前 macOS 构建在 `bin/light-prober`，生产 Linux 构建在 `bin/sre-linux-amd64`；旧验证构建已删除。旧 `bin/refactor/` 已删除。
- 用户 logo 尺寸改动已保留，后续不得覆盖。

## 已完成的生产转换

完整一致性快照、冻结旧写入入口、在途租约排空、严格语义迁移及完整比对均已执行：1340 个完整结果块、1820 个失败事件，共 3160 行。`storage_versions.version=2`，`migration_runs` 中 `state-v2` complete、lease_until=0。原配置、暂停状态、Token 和历史保留。全部迁移快照及回滚备份现已按用户要求删除；不要再重复 apply 或完整导出。

## 历史续作步骤（已完成，不再执行）

以下步骤仅保留历史续作顺序。2026-10-06 已完成额度、配置、暂停同步、新样本/ACK、累计/合并失败、管理边界、手机交互、CI、最终清理和 OpenObserve 新指标验收，不再重复全套查询或临时控制。Cron/门禁已恢复，不再重新开关。写入令牌无需查询权限，验收在 OpenObserve 主机内使用管理鉴权完成；后续无需保存额外查询凭据。

1. 先做一次 `SELECT version FROM storage_versions WHERE id=1`。本次元数据查询成功但真实管理请求仍报告 `d1_read_quota`；因此该查询成功后还需一次真实管理员登录与配置读取，不能仅凭单行查询宣布恢复。任一步明确报当日读取额度耗尽时保持新 Cron 暂停、GitHub `CRON_ENABLED=0`/`UNIFIED_DEPLOY_APPROVED=0`，安静等待下一次；独立 Go 继续落盘。不能把所有 7500 误判为额度错误。
2. 返回正常时确认 version=2，再核对 `migration_runs` 的 complete 和 lease_until=0。与记录冲突时调查，不重启旧生产者、不重新迁移。
3. 核对 Git、当前配置和绑定，恢复新统一 Worker 一分钟 Cron，保持 STATE_STORAGE_VERSION=2/MIGRATION_MODE=0/PACKED_PROBE_COUNTERS=1。根 `.deployment/refactor-production/unified-quota-paused.json` 是当前无 Cron 配置，恢复前核对源码与实际绑定。
4. 使用根私有 `inspect-probes.py` 核对两台真实队列；该脚本通过当前本机只读接口检查，不再为了读取统计停服务。SSH agent 本次为 `/var/run/com.apple.launchd.jgwILRXOgf/Listeners`，代理为 `scripts/ssh-physical.py %h %p en5`，变化时重新发现 agent，不读取私钥。验证远程配置、真实新样本、服务端 latest、批次 ACK 和积压消减，不能以 active 或空队列代替新上报证据。行数优化使用已有 D1 表逐条目接续累计值，无需重迁移或升级 Go；累计数以文档及 HTTP 摘要为准，不能拿已冻结的旧 probe_totals 行判断丢失。短期启用资源计数采集真实批次读写，结束后关闭。
5. 使用根私有 `refactor-production/settings-fingerprints.json` 的不可恢复 SHA256 核验原配置，不依赖已删除备份；若既有校验脚本已清理，按当前 API/源码实现窄范围验收，不恢复旧构建。实际完成 HTTP/管理 Token 分组边界/越权/撤销、暂停恢复、维护计数、历史、移动端色带与仅三项页内详情。临时 Token/目标测试后清理，不发送虚构通知给真实 Webhook。
6. 两台 OpenTelemetry 已开启且无导出错误，写入入口 200，但 9999 查询入口 401。使用用户补充的查询地址与本地私有凭据确认后端新数据；不能以空写入成功代替新指标验收。
7. 核对 `D1_VERIFIED_DATABASE_ID`、init.sql hash，GitHub `CRON_ENABLED=1`、`UNIFIED_DEPLOY_APPROVED=1`，按普通快进推送并确认 CI/自动部署成功。工作流固定 v2，不能覆盖用户后续 main 提交。生产临时 Worker 资源测量后保持 METRICS_ENABLED=0，Go 遥测保留。
8. 所有旧资源、旧版本、手动备份已经清理；只需最终复核没有重新出现，保留当前构建、当前凭据和真实队列。Time Travel 自动历史保留 7 天，平台无单个恢复点删除 API。更新生产报告和 TODO，全部验收完成后停止 heartbeat。

凭据只从当前本地私有配置读取，输出仅保留名称、计数、版本、hash 或错误码。独立 zone Workers Routes 列表曾返回 403；旧 Worker/DO/Pages 已通过资源列表验证删除，新域名绑定及 DNS 已确认。若以后确需该独立清单，记录实际权限限制。


本地页面首次发布：运行源码 6930e0a，Worker 活动版本 `5a93fc28-b306-4669-b5d3-79a020eb68eb`，100%；两台 Go 探针 7d0e48c，已实际验证回环页面、队列哈希保留、1 GiB 总预算和 ACK 后本地历史。后续 main 的验收断言/文档修改不需重复发布相同运行代码。用户已取消云端详情页及积压状态上报，不新增 DO/KV/D1 存储。两台均已成功同步注册名称与目标显示信息；云端补传仍重试，尚未取得升级后的新 ACK，继续沿用原真实新样本/ACK 验收，不依赖或恢复旧二进制。原空 Cron、迁移开关及 GitHub 门禁保持到原定恢复验收。

2026-10-06，本地历史扩展已在两台探针部署 `0f21ef2`：开启目标优先排序、12 小时／90 天色带和延迟／可用率折线已验证，升级回填及原队列摘要完全保留；保持 1 GiB 总预算及回环监听。本次不更换云端运行代码，不新增云端状态存储，不重复升级已运行的新探针。保留原云端新样本、ACK、遥测及门禁的剩余验收。
