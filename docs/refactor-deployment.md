# 生产续作记录

用户已经明确授权：本地完整改造后部署；新部署验证后移除本项目所有旧 Worker/资源和备份。2026-10-05 本地操作时 D1 返回代码 7500：当日免费行读取额度耗尽。用户选择“额度恢复后自动继续”，检查时间为新加坡 08:05（UTC 00:05）。禁止为此自动升级付费套餐。

当前已经执行并读取 Cloudflare 配置验证：`uptimeflare-distributed-worker` 的 Cron 列表为空，workers.dev 和 previews_enabled 都是 false。旧 Pages `uptimeflare-distributed` 尚保留；不要把“入口停用”写成旧 Worker 已删除。Cloudflare 触发器配置传播可能有延迟，迁移前还需核实没有活动写入租约。

## 范围与配置

- 工作区 `/Users/cat/Documents/ChatGPT/light-prober`；服务端子仓库 `UptimeFlare/`；Go 探针独立仓库。
- GitHub：`WhereAreBugs/UptimeFlare-Distributed` 与 `WhereAreBugs/UptimeFlare-Distributed-prober`。本地 GitHub CLI 位于根目录 `bin/tools/gh`。
- 域名 `status.catxxp123.top`，旧 Worker `uptimeflare-distributed-worker`，新统一 Worker 默认 `uptimeflare-distributed`。
- 当前数据库名 `uptimeflare-distributed-d1`。保留正在使用且已经验证的数据，不能因“清理旧资源”删除唯一活动数据库或 KV。
- 当前公共 KV `uptimeflare-distributed-public-status`。新 Worker 可复用；若决定换库或 KV，要先迁移并核对新资源，再删除被替代的旧资源。
- 根目录 `.deployment/cloudflare.json` 存 account_id/api_token；admin.json 存管理员 password/session_secret；probes.json 存稳定探针令牌；hosts.json/metadata.json 存既有安装信息。都是私有凭据/运行配置，不属于“备份”，保留、禁止输出或提交。
- SSH 主机为 `root@45.192.249.191`、`root@45.207.35.75`。先读取远端架构、systemd 与缓存状态，按已授权 SSH 方式连接，保持本地持久队列和 OpenTelemetry 设置。禁止删 queue.db 来绕过补传。
- 原有 Header logo 尺寸改动已保留原样并单独提交；部署前按当前源码生成静态资源，避免误覆盖。

## 续作步骤

1. 仅以一次轻量 D1 查询确认额度恢复；没有恢复时保持旧 Cron 停用，不循环执行大查询或导出。
2. 读取当前资源和域名归属、确认旧生产者停止。保留现有配置、暂停状态、Token 和全部历史。读取当前 KV 可验证公共页面，不能用缓存当数据库迁移成功证据。
3. 用临时私有 Wrangler 配置和本地凭据创建完整 D1 SQL 导出；核验导出可载入 SQLite。加兼容表后做 `state_v2.py --dry-run --plan` 与本地完整语义比对。备份不得只有 state 一行。
4. 新统一 Worker 先使用 STATE_STORAGE_VERSION=1、MIGRATION_MODE=1、无 Cron；ASSETS/D1/KV/两个 DO 绑定齐全，并装入原 Secrets。先验证静态资源及公开缓存、鉴权 401、正确鉴权的 ingest 503。
5. 将状态域名切到此维护入口，阻止 Go 正常上报写入而允许其落盘补传；旧 Pages 的 pages.dev 写入入口也要停用，避免旁路生产者。待旧在途租约结束后，导出最终一致快照并生成计划。不要假设清 Cron 等于瞬间没有在途执行。
6. `migrate-d1.mjs --dry-run` 成功后显式 `STATE_MIGRATION_APPROVED=1` apply。按工具要求再次完整备份、分段续期和验证，完成后确认 storage_versions=2、migration_runs complete、全部样本及字段语义一致。
7. 用 `deploy/provision.py prepare` 生成统一配置（UNIFIED_DEPLOY_APPROVED=1、STATE_STORAGE_VERSION=2），MIGRATION_MODE=0，正常 Cron。部署当前静态产物和 Worker，保留原密码、Session secret、probe tokens。迁移完成后才能打开 GitHub Actions 的 UNIFIED_DEPLOY_APPROVED 和 STATE_STORAGE_VERSION=2，并推送分阶段提交/启用自动部署，不能让工作流用默认 v1 误覆盖线上版本。
8. 部署两台主机的新 Go 构建，先原子替换二进制并重启 systemd，再验证配置获取、真实新结果、服务端 latest 更新、积压批次 ACK 消减与遥测；只看 systemd active 不算完成。跨平台产物在根目录 `bin/refactor/`；生产构建应写入提交版本标识。
9. 核验首页、移动端色带/页内详情、单目标历史、事故分页、徽章、管理员登录、管理 Token 的分组边界、暂停/恢复、维护计数、通知模板和两台探针/Cloudflare 探针的新样本。用唯一虚构敏感标记核验公开 API 与产物，避免触发真实通知给第三方。开启短期 METRICS_ENABLED=1 检查根/DO SQL 与读写、CPU 平台遥测；记录真实限制，不把本地墙钟当 CPU。
10. 新部署验证完成后删除旧 Worker（及其所属 DO 资源）、旧 Pages 项目、未使用的旧路由/DNS、被新资源取代的旧 D1/KV；保留正在使用的新 D1/KV/域名。重新列表验证无遗留本项目旧资源，不删除其他项目。
11. 按用户要求移除本项目全部迁移临时 SQL/SQLite/计划/归档、旧 D1 回滚备份、`.deployment/*before*` 或同类旧配置备份、`public-dashboard-recovery.json` 备份文件和远端 `light-prober.previous-*` 等二进制备份。凭据、实际 queue.db/config.json 及现有活跃数据不删除。自动平台 Time Travel 若不可单独删除，应明确记录平台保留限制，不能声称已经物理清除。提交部署/清理报告，确认备份清理完成后停止自动续作任务。

需要的 API 权限包括 Workers Scripts 编辑、D1 编辑、KV 编辑、Pages 编辑、Workers Routes/域名所需 zone 权限；凭据已有基础授权，新增拒绝时报告具体 API/权限，不在聊天中索要明文密钥。所有生产操作输出只保留资源名、计数、版本、hash 或错误码，不输出配置值/原始错误响应。
