# 分组管理 API

管理员登录 `/admin` 后，在“管理 Token”标签页创建 Token：填写名称、选择已保存的分组，勾选“查询状态”和/或“控制开关”，可选填到期时间。创建和撤销立即生效，不需要点击配置保存。Token 明文只在创建成功时显示一次，请在关闭提示前保存；服务端只保存 SHA-256 哈希。

Token 只能访问授权分组当前包含的目标。分组改名保留授权；删除分组会立即移除访问范围，同名重建也不会恢复旧授权。新增成员自动进入该分组的授权范围，移出成员立即失去访问权限。未分组的目标需要先分组再授权。网页不显示内部 ID，API 通过分组列表返回内部标识用于调用。

## 调用

使用 HTTPS 和 `Authorization: Bearer <Token>`。管理 Token 与管理员登录、探针上报令牌相互独立，不可混用。接口不接受 URL 查询参数或 Cookie 作为管理凭据。

```sh
export STATUS_URL=https://status.catxxp123.top
# 将下方替换为刚创建的管理 Token，避免把真实凭据提交到代码或日志。
export MANAGEMENT_TOKEN=REPLACE_WITH_MANAGEMENT_TOKEN

# 查询授权分组及成员，取得后续调用需要的 group.id 和 monitor.id。
curl --fail-with-body "$STATUS_URL/api/manage/groups" \
  -H "Authorization: Bearer $MANAGEMENT_TOKEN"

# 查询授权范围内全部目标的当前状态。
curl --fail-with-body "$STATUS_URL/api/manage/status" \
  -H "Authorization: Bearer $MANAGEMENT_TOKEN"

# 暂停指定授权分组的全部目标；将 disable 改为 enable 可恢复。
curl --fail-with-body -X POST "$STATUS_URL/api/manage/groups/REPLACE_WITH_GROUP_ID/disable" \
  -H "Authorization: Bearer $MANAGEMENT_TOKEN"
```

| 方法 | 路径                                | 权限       | 功能                           |
| ---- | ----------------------------------- | ---------- | ------------------------------ |
| GET  | `/api/manage/groups`                | 查询或控制 | 授权分组、成员名称及内部标识   |
| GET  | `/api/manage/status`                | 查询       | 所有授权目标的当前状态         |
| GET  | `/api/manage/groups/{id}/status`    | 查询       | 指定授权分组的当前状态         |
| GET  | `/api/manage/monitors/{id}/status`  | 查询       | 单个授权目标的当前状态         |
| POST | `/api/manage/groups/{id}/disable`   | 控制       | 暂停指定授权分组当前的全部目标 |
| POST | `/api/manage/groups/{id}/enable`    | 控制       | 恢复指定授权分组当前的全部目标 |
| POST | `/api/manage/monitors/{id}/disable` | 控制       | 暂停单个授权目标               |
| POST | `/api/manage/monitors/{id}/enable`  | 控制       | 恢复单个授权目标               |

控制接口使用空正文，或发送 `Content-Type: application/json` 和 `{}`。不接受完整配置、目标列表或其他字段。操作重复调用仍保持指定开关状态。

分组列表返回 `{groups: [{id, name, monitors: [{id, name}]}], permissions, configRevision}`。状态接口返回 `{configRevision, updatedAt, monitors: [...]}`，每个目标包含：

- `id`、`name`、`paused`；
- `status`：`up`、`down`、`degraded`、`unknown`、`paused` 或 `maintenance`；
- `up`：可达为 `true`，不可达或部分不可达为 `false`，未知、暂停或维护为 `null`；
- `latest`：最近检测的 Unix 秒时间，无结果为 `null`；
- `latencyMs`：当前有效成功检测的平均延迟，无有效成功检测为 `null`；
- `reachableProbes`、`unreachableProbes`、`unknownProbes`：当前探针数量，暂停或原生兼容目标为 `null`。

状态接口只返回状态摘要，不返回目标 URL、请求头、请求体、代理凭据、通知模板或错误原文。所有响应禁止缓存。

控制成功返回 `{ok: true, paused, updated, configRevision}`；`updated` 表示此次选择的目标数量，包括已处于所需状态的目标。暂停保留配置和历史记录，公开页显示“关闭”，暂停期间不调度新的检查或发送失败通知。Cloudflare 在服务端配置生效后停止调度，独立探针在下次配置刷新后执行新开关，默认刷新周期五分钟；此前已落盘的结果仍可补传。恢复后等待新的检测结果再判断通知。

## 错误与并发

| HTTP 状态 | 含义                                         |
| --------- | -------------------------------------------- |
| 400       | 参数、正文、查询参数不受支持                 |
| 401       | Token 无效、已过期或已撤销                   |
| 403       | 缺少权限、目标不在授权分组内，或跨站来源不符 |
| 404 / 405 | 路径不存在或方法不支持                       |
| 409       | 并发配置修改或授权范围变化，请重新查询后重试 |
| 503       | 存储或运行时暂时不可用                       |

配置写入、当前分组成员检查、Token 撤销和到期检查在同一 D1 事务中执行，冲突不会覆盖新配置或产生暂停副作用。命令行请求可以省略 `Origin`；携带该头时必须与状态页同源，接口不开放跨站 CORS。

## 管理员接口与部署

`GET /api/admin/tokens` 查询 Token 元数据及已保存分组，`POST /api/admin/tokens` 创建，`DELETE /api/admin/tokens/{id}` 撤销。它们仅接受已有管理员会话；写操作还要求同源 `Origin`。管理 Token 本身不能调用管理员接口。

创建正文为 `{name, groupIds, permissions, expiresAt}`；`permissions` 使用 `query` / `control`，可省略（默认两项），`expiresAt` 为未来的 Unix 秒时间或 `null`。创建成功返回 HTTP 201 和 `{token, entry}`；列表只返回元数据。每个 Token 可授权 1–50 个分组，最多 100 个未撤销且未过期的 Token。创建时清理已撤销或过期超过 90 天的记录，并按需清理较旧的失效记录，保证总元数据最多 1000 条。

新部署使用 `init.sql`；已有部署执行 `migrations/0008_management_tokens.sql`。本项目 Actions 部署流程自动准备表结构，不需要新增环境密钥。分组身份在首次管理员读取配置时原子初始化，保留原配置版本和所有目标设置。

直接调用管理员配置接口时，应从最新 `GET /api/admin/config` 保留完整 `groupIds` 映射再提交 PUT；分组改名需提交 `groupRenames`（旧名称到新名称），同时将 `groupIds` 的旧名称键改为新名称，保留其 UUID 值。删除后同名重建时从 `groupIds` 移除旧名称，服务端会分配新身份。未知、重复或已删除的身份不能重新提交复用；存在有效管理 Token 时，旧客户端缺少 `groupIds` 的保存请求会被拒绝，避免误恢复授权。
