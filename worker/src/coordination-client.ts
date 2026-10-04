import { namespaceIdentity } from './resources'
import type { ProbeEnv } from './probes'
import { withTimeout } from './util'
const versions = new WeakMap<object, { until: number; value: Promise<void> }>()
/** Negotiate before the first side effect; expired compatibility is checked again without fallback writes. */
export async function getCoordinator(env: ProbeEnv) {
  const namespace = env.COORDINATOR_DO
  if (!namespace) throw new Error('Coordinator unavailable')
  const identity = namespaceIdentity(namespace)
  const stub = namespace.get(namespace.idFromName('state-v2'))
  let cached = versions.get(identity)
  if (!cached || cached.until < Date.now()) {
    const value = withTimeout(10000, stub.versions()).then((v) => {
      if (v.coordinator !== 1 || v.schema !== 2 || v.probe !== 1)
        throw new Error('Unsupported coordinator protocol')
    })
    cached = { until: Date.now() + 60000, value }
    versions.set(identity, cached)
    value.catch(() => {
      if (versions.get(identity) === cached) versions.delete(identity)
    })
  }
  await cached.value
  return stub
}
