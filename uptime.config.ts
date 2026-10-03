import { MaintenanceConfig, PageConfig, WorkerConfig } from './types/config'

const pageConfig: PageConfig = {
  title: 'Cat · 分布式在线监控',
  links: [
    { link: '/admin', label: '配置管理', highlight: true },
    { link: 'https://github.com/WhereAreBugs/UptimeFlare-Distributed', label: 'GitHub' },
  ],
}

// Initial settings. After the first admin save, D1 becomes authoritative for
// monitors, probe labels and stale time. Redeploying does not overwrite them.
const workerConfig: WorkerConfig = {
  probes: [
    { id: 'probe-1', name: '探针 1' },
    { id: 'probe-2', name: '探针 2' },
  ],
  probeStaleAfterSeconds: 900,
  monitors: [
    {
      id: 'tools-test',
      name: 'Tools 测试站点',
      method: 'GET',
      target: 'https://tools.n.kuapt.top:8888/',
      probes: ['probe-1', 'probe-2'],
      timeout: 10000,
    },
  ],
}
const maintenances: MaintenanceConfig[] = []
export { maintenances, pageConfig, workerConfig }
