<div align="right">
  <a title="English" href="README.md"><img src="https://img.shields.io/badge/-English-545759?style=for-the-badge" alt="English"></a>
  <a title="简体中文" href="README_zh-CN.md"><img src="https://img.shields.io/badge/-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-A31F34?style=for-the-badge" alt="简体中文"></a>
</div>

# UptimeFlare Distributed

本分支新增独立 Go 探针、持久化结果与压缩批量上传，以及可展开的多探针汇总。请参阅[外部探针配置与部署](docs/external-probes.md)。

一个由 Cloudflare Workers 驱动的功能丰富、Serverless 且免费的 Uptime 监控及状态页面。

## ⭐功能

- 开源，易于部署（全程无需本地工具，耗时不到 10 分钟），且完全免费
- 监控功能
  - 每个目标独立检测周期，支持 60 秒至 24 小时，默认 5 分钟
  - 支持指定全球 [310+ 个城市](https://www.cloudflare.com/network/) 的监控节点
  - 支持 HTTP/HTTPS/TCP 端口监控
  - Go 探针或已鉴权检测代理提供 SSL 证书到期与 ICMP 检查
  - 最多 90 天的 uptime 历史记录和 uptime 百分比跟踪
  - 可自定义的 HTTP(s) 请求方法、头和主体
  - 可自定义的 HTTP(s) 状态码和关键字检查
  - 支持 [100 多个通知渠道](https://github.com/caronc/apprise/wiki) 的宕机消息通知
  - 可自定义的 Webhook
  - 多语言支持 (中文/英文)
- 状态页面
  - 所有类型监控的交互式 ping（响应时间）图表
  - 响应式 UI，自适应PC/手机屏幕，及亮色/暗色系统主题
  - 配置选项丰富的状态页面
  - 可使用您自己的域名与 CNAME
  - 可选的密码认证（私人状态页面）
  - 用于获取实时状态数据的 JSON API

## 👀演示

我自己的状态页面（在线演示）：https://uptimeflare.pages.dev/

一些截图：

![桌面，浅色主题](docs/desktop.png)

## ⚡快速入门 / 📄文档

本分布式版本请参阅 [部署、网页管理与外部探针说明](docs/external-probes.md)及[31 项功能矩阵、开发命令与 Webhook 示例](docs/features.md)。[原项目 Wiki](https://github.com/lyc8503/UptimeFlare/wiki) 描述上游版本。

向本版 `main` 推送已审查的修改会自动部署。上游更新通过分支中的 Git 合并与审查引入；原项目的整仓覆盖式同步流程已移除，以保留分布式接收、网页管理和部署功能。网页保存的 D1 配置不会被重新部署覆盖。

## 开发说明

参阅[开发与本地部署](docs/features.md#开发与部署)。原项目[开发 Wiki](https://github.com/lyc8503/UptimeFlare/wiki/How-to-develop)可用于理解上游架构。

## 新功能（历史 TODO）

清单保留上游历史与撤销标记；[功能矩阵](docs/features.md)逐项说明当前分支的实现链路与验证边界。

- [x] 为监控指定地区
- [x] TCP `opened` Promise
- [x] 通过 Apprise 支持多种通知渠道
- [x] ~~Telegram 示例~~
- [x] ~~[Bark](https://bark.day.app) 示例~~
- [x] ~~通过 Cloudflare Email Workers 发送邮件~~
- [x] 补充简明示例文档
- [x] 通知宽限期
- [x] SSL 证书检查
- [x] ~~自托管 Dockerfile~~
- [x] 故障历史
- [x] 改进地区检查路由和代理失败处理
- [x] 分组
- [x] 清理旧故障记录
- [x] ~~已知问题~~：`fetch` 不支持非标准端口（Cloudflare 更新后解决）
- [x] 更新兼容日期
- [x] 计划维护
- [x] 开发文档
- [x] Terraform Cloudflare provider 5.x 迁移
- [x] Cloudflare D1 数据库
- [x] 通过 IIFE 生成计划维护
- [x] 更简单的配置示例
- [x] 即将开始的维护提示
- [x] 通用 Webhook 升级
- [x] 国际化
- [x] 通过代理进行 ICMP 检查
- [x] 默认 User-Agent
- [x] 自定义页脚
- [x] 新页首 Logo
- [x] 降低 CPU 时间消耗
- [x] 本地部署

## 部署文档

[Docker 与本地 Wrangler 部署](docs/local-deployment.md)说明共享持久化 D1、运行时密钥和本地 HTTPS；[可选 Terraform 5 部署](docs/terraform.md)说明 Worker/Pages 绑定、Durable Object 迁移及 SQL 初始化。
