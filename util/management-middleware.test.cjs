const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const code = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '..', 'compat/middleware.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText
const scope = {
  exports: {},
  btoa: (value) => Buffer.from(value).toString('base64'),
  require: (name) => {
    if (name === '../uptime.config')
      return { workerConfig: { passwordProtection: 'fixture:password' } }
    if (name === 'next/server')
      return {
        NextResponse: { json: (body, options) => new Response(JSON.stringify(body), options) },
      }
    throw new Error('Unexpected middleware dependency')
  },
}
vm.runInNewContext(code, scope)
const request = (pathname, authorization) => ({
  nextUrl: new URL(pathname, 'https://status.example'),
  headers: new Headers(authorization ? { Authorization: authorization } : {}),
})

test('exact independent Bearer routes bypass legacy Basic protection to reach their own authentication', async () => {
  for (const route of [
    '/api/manage/groups',
    '/api/manage/status',
    '/api/manage/groups/group/status',
    '/api/manage/groups/group/enable',
    '/api/manage/groups/group/disable',
    '/api/manage/monitors/monitor/status',
    '/api/manage/monitors/monitor/enable',
    '/api/manage/monitors/monitor/disable',
    '/api/probes/config',
    '/api/probes/ingest',
  ])
    assert.equal(await scope.exports.middleware(request(route, 'Bearer fixture')), undefined, route)
})

test('administrator and unknown routes retain Basic protection, and Bearer cannot replace Basic', async () => {
  const basic = 'Basic ' + Buffer.from('fixture:password').toString('base64')
  for (const route of [
    '/admin',
    '/api/admin/config',
    '/api/admin/login',
    '/api/admin/tokens',
    '/api/admin/tokens/token',
    '/',
    '/api/manage/arbitrary',
    '/api/manage/status/extra',
    '/api/probes/config/extra',
  ]) {
    assert.equal((await scope.exports.middleware(request(route))).status, 401, route)
    assert.equal(
      (await scope.exports.middleware(request(route, 'Bearer fixture'))).status,
      401,
      route
    )
    assert.equal(await scope.exports.middleware(request(route, basic)), undefined, route)
  }
})
