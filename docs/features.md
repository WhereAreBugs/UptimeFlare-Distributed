# 功能矩阵与简明示例

本页按英文 README 的 31 项历史 TODO 逐项核对当前分布式版本。删除线保留原项目已经撤销或被通用方案替代的条目含义；它不表示重新加入某个专用通知 SDK。源码入口与回归测试用于说明实现链路，第三方实际投递、Cloudflare 地区放置和每个平台的实机行为仍需在自己的环境验证。

## 31 项功能矩阵

| #   | 原 TODO                                                            | 当前实现与入口                                                                                                                                | 范围与验证边界                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Specify region for monitors                                        | [`doMonitor`](../worker/src/monitor.ts) 支持 `worker://` 地区提示、`globalping://` 和 HTTP 检测代理；也可分配物理地区的 Go 探针。             | Worker/Globalping 地区代理仅分配给 Cloudflare；Go 使用 HTTP 代理。Cloudflare 放置是提示，实际位置以检查返回值为准。                                                                            |
| 2   | TCP `opened` promise                                               | [`getStatus`](../worker/src/monitor.ts) 等待 `cloudflare:sockets` 的 `opened`，设置超时并在结束时关闭 socket；Go 使用带截止时间的 TCP 建连。  | TCP 端口成功不等同于应用协议正常，不需要 ICMP 权限。                                                                                                                                           |
| 3   | Use apprise to support various notification channels               | 管理页 Webhook 模板 → [`notifications.ts`](../worker/src/notifications.ts) → 独立 Apprise API。                                               | 本项目发送 HTTP；渠道配置与服务商鉴权由 Apprise 管理，示例见下文。                                                                                                                             |
| 4   | ~~Telegram example~~                                               | 通用 Webhook 模板可以调用 Telegram `sendMessage`。                                                                                            | 历史专用示例已被模板取代；未新增 Telegram SDK，真实机器人投递需用户验证。                                                                                                                      |
| 5   | ~~Bark example~~                                                   | 通用 JSON Webhook 模板可以调用 Bark `/push`。                                                                                                 | 历史专用示例已被模板取代；设备密钥仅放在管理员模板中。                                                                                                                                         |
| 6   | ~~Email notification via Cloudflare Email Workers~~                | 通用 Webhook 可委托用户部署的 Cloudflare Email Worker。                                                                                       | 保留历史撤销标记；本仓库未新增原生邮件账户、SMTP 鉴权或专用发信服务。                                                                                                                          |
| 7   | Improve docs by providing simple examples                          | 本页覆盖管理配置、目标、地区代理、通知与开发；[安装说明](external-probes.md) 覆盖共享 D1 与上线探针。                                         | 所有凭据示例均为占位符。                                                                                                                                                                       |
| 8   | Notification grace period                                          | 管理页提供全局分钟数和目标秒数覆盖；[`notifications.ts`](../worker/src/notifications.ts) 通过分钟观察、D1 状态和 outbox 延迟故障通知。        | 旧源码 `notification.webhook` 也转换为内部模板进入同一持久观察路径；支持跨检测周期宽限、已通知故障后的恢复门控、维护抑制与原因变化策略。                                                       |
| 9   | SSL certificate checks                                             | `SSL_CERT` → Go TLS 握手/系统信任链/主机名验证 → 到期时间与剩余天数 → D1 → 独立探针详情。                                                     | 默认到期阈值 14 天，可设 0–365 天。Cloudflare 需 HTTP 检测代理；Workers `fetch` 无法提供此检查所需的对端证书。已验证真实 Worker 运行时、Go 检测与 D1 元数据/日桶链路；第三方代理仍需部署验证。 |
| 10  | ~~Self-host Dockerfile~~                                           | 分支保留 [`Dockerfile`](../Dockerfile) 与 [`entrypoint.sh`](../entrypoint.sh)，运行 Worker、Pages 和本地调度。                                | 原文撤销的是历史 Docker 条目；本分支提供本地方案。Worker/Pages 必须共享 D1、变量与持久目录，并通过本地运行验收。                                                                               |
| 11  | Incident history                                                   | `/incidents` 与 [`/api/incidents`](../pages/api/incidents.ts) 按月份与目标过滤，分页加载原生故障段和独立探针失败样本。                        | 最多约 90 天；原生持续故障段和探针单次失败分别展示，不混算持续时间。                                                                                                                           |
| 12  | Improve `checkLocationWorkerRoute` and fix possible `proxy failed` | 原地区路由现由 [`doMonitor`](../worker/src/monitor.ts) 的 Durable Object RPC、Globalping 与 HTTP 代理分支实现；可配置回退。                   | 代理失败显示 `proxy` 阶段；回退仅适用于本地支持的检查，代理端应有独立鉴权。                                                                                                                    |
| 13  | Groups                                                             | 管理页“分组” → D1 `page.group` → [`MonitorList`](../components/MonitorList.tsx) 的折叠分组与汇总。                                            | 名称选择目标，支持排序；每个目标保存到一个分组，未分组目标自动补充显示，展开偏好本地保存。                                                                                                     |
| 14  | Remove old incidents                                               | 原生路径删除已结束的过期故障；[`cleanupProbeResults`](../worker/src/probes.ts) 有界清理过期样本、五分钟桶、日桶与统计。                       | 默认约 90 天；大批数据的清理可能需要多轮，持续故障保留其开始时间。                                                                                                                             |
| 15  | ~~Known issue~~: non-standard `fetch` port                         | HTTP/HTTPS URL 与 TCP 端口检查接受有效的显式端口，非标准端口已进入本地 HTTP/TCP 回归链路。                                                    | 保留上游“平台问题已解决”语义；Cloudflare 自身的出站网络限制仍适用。                                                                                                                            |
| 16  | Compatibility date update                                          | Worker/Pages 源配置、部署生成配置与 Terraform 使用显式 `compatibility_date` 和 `nodejs_compat`。                                              | 当前日期以对应配置文件为准，升级运行时后仍需回归 sockets、hex 编码与构建。                                                                                                                     |
| 17  | Scheduled Maintenance                                              | 管理页“维护计划” → D1 → 当前维护提示、目标维护图标、事件显示与通知抑制。                                                                      | 可针对选定目标或所有目标；维护保留实际检查数据，不把目标强行记为成功。                                                                                                                         |
| 18  | Add docs for dev                                                   | 下文提供依赖安装、Worker/纯函数测试、lint、Next 构建与 Pages 构建命令。                                                                       | 联合网络测试需要独立 Go 仓库及其二进制，构建成功不能代替运行验证。                                                                                                                             |
| 19  | Migration to Terraform Cloudflare provider version 5.x             | [`deploy.tf`](../deploy.tf) 保留 provider `~> 5` 的资源声明。默认部署改用 Actions 与 [`provision.py`](../deploy/provision.py)。               | Terraform 为已有部署兼容路径；按[专用说明](terraform.md)提供分布式 secrets 与共享绑定，不能与 Actions 同时管理同一套资源。                                                                     |
| 20  | Cloudflare D1 database                                             | [`init.sql`](../init.sql)、[`migrations`](../migrations) 与 Worker/Pages 共享 `UPTIMEFLARE_D1`，包括原生 state、探针历史、配置与通知 outbox。 | 新安装使用完整 schema；已有安装在发布前按序执行全部迁移。                                                                                                                                      |
| 21  | Scheduled maintenances (via IIFE)                                  | 旧源码 `maintenances` 数组仍为初始回退；新管理界面通过 [`expandMaintenances`](../util/maintenance.ts) 展开日/周/月计划。                      | 重复按指定 IANA 时区的本地时刻与固定持续时间计算；DST 不存在的时刻跳过，月底日期取该月最后一天，窗口有界。                                                                                     |
| 22  | Simpler config example                                             | 普通操作使用管理页名称选择，ID 自动生成；Go 探针只需服务端地址与独立令牌。                                                                    | 每目标周期默认 300 秒、超时默认 5000 毫秒；有需要时才填写覆盖值。                                                                                                                              |
| 23  | Upcoming maintenances                                              | [`OverallStatus`](../components/OverallStatus.tsx) 可展开未来维护；提示颜色由页面设置管理。                                                   | 重复计划仅展开需要的保留窗口及未来 30 天，不无限生成事件。                                                                                                                                     |
| 24  | Universal Webhook upgrade                                          | 管理页模板支持 JSON、查询参数、表单、请求头、方法、超时、嵌套变量替换与目标复用；D1 outbox 重试和事件标识去重。                               | 以 HTTP 2xx 判断投递成功，不解释供应商响应正文；接收端须用稳定事件标识去重，通知可能重试。                                                                                                     |
| 25  | i18n...? (maybe)                                                   | [`i18n.ts`](../util/i18n.ts) 与 [`locales`](../locales) 提供公共状态页、历史、图表和诊断文案。                                                | 新分布式界面有英文与简体中文；其余已有语言缺少的新键回退英文，管理编辑器当前使用中文。                                                                                                         |
| 26  | ICMP via proxy?                                                    | `ICMP_PING` → Go 本机 ICMP 或 HTTP 代理，Cloudflare 可用 HTTP ICMP 代理或 Globalping；结果包含 ICMP RTT。                                     | Go 在 Linux/macOS 使用 ping socket，在 Windows 使用 IP Helper；权限或不支持时明确报错，也可使用代理。已验证真实 Worker 运行时、Go 检测与 D1 元数据/日桶链路；第三方代理仍需部署验证。          |
| 27  | Add default UA                                                     | Worker HTTP 检查自动提供 `UptimeFlare/...` UA；Go HTTP 检查提供自身 UA。                                                                      | 明确配置的 `User-Agent` 优先；无需每个目标重复设置。                                                                                                                                           |
| 28  | Customizable footer                                                | 管理页“页面设置” → 服务端 HTML 清理 → D1 → [`Footer`](../components/Footer.tsx)。                                                             | 限定标签、属性、协议与样式；留空使用默认页脚。                                                                                                                                                 |
| 29  | New header logo                                                    | 页面设置可修改 Logo、favicon、标题与导航；[`Header`](../components/Header.tsx) 使用动态设置。                                                 | 支持安全的 HTTP/HTTPS 地址或站内路径，公开页面不包含目标鉴权配置。                                                                                                                             |
| 30  | Improve CPU time usage                                             | 原生 state 保留列式/RLE/hex 编码；探针写入事务增量更新统计与日桶，公共读取范围有界；折线图按展开挂载。                                        | 控制并发、历史、目标与分配数量；没有把上游历史 benchmark 当作当前硬件性能承诺。                                                                                                                |
| 31  | Local deployment (docs WIP)                                        | 本地 Worker/Pages 构建与 Docker 流程见下文；Go 探针可直接运行独立二进制。                                                                     | 本地运行使用真实 Miniflare/Workerd D1；地区放置、Email binding 和第三方服务仍需对应环境。                                                                                                      |

## 管理页与最少配置

完成[服务端安装](external-probes.md)并设置管理 secrets 后，访问 `/admin`。六个标签页分别管理目标、探针、通知、分组、维护计划和页面设置；切换标签不会丢弃未保存草稿，最后统一保存到 D1。

新增一个 HTTP 目标，只需要名称、目标 URL、检测方法和执行探针。检测周期、超时、关键词、状态码和通知均可按需要添加；Cloudflare 是无需令牌的内置探针。分组选择目标名称、调整顺序后保存；维护计划填写说明、起止时间与影响目标，重复计划还需要结束时间和时区。

网页目标至少选择一个执行探针。没有 `probes` 的旧源码监控属于原生兼容路径，不是网页新建目标的形式。

以下是源码初始配置例子，内部标识仅用于源码关联；网页编辑时无需填写它们。首次网页保存后，以 D1 配置为准，重部署不会恢复源码初始值。

```ts
const workerConfig: WorkerConfig = {
  probes: [{ id: 'sg', name: 'Singapore' }],
  monitors: [
    {
      id: 'website',
      name: 'Website',
      method: 'GET',
      target: 'https://example.com',
      probes: ['cloudflare', 'sg'],
      // 默认 intervalSeconds: 300、timeout: 5000，可省略。
    },
  ],
}
```

为 `sg` 配置独立服务端令牌后，在对应主机运行：

```sh
export LIGHT_PROBER_SERVER=https://status.example.com
export LIGHT_PROBER_TOKEN=REPLACE_WITH_INDEPENDENT_RANDOM_TOKEN
./light-prober
```

目标及其周期自动下发。配置刷新默认五分钟，结果先同步落盘，再 gzip 批量上传；每台探针保留自己的数据目录。移除目标或分配前先补传完队列，避免产生被服务端拒绝的历史结果。

## SSL、ICMP 与地区代理

管理页的 `SSL_CERT` 使用 HTTPS URL，例如 `https://example.com`，并选择 Go 探针。省略到期阈值时为 14 天；检查验证信任链与主机名，不使用跳过证书验证来判断成功。独立详情显示到期时间、剩余天数及 `tls/certificate` 或 `tls/expiring` 等原因。

`ICMP_PING` 使用主机名或 IP，目标不加端口，例如 `example.com` 或 `2001:db8::1`。本机没有所需 ping socket 权限或平台实现时，会显示 `configuration/permission` 或 `configuration/unsupported`；代理可以继续使用相同检查类型。

HTTP 检测代理的统一地址为用户部署的 `check-proxy` 的 `/v1/check`，支持 HTTP/TCP/SSL/ICMP，默认仅监听本机；对 Cloudflare 或远程探针提供地址时，需要配置 HTTPS。代理有独立令牌，目标本身的鉴权头和代理鉴权头分别设置：

```json
{
  "checkProxyHeaders": {
    "Authorization": "Bearer REPLACE_WITH_CHECK_PROXY_TOKEN"
  }
}
```

把它填写到目标“附加设置”的 JSON，将“检测代理”设置为 `https://proxy.example.com/v1/check`。证书检查分配给 Cloudflare 时也必须通过此类代理。可开启“代理不可用时尝试直接检测”；本地无法执行的 SSL/ICMP 检查仍需有效代理。

Cloudflare 还支持在“检测代理”中填写 `worker://weur` 或 `globalping://REPLACE_WITH_GLOBALPING_TOKEN?magic=Singapore&ipVersion=4`。`worker://` 选择 Cloudflare 的地区放置提示，不保证指定城市；Globalping 的 `magic` 由其服务选择节点。Globalping HTTP 检查仅支持 GET/HEAD/OPTIONS，不能发送自定义请求体；SSL 到期检查使用 Go/HTTP 代理。[Cloudflare 放置规则](https://developers.cloudflare.com/durable-objects/reference/data-location/)说明了提示的限制。

## Webhook 示例

在“通知”中新增模板，再在目标中选择该模板。下列 JSON 为模板的 `webhook` 配置；网页可分别填写推送地址、方法、参数格式、请求头与正文。默认超时 5000 毫秒。

`$MSG`、`$MONITOR`、`$STATUS`、`$TIME`、`$REASON`、`$DURATION`、`$EVENT_ID` 可出现在正文字符串内；变量替换后再编码 JSON，不手工拼接消息。真实密钥仅保存到已鉴权的管理配置，下面的 `REPLACE_WITH_...` 均须替换。模板不会下发给探针或出现在公共 API。

### Apprise

先在自己的 Apprise API 配置并保存通知渠道，用配置键发送。该格式对应 [Apprise API 的 `/notify/{KEY}`](https://github.com/caronc/apprise-api#persistent-stateful-storage-solution)：

```json
{
  "url": "https://apprise.example.com/notify/REPLACE_WITH_CONFIG_KEY",
  "method": "POST",
  "payloadType": "json",
  "payload": { "title": "$MONITOR · $STATUS", "body": "$MSG" },
  "timeout": 5000
}
```

若该服务前有自己的鉴权代理，在请求头中填写其要求的凭据；Apprise 默认部署的权限策略与本状态页管理会话分别配置。

### Telegram

创建自己的机器人并填写聊天标识。使用 [Bot API `sendMessage`](https://core.telegram.org/bots/api#sendmessage) 的 JSON 格式，省略 `parse_mode` 以避免消息中的特殊字符被解释为标记：

```json
{
  "url": "https://api.telegram.org/botREPLACE_WITH_BOT_TOKEN/sendMessage",
  "method": "POST",
  "payloadType": "json",
  "payload": { "chat_id": "REPLACE_WITH_CHAT_ID", "text": "$MSG" },
  "timeout": 5000
}
```

### Bark

使用自己的 Bark 服务或公共推送服务的 HTTPS 地址。字段对应 [Bark API V2](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md)：

```json
{
  "url": "https://bark.example.com/push",
  "method": "POST",
  "payloadType": "json",
  "payload": {
    "device_key": "REPLACE_WITH_DEVICE_KEY",
    "title": "$MONITOR · $STATUS",
    "body": "$MSG",
    "group": "UptimeFlare"
  },
  "timeout": 5000
}
```

### Cloudflare Email Worker

这仍是通用 Webhook 的外部接收端，不是本项目内置邮件账户。先自行部署一个已鉴权的 HTTPS Worker，让它接收 `subject` 和 `text`，通过自己的 Email binding 向固定允许的地址发送邮件。binding、发件/收件限制与邮箱验证按 [Workers 发信 API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)及[发送绑定说明](https://developers.cloudflare.com/email-service/configuration/send-bindings/)配置。

```json
{
  "url": "https://email-worker.example.com/notify",
  "method": "POST",
  "payloadType": "json",
  "headers": { "Authorization": "Bearer REPLACE_WITH_EMAIL_WEBHOOK_TOKEN" },
  "payload": { "subject": "$MONITOR · $STATUS", "text": "$MSG" },
  "timeout": 5000
}
```

这些格式已按提供方接口文档核对，未使用真实密钥发送消息。模板只判断 HTTP 状态；如果某接收端用 HTTP 2xx 表示业务失败，应由适配器转换为非 2xx。投递可能重试，接收端可使用 `X-UptimeFlare-Event-ID` 或 `Idempotency-Key` 去重。

## 折线图、90 天历史与 API

分布式目标可展开查看汇总及各探针的 12 小时延迟折线、90 天 UTC 日可用率条/折线和阶段统计。失败或缺失时间段以断线/灰色表示；延迟折线只绘制全部成功的五分钟桶，不用失败结果伪装成零延迟。90 天可用率由有记录的检查样本计算，不代表对未采集时段的完整时间覆盖。

`/incidents` 按月份展开查询，`/api/incidents` 支持 `from`/`to`（Unix 秒）、`monitor`、`probe`、`kind` 与分页游标，单页最多 100 条。`/api/data` 与 `/api/badge?id=...` 保留轻量状态入口。公共输出不包含目标 URL、请求鉴权头、请求体、模板或令牌。

## 开发与部署

服务端推荐使用与 CI 一致的 Node.js 22。以下命令在服务端仓库执行：

```sh
npm ci
npm --prefix worker ci
npm --prefix worker test
npm --prefix worker run typecheck
node --test util/*.test.cjs
npm run lint
npm run build
npx --no-install @cloudflare/next-on-pages
```

`npm run dev` 启动 Next.js 视图开发服务器；需要绑定 D1 的 API 与管理员保存，应使用构建后的 Wrangler/Pages 本地流程。Next.js 单独启动不等同于完整 Worker/Pages 服务。

生产部署使用本仓库 `.github/workflows/deploy.yml`：检查、构建、幂等创建共享 D1、部署 Worker/Pages、设置 secrets 并处理自定义域名。所需 GitHub Secrets、迁移和绑定见[安装说明](external-probes.md)。先审查再推送 `main`；源码示例不放真实凭据。

本地 Worker/Pages 与 Docker 的完整运行步骤见[本地部署](local-deployment.md)：共享 `/app/.wrangler/state`，Pages 默认 8788，仅发布到宿主回环地址；Worker 8787 留在内部。开发 HTTPS 可使用本地自签证书，正式使用需可信 TLS。容器构建成功与持续调度、写入、重启持久化分别验证，不把本地运行视为真实地区放置或 Email binding 的验收。

已有 Terraform 部署参阅[Terraform 5 兼容流程](terraform.md)，与 Actions 选择一种资源管理方式。

Go 探针与 HTTP 检测代理位于独立[探针仓库](https://github.com/WhereAreBugs/UptimeFlare-Distributed-prober)，构建需要 Go 1.26。二进制运行无需 Node.js 或 C 编译器；遥测默认关闭，只有显式开启后初始化 OpenTelemetry 导出器。
