# 本地统一 Worker

需要 Node 22+、npm、Python 3（迁移演练）、Bash 和 curl。Docker 与本地入口均只运行一个 Worker，包含静态资源、API、Cron、D1、KV 和两类 DO。

```sh
npm ci --no-audit --no-fund
npm ci --prefix worker --no-audit --no-fund
npm run build
npm run build:worker
export PROBE_TOKENS='{"home":"an-independent-test-token"}'
export ADMIN_PASSWORD='a-test-password-at-least-16-characters'
export ADMIN_SESSION_SECRET='a-test-session-secret-at-least-32-characters'
UPTIMEFLARE_APP_DIR="$PWD" UPTIMEFLARE_STATE_DIR="$PWD/.wrangler/state" \
UPTIMEFLARE_LISTEN_IP=127.0.0.1 bash entrypoint.sh
```

打开 `http://localhost:8788`，Go 本地测试使用 `--allow-insecure`。管理员会话采用 Secure cookie，管理员端到端验收建议 `UPTIMEFLARE_LOCAL_PROTOCOL=https` 并在本机信任开发证书；生产必须使用可信 HTTPS。入口只读取三个明确的本地 Secrets，不自动加载仓库 `.env` 或 Cloudflare 凭据。

```sh
docker build -t uptimeflare-local .
docker run --rm --name uptimeflare-local -p 127.0.0.1:8788:8788 \
  --mount type=volume,src=uptimeflare-data,dst=/app/.wrangler/state \
  --env PROBE_TOKENS --env ADMIN_PASSWORD --env ADMIN_SESSION_SECRET uptimeflare-local
```

默认 `UPTIMEFLARE_PORT=8788`，`UPTIMEFLARE_LOCAL_PROTOCOL=http`，`UPTIMEFLARE_STATE_VERSION=2`。全新空数据库自动初始化为 v2；既有 v1 或未标记且含历史的数据库会阻止启动，必须先按 [state-v2](state-v2.md) 完成语义迁移。入口拒绝显式设置 v1，不再提供 Pages 或双端口启动路径。

启动幂等添加 schema，数据卷保留配置和历史；入口生成临时私有 Wrangler 配置与 `.dev.vars`，退出后删除。顺序的调度循环等待一次 `/__scheduled` 完成才运行下一次，任何运行子进程失败会停止其余进程，tini 转发信号。`Ctrl+C`、Docker stop 都会结束调度和 Worker。不要在外部再建立重复 Cron。

回归命令：

```sh
npm test --prefix worker -- --maxWorkers=2
npm run typecheck --prefix worker
node --test util/*.test.cjs
npm run lint
npm run build && npm run build:worker
node scripts/management-smoke.mjs
node scripts/public-cache-smoke.mjs
node scripts/dashboard-smoke.mjs
node scripts/coordinator-smoke.mjs
python3 -m unittest discover -s deploy -p 'test_*.py'
```

smoke 使用虚构配置和独立临时存储，不连接生产目标。`dashboard-smoke.mjs --preview` 在 8794 提供 500 目标容量样例，仅用于本地浏览器验收；默认运行完成后退出并清理。
