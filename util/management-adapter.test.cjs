const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const filename = path.join(__dirname, '..', 'pages/api/manage/[...path].ts')
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const scope = {
  exports: {},
  Request,
  URL,
  process: { env: {} },
  require: (name) => {
    if (name === '@/uptime.config') return { workerConfig: {} }
    if (name === '@/worker/src/management')
      return {
        handleManagementRequest: async (request) =>
          new Response(
            JSON.stringify({
              pathname: new URL(request.url).pathname,
              search: new URL(request.url).search,
              method: request.method,
              body: request.method === 'POST' ? await request.text() : null,
              origin: request.headers.get('Origin'),
              authorization: request.headers.get('Authorization'),
            })
          ),
      }
    throw new Error('Unexpected management adapter dependency')
  },
}
vm.runInNewContext(code, scope)
const handle = async (url, init) => (await scope.exports.default(new Request(url, init))).json()

test('catch-all metadata is removed only when exactly bound to the real pathname', async () => {
  for (const key of ['nxtPpath', 'path']) {
    assert.equal((await handle(`https://status.test/api/manage/groups?${key}=groups`)).search, '')
    assert.equal(
      (await handle(`https://status.test/api/manage/groups?${key}=status`)).search,
      `?${key}=status`
    )
    assert.equal(
      (await handle(`https://status.test/api/manage/groups?${key}=groups&${key}=status`)).search,
      `?${key}=groups&${key}=status`
    )
  }
  const result = await handle(
    'https://status.test/api/manage/groups?path=groups&token=unused&foo=bar'
  )
  assert.equal(result.pathname, '/api/manage/groups')
  assert.equal(result.search, '?token=unused&foo=bar')
})

test('rewriting keeps POST body and authentication/origin boundaries intact', async () => {
  const result = await handle(
    'https://status.test/api/manage/monitors/one/disable?nxtPpath=monitors%2Fone%2Fdisable',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dummy',
        Origin: 'https://foreign.test',
        'Content-Type': 'application/json',
      },
      body: '{}',
    }
  )
  assert.deepEqual(result, {
    pathname: '/api/manage/monitors/one/disable',
    search: '',
    method: 'POST',
    body: '{}',
    origin: 'https://foreign.test',
    authorization: 'Bearer dummy',
  })
})
