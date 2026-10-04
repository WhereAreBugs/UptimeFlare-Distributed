> 统一 Worker/state-v2 改造：静态资源、API、Cron、区域 DO 与协调 DO 使用一个入口。构建及本地运行见 [本地部署](docs/local-deployment.md)，协议、容量、迁移和回滚见 [state-v2](docs/state-v2.md)，本地测试及资源对比见 [验收记录](docs/refactor-validation.md)，生产续作见 [部署记录](docs/refactor-deployment.md)。旧 Pages/Terraform 步骤仅作兼容记录。

<div align="right">
  <a title="English" href="README.md"><img src="https://img.shields.io/badge/-English-A31F34?style=for-the-badge" alt="English" /></a>
  <a title="简体中文" href="README_zh-CN.md"><img src="https://img.shields.io/badge/-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-545759?style=for-the-badge" alt="简体中文"></a>
</div>

# UptimeFlare Distributed

This distributed edition supports independent [Go probes](https://github.com/WhereAreBugs/UptimeFlare-Distributed-prober), durable compressed batch ingestion, expandable multi-probe summaries, and authenticated web configuration at `/admin`. Administrators can create scoped management tokens to query status and enable or disable monitors within authorized groups; see the [management API](docs/management-api.md). See [dashboard performance and public caching](docs/dashboard-performance.md) for large target lists and database quota recovery. It is based on [UptimeFlare](https://github.com/lyc8503/UptimeFlare). See [external probe setup](docs/external-probes.md).

A more advanced, serverless, and free uptime monitoring & status page solution, powered by Cloudflare Workers, complete with a user-friendly interface.

📢 **[[SECURITY ADVISORY](https://github.com/lyc8503/UptimeFlare/security/advisories/GHSA-36q9-v7p3-vj6v) 2026/03/04]** A vulnerability (CVE-2026-29779) that could expose monitor configuration and credentials in `uptime.config.ts` to clients was fixed. Versions between 2025-09-21 (from commit `41257c6`) and 2026-03-04 are affected. **Affected users are strongly advised to upgrade to the latest version.**

🎉 **[UPDATE 2026/01/03]** I have just migrated UptimeFlare from KV to D1 Database. I also updated the Terraform Cloudflare provider to v5 and improved the deployment process. The data structure has been optimized to resolve long-standing performance issues.

New users can deploy directly, while existing users can have a simple auto migration process (upgrade docs below)! Feel free to open an issue if you run into any trouble deploying.

## ⭐Features

- Open-source, easy to deploy (in under 10 minutes, no local tools required), and free
- Monitoring capabilities
  - Per-target check intervals from 60 seconds to 24 hours; default 5 minutes
  - Geo-specific checks from over [310 cities](https://www.cloudflare.com/network/) worldwide
  - Support for HTTP/HTTPS/TCP port monitoring
  - SSL certificate expiry and ICMP checks through Go probes or authenticated check proxies
  - Up to 90-day uptime history and uptime percentage tracking
  - Customizable request methods, headers, and body for HTTP(s)
  - Custom status code & keyword checks for HTTP(s)
  - Downtime notification supporting [100+ notification channels](https://github.com/caronc/apprise/wiki)
  - Customizable Webhook
  - Multi-language support (English/Chinese)
- Status page
  - Interactive ping (response time) chart for all types of monitors
  - Scheduled maintenances alerts & Incident history page
  - Responsive UI that adapts to your system theme
  - Customizable status page
  - Use your own domain with CNAME
  - Optional password authentication (private status page)
  - JSON API for fetching realtime status data

## 👀Demo

My status page (Online demo): https://uptimeflare.pages.dev/

Some screenshots:

![Desktop, Light theme](docs/desktop.png)

## ⚡Quickstart / 📄Documentation

For this distributed edition, see [deployment and external probes](docs/external-probes.md) and the [31-item feature matrix, development commands and Webhook examples](docs/features.md). The original [Wiki](https://github.com/lyc8503/UptimeFlare/wiki) describes the upstream version.

## 🚀Upgrade existing deployments

Push reviewed changes to `main` to deploy this edition. Bring upstream changes in through a reviewed Git merge; the original whole-repository replacement workflow was removed because it would discard distributed ingestion, web administration, and deployment automation. D1 web configuration survives redeployment.

## ⚙️Docs for developer

See the [development and local deployment guide](docs/features.md#开发与部署). The original [development Wiki](https://github.com/lyc8503/UptimeFlare/wiki/How-to-develop) remains useful for upstream architecture.

## New features (TODOs)

The checklist retains upstream history, including retired items. The [feature matrix](docs/features.md) maps every item to this edition's implementation and documents proxy, provider and runtime limits.

- [x] Specify region for monitors
- [x] TCP `opened` promise
- [x] Use apprise to support various notification channels
- [x] ~~Telegram example~~
- [x] ~~[Bark](https://bark.day.app) example~~
- [x] ~~Email notification via Cloudflare Email Workers~~
- [x] Improve docs by providing simple examples
- [x] Notification grace period
- [x] SSL certificate checks
- [x] ~~Self-host Dockerfile~~
- [x] Incident history
- [x] Improve `checkLocationWorkerRoute` and fix possible `proxy failed`
- [x] Groups
- [x] Remove old incidents
- [x] ~~Known issue~~: `fetch` doesn't support non-standard port (resolved after CF update)
- [x] Compatibility date update
- [x] Scheduled Maintenance
- [x] Add docs for dev
- [x] Migration to Terraform Cloudflare provider version 5.x
- [x] Cloudflare D1 database
- [x] Scheduled maintenances (via IIFE)
- [x] Simpler config example
- [x] Upcoming maintenances
- [x] Universal Webhook upgrade
- [x] i18n...? (maybe)
- [x] ICMP via proxy?
- [x] Add default UA
- [x] Customizable footer
- [x] New header logo
- [x] Improve CPU time usage
- [x] Local deployment

## Deployment documentation

See [Docker and local Wrangler deployment](docs/local-deployment.md) for shared persistent D1, runtime secrets and local HTTPS. See [optional Terraform 5 deployment](docs/terraform.md) for Worker/Pages bindings, Durable Object migration and SQL initialization.
