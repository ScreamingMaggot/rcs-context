// Isolated shadow-ledger observation adapters. Run: node tests/memory-ledger-eval.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  assertAuditPaths,
  canonicalProspectivePath,
  computeAuditChecks,
  inspectLegacyInsight,
  pathRelation,
  UsageError,
} from '../work/memory-ledger-20261025/audit.mjs'
import {
  observationFromTool,
  observationFromProbe,
  observationFromLegacy,
  observationFromScopeInit,
  fileEntityRef,
} from '../web/memory-observations.mjs'
import {
  canonicalJson,
  factsAt,
  projectLedger,
  renderFacts,
  sha256Canonical,
} from '../web/memory-ledger-core.mjs'
import { MemoryLedger } from '../web/memory-ledger.mjs'

const SCOPE = 'workspace:adapter-test'
const PATH = 'C:/project/a.txt'
const HASH_A = 'a'.repeat(64)

function project(observations) {
  return projectLedger({ observations, assertions: [], reducerVersion: 'r1' })
}

function current(projection, predicate) {
  return projection.currentFacts.find((fact) => fact.predicate === predicate)
}

function toolCall(name, args = {}, extra = {}) {
  return {
    callId: `call-${name}`,
    name,
    arguments: args,
    scope: SCOPE,
    ts: 1000,
    ...extra,
  }
}

test('tool archive retains complete untruncated call arguments and results', () => {
  const longArguments = 'argument-'.repeat(300)
  const longResult = 'result-'.repeat(400)
  const call = toolCall('write', { path: PATH, content: longArguments, nested: { keep: true } })
  const result = { ok: true, ts: 1100, output: longResult, size: 2400, mtime: 123, sha256: HASH_A }
  const observation = observationFromTool({ call, result, sid: 's1', seq: 7, recordedAt: 1200 })

  assert.deepEqual(observation.rawPayload, { call, result })
  assert.equal(observation.rawPayload.call.arguments.content.length, longArguments.length)
  assert.equal(observation.rawPayload.result.output.length, longResult.length)
  assert.equal(observation.eventKey, 's1:7:call-write')
  assert.equal(observation.rawRef, 's1:7:call-write')
  assert.equal(observation.op, 'write')
  assert.equal(observation.outcome, 'success')
  assert.equal(observation.validAt, 1100)
  assert.deepEqual(observation.value, { size: 2400, mtime: 123, sha256: HASH_A })
})

test('successful and failed writes are explicit and failures derive no facts', () => {
  const successful = observationFromTool({
    call: toolCall('write', { path: PATH, content: 'new' }),
    result: { ok: true, ts: 1000 }, sid: 's1', seq: 1, recordedAt: 1000,
  })
  const failed = observationFromTool({
    call: toolCall('write', { path: PATH, content: 'bad' }, { callId: 'failed-write' }),
    result: { ok: false, error: { code: 'EACCES', message: 'denied' }, ts: 2000 },
    sid: 's1', seq: 2, recordedAt: 2000,
  })
  const before = project([successful])
  const after = project([successful, failed])

  assert.equal(failed.op, 'write')
  assert.equal(failed.outcome, 'failure')
  assert.deepEqual(failed.value, {})
  assert.equal(canonicalJson(after.currentFacts), canonicalJson(before.currentFacts))
  assert.equal(after.factVersions.some((fact) => fact.assertionId.includes('failed-write')), false)
})

test('successful delete closes current facts but failed delete cannot mutate them', () => {
  const write = observationFromTool({
    call: toolCall('write', { path: PATH, content: 'new' }),
    result: { ok: true, ts: 1000, size: 3 }, sid: 's1', seq: 1, recordedAt: 1000,
  })
  const failedDelete = observationFromTool({
    call: toolCall('delete', { path: PATH }, { callId: 'failed-delete' }),
    result: { isError: true, ts: 2000 }, sid: 's1', seq: 2, recordedAt: 2000,
  })
  const deleteObservation = observationFromTool({
    call: toolCall('delete', { path: PATH }, { callId: 'delete' }),
    result: { ok: true, ts: 3000 }, sid: 's1', seq: 3, recordedAt: 3000,
  })
  const before = project([write])
  const afterFailure = project([write, failedDelete])
  const afterDelete = project([write, failedDelete, deleteObservation])

  assert.equal(failedDelete.outcome, 'failure')
  assert.equal(canonicalJson(afterFailure.currentFacts), canonicalJson(before.currentFacts))
  assert.equal(deleteObservation.op, 'delete')
  assert.equal(deleteObservation.outcome, 'success')
  assert.equal(afterDelete.currentFacts.length, 1)
  assert.equal(current(afterDelete, 'file.exists').value, false)
})

test('unknown shell stays task unknown even when its payload resembles file state', () => {
  const write = observationFromTool({
    call: toolCall('write', { path: PATH }), result: { ok: true, ts: 1000 },
    sid: 's1', seq: 1, recordedAt: 1000,
  })
  const shell = observationFromTool({
    call: toolCall('pwsh', { command: `Remove-Item '${PATH}'` }, { callId: 'shell' }),
    result: { ok: true, ts: 2000, exists: false, size: 0, sha256: HASH_A },
    sid: 's1', seq: 2, recordedAt: 2000,
  })
  const before = project([write])
  const after = project([write, shell])

  assert.equal(shell.op, 'task')
  assert.equal(shell.outcome, 'unknown')
  assert.equal(shell.subjectEntityId, 'task:s1:2:shell')
  assert.deepEqual(shell.value, {})
  assert.equal(canonicalJson(after.currentFacts), canonicalJson(before.currentFacts))
  assert.equal(after.observationPlacements.find((item) => item.eventKey === shell.eventKey).reason,
    'outcome-unknown')
})

test('read and stat normalize only explicitly reported measured fields', () => {
  const write = observationFromTool({
    call: toolCall('write', { path: PATH }), result: { ok: true, ts: 1000, size: 3 },
    sid: 's1', seq: 1, recordedAt: 1000,
  })
  const read = observationFromTool({
    call: toolCall('read', { path: PATH }, { callId: 'read' }),
    result: { ok: true, ts: 2000, value: { size: 3, sha256: HASH_A }, ignored: 'not-a-fact' },
    sid: 's1', seq: 2, recordedAt: 2000,
  })
  const stat = observationFromTool({
    call: toolCall('stat', { path: PATH }, { callId: 'stat' }),
    result: { ok: true, ts: 3000, mtime: 456 }, sid: 's1', seq: 3, recordedAt: 3000,
  })
  const projection = project([write, read, stat])

  assert.equal(read.op, 'read')
  assert.deepEqual(read.value, { size: 3, sha256: HASH_A })
  assert.equal(stat.op, 'stat')
  assert.deepEqual(stat.value, { mtime: 456 })
  assert.equal(current(projection, 'file.size').value, 3)
  assert.equal(current(projection, 'file.sha256').value, HASH_A)
  assert.equal(current(projection, 'file.mtime').value, 456)
})

test('probe present always reads bytes and hashes same-size same-mtime content changes', async () => {
  const resolvedPath = 'C:\\project\\a.txt'
  const files = new Map([[resolvedPath, Buffer.from('aaaa')]])
  let reads = 0
  const io = {
    async stat(path) {
      assert.equal(path, resolvedPath)
      return { size: 4, mtimeMs: 999 }
    },
    async readFile(path) {
      reads++
      return files.get(path)
    },
    async realpath(path) { return path },
  }
  const first = await observationFromProbe({
    path: PATH, scope: SCOPE, probeId: 'probe-1', validAt: 1000, recordedAt: 1100, io,
  })
  const firstProjection = project([first])
  files.set(resolvedPath, Buffer.from('bbbb'))
  const second = await observationFromProbe({
    path: PATH, scope: SCOPE, probeId: 'probe-2', validAt: 2000, recordedAt: 2100, io,
  })
  const secondProjection = project([first, second])

  assert.equal(reads, 2)
  assert.equal(first.value.size, 4)
  assert.equal(second.value.size, 4)
  assert.equal(first.value.mtime, 999)
  assert.equal(second.value.mtime, 999)
  assert.equal(first.value.sha256, '61be55a8e2f6b4e172338bddf184d6dbee29c98853e0a0485ecee7f27b9af0b4')
  assert.equal(second.value.sha256, '81cc5b17018674b401b42f35ba07bb79e211239c23bffe658da1577e3e646877')
  assert.notEqual(first.value.sha256, second.value.sha256)
  assert.equal(current(firstProjection, 'file.sha256').value, first.value.sha256)
  assert.equal(current(secondProjection, 'file.sha256').value, second.value.sha256)
  assert.equal(second.sid, 'probe')
  assert.equal(second.seq, 0)
})

test('probe missing is observed absence, not an I/O error', async () => {
  let reads = 0
  const observation = await observationFromProbe({
    path: PATH, scope: SCOPE, probeId: 'probe-missing', validAt: 1000, recordedAt: 1100,
    io: {
      async stat() { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) },
      async readFile() { reads++; throw new Error('must not read a missing path') },
    },
  })

  assert.equal(observation.op, 'probe')
  assert.equal(observation.outcome, 'observed')
  assert.deepEqual(observation.value, { exists: false })
  assert.equal(observation.rawPayload.error.code, 'ENOENT')
  assert.equal(reads, 0)
  assert.equal(current(project([observation]), 'file.exists').value, false)
})

test('probe read and permission errors stay errors and cannot mutate current facts', async () => {
  for (const failure of [
    { stage: 'stat', code: 'EACCES' },
    { stage: 'read', code: 'EACCES' },
    { stage: 'read', code: 'EIO' },
  ]) {
    const present = await observationFromProbe({
      path: PATH, scope: SCOPE, probeId: `before-${failure.stage}-${failure.code}`,
      validAt: 1000, recordedAt: 1000,
      io: {
        async stat() { return { size: 1, mtimeMs: 10 } },
        async readFile() { return Buffer.from('x') },
      },
    })
    const failed = await observationFromProbe({
      path: PATH, scope: SCOPE, probeId: `error-${failure.stage}-${failure.code}`,
      validAt: 2000, recordedAt: 2000,
      io: {
        async stat() {
          if (failure.stage === 'stat') throw Object.assign(new Error('denied'), { code: failure.code })
          return { size: 1, mtimeMs: 10 }
        },
        async readFile() { throw Object.assign(new Error('read failed'), { code: failure.code }) },
      },
    })
    const before = project([present])
    const after = project([present, failed])

    assert.equal(failed.op, 'error')
    assert.equal(failed.outcome, 'failure')
    assert.deepEqual(failed.value, {})
    assert.equal(failed.rawPayload.error.code, failure.code)
    assert.notDeepEqual(failed.value, { exists: false })
    assert.equal(canonicalJson(after.currentFacts), canonicalJson(before.currentFacts))
    assert.equal(after.factVersions.some((fact) => fact.assertionId.includes(failed.eventKey)), false)
  }
})

test('legacy snapshots retain complete rawRecord and never become current semantic facts', () => {
  const rawRecord = {
    rowid: 42,
    sid: 'legacy-session',
    seq: 9,
    kind: 'file_state',
    key: 'file:c:/project/a.txt',
    value: { path: PATH, exists: true, size: 99, sha256: HASH_A, note: 'x'.repeat(2500) },
    source: { sid: 'legacy-session', seq: 9, ts: 500 },
    updated_ts: 700,
    extra: { preserve: ['every', 'field'] },
  }
  const observation = observationFromLegacy({ record: rawRecord, scope: SCOPE, rawRecord })
  const projection = project([observation])

  assert.equal(observation.op, 'legacy_snapshot')
  assert.equal(observation.outcome, 'observed')
  assert.deepEqual(observation.rawPayload, rawRecord)
  assert.equal(observation.rawPayload.value.note.length, 2500)
  assert.equal(observation.source.kind, 'legacy')
  assert.deepEqual(observation.value, {})
  assert.equal(projection.currentFacts.length, 0)
  assert.equal(projection.factVersions.length, 0)
  assert.equal(projection.observationPlacements[0].unplaced, true)
})

test('scope init opens a project generation without file-style existence facts', () => {
  const init = observationFromScopeInit({
    scope: SCOPE, entityId: 'project:decisions', sid: 's1', seq: 3,
    validAt: 1000, recordedAt: 1000,
  })
  assert.equal(init.op, 'scope_init')
  assert.equal(init.outcome, 'observed')
  assert.equal(init.subjectEntityId, 'project:decisions')
  assert.equal(init.value.entityType, 'project')
  const bare = observationFromScopeInit({
    scope: SCOPE, entityId: 'settings', sid: 's1', seq: 4, validAt: 1000, recordedAt: 1000,
  })
  assert.equal(bare.subjectEntityId, 'project:settings')

  const projection = projectLedger({
    observations: [init],
    assertions: [{
      assertionId: 'scope-decision', scope: SCOPE, subjectEntityId: 'project:decisions',
      sid: 's1', seq: 5, op: 'assert', targetAssertionId: null,
      predicate: 'project.decision', value: { text: '采用隔离账本' }, qualifiers: null,
      validAt: 1500, recordedAt: 1500, sourceKind: 'user', sourceAuthority: 'user',
      evidence: null, verification: 'user-confirmed',
    }],
    reducerVersion: 'r1',
  })
  const facts = projection.currentFacts
  assert.equal(facts.length, 1)
  assert.equal(facts[0].predicate, 'project.decision')
  assert.equal(facts[0].generation, 1)
  assert.equal(facts.some((fact) => fact.predicate.startsWith('file.')), false)
  const rendered = renderFacts(facts, 4000)
  assert.match(rendered.text, /项目决策：采用隔离账本/)
  assert.doesNotMatch(rendered.text, /文件路径/)
})

test('relative tool paths require a cwd while absolute . and .. segments are resolved', () => {
  assert.equal(fileEntityRef('notes/a.txt', { platform: 'win32' }), null)
  assert.equal(fileEntityRef('notes\\a.txt', { cwd: 'C:\\Work', platform: 'win32' }).entityId,
    'c:/work/notes/a.txt')
  const dotted = fileEntityRef('C:\\Proj\\.\\sub\\..\\A.TXT', { platform: 'win32' })
  assert.equal(dotted.entityId, 'c:/proj/a.txt')
  assert.equal(dotted.displayPath, 'C:\\Proj\\.\\sub\\..\\A.TXT')

  const withoutCwd = observationFromTool({
    call: toolCall('write', { path: 'notes/a.txt' }), result: { ok: true, ts: 1000 },
    sid: 's1', seq: 1, recordedAt: 1000, platform: 'win32',
  })
  assert.equal(withoutCwd.outcome, 'unknown')
  assert.match(withoutCwd.subjectEntityId, /^unresolved:/)
  const withCwd = observationFromTool({
    call: toolCall('write', { path: 'notes/a.txt' }), result: { ok: true, ts: 1000 },
    sid: 's1', seq: 2, recordedAt: 1000, cwd: 'C:\\Work', platform: 'win32',
  })
  assert.equal(withCwd.subjectEntityId, 'c:/work/notes/a.txt')
})

test('relative probes require an explicit cwd', async () => {
  await assert.rejects(() => observationFromProbe({
    path: 'notes/a.txt', scope: SCOPE, probeId: 'probe-relative-without-cwd',
    validAt: 1000, recordedAt: 1000, platform: 'win32',
    io: {
      async stat() { return { size: 1 } },
      async readFile() { return Buffer.from('x') },
    },
  }), TypeError)
})

test('probe without an observed mtime omits it and stays archiveable', async () => {
  const observation = await observationFromProbe({
    path: PATH, scope: SCOPE, probeId: 'probe-no-mtime', validAt: 1000, recordedAt: 1100,
    io: {
      async stat() { return { size: 4 } },
      async readFile() { return Buffer.from('abcd') },
      async realpath(path) { return path },
    },
  })

  assert.deepEqual(observation.value, {
    exists: true,
    size: 4,
    sha256: '88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589',
  })
  assert.equal(Object.hasOwn(observation.value, 'mtime'), false)
  assert.equal(Object.hasOwn(observation.rawPayload, 'mtime'), false)
  assert.doesNotThrow(() => canonicalJson(observation))
  assert.doesNotThrow(() => canonicalJson(observation.value))

  const invalidDate = await observationFromProbe({
    path: PATH, scope: SCOPE, probeId: 'probe-invalid-mtime', validAt: 1000, recordedAt: 1100,
    io: {
      async stat() { return { size: 4, mtimeMs: Number.NaN, mtime: new Date('not-a-date') } },
      async readFile() { return Buffer.from('abcd') },
    },
  })
  assert.equal(Object.hasOwn(invalidDate.value, 'mtime'), false)
  assert.equal(Object.hasOwn(invalidDate.rawPayload, 'mtime'), false)
  assert.doesNotThrow(() => canonicalJson(invalidDate))

  const directory = mkdtempSync(join(tmpdir(), 'rcs-ledger-eval-'))
  const ledger = new MemoryLedger(join(directory, 'ledger.db'))
  try {
    ledger.appendObservation(observation)
    const facts = ledger.currentFacts(SCOPE)
    assert.equal(facts.find((fact) => fact.predicate === 'file.exists')?.value, true)
    assert.equal(facts.find((fact) => fact.predicate === 'file.size')?.value, 4)
    assert.equal(facts.some((fact) => fact.predicate === 'file.mtime'), false)
  } finally {
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('production renderCurrent suppresses absence markers for missing files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rcs-ledger-render-'))
  const ledger = new MemoryLedger(join(directory, 'ledger.db'))
  const observation = (eventKey, seq, validAt, op, outcome, value) => ({
    eventKey,
    scope: SCOPE,
    sid: 'render',
    seq,
    validAt,
    recordedAt: validAt,
    op,
    outcome,
    subjectEntityId: 'c:/project/gone.txt',
    targetEntityId: null,
    value,
    generationHints: null,
    rawRef: null,
    rawPayload: { eventKey },
    source: { kind: 'observation', authority: 'host' },
    extractorVersion: 'test',
  })
  try {
    ledger.appendObservation(observation('render-write', 1, 1000, 'write', 'success',
      { size: 3, sha256: HASH_A }))
    ledger.appendObservation(observation('render-delete', 2, 2000, 'delete', 'success', {}))
    const current = ledger.currentFacts(SCOPE)
    const preserved = ledger.currentFacts(SCOPE, { injectableOnly: true })
    const rendered = ledger.renderCurrent(SCOPE, 10000)

    // The absence marker stays a legitimate current fact for explicit audit...
    assert.equal(current.filter((fact) => fact.predicate === 'file.exists').length, 1)
    assert.equal(current.find((fact) => fact.predicate === 'file.exists').value, false)
    assert.equal(preserved.some((fact) => fact.predicate === 'file.exists'), true)
    // ...but automatic rendering never injects it.
    assert.equal(rendered.text, '')
    assert.equal(rendered.selected.length, 0)
    assert.equal(rendered.suppressedCount, 1)
  } finally {
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('file operations without a structured path stay unknown instead of a false state', () => {
  const write = observationFromTool({
    call: toolCall('write', { path: PATH }), result: { ok: true, ts: 1000, size: 3 },
    sid: 's1', seq: 1, recordedAt: 1000,
  })
  const pathlessWrite = observationFromTool({
    call: toolCall('write', { content: 'new' }, { callId: 'pathless-write' }),
    result: { ok: true, ts: 2000, size: 3 }, sid: 's1', seq: 2, recordedAt: 2000,
  })
  const malformedDelete = observationFromTool({
    call: toolCall('delete', { path: '   ' }, { callId: 'malformed-delete' }),
    result: { ok: true, ts: 3000 }, sid: 's1', seq: 3, recordedAt: 3000,
  })
  const nonStringDelete = observationFromTool({
    call: toolCall('delete', { path: 42 }, { callId: 'non-string-delete' }),
    result: { ok: true, ts: 4000 }, sid: 's1', seq: 4, recordedAt: 4000,
  })
  const renameWithoutTarget = observationFromTool({
    call: toolCall('rename', { path: PATH }, { callId: 'rename-no-target' }),
    result: { ok: true, ts: 5000 }, sid: 's1', seq: 5, recordedAt: 5000,
  })

  for (const observation of [pathlessWrite, malformedDelete, nonStringDelete, renameWithoutTarget]) {
    const alone = project([observation])
    assert.equal(observation.outcome, 'unknown')
    assert.deepEqual(observation.value, {})
    assert.match(observation.subjectEntityId, /^unresolved:/)
    assert.equal(alone.currentFacts.length, 0)
    assert.equal(alone.entities.length, 0)
    assert.equal(alone.observationPlacements[0].unplaced, true)
  }
  assert.equal(pathlessWrite.op, 'write')
  assert.equal(malformedDelete.op, 'delete')
  assert.equal(nonStringDelete.op, 'delete')
  assert.equal(renameWithoutTarget.op, 'rename')

  const before = project([write])
  const after = project([write, pathlessWrite, malformedDelete, nonStringDelete])
  assert.equal(current(before, 'file.exists').value, true)
  assert.equal(canonicalJson(after.currentFacts), canonicalJson(before.currentFacts))
})

test('file entity keys resolve cwd, unify separators, strip trailing separator, fold case on win32', () => {
  assert.equal(fileEntityRef('C:\\Proj\\A.TXT\\', { platform: 'win32' }).entityId, 'c:/proj/a.txt')
  assert.equal(fileEntityRef('c:/proj/a.txt', { platform: 'win32' }).entityId, 'c:/proj/a.txt')
  assert.equal(fileEntityRef('C:\\', { platform: 'win32' }).entityId, 'c:/')
  assert.equal(fileEntityRef('a.txt', { cwd: 'C:\\Proj', platform: 'win32' }).entityId, 'c:/proj/a.txt')
  assert.equal(fileEntityRef('/proj/A.TXT', { platform: 'linux' }).entityId, '/proj/A.TXT')
  assert.equal(fileEntityRef('//server/share/', { platform: 'win32' }).entityId, '//server/share')
  assert.equal(fileEntityRef('/', { platform: 'linux' }).entityId, '/')
  assert.equal(fileEntityRef('   ', { platform: 'win32' }), null)
  assert.equal(fileEntityRef(42, { platform: 'win32' }), null)

  const reference = fileEntityRef('C:\\Proj\\A.TXT\\', { cwd: 'C:\\Proj', platform: 'win32' })
  assert.equal(reference.displayPath, 'C:\\Proj\\A.TXT\\')
  assert.equal(reference.resolvedPath, 'C:\\Proj\\A.TXT')
})

test('tool and probe path variants resolve to one file entity with no alias fact', async () => {
  const toolWrite = observationFromTool({
    call: toolCall('write', { path: 'C:\\Proj\\A.TXT', content: 'x' }),
    result: { ok: true, ts: 1000, size: 1 }, sid: 's1', seq: 1, recordedAt: 1000,
    platform: 'win32',
  })
  const probe = await observationFromProbe({
    path: 'c:/proj/a.txt', scope: SCOPE, probeId: 'probe-alias', validAt: 2000, recordedAt: 2000,
    platform: 'win32',
    io: {
      async realpath() { return 'c:\\proj\\a.txt' },
      async stat() { return { size: 1, mtimeMs: 5 } },
      async readFile() { return Buffer.from('x') },
    },
  })
  const projection = project([toolWrite, probe])

  assert.equal(toolWrite.subjectEntityId, 'c:/proj/a.txt')
  assert.equal(probe.subjectEntityId, 'c:/proj/a.txt')
  assert.equal(toolWrite.source.displayPath, 'C:\\Proj\\A.TXT')
  assert.equal(toolWrite.source.resolvedPath, 'C:\\Proj\\A.TXT')
  assert.equal(probe.source.displayPath, 'c:/proj/a.txt')
  assert.equal(probe.source.resolvedPath, 'c:\\proj\\a.txt')
  assert.equal(probe.rawPayload.path, 'c:/proj/a.txt')
  assert.equal(probe.rawPayload.resolvedPath, 'c:\\proj\\a.txt')
  assert.equal(projection.entities.length, 1)
  assert.equal(projection.currentFacts.filter((fact) => fact.predicate === 'file.exists').length, 1)
  assert.equal(current(projection, 'file.exists').value, true)
  assert.equal(current(projection, 'file.size').value, 1)
  assert.equal(projection.currentFacts.every((fact) => fact.subjectEntityId === 'c:/proj/a.txt'), true)
})

test('adapters reject empty scope instead of archiving empty or undefined scopes', async () => {
  assert.throws(() => observationFromTool({
    call: { callId: 'no-scope', name: 'read', arguments: { path: PATH } },
    result: { ok: true }, sid: 's1', seq: 1, recordedAt: 1000,
  }), TypeError)
  assert.throws(() => observationFromTool({
    call: toolCall('read', { path: PATH }, { scope: '   ' }),
    result: { ok: true }, sid: 's1', seq: 2, recordedAt: 1000,
  }), TypeError)
  await assert.rejects(() => observationFromProbe({
    path: PATH, scope: '', probeId: 'probe-no-scope',
    io: { async stat() { return { size: 1 } }, async readFile() { return Buffer.from('x') } },
  }), TypeError)
  await assert.rejects(() => observationFromProbe({
    path: '  ', scope: SCOPE, probeId: 'probe-no-path',
    io: { async stat() { return { size: 1 } }, async readFile() { return Buffer.from('x') } },
  }), TypeError)
  assert.throws(() => observationFromLegacy({ record: { rowid: 1 }, scope: undefined }), TypeError)
})

test('uppercase SHA-256 values are normalized to lowercase', () => {
  const write = observationFromTool({
    call: toolCall('write', { path: PATH }), result: { ok: true, ts: 1000, size: 1 },
    sid: 's1', seq: 1, recordedAt: 1000,
  })
  const read = observationFromTool({
    call: toolCall('read', { path: PATH }, { callId: 'read-uppercase-sha' }),
    result: { ok: true, ts: 2000, value: { sha256: HASH_A.toUpperCase() } },
    sid: 's1', seq: 2, recordedAt: 2000,
  })

  assert.equal(read.value.sha256, HASH_A)
  assert.equal(current(project([write, read]), 'file.sha256').value, HASH_A)
})

test('probe error raw payload retains the resolved path', async () => {
  const observation = await observationFromProbe({
    path: PATH, scope: SCOPE, probeId: 'probe-error-path', validAt: 1000, recordedAt: 1000,
    io: {
      async realpath() { return 'C:\\Project\\a.txt' },
      async stat() { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
      async readFile() { return Buffer.from('x') },
    },
  })

  assert.equal(observation.op, 'error')
  assert.equal(observation.rawPayload.path, PATH)
  assert.equal(observation.rawPayload.resolvedPath, 'C:\\Project\\a.txt')
})

// ---------------------------------------------------------------------------
// Projection scorer: one correct fixture plus eight broken implementations.
// ---------------------------------------------------------------------------

const SCORER_SCOPE = 'workspace:scorer'
const SCORER_A = 'C:/scorer/a.txt'
const SCORER_B = 'C:/scorer/b.txt'
const SCORER_A_ID = 'c:/scorer/a.txt'
const SCORER_B_ID = 'c:/scorer/b.txt'
const HASH_B = 'b'.repeat(64)
const SCORER_REPLAY = { validAt: 3500, recordedAt: 3500 }
// Independently computed golden digest for the fixed fixture, at the fixed replay
// times above. It was produced from hand-written historical rows (see
// GOLDEN_REPLAY_ROWS below), never from the projection under test, so a reducer
// that changes replay output fails the evaluator instead of redefining it.
const SCORER_GOLDEN_REPLAY_HASH =
  '58ae7a686eeec14527888b5a1fa7423a7cb487bd7fc8c37640bc1c59262200c7'

let scorerSeq = 0

function scorerTool(name, path, ts, extra = {}) {
  scorerSeq++
  return observationFromTool({
    call: { callId: `scorer-${name}-${scorerSeq}`, name, arguments: { path } },
    result: { ok: true, ts, ...extra },
    sid: 'scorer',
    seq: scorerSeq,
    recordedAt: ts,
    scope: SCORER_SCOPE,
    platform: 'win32',
  })
}

// A is written then deleted (must leave only an absence marker). B is written,
// deleted, and rewritten with the same bytes, so the correct projection has a
// closed generation 1 and a current generation 2 with identical values.
function scorerFixture() {
  scorerSeq = 0
  return project([
    scorerTool('write', SCORER_A, 1000, { size: 10, sha256: HASH_A }),
    scorerTool('delete', SCORER_A, 2000),
    scorerTool('write', SCORER_B, 1000, { size: 20, sha256: HASH_B }),
    scorerTool('delete', SCORER_B, 2000),
    scorerTool('write', SCORER_B, 3000, { size: 20, sha256: HASH_B }),
  ])
}

function scorerExpected() {
  return {
    scope: SCORER_SCOPE,
    facts: [
      { entityId: SCORER_A_ID, predicate: 'file.exists', value: false },
      { entityId: SCORER_B_ID, predicate: 'file.exists', value: true },
      { entityId: SCORER_B_ID, predicate: 'file.size', value: 20 },
      { entityId: SCORER_B_ID, predicate: 'file.sha256', value: HASH_B },
    ],
    absent: [
      { entityId: SCORER_A_ID, predicate: 'file.size' },
      { entityId: SCORER_A_ID, predicate: 'file.sha256' },
      { entityId: SCORER_A_ID, predicate: 'file.mtime' },
    ],
    generations: [
      { entityId: SCORER_A_ID, generation: 1, presence: false },
      { entityId: SCORER_B_ID, generation: 2, presence: true },
    ],
    conflictFree: true,
    // Nonempty on purpose: the correct fixture must not contain project.decision,
    // so the forbidden-predicate detector has something it could actually leak.
    forbidden: { entities: ['c:/scorer/foreign.txt'], predicates: ['project.decision'] },
    replay: {
      ...SCORER_REPLAY,
      hash: SCORER_GOLDEN_REPLAY_HASH,
    },
  }
}

function brokenProjection(kind) {
  const correct = scorerFixture()
  const expected = scorerExpected()
  const changed = structuredClone(correct)
  // The reducer shares row objects between currentFacts and factVersions. A broken
  // implementation corrupts one surface only, so detach every section before mutating.
  changed.currentFacts = changed.currentFacts.map((fact) => ({ ...fact }))
  changed.factVersions = changed.factVersions.map((fact) => ({ ...fact }))
  changed.entities = changed.entities.map((entity) => ({ ...entity }))
  if (kind === 'missed-invalidation') {
    // Simulates a reducer that ignores the delete: the pre-delete size fact
    // remains current even though the file was removed.
    const beforeDelete = project([observationFromTool({
      call: { callId: 'scorer-pre-delete', name: 'write', arguments: { path: SCORER_A } },
      result: { ok: true, ts: 1000, size: 10, sha256: HASH_A },
      sid: 'scorer', seq: 1, recordedAt: 1000, scope: SCORER_SCOPE, platform: 'win32',
    })])
    changed.currentFacts.push(structuredClone(
      beforeDelete.currentFacts.find((fact) => fact.predicate === 'file.size'),
    ))
  } else if (kind === 'false-invalidation') {
    // Simulates a reducer that treats a read as invalidating real state.
    changed.currentFacts = changed.currentFacts.filter((fact) =>
      !(fact.subjectEntityId === SCORER_B_ID && fact.predicate === 'file.size'))
  } else if (kind === 'old-generation-revival') {
    // Simulates a reducer that reuses the closed generation instead of a new one.
    for (const fact of changed.currentFacts) {
      if (fact.subjectEntityId === SCORER_B_ID) fact.generation = 1
    }
    const entity = changed.entities.find((item) => item.entityId === SCORER_B_ID)
    entity.generation = 1
  } else if (kind === 'cross-scope-pollution') {
    // Simulates a reducer that projects another workspace into this scope.
    const foreign = structuredClone(
      changed.currentFacts.find((fact) => fact.subjectEntityId === SCORER_B_ID),
    )
    foreign.scope = 'workspace:elsewhere'
    foreign.subjectEntityId = 'c:/scorer/foreign.txt'
    changed.currentFacts.push(foreign)
    changed.entities.push({
      scope: 'workspace:elsewhere', entityId: 'c:/scorer/foreign.txt', generation: 1,
      presence: true, openedBy: null, closedBy: null, lastValidAt: null, lastRecordedAt: null,
    })
  } else if (kind === 'conflict-injection') {
    // Simulates a reducer that marks mutually exclusive claims as simultaneous.
    const fact = changed.currentFacts.find((item) =>
      item.subjectEntityId === SCORER_B_ID && item.predicate === 'file.size')
    fact.status = 'conflicted'
    fact.conflict = { assertionIds: [fact.assertionId, `${fact.assertionId}-other`], reason: 'equal-authority-overlap' }
  } else if (kind === 'replay-mismatch') {
    // Simulates a reducer that rewrites history differently from the live projection.
    const row = changed.factVersions.find((fact) =>
      fact.subjectEntityId === SCORER_A_ID && fact.predicate === 'file.exists' && fact.value === false)
    row.value = true
  } else if (kind === 'forbidden-predicate') {
    // Simulates a regulator that lets a non-file predicate class into file scope.
    changed.currentFacts.push({
      scope: SCORER_SCOPE,
      subjectEntityId: 'project:scorer',
      subjectDisplay: 'project:scorer',
      generation: 1,
      predicate: 'project.decision',
      qualifiers: null,
      value: { text: 'leaked decision' },
      assertionId: 'leaked-project-decision',
      evidence: null,
      causalOrder: [1000, 'scorer', 0, 'leaked-project-decision'],
      validFrom: 1000,
      validTo: null,
      recordedAt: 1000,
      retiredAt: null,
      status: 'active',
      verification: 'observed',
      conflict: null,
    })
  } else if (kind === 'expected-fact-mismatch') {
    // Simulates a reducer that computes a wrong value for a correct fact.
    const fact = changed.currentFacts.find((item) =>
      item.subjectEntityId === SCORER_B_ID && item.predicate === 'file.size')
    fact.value = 21
  } else {
    throw new Error(`unknown broken projection: ${kind}`)
  }
  return { result: evaluateProjection(changed, expected), changed }
}

function failureCodes(result) {
  return [...new Set(result.failures.map((failure) => failure.code))]
}

test('evaluator passes the correct projection with no failure', () => {
  const correct = scorerFixture()
  const result = evaluateProjection(correct, scorerExpected())

  assert.equal(result.passed, true)
  assert.deepEqual(result.failures, [])
  assert.equal(correct.currentFacts.some((fact) => fact.subjectEntityId === SCORER_A_ID &&
    fact.predicate === 'file.size'), false)
})

// Hand-written historical rows at validAt=recordedAt=3500. This literal is the
// independent source of the replay expectation; it is deliberately not produced
// from projectLedger/factsAt.
const GOLDEN_REPLAY_ROWS = [
  {
    fact_key: 'workspace:scorer/c:/scorer/a.txt/1/file.exists/null',
    scope: 'workspace:scorer',
    subject_entity_id: 'c:/scorer/a.txt',
    generation: 1,
    predicate: 'file.exists',
    value: false,
    qualifiers: null,
    assertion_id: 'observation:scorer:2:scorer-delete-2:subject:file.exists:assert',
    valid_from: 2000,
    valid_to: null,
    recorded_at: 2000,
    retired_at: null,
    status: 'active',
    verification: 'observed',
    conflict: null,
  },
  {
    fact_key: 'workspace:scorer/c:/scorer/b.txt/2/file.exists/null',
    scope: 'workspace:scorer',
    subject_entity_id: 'c:/scorer/b.txt',
    generation: 2,
    predicate: 'file.exists',
    value: true,
    qualifiers: null,
    assertion_id: 'observation:scorer:5:scorer-write-5:subject:file.exists:assert',
    valid_from: 3000,
    valid_to: null,
    recorded_at: 3000,
    retired_at: null,
    status: 'active',
    verification: 'observed',
    conflict: null,
  },
  {
    fact_key: 'workspace:scorer/c:/scorer/b.txt/2/file.sha256/null',
    scope: 'workspace:scorer',
    subject_entity_id: 'c:/scorer/b.txt',
    generation: 2,
    predicate: 'file.sha256',
    value: HASH_B,
    qualifiers: null,
    assertion_id: 'observation:scorer:5:scorer-write-5:subject:file.sha256:assert',
    valid_from: 3000,
    valid_to: null,
    recorded_at: 3000,
    retired_at: null,
    status: 'active',
    verification: 'observed',
    conflict: null,
  },
  {
    fact_key: 'workspace:scorer/c:/scorer/b.txt/2/file.size/null',
    scope: 'workspace:scorer',
    subject_entity_id: 'c:/scorer/b.txt',
    generation: 2,
    predicate: 'file.size',
    value: 20,
    qualifiers: null,
    assertion_id: 'observation:scorer:5:scorer-write-5:subject:file.size:assert',
    valid_from: 3000,
    valid_to: null,
    recorded_at: 3000,
    retired_at: null,
    status: 'active',
    verification: 'observed',
    conflict: null,
  },
]

test('scorer replay expectation is an independent literal golden hash', () => {
  assert.equal(sha256Canonical(GOLDEN_REPLAY_ROWS), SCORER_GOLDEN_REPLAY_HASH)
  assert.equal(SCORER_GOLDEN_REPLAY_HASH,
    '58ae7a686eeec14527888b5a1fa7423a7cb487bd7fc8c37640bc1c59262200c7')
  assert.equal(replayHash(scorerFixture(), SCORER_REPLAY), SCORER_GOLDEN_REPLAY_HASH)
})

test('evaluator rejects a missed invalidation for the named reason', () => {
  const result = brokenProjection('missed-invalidation').result
  assert.equal(result.passed, false)
  assert.deepEqual(failureCodes(result), ['missed-invalidation'])
})

test('evaluator rejects a false invalidation for the named reason', () => {
  const result = brokenProjection('false-invalidation').result
  assert.equal(result.passed, false)
  assert.deepEqual(failureCodes(result), ['false-invalidation'])
})

test('evaluator rejects old-generation revival for the named reason', () => {
  const { result, changed } = brokenProjection('old-generation-revival')
  assert.equal(result.passed, false)
  assert.deepEqual(failureCodes(result), ['old-generation-revival'])
  assert.equal(changed.currentFacts.every((fact) =>
    fact.subjectEntityId !== SCORER_B_ID || fact.generation === 1), true)
})

test('evaluator rejects cross-scope pollution for the named reason', () => {
  const result = brokenProjection('cross-scope-pollution').result
  assert.equal(result.passed, false)
  assert.deepEqual(failureCodes(result), ['cross-scope-pollution'])
})

test('evaluator rejects conflict injection for the named reason', () => {
  const result = brokenProjection('conflict-injection').result
  assert.equal(result.passed, false)
  assert.deepEqual(failureCodes(result), ['conflict-injection'])
})

test('evaluator rejects forbidden-predicate leakage for the named reason', () => {
  const result = brokenProjection('forbidden-predicate').result
  assert.equal(result.passed, false)
  assert.equal(failureCodes(result).includes('cross-scope-pollution'), true)
  assert.deepEqual(failureCodes(result).sort(), ['cross-scope-pollution', 'unexpected-fact'])
})

test('evaluator rejects replay mismatch for the named reason', () => {
  const result = brokenProjection('replay-mismatch').result
  assert.equal(result.passed, false)
  assert.deepEqual(failureCodes(result), ['replay-mismatch'])
})

test('evaluator rejects an expected-fact value mismatch for the named reason', () => {
  const result = brokenProjection('expected-fact-mismatch').result
  assert.equal(result.passed, false)
  assert.deepEqual(failureCodes(result), ['expected-fact-mismatch'])
})

// ---------------------------------------------------------------------------
// Scorer implementation.
// ---------------------------------------------------------------------------

function replayRow(fact) {
  return {
    fact_key: fact.factKey,
    scope: fact.scope,
    subject_entity_id: fact.subjectEntityId,
    generation: fact.generation,
    predicate: fact.predicate,
    value: fact.value ?? null,
    qualifiers: fact.qualifiers ?? null,
    assertion_id: fact.assertionId,
    valid_from: fact.validFrom ?? null,
    valid_to: fact.validTo ?? null,
    recorded_at: fact.recordedAt ?? null,
    retired_at: fact.retiredAt ?? null,
    status: fact.status,
    verification: fact.verification ?? null,
    conflict: fact.conflict ?? null,
  }
}

export function replayHash(projection, query) {
  if (!query || !Number.isFinite(query.validAt) || !Number.isFinite(query.recordedAt)) {
    throw new TypeError('replayHash requires finite validAt and recordedAt')
  }
  return sha256Canonical(factsAt(projection, query).map(replayRow))
}

function factSlot(fact) {
  return `${fact.subjectEntityId}\u0000${fact.predicate}`
}

export function evaluateProjection(projection, expected) {
  const failures = []
  const fail = (code, detail) => failures.push({ code, detail })
  const scope = expected.scope
  const currentFacts = Array.isArray(projection?.currentFacts) ? projection.currentFacts : []
  const entities = Array.isArray(projection?.entities) ? projection.entities : []
  const inScope = currentFacts.filter((fact) => fact.scope === scope)

  for (const fact of currentFacts) {
    if (fact.scope !== scope) {
      fail('cross-scope-pollution',
        `fact ${fact.subjectEntityId}/${fact.predicate} carries scope ${fact.scope}`)
    }
  }
  for (const entity of entities) {
    if (entity.scope !== scope) {
      fail('cross-scope-pollution', `entity ${entity.entityId} carries scope ${entity.scope}`)
    }
  }
  const forbiddenEntities = new Set(expected.forbidden?.entities ?? [])
  const forbiddenPredicates = new Set(expected.forbidden?.predicates ?? [])
  for (const fact of currentFacts) {
    if (forbiddenEntities.has(fact.subjectEntityId)) {
      fail('cross-scope-pollution', `forbidden entity leaked: ${fact.subjectEntityId}`)
    }
    if (forbiddenPredicates.has(fact.predicate)) {
      fail('cross-scope-pollution', `forbidden predicate leaked: ${fact.predicate}`)
    }
  }

  if (expected.conflictFree !== false) {
    for (const fact of currentFacts) {
      if (fact.status === 'conflicted' || fact.conflict != null) {
        fail('conflict-injection',
          `conflict leaked on ${fact.subjectEntityId}/${fact.predicate}: ${canonicalJson(fact.conflict ?? null)}`)
      }
    }
  }

  for (const generation of expected.generations ?? []) {
    const entity = entities.find((item) =>
      item.scope === scope && item.entityId === generation.entityId)
    const facts = inScope.filter((fact) => fact.subjectEntityId === generation.entityId)
    const generationMismatch = facts.some((fact) => fact.generation !== generation.generation)
    const entityMismatch = !entity || entity.generation !== generation.generation ||
      (generation.presence !== undefined && Boolean(entity.presence) !== generation.presence)
    if (generationMismatch || entityMismatch) {
      fail('old-generation-revival',
        `entity ${generation.entityId} expected generation ${generation.generation}, ` +
        `observed ${entity?.generation ?? 'none'}`)
    }
  }

  const actualBySlot = new Map()
  for (const fact of inScope) {
    const slot = factSlot(fact)
    if (actualBySlot.has(slot)) {
      fail('unexpected-fact', `duplicate current fact for ${fact.subjectEntityId}/${fact.predicate}`)
      continue
    }
    actualBySlot.set(slot, fact)
  }
  for (const wanted of expected.facts ?? []) {
    const slot = `${wanted.entityId}\u0000${wanted.predicate}`
    const actual = actualBySlot.get(slot)
    if (!actual) {
      fail('false-invalidation', `expected current fact missing: ${wanted.entityId}/${wanted.predicate}`)
      continue
    }
    actualBySlot.delete(slot)
    if (canonicalJson(actual.value ?? null) !== canonicalJson(wanted.value ?? null)) {
      fail('expected-fact-mismatch',
        `${wanted.entityId}/${wanted.predicate} expected ${canonicalJson(wanted.value ?? null)}, ` +
        `observed ${canonicalJson(actual.value ?? null)}`)
    }
  }
  const absent = new Set((expected.absent ?? []).map((item) => `${item.entityId}\u0000${item.predicate}`))
  for (const [slot, fact] of actualBySlot) {
    if (absent.has(slot)) {
      fail('missed-invalidation',
        `invalidated fact still current: ${fact.subjectEntityId}/${fact.predicate}`)
    } else {
      fail('unexpected-fact',
        `unexpected current fact: ${fact.subjectEntityId}/${fact.predicate}`)
    }
  }

  if (expected.replay) {
    const observed = replayHash(projection, expected.replay)
    if (observed !== expected.replay.hash) {
      fail('replay-mismatch',
        `replay ${expected.replay.validAt}/${expected.replay.recordedAt} hash ${observed} ` +
        `!= expected ${expected.replay.hash}`)
    }
  }

  return { passed: failures.length === 0, failures }
}


test('probe resolves a relative path against the supplied workspace cwd', async () => {
  const calls = []
  const observation = await observationFromProbe({
    path: 'notes/a.txt',
    cwd: 'C:\\Work',
    scope: SCOPE,
    probeId: 'probe-cwd',
    validAt: 1000,
    recordedAt: 1000,
    platform: 'win32',
    io: {
      async realpath(path) {
        calls.push(['realpath', path])
        return 'C:\\Work\\notes\\a.txt'
      },
      async stat(path) {
        calls.push(['stat', path])
        return { size: 1, mtimeMs: 2 }
      },
      async readFile(path) {
        calls.push(['readFile', path])
        return Buffer.from('x')
      },
    },
  })

  assert.equal(observation.subjectEntityId, 'c:/work/notes/a.txt')
  assert.equal(observation.source.displayPath, 'notes/a.txt')
  assert.equal(observation.source.resolvedPath, 'C:\\Work\\notes\\a.txt')
  assert.equal(observation.rawPayload.path, 'notes/a.txt')
  assert.equal(observation.rawPayload.resolvedPath, 'C:\\Work\\notes\\a.txt')
  assert.deepEqual(calls, [
    ['realpath', 'C:\\Work\\notes\\a.txt'],
    ['stat', 'C:\\Work\\notes\\a.txt'],
    ['readFile', 'C:\\Work\\notes\\a.txt'],
  ])
})


// ---------------------------------------------------------------------------
// Audit guards: path identity and non-vacuous verdict preconditions.
// ---------------------------------------------------------------------------

test('audit path relation is separator-normalized and case-folded on win32', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcs-audit-guard-'))
  try {
    assert.equal(pathRelation(root, root), 'equal')
    assert.equal(pathRelation(join(root, 'a'), root), 'inside')
    assert.equal(pathRelation(dirname(root), root), 'outside')
    if (process.platform === 'win32') {
      assert.equal(pathRelation(root.toUpperCase(), root), 'equal')
      assert.equal(pathRelation(join(root, 'A').toUpperCase(), root), 'inside')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('audit guard refuses output inside the source state directory and realpath aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcs-audit-guard-'))
  const state = join(root, 'state')
  mkdirSync(state)
  mkdirSync(join(state, 'sub'))
  const source = join(state, 'memory.sqlite')
  writeFileSync(source, 'not-a-real-db')
  try {
    assert.throws(() => assertAuditPaths({ source, out: state }), UsageError)
    assert.throws(() => assertAuditPaths({ source, out: join(state, 'shadow-ledger') }), UsageError)
    assert.throws(() => assertAuditPaths({ source, out: join(state, 'sub', '..') }), UsageError)
    assert.throws(() => assertAuditPaths({
      source: join(state, 'sub', '..', 'memory.sqlite'), out: state,
    }), UsageError)
    // Output target that resolves to the source file through a relative alias.
    assert.throws(() => assertAuditPaths({
      source, out: root, outputNames: ['state/memory.sqlite'],
    }), UsageError)

    let junction = null
    try {
      junction = join(root, 'state-junction')
      symlinkSync(state, junction, 'junction')
    } catch {
      junction = null
    }
    if (junction !== null) {
      // Junction alias must be resolved before the inside-state refusal.
      assert.throws(() => assertAuditPaths({ source, out: join(junction, 'shadow') }), UsageError)
      assert.throws(() => assertAuditPaths({
        source: join(junction, 'memory.sqlite'), out: root, outputNames: ['state/memory.sqlite'],
      }), UsageError)
    } else {
      assert.notEqual(process.platform, 'win32', 'junction creation must work on win32')
    }

    const guard = assertAuditPaths({ source, out: join(root, 'audit-out') })
    assert.equal(guard.out, canonicalProspectivePath(join(root, 'audit-out')))
    assert.deepEqual(guard.outputs.map((output) => output.name),
      ['source-copy.sqlite', 'shadow-ledger.sqlite'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy insight inspection derives reasons from inspected content, not status', () => {
  const summaryOnly = inspectLegacyInsight({ summary: 's', confidence: 1, evidence: [1, 2] })
  assert.deepEqual(summaryOnly.inspectedFields, ['confidence', 'evidence', 'summary'])
  assert.deepEqual(summaryOnly.missingParts,
    ['entity-reference', 'predicate', 'structured-evidence'])
  assert.match(summaryOnly.reason, /^legacy-insight-content-unverifiable:/)

  const verifiable = inspectLegacyInsight({
    entityId: 'c:/x.txt', predicate: 'file.size', evidence: [{ eventKey: 'e1' }],
  })
  assert.deepEqual(verifiable.missingParts, [])
  assert.equal(verifiable.reason, null)
})

function auditEvidence(overrides = {}) {
  return {
    migratedRows: 79,
    probesAttempted: 79,
    uniqueProbedPaths: 79,
    present: 24,
    presentHashed: 24,
    missing: 55,
    errors: 0,
    missingContentFacts: 0,
    errorContentFacts: 0,
    candidateFacts: 96,
    productionSelected: 39,
    productionTextLength: 3982,
    absenceMarkersInText: 0,
    productionMissingLeaks: 0,
    productionErrorLeaks: 0,
    productionUnverified: 0,
    missingPathFactsInLedger: 55,
    absenceMarkerFactsInLedger: 55,
    sourceInsightRows: 25,
    rejectedInsights: 25,
    insightsWithContentReasons: 25,
    insightRowIdsMatch: true,
    archiveAssertions: 0,
    legacyCurrentFacts: 0,
    unplacedLegacy: 79,
    sourceFileBytesUnchanged: true,
    sourceWriteRejected: true,
    sourceClosedRejectsQueries: true,
    migrationStartedAfterClose: true,
    outputsDistinctFromSource: true,
    syntheticSameSize: true,
    syntheticSameMtime: true,
    syntheticHashesDiffer: true,
    syntheticForceHashPassed: true,
    syntheticSha256Before: 'a'.repeat(64),
    syntheticSha256After: 'b'.repeat(64),
    ...overrides,
  }
}

test('audit verdict requires non-vacuous probe and render evidence', () => {
  const pass = computeAuditChecks(auditEvidence())
  assert.equal(pass.verdict, 'PASS')
  assert.equal(pass.preconditions.length, 4)
  assert.equal(pass.checks.length, 13)
  assert.deepEqual(pass.failedChecks, [])

  const failures = [
    ['zero migrated rows', { migratedRows: 0, probesAttempted: 0, uniqueProbedPaths: 0,
      present: 0, presentHashed: 0, missing: 0, unplacedLegacy: 0 }],
    ['zero verified paths', { present: 0, presentHashed: 0 }],
    ['total probe failure', { present: 0, presentHashed: 0, missing: 79 }],
    ['outcome partition mismatch', { missing: 54 }],
    ['unique path mismatch', { uniqueProbedPaths: 78 }],
    ['forced-hash count mismatch', { presentHashed: 23 }],
  ]
  for (const [label, overrides] of failures) {
    const result = computeAuditChecks(auditEvidence(overrides))
    assert.equal(result.verdict, 'FAIL', label)
    assert.equal(result.failedChecks.length > 0, true, label)
  }

  const totalFailure = computeAuditChecks(auditEvidence({
    present: 0, presentHashed: 0, missing: 79,
  }))
  assert.equal(totalFailure.verdict, 'FAIL')
  assert.equal(totalFailure.failedChecks.includes('present-paths-force-hashed'), true)
  assert.deepEqual(
    totalFailure.preconditions.find((check) => check.name === 'present-paths-force-hashed').observed,
    { present: 0, presentHashed: 0 },
  )

  const partitionFailure = computeAuditChecks(auditEvidence({ missing: 54 }))
  assert.equal(partitionFailure.failedChecks.includes('probe-outcomes-partition-migrated'), true)

  const leakage = [
    ['absence marker rendered', { absenceMarkersInText: 1 }],
    ['missing content fact leaked', { missingContentFacts: 1 }],
    ['missing path rendered', { productionMissingLeaks: 1 }],
    ['probe error path rendered', { productionErrorLeaks: 1 }],
    ['unverified fact rendered', { productionUnverified: 1 }],
    ['empty production render', { productionSelected: 0, productionTextLength: 0 }],
    ['insights counted without content reasons', { insightsWithContentReasons: 24 }],
    ['insight assertion archived', { archiveAssertions: 1 }],
    ['legacy fact current', { legacyCurrentFacts: 1 }],
    ['unplaced count not exact', { unplacedLegacy: 80 }],
    ['source bytes changed', { sourceFileBytesUnchanged: false }],
    ['source write not rejected', { sourceWriteRejected: false }],
    ['source not closed before migration', { sourceClosedRejectsQueries: false }],
    ['outputs not distinct', { outputsDistinctFromSource: false }],
    ['synthetic hashes identical', { syntheticHashesDiffer: false }],
    ['synthetic sizes differ', { syntheticSameSize: false }],
    ['synthetic mtimes differ', { syntheticSameMtime: false }],
    ['synthetic force hash missing', { syntheticForceHashPassed: false }],
  ]
  for (const [label, overrides] of leakage) {
    const result = computeAuditChecks(auditEvidence(overrides))
    assert.equal(result.verdict, 'FAIL', label)
    assert.equal(result.failedChecks.length > 0, true, label)
  }
})
