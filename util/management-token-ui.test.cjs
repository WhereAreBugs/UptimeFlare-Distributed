const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const filename = path.join(__dirname, 'management-token-ui.ts')
const compiled = new Module(filename, module)
compiled.filename = filename
compiled.paths = module.paths
compiled._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  filename
)
const {
  savedGroupRenames,
  renamedSavedGroupIds,
  managementTokenExpiry,
  managementTokenGroups,
  managementTokenStatus,
} = compiled.exports

test('only surviving saved groups can retain identity through a trimmed rename', () => {
  const groups = { Mac: ['mac'], New: ['new'], Unchanged: [] }
  const ids = { Mac: 'stable-mac', Deleted: 'stable-deleted', Unchanged: 'stable-unchanged' }
  const drafts = { Mac: '  Servers  ', Deleted: 'Moved', New: 'Fresh', Unchanged: 'Unchanged' }
  assert.deepEqual(savedGroupRenames(groups, ids, drafts), { Mac: 'Servers' })
  assert.deepEqual(groups.Mac, ['mac'])
  assert.equal(drafts.Mac, '  Servers  ')
})

test('rename follows identity and delete/recreate with the same name cannot regain authorization', () => {
  const token = { groupIds: ['original-mac', 'stable-other'] }
  assert.deepEqual(
    managementTokenGroups(token, [
      { id: 'original-mac', name: 'Renamed', targetCount: 1 },
      { id: 'stable-other', name: 'Other', targetCount: 0 },
    ]),
    { names: ['Renamed', 'Other'], deleted: 0 }
  )
  assert.deepEqual(
    managementTokenGroups(token, [
      { id: 'recreated-mac', name: 'Mac', targetCount: 1 },
      { id: 'stable-other', name: 'Other', targetCount: 0 },
    ]),
    { names: ['Other'], deleted: 1 }
  )
  assert.deepEqual(savedGroupRenames({ Mac: [] }, {}, { Mac: 'Renamed again' }), {})
})

test('submitted IDs use final renamed keys without assigning an ID to a recreated or draft group', () => {
  assert.deepEqual(
    renamedSavedGroupIds(
      { Renamed: ['old-a'], Other: ['other'], Recreated: [], New: [] },
      { A: 'identity-a', Other: 'identity-other', Removed: 'retired' },
      { A: 'Renamed' }
    ),
    { Renamed: 'identity-a', Other: 'identity-other' }
  )
})

test('expiration is an absolute Unix instant and refuses expired or invalid input', () => {
  const now = Date.parse('2026-10-04T12:00:00Z')
  assert.equal(managementTokenExpiry('', now), null)
  assert.equal(managementTokenExpiry('2026-10-04T20:01:00+08:00', now), now / 1000 + 60)
  for (const value of ['bad-date', '2026-10-04T12:00:00Z', '2026-10-04T11:59:59Z'])
    assert.throws(() => managementTokenExpiry(value, now), /晚于当前时间/)
  const local = new Date('2026-10-05T10:00')
  assert.equal(managementTokenExpiry('2026-10-05T10:00', now), local.getTime() / 1000)
})

test('revocation has priority and expiration becomes inactive at the exact boundary', () => {
  assert.equal(managementTokenStatus({ revokedAt: null, expiresAt: null }, 100), 'active')
  assert.equal(managementTokenStatus({ revokedAt: null, expiresAt: 101 }, 100), 'active')
  assert.equal(managementTokenStatus({ revokedAt: null, expiresAt: 100 }, 100), 'expired')
  assert.equal(managementTokenStatus({ revokedAt: 0, expiresAt: 100 }, 100), 'revoked')
})
