# 旧 Pages Terraform 兼容记录

此文件及 `deploy.tf` 仅记录旧 Pages 部署。统一 Worker 的静态资产发布请使用 `deploy/provision.py`、Wrangler 与当前 GitHub Actions，按 [state-v2](state-v2.md) 完成迁移。不要继续运行下面的旧 Pages 发布流程。

# 可选 Terraform 部署（Cloudflare provider 5.x）

默认 GitHub Actions 部署使用 `deploy/provision.py` 与 Wrangler；`deploy.tf` 是可选的基础设施管理入口。两种方式不要同时管理同名资源。Terraform 管理 D1、Worker 代码/绑定/分钟 Cron 和 Pages 项目/生产绑定；Pages 静态产物发布与 D1 SQL 初始化仍是明确步骤。

需要 Terraform >= 1.5、Cloudflare provider 5.x、Node 22 和有对应账户 D1、Workers、Pages 写权限的 API token。依照 [Cloudflare provider 的 Worker schema](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_script) 与 [Pages schema](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/pages_project) 使用 `secret_text`：`PROBE_TOKENS`、`ADMIN_PASSWORD` 和 `ADMIN_SESSION_SECRET` 同时绑定到 Worker 与 Pages production。管理员变量标记为 sensitive，长度分别至少 16/32 字符。

## 首次部署

```sh
npm ci --no-audit --no-fund
npm ci --prefix worker --no-audit --no-fund
npx --no-install @cloudflare/next-on-pages
npx --no-install wrangler deploy --config worker/wrangler.toml --dry-run --outdir worker/dist

export CLOUDFLARE_API_TOKEN='replace-with-your-cloudflare-api-token'
export TF_VAR_CLOUDFLARE_ACCOUNT_ID='replace-with-your-account-id'
export TF_VAR_probe_tokens='{"home":"replace-with-an-independent-random-probe-token"}'
export TF_VAR_admin_password='replace-with-a-random-administrator-password'
export TF_VAR_admin_session_secret='replace-with-an-independent-random-session-secret'

terraform init
terraform plan -var=enable_do_migration=true
terraform apply -var=enable_do_migration=true
```

首次 Worker 上传必须打开 `enable_do_migration`，创建 `RemoteChecker` SQLite Durable Object namespace；后续不增加类时用默认 false，保持既有 namespace。`worker/wrangler.toml` 也包含相同 DO 类与 v1 迁移，Wrangler 独立部署会按自身迁移记录处理。Terraform 的分钟 Cron 只唤醒调度器，目标的具体检查频率仍由 `intervalSeconds` 控制。

取 `terraform output -raw d1_database_id`，将仓库根 `wrangler.toml` 与 `worker/wrangler.toml` 的 D1 `database_id` 均替换成该 ID，然后初始化 schema，发布 Pages：

```sh
npx --no-install wrangler d1 execute uptimeflare_d1 --remote --file init.sql
npx --no-install wrangler pages deploy .vercel/output/static \
  --project-name uptimeflare --branch main
```

Worker 的首次 Cron 在 SQL 初始化前可能暂时报错；初始化后下一分钟恢复。升级先执行所有新增 D1 migration（或幂等 `init.sql`），再部署 Worker/Pages。日汇总 0006 是幂等重算；滚动发布后再次执行该 SQL 可同步旧代码切换期间的数据。

`probe_tokens` 可为空以只使用内置 Cloudflare 探针；启用独立探针时填入 token registry 并在管理页分配目标。管理密码与签名密钥始终必填。Pages preview 当前只设置运行兼容性、没有生产数据库与密钥绑定，避免预览部署修改生产配置；需要预览服务时为它配置独立 D1 与独立三项密钥，勿直接复制生产绑定。

## 已有资源与状态

已有部署先按 provider 文档导入资源，再查看 plan；不要用创建新资源的 apply 接管当前资源。Terraform 的 `sensitive` 只隐藏正常输出，密钥值仍可能保存在 Terraform state；使用受控的加密远端 backend 或权限为 0600 的本地 state，state/变量文件不进入仓库。不要把密钥写到 `deploy.tf`、普通 `vars` 或源码。

本配置已通过 Terraform 1.13.4 / Cloudflare provider 5.26.0 的隔离 `terraform init`、`terraform validate` 与格式检查；此次验证未执行云端 plan/apply。

部署后验证 `/api/admin/config` 未登录返回 401、管理员登录后可保存配置、分配探针的 bearer token 能取得其独立配置，且 Worker 的同名 D1 绑定看到同一配置版本。Terraform validate/plan 通过只能证明配置，不替代实际远端部署验收。
