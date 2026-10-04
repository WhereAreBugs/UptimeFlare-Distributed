# 外部 Go 探针与多探针汇总

在原 UptimeFlare 的 Worker/Pages 与 D1 架构上添加外部探针。原 Cloudflare 定时检测仍用于未设置 `probes` 的监控；设置该字段的目标由分配的 Go 或内置 Cloudflare 探针负责。服务端只检测明确分配给 Cloudflare 的目标。

## 服务端配置

在 `uptime.config.ts` 的 `workerConfig` 中添加：

```ts
probes: [
  { id: 'sg', name: 'Singapore', location: 'Singapore / ISP A' },
  { id: 'hk', name: 'Hong Kong', location: 'Hong Kong / ISP B' },
],
monitors: [
  {
    id: 'website', name: 'Website', method: 'GET',
    target: 'https://example.com', probes: ['sg', 'hk'],
    // 两项均可省略：默认检测周期 300 秒、单次超时 5000 毫秒
    intervalSeconds: 300, timeout: 5000,
  },
  {
    id: 'ssh', name: 'SSH', method: 'TCP_PING',
    target: 'example.com:22', probes: ['sg', 'hk'],
  },
],
```

每个探针令牌独立，设置 `PROBE_TOKENS` **secret** 为 JSON 对象：

```json
{
  "sg": "replace-with-a-unique-random-token-at-least-24-characters",
  "hk": "replace-with-another-independent-random-token"
}
```

令牌长度 24–512 字符，不允许空白或重复。可用 `openssl rand -hex 32` 生成。不要把真实令牌提交到源码。身份由令牌映射，不接受客户端任意指定探针 ID；上传目标必须属于该身份的 `probes` 分配。

本分布式版本通过 `.github/workflows/deploy.yml` 自动部署：向 `main` 推送或手动触发后，执行验证、构建，幂等创建共享 D1 和 Pages 项目，配置 production bindings，发布 Worker 与 Pages，绑定自定义域名。需要 GitHub Actions Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`PROBE_TOKENS`、`ADMIN_PASSWORD`（至少 16 字符）、`ADMIN_SESSION_SECRET`（至少 32 字符）。Secrets 只在部署步骤提供，预览环境不注入生产秘密。资源名称和域名在工作流的非秘密环境变量中修改。`deploy/provision.py` 不删除其他资源，发现已有 DNS 指向其他项目时停止。原 `deploy.tf` 保留供已有 Terraform 部署使用，但本仓库默认工作流不运行它。

`/api/probes/config` 与 `/api/probes/ingest` 可通过 Worker 或 Pages 同源访问。推荐探针配置 Pages 状态页地址，从而只维护一个地址。这两个精确路径由独立 bearer 鉴权，状态页原有 Basic 密码保护继续用于其他页面与 API。

## D1 安装与升级

新部署：`deploy/provision.py prepare` 自动执行更新后的 `init.sql`，包含新表。已有 D1：先执行幂等迁移，再发布新 Worker 与 Pages：

```sh
cd worker
npx wrangler d1 migrations apply uptimeflare_d1 --remote
```

`worker/wrangler.toml` 已设置迁移目录。先把示例 database ID 换成实际绑定。需包含 `0001`–`0007` 全部迁移；`0005_monitor_schedule.sql` 添加内置与原生目标的调度租约表，`0006_probe_history.sql` 从现有五分钟桶回填日汇总并创建稀疏诊断元数据表。回填以重算方式执行，重跑不会双计；如果旧 Worker 在回填后仍写入过数据，新 Worker 发布后再执行一次 `0006` SQL 文件可同步日汇总。`0007_notification_observations.sql` 保存通知宽限期及已通知状态。自动部署在切换新 Worker/Pages 后再次幂等回填日汇总。迁移不重写原 compact state，也不修改已保存的目标、显式超时或管理配置版本。

本地运行时，分别给 Worker 和 Pages 的本地变量文件设置测试用 `PROBE_TOKENS`；Worker 与 Pages 必须连接相同 D1。Docker 自托管会从容器环境读取变量，需给两者同样的 `PROBE_TOKENS` 并持久化 `.wrangler/state`。

## 网页配置管理

公开状态页无需登录。`/admin` 使用独立管理密码，密码和会话签名密钥设置为 Worker/Pages secrets，不写入公开源码。会话使用 Secure、HttpOnly、SameSite=Strict Cookie，8 小时过期；写操作校验同源 Origin，管理 API 不开放 CORS。每个来源地址每 15 分钟最多 10 次登录，D1 仅保存地址哈希。更换管理密码或签名密钥会使已有会话失效。

管理页按监控目标、探针、通知模板、分组、维护计划、页面设置六个标签页管理，草稿可跨标签保留并统一保存。登录后可以添加、编辑、删除 HTTP/HTTPS/TCP/SSL/ICMP 目标，设置检测周期、单次超时、状态码、关键词、请求头、请求体和探针分配，以及编辑探针显示名称与地区。页面不显示内部标识；目标和通知模板的标识自动生成并处理冲突，编辑现有目标会保留历史。新探针身份仍需先在 `PROBE_TOKENS` 配置独立令牌，重复的已注册探针条目和目标分配会自动合并。

内置 `cloudflare` 探针无需令牌，在“执行探针”中选择即可。可以仅分配 Cloudflare，也可以同时分配独立 Go 探针；Worker 的 cron 每分钟检查调度，Cloudflare 仅检测已到达各自周期的目标，结果写入同一组 D1 样本、累计统计和五分钟历史。未分配给 Cloudflare 的目标不会由该内置探针检测。Cloudflare 支持目标配置的区域或 HTTP 检查代理；SSL_CERT 需通过 Go HTTP 代理，ICMP 可使用 HTTP 代理或 Globalping。无 probes 的原生监控也按目标周期执行，并保留原历史、通知和回调流程。

每个目标的 `intervalSeconds` 为 60–86400 的整数，省略时为 300 秒；`timeout` 仍以毫秒表示，省略时为 5000 毫秒。数据库里已有的显式超时（例如 10000 毫秒）继续生效。离线判定自动使用该目标周期的两倍，恰好达到边界时仍有效，超过边界才显示 `unknown`。旧配置的全局 `probeStaleAfterSeconds` 被忽略，不再出现在管理接口或页面；读取旧记录不会改写目标、令牌、管理密码或配置版本。

新目标和影响检查的配置变更通常在下一次 cron 检测，不等待旧周期；仍在执行的检查完成或租约回收后再检测新配置。cron 的一分钟精度会把非整分钟周期向后推迟不足一分钟；只修改名称或通知模板不会额外检测。D1 租约避免并发或重复 cron 重复检测，检查结果与调度完成状态在同一事务保存；失去租约的旧执行者不能写入结果。内置检查未到期时不请求节点位置，也不更新探针标签。异常终止的租约最长 15 分钟后可回收。原生目标通过共享写入租约保护 compact state，仅有新检查时持久化，通知和新鲜度使用该目标最近的检查时间，不使用其他目标更新的全局时间。

独立探针名称留空时，显示服务端从探针配置请求的 Cloudflare `cf` 元数据获取的公网出口 IP 国家、地区、城市与 ASN，例如 `US / California / Los Angeles · AS64512`。不读取客户端自报的请求头，不依赖第三方 IP 查询服务，也不增加探针网络请求。配置刷新时更新已变化的标签，缺失元数据时保留旧标签，手动名称与地区优先。平台元数据首次获取前显示探针序号；使用代理出口时对应代理公网 IP。

Cloudflare 没有固定服务器 IP，默认显示最近执行节点，例如 `Cloudflare SIN · AS13335`；节点可随调度变化。`cloudflare` 为保留身份，不能在 `PROBE_TOKENS` 中分配外部令牌，以避免独立探针冒充内置检查。

已有安装需执行 `migrations/0003_probe_metadata.sql`；自动部署的 `init.sql` 会幂等创建标签表。数据库中的旧自定义名称不会被自动覆盖，将名称清空即可使用自动命名。Cloudflare 正文关键词检查限于 1 MiB，读取超时或超过上限时分别显示 `body/timeout` 和 `body/too_large`。HTTP 检查与 Go 探针一致，不跟随重定向；需要接受 3xx 时显式配置预期状态码，或直接配置最终地址。

保存后配置存储在 D1 `admin_config`，带版本冲突检测；探针下一次刷新通常在 5 分钟内获取。页面、API、scheduled Worker 和配置接口使用同一份配置。`uptime.config.ts` 仅作初始配置，第一次网页保存后，重部署不会覆盖 D1 配置。高级鉴权字段仅返回给已登录管理员和分配的探针。

已有安装需要执行 `migrations/0002_admin_config.sql`（新安装的 `init.sql` 已包含）。移除目标或取消探针分配前先补传完队列。

## SSL、ICMP 与区域代理

`SSL_CERT` 目标必须是 HTTPS URL。Go 探针建立受信任的 TLS 连接，校验主机名、证书链及有效期，不发 HTTP 请求；默认在证书剩余 14 天内显示 `tls/expiring`。`certificateExpiryDays` 可设为 0–365，0 表示仅校验证书，不提前告警。最新结果显示证书到期时间和剩余天数。

`ICMP_PING` 目标为主机名或 IP。Go 的 Linux/macOS 使用无特权 Echo socket，Windows 使用 IP Helper；不提供该接口的平台显示明确的 `icmp/unsupported`，可改用代理。Linux 服务用户需被系统 `ping_group_range` 允许。HTTP 代理方式的 `icmpProxyURL` 接收 `{target,timeout_ms}`，返回 `{up,latency_ms,stage?,code?}`；鉴权使用 `checkProxyHeaders`，旧 `headers` 仍兼容，代理专用头优先。失败区分 `icmp` 目标不可达与 `proxy` 代理故障。

探针仓库提供独立 `check-proxy` 命令，可通过 Bearer 鉴权给 Cloudflare 执行 HTTP、TCP、SSL 或 ICMP。目标的 `checkProxy` 填代理完整 `/v1/check` 地址，`checkProxyHeaders` 配置代理鉴权，目标 headers 保留给实际网站。代理不可用时可选择 `checkProxyFallback`，回退至常规检查路径，ICMP 若配置 `icmpProxyURL` 则使用它；Cloudflare 直接执行 SSL 没有证书到期信息，不能用此回退代替 SSL 证书校验。生产代理请配置 HTTPS 入口与访问限制，使用探针仓库提供的服务示例。

`worker://weur` 等区域检查仅分配 Cloudflare。更换区域会使用新的 Durable Object 标识，避免旧实例仍留在原位置；Cloudflare 区域提示是 best effort，页面展示实际检查节点。`globalping://?magic=Tokyo` 可匿名使用 Globalping HTTP/TCP/ICMP 测量，也可按该服务配置 token；配额与节点由外部服务控制。`worker://` 和 `globalping://` 不下发给 Go 探针。代理配置与鉴权仅对管理员和分配探针可见。

## 上线探针

```sh
export LIGHT_PROBER_SERVER=https://your-status.pages.dev
export LIGHT_PROBER_TOKEN=the-token-for-sg
./light-prober
```

新探针只需这两个配置。每个目标的检测周期由服务端下发，探针无需单独设置全局检测周期。服务端下发其分配目标的实际检查配置（包含该目标必需的鉴权头）。公共状态页与 API 只返回显示字段、结果和探针标签，不公开目标 URL、请求体、鉴权头或令牌。接收端只保存已校验的结果字段。

默认按服务端配置每五分钟检测，每五分钟 gzip 批量推送；因此状态页可能有约五分钟的可见延迟。探测结果先落盘，直到 D1 完成事务、返回匹配批次确认后才删除。每批最多 200 个样本，压缩前后请求体都限制为 512 KiB。保留每次检查的失败阶段，再用五分钟桶汇总，不用平均结果覆盖短暂故障。

## 汇总与故障诊断

主机条目可展开查看多个探针，再展开每个探针查看延迟、最新原因、阶段统计、最近 12 小时的五分钟历史与最近 100 条失败明细。Incidents 页面可按目标、月份持续分页查看保留期内失败记录。公共 `/api/data` 与 `/api/badge?id=...` 使用同样的汇总语义。

- `up`：有新鲜结果的探针全部成功。
- `down`：有新鲜结果的探针全部失败。
- `degraded`：有新鲜结果的探针同时有成功和失败。
- `unknown`：全部探针缺失或过期。

缺失或过期的探针保留 `unknown` 状态与数量，但不参与汇总颜色判定。折叠时可见的五分钟历史时间轴使用相同规则：仅有样本的探针参与颜色判定；桶内全部检查成功为绿色、全部失败为红色、成功与失败混合为黄色，全部无样本为灰色。悬浮提示显示有数据的探针数与总数。补传按检查时间排序更新最新状态，旧成功记录不能覆盖较新的失败。

Go 探针区分 `dns`、`tcp`、`tls`、`http`、`body`、`icmp`、`proxy`、`configuration`、`unknown` 阶段，以及 timeout/refused/certificate/status/keyword 等原因。原 Cloudflare 检查也提供分类前缀；Workers 隐藏底层原因时保留 unknown，不猜测 DNS/TCP/TLS 阶段。

## 资源与数据生命周期

接收端一次 D1 事务处理一批样本：主键去重、单调更新 latest、增量更新总计、阶段总计和日汇总、重建受影响的五分钟桶。状态页读取总计、最多 91 个 UTC 日桶与最近 12 小时的五分钟桶，避免每次访问扫描 90 天原始样本。证书到期时间、剩余天数与 ICMP 延迟仅在存在这些可选字段时占用元数据行，同一记录的重放不能篡改或补写元数据。

当前限制为最多 100 个监控配置、32 个独立令牌以及 1 个内置 Cloudflare 探针、**64 个监控与探针分配组合**，例如 32 个目标各分配 2 个探针。近期历史和失败明细均有界。这是控制 Worker CPU、D1 读取和页面大小的明确限制；更大部署应先做容量测量与分页扩展。

原始样本与汇总保存约 90 天。每分钟 scheduled 任务有界删除过期数据，并同步扣除累积总计；大量历史补传过期后清理可能需要多轮。累计统计反映尚未清理的保留数据。latest 保留最后一次结果，使用该目标周期的两倍与最后检查时间判断过期。

### 历史图表与事件

监控汇总及每个独立探针都提供最近 12 小时的响应延迟折线与 90 天 UTC 日可用率历史。可用率按实际上报检查中的成功比例计算，缺测不计为失败，也不凭空推断持续故障时长。五分钟桶只要包含一次失败（包括成功与失败混合的桶），其延迟点就是 `null`；缺测同样为 `null`，图表不跨这些点连接。页面所示平均延迟仅统计完全成功的桶中的检查。原生监控继续使用原版故障事件持续时间计算可用率，响应图在失败或漏掉预期检查时断线。

点击每日色块可打开按目标、月份筛选的事件页。分布式失败检查以检查时间、目标与探针稳定分页，每页最多 100 条；可持续加载窗口内全部保留记录，不再只展示最新 200 条。原生故障事件另列开始、恢复时间和原因变化，计划维护与已发布事件保留独立栏目；未上报、过期探针不会被记录成目标故障。

页面使用 `GET /api/incidents?from=<Unix秒>&to=<Unix秒>&monitor=<目标ID>&kind=all` 读取历史；`kind=probes|native` 可分别分页，响应包含 `nextCursor`，后续传入 `cursor` 或 `nativeCursor`。日期范围自动收窄到最近 90 天，`limit` 最大 100。返回数据只有公开显示名、时间和故障诊断，不包含检查地址、代理鉴权头、通知配置或令牌；该端点遵循状态页密码保护。

## Webhook 通知模板

在管理页的“通知模板”中添加模板，填写名称、推送地址、请求方法、参数格式、超时、请求头和 JSON 正文。支持 JSON、URL 查询参数和表单；GET 使用查询参数。每个监控目标在“通知模板”中选择一个模板，清空选择即关闭通知。模板可供多个目标复用；删除模板会同时清除相关目标的选择。重复名称在选择列表中按序号区分。

正文中的字符串支持 `$MSG`、`$MONITOR`、`$STATUS`、`$TIME`、`$REASON`、`$DURATION` 和 `$EVENT_ID`，可嵌套在 JSON 对象及数组中。`$STATUS` 为 `down` 或 `up`，`$TIME` 为 UTC ISO 时间，`$DURATION` 为恢复时的故障秒数。默认正文为 `{"text":"$MSG"}`。请求头支持配置接收端的鉴权信息；模板配置仅可经已登录的管理接口读取，不下发给探针，也不出现在公共页面/API 中。

通知每分钟基于最新且未过期的结果评估：全部有效探针失败时发送故障通知，恢复为全部有效探针成功时发送恢复通知。无数据和混合状态不会开启或关闭故障；首次成功不通知。上传历史样本不会单独触发通知，重复调度通过 D1 事务去重。原生监控也支持模板，未选择模板的原生监控将源码配置的 webhook 接入相同持久队列；原状态变化和故障回调仍在检查完成后运行。

“通知模板”标签页也可设置全局通知宽限期（分钟）、时区、排除目标与是否忽略失败原因变化；每个目标可用秒数覆盖宽限期。宽限期按连续新鲜失败样本经过的时间判断，重复使用旧结果不会推进计时，部分可达或缺测会中断尚未通知的计时。达到宽限期后发出一次故障通知，仅为已通知故障发送恢复。维护期间抑制通知并取消待投递事件。

事件和故障状态原子写入 D1。投递失败最多尝试 8 次，间隔由 1 分钟指数增加到最长 1 小时，同一目标保持事件顺序；未投递事件最长保留 7 天。每次重试携带稳定的 `X-UptimeFlare-Event-ID`，默认也设置 `Idempotency-Key`，接收端可据此去重。关闭目标通知后取消其排队事件。Webhook 不跟随重定向，不读取响应正文，不在日志中输出地址、鉴权头或推送正文。

移除目标或取消分配前，先补传完其队列。对未分配目标返回 403，探针保留数据；恢复原分配后可重试。令牌撤销后无法继续读取配置或上传，已落盘数据仍在本地。请保持探针系统时间准确，服务端拒绝超过当前时间五分钟的未来样本。

## 升级与上游合并

本版 `main` 推送会触发部署，D1 中的网页配置和探针历史会保留。原项目按整仓替换代码的 Upstream Sync 流程已移除；更新上游时，应在分支中合并并审查冲突，保留外部探针、网页管理及当前部署流程，再通过验证后合并到 `main`。

## 开发验证

```sh
npm ci
npm --prefix worker ci
npm --prefix worker test
npm --prefix worker run typecheck
node --test util/*.test.cjs
npm run lint
npm run build
```

Worker 测试使用真实 Miniflare D1，覆盖 gzip、压缩炸弹限制、令牌与目标权限、重复上传、乱序补传、事务失败、累计总计与保留期清理，以及目标周期与超时默认值、旧管理配置兼容、各目标 TTL 边界、cron 并发去重、配置变更调度、旧执行者写入隔离和原生通知新鲜度。探针仓库的端到端脚本可与本仓库联合验证完整网络协议。
