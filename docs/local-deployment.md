# 本地部署：Docker 与 Wrangler

本地运行保留完整 Worker/Pages/D1 链路，D1 SQLite 数据存放在同一个持久化目录。无需 Cloudflare 账户或 API token。Docker 使用 Node 22 与仓库锁定依赖；宿主机方式需要 Node 22、npm、Bash 和 curl。

## Docker

先构建镜像（构建阶段需要网络下载 npm 包和字体）：

```sh
docker build -t uptimeflare-local .
```

准备三个运行时环境变量。`PROBE_TOKENS` 是稳定探针 ID 到独立令牌的 JSON 对象；密码至少 16 字符，独立的会话签名密钥至少 32 字符。可以用 `openssl rand -hex 32` 分别生成，保存在本机密码管理器或权限为 0600、未提交的环境文件中。

```sh
export PROBE_TOKENS='{"home":"replace-with-an-independent-random-token"}'
export ADMIN_PASSWORD='replace-with-a-random-administrator-password'
export ADMIN_SESSION_SECRET='replace-with-an-independent-random-session-secret'

docker run -d --name uptimeflare-local --restart unless-stopped \
  -p 127.0.0.1:8788:8788 \
  --mount type=volume,src=uptimeflare-data,dst=/app/.wrangler/state \
  --env PROBE_TOKENS --env ADMIN_PASSWORD --env ADMIN_SESSION_SECRET \
  --env UPTIMEFLARE_LOCAL_PROTOCOL=https \
  uptimeflare-local
```

打开 `https://localhost:8788` 和 `/admin`，首次在本机浏览器信任 Wrangler 的本地证书。管理页使用 `localhost`，不要换成 `127.0.0.1` 或 `[::1]`：Next.js 会规范化回环 IP，导致严格 Origin 检查拒绝登录。使用 HTTPS 可保持管理会话的 Secure cookie 语义；生产或局域网访问应由带可信证书的 HTTPS 反向代理承接，不把 Wrangler 开发端口直接暴露到公网。只有 Pages 8788 需要映射；Worker 8787 用于容器内部定时调度。

配置目标并分配 `home` 后，Go 探针使用同一 ID 对应的令牌和 Pages 地址即可。Go 探针会验证 TLS 证书；本机测试需把开发证书加入系统信任，或仅在回环网络上使用默认 HTTP 方式（删除 `UPTIMEFLARE_LOCAL_PROTOCOL=https`），正式部署使用可信 HTTPS 域名。

```sh
docker logs --tail 100 uptimeflare-local
docker stop --time 15 uptimeflare-local
docker start uptimeflare-local
```

数据库卷保留监控配置和历史，重启会幂等执行 `init.sql`。更换镜像时复用同一卷；删除容器不会删除命名卷。日志写到标准输出/错误，不需要容器内 cron 或 `tail -f`。tini 与入口脚本转发停止信号、回收子进程；任意 Wrangler 或调度子进程退出，整个服务退出，便于容器重启策略恢复。

## 不使用 Docker

```sh
npm ci --no-audit --no-fund
npm ci --prefix worker --no-audit --no-fund
npx --no-install @cloudflare/next-on-pages

# 先设置上面的三个环境变量
UPTIMEFLARE_APP_DIR="$PWD" \
UPTIMEFLARE_STATE_DIR="$PWD/.wrangler/state" \
UPTIMEFLARE_LISTEN_IP=127.0.0.1 \
UPTIMEFLARE_LOCAL_PROTOCOL=https \
bash ./entrypoint.sh
```

Ctrl+C 同时停止 Pages、Worker 和调度循环。所有 D1 初始化、Worker 与 Pages 都显式使用同一绝对 `--persist-to` 目录，初始化命令显式指定 `--local`，不会访问远端 D1。入口脚本在私有临时目录生成两个本地配置文件和 `.dev.vars`，只装入 `PROBE_TOKENS`、`ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET`；退出时删除。项目中已有的 `.env`/`.dev.vars` 不会被覆盖或自动装载，其他进程环境变量不会变成 Worker bindings。管理员密钥需能以 dotenv 原样表示，建议使用生成的十六进制值。

本地参数均可选：`UPTIMEFLARE_WORKER_PORT` 默认 8787，`UPTIMEFLARE_PAGES_PORT` 默认 8788，`UPTIMEFLARE_LISTEN_IP` 默认 `0.0.0.0`，`UPTIMEFLARE_LOCAL_PROTOCOL` 默认 `http`。数据目录默认 `/app/.wrangler/state`（宿主机运行时设置 `UPTIMEFLARE_APP_DIR`）。

## 定时与调试

本地每次调用等待 `/__scheduled` 完成后才等待下一个分钟边界；同一个循环不重叠执行。Worker 中的目标租约继续防止重复调用产生重复数据，各目标仍按自己的 `intervalSeconds` 检查。一次调用最长等待 900 秒，失败后下分钟重试。不要在入口脚本外再添加系统 cron。

手工开发时也必须保持同一个目录，例如：

```sh
npx --no-install wrangler d1 execute uptimeflare_d1 --local \
  --persist-to "$PWD/.wrangler/state" --file init.sql
npx --no-install wrangler dev --config worker/wrangler.toml --local \
  --persist-to "$PWD/.wrangler/state" --test-scheduled
# 另一个终端，从仓库根运行
npx --no-install wrangler pages dev .vercel/output/static \
  --persist-to "$PWD/.wrangler/state"
```

手工方式自行维护仓库根与 `worker/` 的 `.dev.vars`，不要提交或放入 Docker 构建上下文；不需要用 `CLOUDFLARE_INCLUDE_PROCESS_ENV` 装载全部环境。入口脚本方式已自动安全处理这些步骤。
