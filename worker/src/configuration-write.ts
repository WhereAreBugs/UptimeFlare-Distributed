import type { MonitorTarget } from '../../types/config'
import type { ProbeEnv } from './probes'
import { pauseTransitionStatements } from './pause'
import { publishPublicConfiguration } from './public-dashboard'
import type { WorkerConfig } from '../../types/config'

/** Authorization guards are evaluated by the same transaction that changes configuration. */
export async function saveConfiguration(
  env: ProbeEnv,
  value: Record<string, unknown> & { monitors: MonitorTarget[] },
  revision: number,
  previous: MonitorTarget[],
  authorization = '1',
  bindings: (string | number | null)[] = []
): Promise<boolean> {
  const priorMonitors = new Map(previous.map((monitor) => [monitor.id, monitor]))
  const transitions = value.monitors.flatMap((monitor) => {
    const prior = priorMonitors.get(monitor.id)
    return !!monitor.paused !== !!prior?.paused
      ? [
          {
            id: monitor.id,
            paused: !!monitor.paused,
            native: !monitor.probes?.length || (!!prior && !prior.probes?.length),
          },
        ]
      : []
  })
  const now = Math.floor(Date.now() / 1000)
  const writeId = crypto.randomUUID()
  const statement = env.UPTIMEFLARE_D1.prepare(
    `INSERT INTO admin_config(id,revision,value,updated_at)
    SELECT 1,?,?,? WHERE (?=0 OR EXISTS(SELECT 1 FROM admin_config WHERE id=1)) AND (${authorization})
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at
    WHERE admin_config.revision=excluded.revision-1`
  ).bind(revision + 1, JSON.stringify({ ...value, _writeId: writeId }), now, revision, ...bindings)
  const guard = `EXISTS(SELECT 1 FROM admin_config WHERE id=1 AND revision=${
    revision + 1
  } AND json_extract(value,'$._writeId')='${writeId}')`
  const results = await env.UPTIMEFLARE_D1.batch([
    statement,
    ...pauseTransitionStatements(env, transitions, now, guard),
  ])
  if (results.some((result) => !result.success)) throw new Error('Configuration persistence failed')
  const changed = !!results[0].meta.changes
  if (changed)
    await publishPublicConfiguration(env, value as WorkerConfig, revision + 1).catch(() =>
      console.error('Public configuration snapshot update failed')
    )
  return changed
}
