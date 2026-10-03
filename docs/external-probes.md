# 外部 Go 探针与多探针汇总

在原 UptimeFlare 的 Worker/Pages 与 D1 架构上添加外部探针。原 Cloudflare 定时检测仍用于未设置 `probes` 的监控；设置该字段的目标由独立 Go 探针负责。服务端不会对同一外部目标重复发起检测。

## 服务端配置

在 `uptime.config.ts` 的 `workerConfig` 中添加：

```ts
probes: [
  { id: 'sg', name: 'Singapore', location: 'Singapore / ISP A' },
  { id: 'hk', name: 'Hong Kong', location: 'Hong Kong / ISP B' },
],
probeStaleAfterSeconds: 900, // 可省略，默认 15 分钟
monitors: [
  {
    id: 'website', name: 'Website', method: 'GET',
    target: 'https://example.com', probes: ['sg', 'hk'],
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
npx wrangler d1 execute uptimeflare_d1 --remote --file ../migrations/0001_external_probes.sql
```

也可以使用 `wrangler d1 migrations apply uptimeflare_d1 --remote`，`worker/wrangler.toml` 已设置迁移目录。先把示例 database ID 换成实际绑定。迁移不更改原 `uptimeflare` 表，不重写原 compact state。

本地运行时，分别给 Worker 和 Pages 的本地变量文件设置测试用 `PROBE_TOKENS`；Worker 与 Pages 必须连接相同 D1。Docker 自托管会从容器环境读取变量，需给两者同样的 `PROBE_TOKENS` 并持久化 `.wrangler/state`。

## 网页配置管理

公开状态页无需登录。`/admin` 使用独立管理密码，密码和会话签名密钥设置为 Worker/Pages secrets，不写入公开源码。会话使用 Secure、HttpOnly、SameSite=Strict Cookie，8 小时过期；写操作校验同源 Origin，管理 API 不开放 CORS。每个来源地址每 15 分钟最多 10 次登录，D1 仅保存地址哈希。更换管理密码或签名密钥会使已有会话失效。

登录后可以添加、编辑、删除 HTTP/HTTPS/TCP 目标，设置超时、状态码、关键词、请求头、请求体和探针分配，以及编辑探针显示名称、地区和过期时间。新探针身份仍需先在 `PROBE_TOKENS` 配置独立令牌。目标 ID 保持不变即可保留历史。

保存后配置存储在 D1 `admin_config`，带版本冲突检测；探针下一次刷新通常在 5 分钟内获取。页面、API、scheduled Worker 和配置接口使用同一份配置。`uptime.config.ts` 仅作初始配置，第一次网页保存后，重部署不会覆盖 D1 配置。高级鉴权字段仅返回给已登录管理员和分配的探针。

已有安装需要执行 `migrations/0002_admin_config.sql`（新安装的 `init.sql` 已包含）。移除目标或取消探针分配前先补传完队列；网页管理也提示该要求。

## 上线探针

```sh
export LIGHT_PROBER_SERVER=https://your-status.pages.dev
export LIGHT_PROBER_TOKEN=the-token-for-sg
./light-prober
```

新探针只需这两个配置。服务端下发其分配目标的实际检查配置（包含该目标必需的鉴权头）。公共状态页与 API 只返回显示字段、结果和探针标签，不公开目标 URL、请求体、鉴权头或令牌。接收端只保存已校验的结果字段。

默认每分钟检测，每五分钟 gzip 批量推送；因此状态页可能有约五分钟的可见延迟。探测结果先落盘，直到 D1 完成事务、返回匹配批次确认后才删除。每批最多 200 个样本，压缩前后请求体都限制为 512 KiB。保留每次检查的失败阶段，再用五分钟桶汇总，不用平均结果覆盖短暂故障。

## 汇总与故障诊断

主机条目可展开查看多个探针，再展开每个探针查看延迟、最新原因、阶段统计、最近 12 小时的五分钟历史与最近 100 条失败明细。Incidents 页面也显示有界的探针失败记录。公共 `/api/data` 与 `/api/badge?id=...` 使用同样的汇总语义。

- `up`：全部预期探针都有新鲜的成功结果。
- `down`：全部预期探针都有新鲜的失败结果。
- `degraded`：结果混合，或者部分探针缺失/过期。
- `unknown`：全部探针缺失或过期。

不将探针失联当作目标宕机，也不把缺失结果当作成功。补传按检查时间排序更新最新状态，旧成功记录不能覆盖较新的失败。

Go 探针区分 `dns`、`tcp`、`tls`、`http`、`body`、`configuration`、`unknown` 阶段，以及 timeout/refused/certificate/status/keyword 等原因。原 Cloudflare 检查也提供分类前缀；Workers 隐藏底层原因时保留 unknown，不猜测 DNS/TCP/TLS 阶段。

## 资源与数据生命周期

接收端一次 D1 事务处理一批样本：主键去重、单调更新 latest、增量更新总计和阶段总计、重建受影响的五分钟桶。状态页读取总计表，避免每次访问扫描 90 天历史。

当前限制为最多 100 个监控配置、32 个独立令牌、**64 个监控与探针分配组合**，例如 32 个目标各分配 2 个探针。近期历史和失败明细均有界。这是控制 Worker CPU、D1 读取和页面大小的明确限制；更大部署应先做容量测量与分页扩展。

原始样本与汇总保存约 90 天。每分钟 scheduled 任务有界删除过期数据，并同步扣除累积总计；大量历史补传过期后清理可能需要多轮。累计统计反映尚未清理的保留数据。latest 保留最后一次结果，用时间判断过期。

仅原生 Cloudflare 监控继续使用原 webhook 与回调生命周期；外部历史样本不会补发原生宕机通知。外部告警可以从 `/api/data` 的聚合状态构建，避免将补传历史当成当前故障。

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

Worker 测试使用真实 Miniflare D1，覆盖 gzip、压缩炸弹限制、令牌与目标权限、重复上传、乱序补传、事务失败、累计总计与保留期清理。探针仓库的端到端脚本可与本仓库联合验证完整网络协议。
