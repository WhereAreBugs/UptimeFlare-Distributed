const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const filename = path.join(__dirname, 'internal-id.ts')
const loaded = new Module(filename, module)
loaded._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  filename
)
const { createInternalId, normalizeInternalIds } = loaded.exports

test('identity allocation handles a forced UUID collision without changing existing identities', () => {
  const used = new Set(['monitor-fixed', 'monitor-fixed-1'])
  assert.equal(
    createInternalId('monitor', used, () => 'fixed'),
    'monitor-fixed-2'
  )
  assert.equal(
    createInternalId('monitor', used, () => 'fixed'),
    'monitor-fixed-3'
  )
  const normalized = normalizeInternalIds(
    [{ id: 'existing' }, { id: 'existing' }, {}, { id: 'another' }],
    'monitor'
  )
  assert.equal(normalized[0].id, 'existing')
  assert.equal(normalized[3].id, 'another')
  assert.equal(new Set(normalized.map((item) => item.id)).size, 4)
})
