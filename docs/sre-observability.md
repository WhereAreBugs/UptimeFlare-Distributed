# 栈运行观测

遥测关注探针与 Worker 的资源、吞吐、耗时和运行故障。目标可达性继续由状态站保存与展示，不在 SRE 指标中重复导出。Go 指标和标准 OTLP trace 由官方 SDK 输出；Worker 使用有界的 OTLP HTTP/JSON 批量导出，兼容 OpenObserve。两端使用独立的组织写入令牌，查询/管理凭据不下发到生产探针或 Worker。

## 云端指标和追踪

| 指标 | 内容 |
| --- | --- |
| `worker.invocations`, `worker.invocation.duration` | 按 fetch/Cron/Coordinator/Regional、固定路由类别和响应状态类别统计调用量和耗时 |
| `worker.operation.duration` | D1、KV、DO RPC 和通知 HTTP 的耗时与成功/失败 |
| `worker.d1.queries`, `rows.read`, `rows.written`, `rows.returned` | 实际 D1 响应 metadata，后三项均以 `worker.d1.` 为前缀；不增加查询 |
| `worker.kv.operations`, `worker.rpc.calls`, `worker.rpc.duration` | KV 操作、DO RPC 数量和耗时 |
| `worker.coordinator.queue.wait`, `worker.coordinator.queue.pending` | 串行提交队列等待时间及进入时的等待数量分布 |
| `worker.telemetry.export.failures`, `worker.telemetry.series.dropped` | 导出失败与指标缓冲满丢弃 |

`worker.fetch → rpc.commitProbe → coordinator.commitProbe → d1.batch` 继承探针请求的 trace ID。Cron 的执行、区域 DO、通知发送和提交也形成相应链路。应用 span 仅包含固定操作名及安全数值，不保存 SQL 文本、参数、目标 URL、错误详情或认证数据。公开请求不接受外部采样指令；仅已鉴权的探针接口继续传入的 W3C context。DO RPC 显式传递 context，使用 AsyncLocalStorage 隔离并发调用。

运行开关：`TELEMETRY_ENABLED=1`、`OTEL_EXPORTER_OTLP_ENDPOINT`（不带 `/v1/metrics` 或 `/v1/traces`）和 Secret `OTEL_EXPORTER_OTLP_HEADERS`（JSON HTTP headers）。`OTEL_TRACES_SAMPLER_ARG` 默认 0.05。关闭开关不初始化导出、包装存储或发送网络请求；原 `METRICS_ENABLED` 仅用于短期控制台行数诊断，不需开启。

指标按 isolate 在内存聚合，最多 64 个 series；每次调用最多 64 个 span；每份未压缩请求不超过 64 KiB，gzip、5 秒超时、禁止跳转，导出通过 `waitUntil`。无定时器、重试风暴、D1/KV/DO 遥测存储或新增云端资源。活动 isolate 大约每分钟导出，Cron 结束强制导出；冷 isolate 被回收时尚未导出的指标可能丢失，因此不能将它们作为业务计费或严格配额账本。遥测失败不影响 ACK 或真实结果。

当普通 fetch 上下文的出站路由与 DO/Cron 不一致时，可以设 `OTEL_EXPORTER_USE_COORDINATOR=1`，将根 fetch 的遥测批次通过既有 Coordinator 转发；没有新增对象或持久化。转发独立于提交队列，并发最多 2、等待最多 8，满载丢弃遥测，保持监控 ACK。额外开销是每个已采样调用一次 traces RPC，以及约每分钟一次 metrics RPC；`worker.telemetry.relay.calls` 可观测这些调用。生产当前启用此项：普通 Worker 直连既定写入地址返回 307，DO 从同地址能写入。导出明确识别 HTTP/OTLP 部分拒收，并最多每分钟记录一次不含响应正文的安全诊断。

指标可以按 service、scope、operation、probe_id 筛选。追踪界面按 `trace_id` 查看调用树，`span_id`/`parent_span_id` 对应具体操作；不要将这些 ID 加为高基数指标标签。Go 的执行结果异步落盘，后续上传是独立 trace，原队列与 batch ID 未改变。

## 平台 CPU 与内存的边界

`worker.*.duration` 是墙钟耗时，不能冒充 CPU。Cloudflare JavaScript 不提供 isolate 进程 CPU 或 RSS；真实每次调用 CPU 时间、平台结果（CPU/内存超限等）需要原生 Workers Traces 的 `cloudflare.cpu_time_ms`/`cloudflare.outcome`。不提供虚构的 Worker 内存/CPU 指标。

使用账户 `Workers Observability Write` 权限创建 OTLP traces destination，并把其名称设为部署变量 `CF_OTEL_TRACES_DESTINATION`；provision 会启用采样及 `persist=false`，无需 Tail Worker 或自动升级账户。原生 trace 与应用 trace 的 ID 是否自动连接由平台支持决定，不能假定其支持跨外部服务传播。原生 span 还可能包含 URL/SQL 文本，使用前须在 collector 上移除这些字段；应用 exporter 只导出允许的属性。参考 [Cloudflare 原生 span 字段](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)、[导出配置](https://developers.cloudflare.com/workers/observability/opentelemetry-export/) 与 [已知限制](https://developers.cloudflare.com/workers/observability/traces/known-limitations/)。

## 验证

Go 测试解码真实 gzip/protobuf metrics 和 traces，核对传播、父子关系、采样关闭和错误脱敏；Worker 测试解码 gzip/JSON，核对 RPC 父子关系和导出故障隔离。`node scripts/telemetry-smoke.mjs` 对构建后的真实 Worker/Coordinator/D1 完成一次提交，检查 ACK、存储、OTLP 导出与秘密字段不外泄。生产验收必须在后端查询部署后的新记录，不能以空 OTLP 写入 200 或 systemd active 代替。
