const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

function load(filename, imports = {}) {
  const compiled = new Module(filename, module)
  compiled.filename = filename
  compiled.paths = module.paths
  compiled.require = (name) => imports[name] ?? module.require(name)
  compiled._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    filename
  )
  return compiled.exports
}

// Exercise the real hook's effects and cleanups without introducing a DOM test dependency.
function lifecycle() {
  const slots = []
  let cursor, dirty, effects
  const react = {
    useRef(value) {
      return (slots[cursor++] ??= { current: value })
    },
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: initial }
      return [
        slots[index].value,
        (value) => {
          if (!Object.is(value, slots[index].value)) dirty = true
          slots[index].value = value
        },
      ]
    },
    useEffect(effect, dependencies) {
      const index = cursor++
      const previous = slots[index]
      if (previous && dependencies.every((value, i) => Object.is(value, previous.deps[i]))) return
      effects.push(() => {
        previous?.cleanup?.()
        slots[index] = { deps: dependencies, cleanup: effect() }
      })
    },
  }
  return {
    react,
    render(hook, expanded) {
      let result
      do {
        cursor = 0
        dirty = false
        effects = []
        result = hook('target', 1, true, expanded)
        result.ref.current ??= {}
        effects.forEach((effect) => effect())
      } while (dirty)
      return result
    },
    close() {
      slots.forEach((slot) => slot.cleanup?.())
    },
  }
}

test('offscreen collapsed cards release local history, ignore late completions, and reuse the bounded cache on re-entry', async (t) => {
  const original = {
    window: global.window,
    observer: global.IntersectionObserver,
    fetch: global.fetch,
  }
  const runtime = lifecycle()
  let observed,
    response,
    requests = 0,
    cancelled = 0
  global.window = {}
  global.IntersectionObserver = class {
    constructor(callback, options) {
      observed = callback
      assert.equal(options.rootMargin, '120px')
    }
    observe() {}
    disconnect() {}
  }
  global.window.IntersectionObserver = global.IntersectionObserver
  global.fetch = (_url, { signal }) => {
    requests++
    return new Promise((resolve, reject) => {
      response = resolve
      signal.addEventListener(
        'abort',
        () => {
          cancelled++
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true }
      )
    })
  }
  t.after(() => {
    runtime.close()
    global.window = original.window
    global.IntersectionObserver = original.observer
    global.fetch = original.fetch
  })
  const loader = load(path.join(__dirname, 'public-history-loader.ts'))
  const hook = load(path.join(__dirname, '../components/usePublicHistory.ts'), {
    react: runtime.react,
    '@/util/public-history-loader': loader,
  }).default
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.render(hook, false).inView, false)
  assert.equal(requests, 0)
  observed([{ isIntersecting: true }])
  runtime.render(hook, false)
  await settle()
  assert.equal(requests, 1)
  observed([{ isIntersecting: false }])
  assert.equal(runtime.render(hook, false).history, undefined)
  const full = {
    monitorId: 'target',
    summary: { monitorId: 'target', probes: [], historyLoaded: true },
  }
  response({ ok: true, json: async () => full })
  await settle()
  assert.equal(runtime.render(hook, false).history, undefined, 'late data is discarded')
  assert.equal(cancelled, 1, 'offscreen request is cancelled')
  observed([{ isIntersecting: true }])
  runtime.render(hook, false)
  await settle()
  assert.equal(requests, 2, 'cancelled data is fetched again')
  response({ ok: true, json: async () => full })
  await settle()
  assert.equal(runtime.render(hook, false).history, full)
  observed([{ isIntersecting: false }])
  runtime.render(hook, false)
  observed([{ isIntersecting: true }])
  runtime.render(hook, false)
  await settle()
  assert.equal(requests, 2, 'completed data is reused from the bounded cache')
  runtime.render(hook, true)
  observed([{ isIntersecting: false }])
  runtime.render(hook, true)
  await settle()
  assert.equal(
    runtime.render(hook, true).history,
    full,
    'explicitly expanded details remain available'
  )
  assert.equal(
    runtime.render(hook, false).history,
    undefined,
    'collapsing offscreen releases data again'
  )
})
