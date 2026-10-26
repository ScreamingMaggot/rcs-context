// 隔离 SQLite 账本：归档优先、幂等、双时间查询与死信恢复。运行：node tests/memory-ledger-store.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { MemoryLedger } from '../web/memory-ledger.mjs'
import { canonicalJson, projectLedger } from '../web/memory-ledger-core.mjs'
import { observationFromScopeInit } from '../web/memory-observations.mjs'

const root = mkdtempSync(join(tmpdir(), 'rcs-memory-ledger-store-'))
const SCOPE = 'workspace:store-test'
const OTHER_SCOPE = 'workspace:other'
const FILE = 'C:/p/a.txt'
const PROJECT = 'project:decisions'
let fails = 0
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!condition) fails++
}
const throws = (fn) => {
  try { fn(); return false } catch { return true }
}
const observation = (eventKey, extra = {}) => ({
  eventKey,
  scope: SCOPE,
  sid: 's1',
  seq: 1,
  validAt: 1000,
  recordedAt: 1100,
  op: 'create',
  outcome: 'success',
  subjectEntityId: FILE,
  targetEntityId: null,
  value: { size: 10 },
  generationHints: { source: 'host-test' },
  rawRef: `raw:${eventKey}`,
  rawPayload: { eventKey, complete: 'x'.repeat(2500) },
  source: { kind: 'observation', authority: 'host' },
  extractorVersion: 'fixture-v1',
  ...extra,
})
const assertion = (assertionId, extra = {}) => ({
  assertionId,
  scope: SCOPE,
  subjectEntityId: PROJECT,
  sid: 's1',
  seq: 20,
  op: 'assert',
  targetAssertionId: null,
  predicate: 'project.decision',
  value: { text: 'use SQLite' },
  qualifiers: null,
  validAt: 2000,
  recordedAt: 2000,
  sourceKind: 'user',
  sourceAuthority: 'user',
  evidence: { ref: `evidence:${assertionId}` },
  verification: 'user-confirmed',
  ...extra,
})

const stores = []
try {
  const file = join(root, 'archive.sqlite')
  let reducerOutsideTransaction = false
  let store
  store = new MemoryLedger(file, {
    reducer(input) {
      reducerOutsideTransaction = !store.db.isTransaction
      return projectLedger(input)
    },
  })
  stores.push(store)
  const first = observation('obs-1')
  const firstCanonical = canonicalJson(first)
  const firstHash = store.appendObservation(first)
  const inspector = new DatabaseSync(file)
  const archived = inspector.prepare('SELECT * FROM ledger_observations WHERE event_key = ?').get('obs-1')
  check('archive insert commits with canonical full raw payload before queries',
    archived?.scope === SCOPE && archived.raw_ref === 'raw:obs-1' &&
    archived.raw_payload_json === canonicalJson(first.rawPayload) &&
    archived.full_input_json === firstCanonical && archived.projection_state === 'applied')
  check('archive retains payload beyond legacy truncation limits',
    JSON.parse(archived.raw_payload_json).complete.length === 2500)
  check('required ledger tables are created', inspector.prepare(`
    SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (
      'ledger_observations', 'ledger_assertions', 'ledger_fact_versions',
      'ledger_observation_placements', 'ledger_assertion_placements', 'ledger_meta'
    )
  `).get().count === 6)
  check('pure reducer runs outside the derived write transaction', reducerOutsideTransaction)
  check('append projects current facts and returns a stable hash',
    typeof firstHash === 'string' && firstHash.length === 64 &&
    store.currentFacts(SCOPE).some((fact) => fact.predicate === 'file.size' && fact.value === 10))

  const duplicateHash = store.appendObservation(first)
  check('identical Observation append is idempotent',
    duplicateHash === firstHash &&
    inspector.prepare('SELECT count(*) AS count FROM ledger_observations WHERE event_key = ?').get('obs-1').count === 1)
  check('reusing an event ID with different input is rejected',
    throws(() => store.appendObservation({ ...first, value: { size: 11 } })) &&
    inspector.prepare('SELECT full_input_json FROM ledger_observations WHERE event_key = ?').get('obs-1').full_input_json === firstCanonical)

  const otherHash = store.appendObservation(observation('obs-other', {
    scope: OTHER_SCOPE, subjectEntityId: 'C:/p/other.txt', seq: 2,
  }))
  store.appendObservation(observation('obs-2', {
    seq: 3, validAt: 1500, recordedAt: 1600, value: { size: 12 }, op: 'write',
  }))
  check('scope rebuild replaces only that scope projection',
    store.currentFacts(OTHER_SCOPE).some((fact) => fact.subjectEntityId === 'C:/p/other.txt') &&
    inspector.prepare('SELECT projection_hash FROM ledger_meta WHERE scope = ?').get(OTHER_SCOPE).projection_hash === otherHash &&
    store.currentFacts(SCOPE).some((fact) => fact.predicate === 'file.size' && fact.value === 12))

  store.appendObservation(observationFromScopeInit({
    scope: SCOPE, entityId: PROJECT, sid: 's1', seq: 4, validAt: 500, recordedAt: 500,
  }))
  const original = assertion('d1')
  store.appendAssertion(original)
  const assertionHash = store.rebuild(SCOPE)
  check('identical Assertion append is idempotent', store.appendAssertion(original) === assertionHash &&
    inspector.prepare('SELECT count(*) AS count FROM ledger_assertions WHERE assertion_id = ?').get('d1').count === 1)
  check('reusing an assertion ID with different input is rejected',
    throws(() => store.appendAssertion({ ...original, value: { text: 'changed' } })))
  check('invalid assertions are rejected before archive instead of poisoning the scope',
    throws(() => store.appendAssertion({ ...assertion('bad-unknown'), predicate: 'unknown.predicate' })) &&
    throws(() => store.appendAssertion({ ...assertion('bad-size'), predicate: 'file.size', value: -1,
      subjectEntityId: FILE, sourceKind: 'observation', verification: 'observed' })) &&
    inspector.prepare('SELECT count(*) AS count FROM ledger_assertions WHERE assertion_id IN (?, ?)')
      .get('bad-unknown', 'bad-size').count === 0 &&
    store.projectionStatus(SCOPE).status === 'applied')

  store.appendAssertion(assertion('d2', {
    op: 'correct', targetAssertionId: 'd1', value: { text: 'use archived SQLite' },
    validAt: 3000, recordedAt: 5000, seq: 21,
  }))
  const oldHistory = store.factsAt(SCOPE, { validAt: 3500, recordedAt: 2500 })
    .filter((fact) => fact.predicate === 'project.decision')
  const newHistory = store.factsAt(SCOPE, { validAt: 3500, recordedAt: 5000 })
    .filter((fact) => fact.predicate === 'project.decision')
  check('history query applies both valid and recorded times',
    oldHistory.length === 1 && oldHistory[0].assertionId === 'd1' && oldHistory[0].value.text === 'use SQLite' &&
    newHistory.length === 1 && newHistory[0].assertionId === 'd2' && newHistory[0].value.text === 'use archived SQLite')
  check('history query requires both timestamps',
    throws(() => store.factsAt(SCOPE, { validAt: 3500 })) &&
    throws(() => store.factsAt(SCOPE, { recordedAt: 3500 })))
  check('current facts use open current-generation intervals',
    store.currentFacts(SCOPE).some((fact) => fact.assertionId === 'd2' && fact.validTo === null && fact.retiredAt === null))

  store.appendAssertion(assertion('c1', {
    predicate: 'project.constraint', value: { text: 'alpha' }, validAt: 1000, recordedAt: 1000,
  }))
  store.appendAssertion(assertion('c2', {
    predicate: 'project.constraint', value: { text: 'beta' }, validAt: 1000, recordedAt: 1500,
  }))
  store.appendAssertion(assertion('lines-1', {
    predicate: 'file.lines', value: 12, validAt: 1200, recordedAt: 1200,
    subjectEntityId: FILE, sourceKind: 'observation', verification: 'observed',
  }))
  const allCurrent = store.currentFacts(SCOPE)
  const injectable = store.currentFacts(SCOPE, { injectableOnly: true })
  check('currentFacts can expose conflicts while injectableOnly excludes them',
    allCurrent.filter((fact) => fact.predicate === 'project.constraint').length === 2 &&
    allCurrent.filter((fact) => fact.predicate === 'project.constraint').every((fact) => fact.status === 'conflicted') &&
    injectable.every((fact) => fact.status === 'active'))
  check('injectableOnly excludes disabled predicates',
    allCurrent.some((fact) => fact.predicate === 'file.lines') &&
    injectable.every((fact) => fact.predicate !== 'file.lines'))
  const rendered = store.renderCurrent(SCOPE, 10000)
  check('renderCurrent uses only active injectable current facts',
    rendered.text.includes('项目决策：use archived SQLite') &&
    !rendered.text.includes('alpha') && !rendered.text.includes('beta') &&
    !rendered.text.includes('行数'))
  inspector.exec("CREATE TABLE records (value TEXT); INSERT INTO records VALUES ('legacy must not be read')")
  check('queries and renderer ignore legacy records', store.renderCurrent(SCOPE, 10000).text === rendered.text &&
    !store.currentFacts(SCOPE).some((fact) => fact.value === 'legacy must not be read'))

  const hasObservationLookup = typeof store.getObservation === 'function'
  const observationView = hasObservationLookup ? store.getObservation('obs-1') : null
  check('getObservation returns archived metadata, raw payload, and host source',
    observationView !== null && observationView.eventKey === 'obs-1' &&
    observationView.scope === SCOPE && observationView.op === 'create' &&
    observationView.sid === 's1' && observationView.seq === 1 &&
    canonicalJson(observationView.rawPayload) === canonicalJson(first.rawPayload) &&
    canonicalJson(observationView.source) === canonicalJson(first.source) &&
    observationView.projectionState === 'applied')
  check('getObservation returns null for an unknown key',
    hasObservationLookup && store.getObservation('obs-unknown') === null)
  check('getObservation requires a non-empty key',
    hasObservationLookup && throws(() => store.getObservation('')) &&
    throws(() => store.getObservation(null)))
  check('getObservation honours an optional scope and returns null for missing or foreign records',
    hasObservationLookup &&
    store.getObservation('obs-1', { scope: SCOPE })?.eventKey === 'obs-1' &&
    store.getObservation('obs-1', { scope: OTHER_SCOPE }) === null &&
    store.getObservation('obs-unknown', { scope: SCOPE }) === null &&
    store.getObservation('obs-1', {})?.eventKey === 'obs-1' &&
    throws(() => store.getObservation('obs-1', { scope: '' })) &&
    throws(() => store.getObservation('obs-1', { scope: 42 })))
  check('getObservation returns a frozen copy that callers cannot mutate',
    hasObservationLookup &&
    Object.isFrozen(observationView) &&
    Object.isFrozen(observationView.rawPayload) &&
    throws(() => { observationView.rawPayload.complete = 'mutated by caller' }) &&
    store.getObservation('obs-1').rawPayload.complete.length === 2500)
  check('getObservation reports the owning scope when no scope is requested',
    hasObservationLookup && store.getObservation('obs-other').scope === OTHER_SCOPE)

  store.appendAssertion(assertion('a-other', {
    scope: OTHER_SCOPE, subjectEntityId: 'project:other', seq: 1, validAt: 900, recordedAt: 900,
  }))
  const hasAssertionLookup = typeof store.getAssertion === 'function'
  const assertionView = hasAssertionLookup ? store.getAssertion('d1', { scope: SCOPE }) : null
  check('getAssertion returns archived assertion metadata and projection state',
    assertionView !== null && assertionView.assertionId === 'd1' &&
    assertionView.scope === SCOPE && assertionView.predicate === 'project.decision' &&
    canonicalJson(assertionView.value) === canonicalJson(original.value) &&
    assertionView.verification === 'user-confirmed' &&
    assertionView.projectionState === 'applied')
  check('getAssertion returns null for an unknown id and throws on a blank id',
    hasAssertionLookup && store.getAssertion('assertion-unknown') === null &&
    throws(() => store.getAssertion('')) && throws(() => store.getAssertion(null)))
  check('getAssertion honours an optional scope and reports the owning scope',
    hasAssertionLookup &&
    store.getAssertion('a-other', { scope: OTHER_SCOPE })?.assertionId === 'a-other' &&
    store.getAssertion('a-other', { scope: SCOPE }) === null &&
    store.getAssertion('a-other')?.scope === OTHER_SCOPE &&
    throws(() => store.getAssertion('d1', { scope: '' })))
  check('getAssertion returns a frozen copy that callers cannot mutate',
    hasAssertionLookup && Object.isFrozen(assertionView) &&
    Object.isFrozen(assertionView.value) &&
    throws(() => { assertionView.value.text = 'mutated by caller' }) &&
    store.getAssertion('d1', { scope: SCOPE }).value.text === 'use SQLite')

  inspector.prepare("UPDATE ledger_assertions SET projection_state = 'pending', projection_error = NULL WHERE assertion_id = 'd1'").run()
  check('pending reads archived pending input', store.pending(SCOPE).some((item) => item.assertionId === 'd1'))
  store.rebuild(SCOPE)
  check('rebuild clears pending projection state from archived input', !store.pending(SCOPE).some((item) => item.assertionId === 'd1'))
  inspector.close()
  store.close()
  stores.pop()

  const recoveryFile = join(root, 'recovery.sqlite')
  const recoveryInput = observation('obs-recovery', {
    rawPayload: { full: { nested: ' survives projection failure '.repeat(100) } },
  })
  const recoveryCanonical = canonicalJson(recoveryInput)
  let reducerSawCommittedArchive = false
  let failedStore = new MemoryLedger(recoveryFile, {
    reducer() {
      const db = new DatabaseSync(recoveryFile)
      const row = db.prepare('SELECT raw_payload_json FROM ledger_observations WHERE event_key = ?').get('obs-recovery')
      reducerSawCommittedArchive = row?.raw_payload_json === canonicalJson(recoveryInput.rawPayload)
      db.close()
      throw new Error('projection exploded')
    },
  })
  stores.push(failedStore)
  const failedHash = failedStore.appendObservation(recoveryInput)
  check('projection failure is visible only after committed archive insert', reducerSawCommittedArchive && failedHash === null)
  check('projection failure creates dead letter without losing archived input',
    failedStore.dead(SCOPE).some((item) => item.eventKey === 'obs-recovery' &&
      item.projectionError.includes('projection exploded')) && failedStore.currentFacts(SCOPE).length === 0)
  const recoveryDb = new DatabaseSync(recoveryFile)
  const beforeRetry = recoveryDb.prepare('SELECT full_input_json, raw_payload_json FROM ledger_observations WHERE event_key = ?').get('obs-recovery')
  check('dead archive remains complete and canonically unchanged',
    beforeRetry.full_input_json === recoveryCanonical &&
    beforeRetry.raw_payload_json === canonicalJson(recoveryInput.rawPayload))
  failedStore.close()
  stores.pop()

  failedStore = new MemoryLedger(recoveryFile)
  stores.push(failedStore)
  const recoveredHash = failedStore.retryDead('obs-recovery')
  const afterRetry = recoveryDb.prepare('SELECT full_input_json, raw_payload_json, projection_state, projection_error FROM ledger_observations WHERE event_key = ?').get('obs-recovery')
  check('retryDead rebuilds from archived input after reopen',
    typeof recoveredHash === 'string' && recoveredHash.length === 64 &&
    failedStore.currentFacts(SCOPE).some((fact) => fact.predicate === 'file.exists' && fact.value === true) &&
    failedStore.dead(SCOPE).length === 0)
  check('retryDead changes projection state only, never archived input',
    afterRetry.full_input_json === beforeRetry.full_input_json &&
    afterRetry.raw_payload_json === beforeRetry.raw_payload_json &&
    afterRetry.projection_state === 'applied' && afterRetry.projection_error === null)
  recoveryDb.close()

  const batchFile = join(root, 'batch.sqlite')
  let batchProjections = 0
  const batchStore = new MemoryLedger(batchFile, {
    reducer(input) {
      batchProjections++
      return projectLedger(input)
    },
  })
  stores.push(batchStore)
  check('projectionStatus is empty for a scope with no projection yet',
    batchStore.projectionStatus(SCOPE).status === 'empty')
  const batchInputs = []
  for (let index = 0; index < 200; index++) {
    batchInputs.push(observation(`batch-${index}`, {
      seq: index + 1,
      validAt: 1000 + index,
      recordedAt: 1000 + index,
      subjectEntityId: `C:/p/batch-${index % 20}.txt`,
      op: 'write',
      value: { size: index, mtime: index, sha256: 'a'.repeat(64) },
    }))
  }
  batchInputs.push(observationFromScopeInit({
    scope: SCOPE, entityId: PROJECT, sid: 's1', seq: 500, validAt: 500, recordedAt: 500,
  }))
  const batchStarted = performance.now()
  const batchHashes = batchStore.appendObservations(batchInputs)
  const batchMilliseconds = performance.now() - batchStarted
  const batchInspector = new DatabaseSync(batchFile)
  check('200 batched observations archive and project in one pass within the 8s budget',
    batchMilliseconds < 8000 && batchProjections === 1 &&
    typeof batchHashes[SCOPE] === 'string' && batchHashes[SCOPE].length === 64 &&
    batchInspector.prepare(
      "SELECT count(*) AS count FROM ledger_observations WHERE projection_state = 'applied'",
    ).get().count === 201 &&
    batchStore.projectionStatus(SCOPE).projectionHash === batchHashes[SCOPE],
    `${batchMilliseconds.toFixed(0)}ms`)
  const assertionHashes = batchStore.appendAssertions([
    assertion('batch-decision'),
    assertion('batch-constraint', {
      predicate: 'project.constraint', value: { text: 'single writer' },
    }),
  ])
  check('batched assertions archive and project in one pass',
    batchProjections === 2 && typeof assertionHashes[SCOPE] === 'string' &&
    batchStore.currentFacts(SCOPE).some((fact) => fact.assertionId === 'batch-decision') &&
    batchStore.currentFacts(SCOPE).some((fact) => fact.assertionId === 'batch-constraint'))
  batchInspector.close()

  const corruptFile = join(root, 'corrupt.sqlite')
  const corruptStore = new MemoryLedger(corruptFile)
  stores.push(corruptStore)
  corruptStore.appendObservation(observation('obs-valid'))
  const corruptHashBefore = corruptStore.projectionStatus(SCOPE).projectionHash
  const corruptFactsBefore = canonicalJson(corruptStore.currentFacts(SCOPE))
  const corruptInspector = new DatabaseSync(corruptFile)
  const corruptInput = assertion('corrupt-archived', { predicate: 'unknown.predicate' })
  corruptInspector.prepare(`
    INSERT INTO ledger_assertions (
      assertion_id, scope, subject_entity_id, sid, seq, op, target_assertion_id,
      predicate, value_json, qualifiers_json, valid_at, recorded_at,
      source_kind, source_authority, evidence_json, verification, reducer_version,
      projection_state, projection_error, full_input_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)
  `).run(
    corruptInput.assertionId, corruptInput.scope, corruptInput.subjectEntityId,
    corruptInput.sid, corruptInput.seq, corruptInput.op, corruptInput.targetAssertionId,
    corruptInput.predicate, canonicalJson(corruptInput.value),
    canonicalJson(corruptInput.qualifiers), corruptInput.validAt, corruptInput.recordedAt,
    corruptInput.sourceKind, corruptInput.sourceAuthority,
    canonicalJson(corruptInput.evidence), corruptInput.verification, 'r1',
    canonicalJson(corruptInput),
  )
  const corruptRebuilt = corruptStore.rebuild(SCOPE)
  check('one archived poison assertion is isolated without blanking prior valid facts',
    canonicalJson(corruptStore.currentFacts(SCOPE)) === corruptFactsBefore &&
    corruptRebuilt === corruptHashBefore &&
    corruptStore.projectionStatus(SCOPE).status === 'applied' &&
    corruptStore.dead(SCOPE).some((item) => item.assertionId === 'corrupt-archived'))
  corruptInspector.close()

  const poisonFile = join(root, 'poison.sqlite')
  const poisonReducer = (input) => {
    if (input.observations.some((item) => item.eventKey === 'obs-poison')) {
      throw new Error('poison record cannot be projected')
    }
    return projectLedger(input)
  }
  let poisonStore = new MemoryLedger(poisonFile, { reducer: poisonReducer })
  stores.push(poisonStore)
  const goodHash = poisonStore.appendObservation(observation('obs-good'))
  const goodFacts = canonicalJson(poisonStore.currentFacts(SCOPE))
  const poisonedHash = poisonStore.appendObservation(observation('obs-poison', {
    seq: 2, validAt: 2000, recordedAt: 2000, subjectEntityId: 'C:/p/poison.txt', value: { size: 2 },
  }))
  const failedStatus = poisonStore.projectionStatus(SCOPE)
  check('projection failure retains the last good hash and facts instead of blanking the scope',
    poisonedHash === null && goodHash === failedStatus.projectionHash &&
    canonicalJson(poisonStore.currentFacts(SCOPE)) === goodFacts &&
    failedStatus.status === 'failed' &&
    failedStatus.reason.includes('poison record cannot be projected') &&
    failedStatus.failingRecord === 'obs-poison' &&
    poisonStore.dead(SCOPE).some((item) => item.eventKey === 'obs-poison'))
  check('retrying a still-failing poison record preserves valid facts and reports it',
    poisonStore.retryDead('obs-poison') === null &&
    canonicalJson(poisonStore.currentFacts(SCOPE)) === goodFacts &&
    poisonStore.projectionStatus(SCOPE).failingRecord === 'obs-poison')
  poisonStore.close()
  stores.pop()

  poisonStore = new MemoryLedger(poisonFile)
  stores.push(poisonStore)
  const recoveredPoisonHash = poisonStore.retryDead('obs-poison')
  check('retryDead after the reducer fix preserves valid facts and clears the poison record',
    typeof recoveredPoisonHash === 'string' &&
    poisonStore.currentFacts(SCOPE).some((fact) =>
      fact.subjectEntityId === 'C:/p/poison.txt' && fact.predicate === 'file.size' && fact.value === 2) &&
    poisonStore.projectionStatus(SCOPE).status === 'applied' &&
    poisonStore.projectionStatus(SCOPE).failingRecord === null &&
    poisonStore.dead(SCOPE).length === 0)

  const guardFile = join(root, 'guard.sqlite')
  const guardStore = new MemoryLedger(guardFile, { maxProjectionEvents: 1 })
  stores.push(guardStore)
  const guardFirst = guardStore.appendObservation(observation('guard-first'))
  const guardFacts = canonicalJson(guardStore.currentFacts(SCOPE))
  const guardSecond = guardStore.appendObservation(observation('guard-second', {
    seq: 2, validAt: 2000, recordedAt: 2000, subjectEntityId: 'C:/p/second.txt',
  }))
  const guardStatus = guardStore.projectionStatus(SCOPE)
  check('projection event guard fails visibly instead of hanging and keeps last good facts',
    typeof guardFirst === 'string' && guardSecond === null &&
    guardStatus.status === 'failed' &&
    guardStatus.reason.includes('projection-event-limit-exceeded') &&
    guardStatus.failingRecord === 'guard-second' &&
    guardStatus.projectionHash === guardFirst &&
    canonicalJson(guardStore.currentFacts(SCOPE)) === guardFacts &&
    guardStore.dead(SCOPE).some((item) => item.eventKey === 'guard-second'))
} finally {
  for (const store of stores.splice(0).reverse()) {
    try { store.close() } catch { /* already closed after a failed check */ }
  }
  rmSync(root, { recursive: true, force: true })
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
