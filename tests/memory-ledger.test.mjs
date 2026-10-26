// 隔离记忆账本：规范化契约与完整事实预算。运行：node tests/memory-ledger.test.mjs
import { performance } from 'node:perf_hooks'
import * as ledger from '../web/memory-ledger-core.mjs'
import { observationFromScopeInit } from '../web/memory-observations.mjs'

const {
  canonicalJson,
  sha256Canonical,
  PREDICATES,
  factKey,
  projectLedger,
  renderFacts,
  factsAt,
  projectionHash,
  validateAssertionInput,
} = ledger

let fails = 0
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!condition) fails++
}
const rejects = (value) => {
  try { canonicalJson(value); return false } catch { return true }
}

check('canonical object keys and NFC are stable',
  canonicalJson({ z: -0, a: 'e\u0301' }) === '{"a":"é","z":0}')
check('canonical rejects non-finite numbers', (() => {
  try { canonicalJson({ x: NaN }); return false } catch { return true }
})())
check('canonical sorts nested keys and normalizes keys',
  canonicalJson({ z: { b: 2, a: 1 }, 'e\u0301': { d: 4, c: 3 } }) === '{"z":{"a":1,"b":2},"é":{"c":3,"d":4}}')
check('canonical preserves ordinary array order',
  canonicalJson(['b', 'a', { z: 1, a: 2 }]) === '["b","a",{"a":2,"z":1}]')
check('canonical sorts only explicit set wrappers',
  canonicalJson({ values: { $set: ['b', 'a'] }, plain: ['b', 'a'] }) === '{"plain":["b","a"],"values":{"$set":["a","b"]}}')
check('canonical sorts structured set elements by their canonical JSON',
  canonicalJson({ $set: [{ z: 1 }, { a: 1 }] }) === '{"$set":[{"a":1},{"z":1}]}')
check('canonical preserves explicit null optional fields',
  canonicalJson({ validTo: null, conflict: null }) === '{"conflict":null,"validTo":null}')
check('canonical rejects undefined in objects and arrays',
  rejects({ x: undefined }) && rejects([undefined]) && rejects(new Array(1)) &&
  rejects({ $set: new Array(1) }))
check('canonical rejects bigint, functions, symbols, and infinities',
  rejects(1n) && rejects(() => {}) && rejects(Symbol('x')) && rejects(Infinity) && rejects(-Infinity))
check('canonical rejects cyclic objects', (() => {
  const value = { name: 'cycle' }
  value.self = value
  return rejects(value)
})())
check('canonical accepts repeated non-cyclic references', (() => {
  const shared = { b: 2, a: 1 }
  return canonicalJson([shared, shared]) === '[{"a":1,"b":2},{"a":1,"b":2}]'
})())
check('canonical rejects key collisions introduced by NFC',
  rejects({ 'e\u0301': 1, 'é': 2 }))
check('sha256Canonical hashes canonical UTF-8 JSON',
  sha256Canonical('a') === 'ac8d8342bbb2362d13f0a559a3621bb407011368895164b628a54f7fc33fc43c')

const registryFields = ['allowedSources', 'cardinality', 'mutable', 'entityBound',
  'invalidationRule', 'conflictRule', 'injectable', 'valueSchema', 'renderer']
const enabledPredicates = ['file.exists', 'file.size', 'file.mtime', 'file.sha256',
  'project.decision', 'project.constraint', 'project.preference']
check('registry enables only the seven Cycle-1 predicates',
  enabledPredicates.every((name) => PREDICATES[name]?.injectable === true) &&
  PREDICATES['file.lines']?.injectable === false &&
  PREDICATES['synthetic.set']?.injectable === false)
check('registry key set is exactly the declared contract set',
  canonicalJson(Object.keys(PREDICATES).sort()) ===
  canonicalJson([...enabledPredicates, 'file.lines', 'synthetic.set'].sort()))
check('exactly the seven enabled predicates are injectable',
  canonicalJson(Object.keys(PREDICATES).filter((name) => PREDICATES[name].injectable).sort()) ===
  canonicalJson([...enabledPredicates].sort()))
check('every predicate declares the complete contract',
  [...enabledPredicates, 'file.lines', 'synthetic.set'].every((name) =>
    registryFields.every((field) => Object.hasOwn(PREDICATES[name], field))))
check('source and cardinality contracts distinguish files, projects, and sets',
  enabledPredicates.slice(0, 4).every((name) =>
    PREDICATES[name].cardinality === 'single' && PREDICATES[name].entityBound === true &&
    PREDICATES[name].allowedSources.includes('observation') &&
    PREDICATES[name].allowedSources.includes('probe') &&
    !PREDICATES[name].allowedSources.includes('llm')) &&
  // Cycle 2 opens `llm` only for the three project predicates; the proposal engine
  // still derives every admitted llm fact from an archived user quote.
  enabledPredicates.slice(4).every((name) =>
    PREDICATES[name].cardinality === 'multi' && PREDICATES[name].entityBound === false &&
    canonicalJson(PREDICATES[name].allowedSources) === canonicalJson(['user', 'llm'])) &&
  PREDICATES['synthetic.set'].cardinality === 'multi' &&
  !PREDICATES['synthetic.set'].allowedSources.includes('llm'))

const singleKeyFact = {
  scope: 'workspace', subjectEntityId: 'file:a', generation: 2,
  predicate: 'file.sha256', qualifiers: { z: 'e\u0301', a: 1 }, value: 'old',
}
check('factKey canonicalizes qualifiers and excludes single values',
  factKey(singleKeyFact) === 'workspace/file:a/2/file.sha256/{"a":1,"z":"é"}' &&
  factKey({ ...singleKeyFact, value: 'new' }) === factKey(singleKeyFact))
check('factKey appends canonical value keys for multi-value predicates',
  factKey({ scope: 'workspace', subjectEntityId: 'project', generation: 1,
    predicate: 'synthetic.set', qualifiers: {}, valueKey: { z: 2, a: 1 } }) ===
  'workspace/project/1/synthetic.set/{}/{"a":1,"z":2}')
check('project rules get distinct fact keys for distinct values',
  factKey({ scope: 'workspace', subjectEntityId: 'project', generation: 1,
    predicate: 'project.constraint', qualifiers: null,
    valueKey: { text: '金额用整数分' }, value: { text: '金额用整数分' } }) !==
  factKey({ scope: 'workspace', subjectEntityId: 'project', generation: 1,
    predicate: 'project.constraint', qualifiers: null,
    valueKey: { text: '测试用 node:test' }, value: { text: '测试用 node:test' } }))

const facts = [
  { predicate: 'file.exists', subjectDisplay: 'C:/p/a.txt', value: true },
  { predicate: 'project.constraint', subjectDisplay: 'project', value: { text: '固定端口 8848' } },
]
const rendered = renderFacts(facts, 20)
check('budget drops whole facts without fragments',
  rendered.text.length <= 20 && !rendered.text.includes('文件路径为') && rendered.overflowCount >= 1)
check('renderer selects complete later facts that fit and counts all overflow',
  rendered.text === '项目约束：固定端口 8848' && rendered.selected.length === 1 &&
  rendered.selected[0] === facts[1] && rendered.overflowCount === 1, JSON.stringify(rendered))
check('renderer preserves supplied order and exact-fit lines', (() => {
  const expected = '项目决策：采用 SQLite\n项目偏好：简洁回复'
  const input = [
    { predicate: 'project.decision', subjectDisplay: 'project', value: { text: '采用 SQLite' } },
    { predicate: 'project.preference', subjectDisplay: 'project', value: { text: '简洁回复' } },
  ]
  const result = renderFacts(input, expected.length)
  return result.text === expected && result.selected.length === 2 && result.overflowCount === 0
})())
check('renderer never slices an over-budget fact', (() => {
  const result = renderFacts([facts[1]], 5)
  return result.text === '' && result.selected.length === 0 && result.overflowCount === 1
})())
check('renderer omits disabled and non-active facts', (() => {
  const input = [
    { predicate: 'file.lines', subjectDisplay: 'C:/p/a.txt', value: 12 },
    { ...facts[1], status: 'conflicted' },
    facts[0],
  ]
  const result = renderFacts(input, 200)
  return result.selected.length === 1 && result.selected[0] === facts[0] &&
    result.overflowCount === 2 && !result.text.includes('固定端口')
})())
check('renderer suppresses file.exists=false instead of injecting an absence marker', (() => {
  const input = [
    { predicate: 'file.exists', subjectDisplay: 'C:/p/gone.txt', value: false },
    { predicate: 'file.exists', subjectDisplay: 'C:/p/here.txt', value: true },
  ]
  const result = renderFacts(input, 200)
  return result.selected.length === 1 && result.selected[0] === input[1] &&
    result.suppressedCount === 1 && !result.text.includes('当前不存在') &&
    !result.text.includes('gone.txt') && result.text.includes('当前存在')
})())

const A = 'C:/p/a.txt'
const B = 'C:/p/b.txt'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
let observationSeq = 0
const observe = (eventKey, op, outcome, subjectEntityId, value = {}, extra = {}) => {
  observationSeq++
  const timestamp = 1000 + (observationSeq - 1) * 200
  return {
    eventKey, scope: 'workspace', sid: 's1', seq: observationSeq,
    validAt: timestamp, recordedAt: timestamp, op, outcome,
    subjectEntityId, targetEntityId: null, value,
    rawRef: `raw:${eventKey}`, rawPayload: { eventKey, value },
    source: { kind: op === 'probe' ? 'probe' : 'observation', authority: 'host' },
    ...extra,
  }
}
const lifecycleFixture = [
  observe('e1', 'create', 'success', A, { size: 10, mtime: 100, sha256: HASH_A }),
  observe('e2', 'write', 'success', A, { size: 20, mtime: 200, sha256: HASH_B }),
  observe('e2-plain', 'write', 'success', A, { exists: true }),
  observe('e3', 'delete', 'success', A),
  observe('read-deleted', 'read', 'success', A, { exists: true, size: 999, sha256: HASH_C }),
  observe('e4', 'create', 'success', A, { size: 30, mtime: 300 }),
  observe('failed-delete', 'delete', 'failure', A),
  observe('unknown-task', 'task', 'unknown', A, { exists: false, size: 1 }),
  observe('probe-full', 'probe', 'observed', A, { exists: true, size: 31, mtime: 301, sha256: HASH_C }),
  observe('probe-partial', 'probe', 'observed', A, { exists: true, size: 32 }),
  observe('stat-partial', 'stat', 'success', A, { mtime: 302 }),
  observe('missing-b-1', 'probe', 'observed', B, { exists: false }),
  observe('missing-b-2', 'probe', 'observed', B, { exists: false }),
  observe('rename1', 'rename', 'success', A, {}, { targetEntityId: B }),
  observe('e5', 'create', 'success', A, { size: 40 }),
  observe('rename-denied', 'rename', 'success', A, {}, { targetEntityId: B }),
]
const project = (observations, assertions = []) => projectLedger({
  observations, assertions, reducerVersion: 'r1',
})
const through = (eventKey) => {
  const index = lifecycleFixture.findIndex((observation) => observation.eventKey === eventKey)
  return project(lifecycleFixture.slice(0, index + 1))
}
const currentFact = (result, predicate, subjectEntityId) => result.currentFacts.find((fact) =>
  fact.predicate === predicate && fact.subjectEntityId === subjectEntityId)
const placement = (result, eventKey, role = 'subject') => result.observationPlacements.find((item) =>
  item.eventKey === eventKey && item.role === role)

const archivedFixtureJson = canonicalJson(lifecycleFixture)
const lifecycle = project(lifecycleFixture)
const recreated = placement(lifecycle, 'e4')
check('delete then recreate opens a new generation',
  recreated?.generation === 2 && recreated.unplaced === false)
check('read after delete is unplaced and derives no facts',
  placement(lifecycle, 'read-deleted')?.unplaced === true &&
  placement(lifecycle, 'read-deleted')?.generation === null &&
  !lifecycle.factVersions.some((fact) => fact.assertionId.startsWith('observation:read-deleted:')))
check('failed delete does not close the entity',
  currentFact(through('failed-delete'), 'file.exists', A)?.value === true &&
  currentFact(through('failed-delete'), 'file.exists', A)?.generation === 2 &&
  !lifecycle.factVersions.some((fact) => fact.assertionId.startsWith('observation:failed-delete:')))
check('unknown operations cannot mutate facts',
  canonicalJson(through('unknown-task').currentFacts) === canonicalJson(through('failed-delete').currentFacts) &&
  placement(lifecycle, 'unknown-task')?.unplaced === true)
check('repeated missing observations reuse the closed first generation',
  placement(lifecycle, 'missing-b-1')?.generation === 1 &&
  placement(lifecycle, 'missing-b-2')?.generation === 1 &&
  placement(lifecycle, 'missing-b-2')?.unplaced === false)
check('rename to previously deleted target does not revive target generation',
  placement(lifecycle, 'rename1', 'target')?.generation === 2 &&
  placement(lifecycle, 'rename1', 'source')?.generation === 2)
check('rename onto an existing target leaves both entities unchanged',
  placement(lifecycle, 'rename-denied', 'source')?.unplaced === true &&
  placement(lifecycle, 'rename-denied', 'target')?.unplaced === true &&
  canonicalJson(lifecycle.currentFacts) === canonicalJson(through('e5').currentFacts))
check('rename transfers existence only, never source content facts',
  currentFact(lifecycle, 'file.exists', B)?.value === true &&
  currentFact(lifecycle, 'file.exists', B)?.generation === 2 &&
  currentFact(lifecycle, 'file.size', B) === undefined &&
  currentFact(lifecycle, 'file.mtime', B) === undefined &&
  currentFact(lifecycle, 'file.sha256', B) === undefined)
check('unmeasured write fields invalidate stale metadata',
  ['file.size', 'file.mtime', 'file.sha256'].every((predicate) =>
    currentFact(through('e2-plain'), predicate, A) === undefined) &&
  currentFact(through('e2-plain'), 'file.exists', A)?.value === true)
check('probe-present updates measured fields without invalidating others',
  currentFact(through('probe-partial'), 'file.size', A)?.value === 32 &&
  currentFact(through('probe-partial'), 'file.mtime', A)?.value === 301 &&
  currentFact(through('probe-partial'), 'file.sha256', A)?.value === HASH_C)
check('read and stat retain fields they did not measure',
  currentFact(through('stat-partial'), 'file.size', A)?.value === 32 &&
  currentFact(through('stat-partial'), 'file.mtime', A)?.value === 302 &&
  currentFact(through('stat-partial'), 'file.sha256', A)?.value === HASH_C)
check('derived rename assertion IDs include distinct source and target roles',
  lifecycle.factVersions.some((fact) =>
    fact.assertionId === 'observation:rename1:source:file.exists:assert') &&
  lifecycle.factVersions.some((fact) =>
    fact.assertionId === 'observation:rename1:target:file.exists:assert'))

const closureUnrelated = observe('closure-unrelated', 'create', 'success', B,
  { size: 50, mtime: 500, sha256: HASH_C }, { seq: 3, validAt: 1500, recordedAt: 1500 })
const closureBefore = [lifecycleFixture[0], lifecycleFixture[1], closureUnrelated]
const closureCases = [
  ['delete', lifecycleFixture[3]],
  ['probe-missing', observe('closure-probe-missing', 'probe', 'observed', A, { exists: false })],
]
const unrelatedClosureProjection = (result) => ({
  entity: result.entities.find((entity) => entity.entityId === B),
  versions: result.factVersions.filter((fact) => fact.subjectEntityId === B),
  current: result.currentFacts.filter((fact) => fact.subjectEntityId === B),
})
for (const [label, closingEvent] of closureCases) {
  const before = project(closureBefore)
  const after = project([...closureBefore, closingEvent])
  const prior = before.currentFacts.filter((fact) => fact.subjectEntityId === A)
  const priorIds = new Set(prior.map((fact) => fact.assertionId))
  const remaining = after.currentFacts.filter((fact) => fact.subjectEntityId === A)
  const closed = after.factVersions.filter((fact) => priorIds.has(fact.assertionId))

  check(`${label} leaves only its new exists=false absence marker current`,
    prior.length === 4 && currentFact(before, 'file.exists', A)?.value === true &&
    remaining.length === 1 && remaining[0].predicate === 'file.exists' &&
    remaining[0].value === false && remaining[0].status === 'active' &&
    remaining[0].validTo === null && remaining[0].assertionId ===
      `observation:${closingEvent.eventKey}:subject:file.exists:assert`)
  check(`${label} closes old existence and every prior bound content fact`,
    closed.length === prior.length && closed.every((fact) =>
      fact.status !== 'active' && fact.validTo === closingEvent.validAt) &&
    !after.currentFacts.some((fact) => priorIds.has(fact.assertionId)))
  check(`${label} leaves unrelated entity state, history, and current facts unchanged`,
    canonicalJson(unrelatedClosureProjection(after)) === canonicalJson(unrelatedClosureProjection(before)))

  const shadow = renderFacts(after.currentFacts, 2000)
  const selectedForMissing = shadow.selected.filter((fact) => fact.subjectEntityId === A)
  check(`${label} rendering suppresses the absence marker and never claims existence`,
    selectedForMissing.length === 0 &&
    !shadow.text.includes(`文件路径为 ${A}，当前不存在`) &&
    !shadow.text.includes(`文件路径为 ${A}，当前存在`))
}

const reversed = project([...lifecycleFixture].reverse())
const normalizedProjection = (result) => ({
  entities: result.entities,
  observationPlacements: result.observationPlacements,
  assertionPlacements: result.assertionPlacements,
  factVersions: result.factVersions,
  currentFacts: result.currentFacts,
  dead: result.dead,
})
check('forward and reversed archives have identical normalized projections',
  canonicalJson(normalizedProjection(reversed)) === canonicalJson(normalizedProjection(lifecycle)))
check('projection is pure and does not rewrite archived observations',
  canonicalJson(lifecycleFixture) === archivedFixtureJson)

const semanticAssertion = {
  assertionId: 'semantic-without-generation', scope: 'workspace', subjectEntityId: 'project',
  sid: 's1', seq: 100, op: 'assert', targetAssertionId: null,
  predicate: 'project.decision', value: { text: '不附着到猜测代际' }, qualifiers: null,
  validAt: 1500, recordedAt: 1500, sourceKind: 'user', sourceAuthority: 'user',
  evidence: null, verification: 'user-confirmed',
}
const semanticPlacement = project(lifecycleFixture, [semanticAssertion]).assertionPlacements.find((item) =>
  item.assertionId === 'semantic-without-generation')
check('semantic assertions without a matching generation are unplaced',
  semanticPlacement?.unplaced === true && semanticPlacement.generation === null)

const tiedWrites = [
  { ...lifecycleFixture[0], eventKey: 'tie-create', seq: 1, validAt: 1000, recordedAt: 5000 },
  { ...lifecycleFixture[1], eventKey: 'w2', seq: 2, validAt: 2000, recordedAt: 3000,
    value: { size: 22 } },
  { ...lifecycleFixture[1], eventKey: 'w1', seq: 2, validAt: 2000, recordedAt: 4000,
    value: { size: 11 } },
]
const tiedForward = project(tiedWrites)
const tiedReverse = project([...tiedWrites].reverse())
check('namespaced IDs break equal timestamp and sequence ties deterministically',
  currentFact(tiedForward, 'file.size', A)?.value === 22 &&
  currentFact(tiedForward, 'file.size', A)?.assertionId === 'observation:w2:subject:file.size:assert' &&
  canonicalJson(normalizedProjection(tiedReverse)) === canonicalJson(normalizedProjection(tiedForward)))

const prefixTie = [
  { ...lifecycleFixture[1], eventKey: 'a', seq: 2, validAt: 2000, recordedAt: 2000,
    value: { size: 10 } },
  { ...lifecycleFixture[1], eventKey: 'a:0', seq: 2, validAt: 2000, recordedAt: 2000,
    value: { size: 20 } },
]
check('derived changes use full assertion IDs rather than event-level prefix order',
  currentFact(project(prefixTie), 'file.size', A)?.value === 10 &&
  currentFact(project(prefixTie), 'file.size', A)?.assertionId === 'observation:a:subject:file.size:assert')

const failedRename = observe('failed-rename', 'rename', 'failure', A, {}, { targetEntityId: B })
const beforeFailedRename = through('e5')
const afterFailedRename = project([...lifecycleFixture.slice(0, 15), failedRename])
check('failed rename has source and target placements but no state changes',
  placement(afterFailedRename, 'failed-rename', 'source')?.unplaced === true &&
  placement(afterFailedRename, 'failed-rename', 'target')?.unplaced === true &&
  !afterFailedRename.factVersions.some((fact) => fact.assertionId.startsWith('observation:failed-rename:')) &&
  canonicalJson(afterFailedRename.currentFacts) === canonicalJson(beforeFailedRename.currentFacts))

const DECISION_ENTITY = 'project:decisions'
// Project entities are opened by an explicit scope initialization, never by a fake
// file-style create that would additionally mint file.exists.
const decisionCreate = observationFromScopeInit({
  scope: 'workspace', entityId: DECISION_ENTITY, sid: 's1', seq: 1,
  validAt: 0, recordedAt: 0,
})
const decisionAssertion = (assertionId, op, value, validAt, recordedAt, extra = {}) => ({
  assertionId, scope: 'workspace', subjectEntityId: DECISION_ENTITY,
  sid: 's1', seq: 10, op, targetAssertionId: null,
  predicate: 'project.decision', value, qualifiers: null,
  validAt, recordedAt, sourceKind: 'user', sourceAuthority: 'user',
  evidence: { ref: `decision:${assertionId}` }, verification: 'user-confirmed',
  ...extra,
})
const originalDecision = decisionAssertion('d1', 'assert', { text: 'use SQLite' }, 1000, 1000)
const correctedDecision = decisionAssertion('d2', 'correct', { text: 'use PostgreSQL' }, 2000, 5000, {
  targetAssertionId: 'd1', seq: 11,
})
const correctedHistory = project([decisionCreate], [originalDecision, correctedDecision])
const decisionAt = (validAt, recordedAt) => factsAt?.(correctedHistory, { validAt, recordedAt })
  .find((fact) => fact.predicate === 'project.decision')

check('input assertions are placed and late corrections preserve pre-recording history',
  typeof factsAt === 'function' && decisionAt(2500, 1500)?.value.text === 'use SQLite' &&
  decisionAt(2500, 1500)?.validTo === null && decisionAt(2500, 1500)?.recordedAt === 1000)
check('late correction recomputes valid-time history without rewriting old system versions',
  typeof factsAt === 'function' && decisionAt(1500, 1500)?.value.text === 'use SQLite' &&
  decisionAt(1500, 5000)?.value.text === 'use SQLite' &&
  decisionAt(1500, 5000)?.validTo === 2000 && decisionAt(1500, 5000)?.recordedAt === 5000 &&
  correctedHistory.factVersions.some((fact) => fact.assertionId === 'd1' &&
    fact.recordedAt === 1000 && fact.retiredAt === 5000 && fact.validTo === null))
check('current facts use the corrected value after its recordedAt',
  typeof factsAt === 'function' && decisionAt(2500, 5000)?.value.text === 'use PostgreSQL' &&
  currentFact(correctedHistory, 'project.decision', DECISION_ENTITY)?.value.text === 'use PostgreSQL' &&
  currentFact(correctedHistory, 'project.decision', DECISION_ENTITY)?.assertionId === 'd2')
check('validTo is an exact half-open boundary',
  decisionAt(1999, 5000)?.assertionId === 'd1' && decisionAt(1999, 5000)?.validTo === 2000 &&
  decisionAt(2000, 5000)?.assertionId === 'd2' && decisionAt(2000, 5000)?.validFrom === 2000)
check('retiredAt is an exact half-open boundary',
  factsAt(correctedHistory, { validAt: 1500, recordedAt: 4999 }).some((fact) =>
    fact.assertionId === 'd1' && fact.recordedAt === 1000 && fact.retiredAt === 5000) &&
  !factsAt(correctedHistory, { validAt: 1500, recordedAt: 5000 }).some((fact) =>
    fact.assertionId === 'd1' && fact.recordedAt === 1000 && fact.retiredAt === 5000))

const sameTimeTarget = decisionAssertion('z-target', 'assert', { text: 'before' }, 1000, 1000, {
  predicate: 'project.preference',
})
const sameTimeCorrection = decisionAssertion('a-correction', 'correct', { text: 'after' }, 1000, 2000, {
  predicate: 'project.preference', targetAssertionId: 'z-target', seq: 10,
})
const sameTimeCorrectionResult = project([decisionCreate], [sameTimeTarget, sameTimeCorrection])
const sameTimeCorrectionPlacement = sameTimeCorrectionResult.assertionPlacements.find((item) =>
  item.assertionId === 'a-correction')
check('equal-validAt correction inherits target placement and closes it regardless of lexical ID order',
  sameTimeCorrectionPlacement?.unplaced === false && sameTimeCorrectionPlacement.generation === 1 &&
  currentFact(sameTimeCorrectionResult, 'project.preference', DECISION_ENTITY)?.assertionId === 'a-correction' &&
  currentFact(sameTimeCorrectionResult, 'project.preference', DECISION_ENTITY)?.value.text === 'after' &&
  !sameTimeCorrectionResult.dead.some((entry) => entry.assertionId === 'a-correction'))

const conflictFirst = decisionAssertion('c1', 'assert', { text: 'alpha' }, 1000, 1000, {
  predicate: 'project.constraint',
})
const conflictSecond = decisionAssertion('c2', 'assert', { text: 'beta' }, 1000, 2000, {
  predicate: 'project.constraint', seq: 11,
})
const coexisting = project([decisionCreate], [conflictFirst, conflictSecond])
const conflictRows = coexisting.currentFacts.filter((fact) => fact.predicate === 'project.constraint')
check('different project.constraints coexist and both render',
  conflictRows.length === 2 && conflictRows.every((fact) =>
    fact.status === 'active' && fact.conflict === null) &&
  canonicalJson(conflictRows.map((fact) => fact.value.text).sort()) ===
    canonicalJson(['alpha', 'beta']) &&
  renderFacts(coexisting.currentFacts, 2000).selected.filter((fact) =>
    fact.predicate === 'project.constraint').length === 2)
const conflictThird = decisionAssertion('c3', 'assert', { text: 'alpha' }, 1500, 2500, {
  predicate: 'project.constraint', seq: 12,
})
const expandedConflict = project([decisionCreate], [conflictFirst, conflictSecond, conflictThird])
const expandedRows = expandedConflict.currentFacts.filter((fact) =>
  fact.predicate === 'project.constraint')
check('re-asserting the same rule keeps one slot while the other rule survives',
  expandedRows.length === 2 && expandedRows.every((fact) =>
    fact.status === 'active' && fact.conflict === null) &&
  canonicalJson(expandedRows.map((fact) => fact.value.text).sort()) ===
    canonicalJson(['alpha', 'beta']))
const differentAuthorityAssert = decisionAssertion('different-authority', 'assert', { text: 'gamma' }, 1500, 2500, {
  predicate: 'project.constraint', seq: 12, sourceAuthority: 'host-verified',
})
const differentAuthorityConflict = project([decisionCreate],
  [conflictFirst, conflictSecond, differentAuthorityAssert])
const differentAuthorityRows = differentAuthorityConflict.currentFacts.filter((fact) =>
  fact.predicate === 'project.constraint')
check('different rule values coexist regardless of sourceAuthority',
  differentAuthorityRows.length === 3 && differentAuthorityRows.every((fact) =>
    fact.status === 'active' && fact.conflict === null) &&
  canonicalJson(differentAuthorityRows.map((fact) => fact.value.text).sort()) ===
    canonicalJson(['alpha', 'beta', 'gamma']))
const retractSecond = decisionAssertion('r2', 'retract', null, 2000, 3000, {
  predicate: 'project.constraint', targetAssertionId: 'c2', seq: 13,
})
const retractedConflict = project([decisionCreate], [conflictFirst, conflictSecond, retractSecond])
const remainingDecision = currentFact(retractedConflict, 'project.constraint', DECISION_ENTITY)
check('retracting one rule leaves the other rule active',
  retractedConflict.currentFacts.filter((fact) => fact.predicate === 'project.constraint').length === 1 &&
  remainingDecision?.assertionId === 'c1' && remainingDecision.status === 'active' &&
  remainingDecision.conflict === null && remainingDecision.validTo === null)

// Multi cardinality scopes conflicts to one rule slot. Two equal-authority
// assertions that explicitly name the same slot are still a safety conflict;
// distinct slots coexist above. This preserves the "conflicted facts are never
// rendered" contract without making every independent rule collide.
const sameSlotFirst = decisionAssertion('same-slot-1', 'assert', { text: 'alpha' }, 1000, 1000, {
  predicate: 'project.constraint', valueKey: { rule: 'same' }, seq: 10,
})
const sameSlotSecond = decisionAssertion('same-slot-2', 'assert', { text: 'beta' }, 1000, 2000, {
  predicate: 'project.constraint', valueKey: { rule: 'same' }, seq: 11,
})
const sameSlot = project([decisionCreate], [sameSlotFirst, sameSlotSecond])
const sameSlotRows = sameSlot.currentFacts.filter((fact) => fact.predicate === 'project.constraint')
check('same rule slot with equal-authority values is conflicted and not rendered',
  sameSlotRows.length === 2 && sameSlotRows.every((fact) => fact.status === 'conflicted') &&
  sameSlotRows.every((fact) =>
    canonicalJson(fact.conflict.assertionIds) === '["same-slot-1","same-slot-2"]') &&
  renderFacts(sameSlot.currentFacts, 2000).selected.every((fact) =>
    fact.predicate !== 'project.constraint'))

const changedQualifiers = decisionAssertion('bad-qualifiers', 'correct', { text: 'wrong' }, 2000, 3000, {
  targetAssertionId: 'd1', qualifiers: { changed: true },
})
const changedQualifiersResult = project([decisionCreate], [originalDecision, changedQualifiers])
check('correction with changed qualifiers is dead and cannot close its target',
  changedQualifiersResult.dead.some((entry) => entry.assertionId === 'bad-qualifiers') &&
  currentFact(changedQualifiersResult, 'project.decision', DECISION_ENTITY)?.value.text === 'use SQLite')
const earlyCorrection = decisionAssertion('bad-valid-at', 'correct', { text: 'wrong' }, 500, 3000, {
  targetAssertionId: 'd1',
})
const earlyCorrectionResult = project([decisionCreate], [originalDecision, earlyCorrection])
check('correction earlier than its target validAt is dead',
  earlyCorrectionResult.dead.some((entry) => entry.assertionId === 'bad-valid-at') &&
  currentFact(earlyCorrectionResult, 'project.decision', DECISION_ENTITY)?.value.text === 'use SQLite')
const duplicateTerminal = decisionAssertion('duplicate-terminal', 'correct', { text: 'wrong' }, 2000, 4000, {
  targetAssertionId: 'd1', seq: 12,
})
const firstTerminal = decisionAssertion('first-terminal', 'retract', null, 2000, 3000, {
  targetAssertionId: 'd1', seq: 11,
})
const duplicateTerminalResult = project([decisionCreate], [originalDecision, firstTerminal, duplicateTerminal])
const duplicateTerminalDead = duplicateTerminalResult.dead.filter((entry) =>
  entry.assertionId === 'first-terminal' || entry.assertionId === 'duplicate-terminal')
check('duplicate terminal operations are all dead and neither mutates their target',
  duplicateTerminalDead.length === 2 &&
  duplicateTerminalDead.every((entry) => entry.reason === 'duplicate-terminal-operation') &&
  currentFact(duplicateTerminalResult, 'project.decision', DECISION_ENTITY)?.assertionId === 'd1' &&
  currentFact(duplicateTerminalResult, 'project.decision', DECISION_ENTITY)?.value.text === 'use SQLite')

const lateProbeCreate = observe('late-create', 'create', 'success', A, { size: 10 }, {
  seq: 1, validAt: 1000, recordedAt: 1000,
})
const lateProbe = observe('late-probe', 'probe', 'observed', A, { exists: true, size: 20 }, {
  seq: 2, validAt: 2000, recordedAt: 5000,
})
const lateObservationHistory = project([lateProbeCreate, lateProbe])
const observedSizeAt = (validAt, recordedAt) => factsAt?.(lateObservationHistory, { validAt, recordedAt })
  .find((fact) => fact.predicate === 'file.size')
check('late Observation-derived facts preserve pre-recording history',
  typeof factsAt === 'function' && observedSizeAt(2500, 1500)?.value === 10 &&
  observedSizeAt(2500, 1500)?.validTo === null && observedSizeAt(2500, 1500)?.recordedAt === 1000)
check('late Observation recomputes valid_to only for later system knowledge',
  typeof factsAt === 'function' && observedSizeAt(1500, 1500)?.value === 10 &&
  observedSizeAt(1500, 5000)?.value === 10 && observedSizeAt(1500, 5000)?.validTo === 2000 &&
  observedSizeAt(2500, 5000)?.value === 20 &&
  currentFact(lateObservationHistory, 'file.size', A)?.value === 20)

const expectedHashFacts = (result) => result.currentFacts
  .filter((fact) => (fact.status === 'active' || fact.status === 'conflicted') &&
    fact.validTo === null && fact.retiredAt === null)
  .map((fact) => ({
    fact_key: fact.factKey,
    subject_entity_id: fact.subjectEntityId,
    generation: fact.generation,
    predicate: fact.predicate,
    value_json: fact.value ?? null,
    qualifiers_json: fact.qualifiers ?? null,
    assertion_id: fact.assertionId,
    evidence_json: fact.evidence ?? null,
    causal_order: fact.causalOrder,
    valid_from: fact.validFrom,
    valid_to: fact.validTo ?? null,
    recorded_at: fact.recordedAt,
    status: fact.status,
    verification: fact.verification,
    conflict_json: fact.conflict ?? null,
  }))
  .sort((a, b) => lexicalTestCompare(a.fact_key, b.fact_key) || lexicalTestCompare(a.assertion_id, b.assertion_id))
function lexicalTestCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0 }

const mixedFileCreate = observe('mixed-file-create', 'create', 'success', A, { size: 10 }, {
  seq: 1, validAt: 500, recordedAt: 1500,
})
const mixedRetractTarget = decisionAssertion('mixed-retract-target', 'assert', { text: 'temporary' }, 1000, 1000, {
  predicate: 'project.preference',
})
const mixedRetraction = decisionAssertion('mixed-retraction', 'retract', null, 2000, 3000, {
  predicate: 'project.preference', targetAssertionId: 'mixed-retract-target', seq: 11,
})
const mixedObservations = [decisionCreate, mixedFileCreate]
const mixedAssertions = [originalDecision, correctedDecision, conflictFirst, conflictSecond,
  mixedRetractTarget, mixedRetraction]
const mixedForward = project(mixedObservations, mixedAssertions)
const mixedReversed = project([...mixedObservations].reverse(), [...mixedAssertions].reverse())
check('mixed Observation and Assertion replay hash is independent of archive order',
  projectionHash(mixedForward) === projectionHash(mixedReversed) &&
  currentFact(mixedForward, 'file.size', A)?.value === 10 &&
  currentFact(mixedForward, 'project.decision', DECISION_ENTITY)?.assertionId === 'd2' &&
  currentFact(mixedForward, 'project.preference', DECISION_ENTITY) === undefined &&
  mixedForward.currentFacts.filter((fact) => fact.predicate === 'project.constraint').length === 2)
const mixedExpectedHashFacts = expectedHashFacts(mixedForward)
check('mixed exact hash DTO exposes both independent project rules as active',
  projectionHash(mixedForward) === sha256Canonical({
    reducer_version: 'r1', facts: mixedExpectedHashFacts,
  }) && ['c1', 'c2'].every((assertionId) => mixedExpectedHashFacts.some((fact) =>
    fact.assertion_id === assertionId && fact.status === 'active' &&
    fact.conflict_json === null)))

const rebuildOne = project(lifecycleFixture)
const rebuildTwo = project(lifecycleFixture)
const rebuildThree = project(lifecycleFixture)
check('three independent rebuilds have identical stable projection hashes',
  typeof projectionHash === 'function' && projectionHash(rebuildOne) === projectionHash(rebuildTwo) &&
  projectionHash(rebuildTwo) === projectionHash(rebuildThree))
check('projection hash is independent of archive order',
  typeof projectionHash === 'function' && projectionHash(rebuildOne) === projectionHash(reversed))
check('projection hash uses the exact specified current-fact DTO',
  typeof projectionHash === 'function' && projectionHash(rebuildOne) === sha256Canonical({
    reducer_version: 'r1', facts: expectedHashFacts(rebuildOne),
  }))
const changedRecordingFixture = lifecycleFixture.map((observation) => observation.eventKey === 'e5'
  ? { ...observation, recordedAt: observation.recordedAt + 1 }
  : observation)
check('changed recordedAt intentionally changes projection history hash',
  typeof projectionHash === 'function' &&
  projectionHash(rebuildOne) !== projectionHash(project(changedRecordingFixture)))

const projectOnly = project([decisionCreate], [originalDecision])
const projectOnlyRender = renderFacts(projectOnly.currentFacts, 4000)
check('scope init opens a project generation without deriving file facts',
  projectOnly.entities.some((entity) => entity.entityId === DECISION_ENTITY &&
    entity.generation === 1 && entity.presence === true) &&
  projectOnly.observationPlacements.find((item) =>
    item.eventKey === decisionCreate.eventKey)?.generation === 1 &&
  !projectOnly.currentFacts.some((fact) => fact.predicate.startsWith('file.')) &&
  !projectOnlyRender.text.includes('文件路径') &&
  projectOnlyRender.text.includes('项目决策：use SQLite'),
  JSON.stringify(projectOnlyRender.text))

const fileCreateOnly = [lifecycleFixture[0]]
const existsDerived = 'observation:e1:subject:file.exists:assert'
const userFileWrite = {
  assertionId: 'user-file-write', scope: 'workspace', subjectEntityId: A,
  sid: 's1', seq: 50, op: 'assert', targetAssertionId: null,
  predicate: 'file.exists', value: true, qualifiers: null,
  validAt: 1200, recordedAt: 1200, sourceKind: 'user', sourceAuthority: 'user',
  evidence: null, verification: 'user-confirmed',
}
const userFileProjection = project(fileCreateOnly, [userFileWrite])
check('user assertions cannot claim observation-owned file facts',
  userFileProjection.dead.some((entry) => entry.assertionId === 'user-file-write' &&
    entry.reason === 'source-not-allowed') &&
  !userFileProjection.currentFacts.some((fact) => fact.assertionId === 'user-file-write') &&
  currentFact(userFileProjection, 'file.exists', A)?.value === true)

const userFileCorrect = {
  ...userFileWrite, assertionId: 'user-file-correct', op: 'correct',
  targetAssertionId: existsDerived, validAt: 1300, recordedAt: 1300,
}
const userFileCorrectProjection = project(fileCreateOnly, [userFileCorrect])
check('user correction of an observation-derived file fact is dead and changes nothing',
  userFileCorrectProjection.dead.some((entry) => entry.assertionId === 'user-file-correct' &&
    entry.reason === 'source-not-allowed') &&
  currentFact(userFileCorrectProjection, 'file.exists', A)?.assertionId === existsDerived &&
  currentFact(userFileCorrectProjection, 'file.exists', A)?.value === true)

const validationErrors = (patch) => validateAssertionInput({ ...originalDecision, ...patch }).errors
const fileAssertion = (predicate, value) => ({
  ...originalDecision, assertionId: `schema-${predicate}`, subjectEntityId: A,
  predicate, value, sourceKind: 'observation', sourceAuthority: 'host',
  verification: 'observed',
})
check('assertion validation enforces predicate, op, source, verification, and value schema',
  !validateAssertionInput({ ...originalDecision, predicate: 'unknown.predicate' }).valid &&
  validationErrors({ predicate: 'unknown.predicate' }).includes('unknown-predicate') &&
  validationErrors({ op: 'invalidate' }).includes('unsupported-operation') &&
  validationErrors({ predicate: 'file.exists', subjectEntityId: A }).includes('source-not-allowed') &&
  // `llm` is admitted for project predicates only, so a file assertion still fails.
  validationErrors({ predicate: 'file.size', subjectEntityId: A, sourceKind: 'llm', value: 1 })
    .includes('source-not-allowed') &&
  validationErrors({ verification: 'made-up' }).includes('invalid-verification') &&
  validationErrors({ value: { text: '   ' } }).includes('value-schema-invalid') &&
  validationErrors({ value: 'not-structured' }).includes('value-schema-invalid'))
check('assertion validation enforces value schemas for every Cycle-1 file predicate',
  !validateAssertionInput(fileAssertion('file.exists', 'true')).valid &&
  !validateAssertionInput(fileAssertion('file.size', -1)).valid &&
  !validateAssertionInput(fileAssertion('file.mtime', -5)).valid &&
  !validateAssertionInput(fileAssertion('file.sha256', HASH_A.toUpperCase())).valid &&
  validateAssertionInput(fileAssertion('file.exists', true)).valid &&
  validateAssertionInput(fileAssertion('file.size', 0)).valid &&
  validateAssertionInput(fileAssertion('file.mtime', 0)).valid &&
  validateAssertionInput(fileAssertion('file.sha256', HASH_A)).valid)

const invalidSemanticValue = decisionAssertion('bad-project-value', 'assert',
  'not-structured', 1000, 1000)
const invalidSemanticProjection = project([decisionCreate], [invalidSemanticValue])
check('invalid archived assertion values mark only that assertion dead',
  invalidSemanticProjection.dead.some((entry) =>
    entry.assertionId === 'bad-project-value' && entry.reason === 'value-schema-invalid') &&
  currentFact(invalidSemanticProjection, 'project.decision', DECISION_ENTITY) === undefined)

const corruptUnknownPredicate = {
  ...originalDecision, assertionId: 'corrupt-unknown', predicate: 'does.not.exist',
}
const poisonedProjection = project(fileCreateOnly, [corruptUnknownPredicate])
check('unknown archived predicates never throw and leave valid observation facts intact',
  poisonedProjection.dead.some((entry) => entry.assertionId === 'corrupt-unknown' &&
    entry.reason === 'unknown-predicate') &&
  currentFact(poisonedProjection, 'file.exists', A)?.value === true &&
  currentFact(poisonedProjection, 'file.size', A)?.value === 10)

const readMissing = observe('read-missing', 'read', 'success', A,
  { exists: false, size: 555, sha256: HASH_C })
const readMissingProjection = project([lifecycleFixture[0], readMissing])
check('read reporting exists:false degrades to unknown without contradictory facts',
  placement(readMissingProjection, 'read-missing')?.unplaced === true &&
  placement(readMissingProjection, 'read-missing')?.reason === 'reported-exists-false' &&
  !readMissingProjection.factVersions.some((fact) =>
    fact.assertionId.startsWith('observation:read-missing:')) &&
  currentFact(readMissingProjection, 'file.exists', A)?.value === true &&
  currentFact(readMissingProjection, 'file.size', A)?.value === 10)

const writeMissing = observe('write-missing', 'write', 'success', A,
  { exists: false, size: 1, sha256: HASH_A })
const writeMissingProjection = project([lifecycleFixture[0], writeMissing])
check('successful write reporting exists:false cannot mint exists=true',
  placement(writeMissingProjection, 'write-missing')?.unplaced === true &&
  placement(writeMissingProjection, 'write-missing')?.reason === 'reported-exists-false' &&
  !writeMissingProjection.factVersions.some((fact) =>
    fact.assertionId.startsWith('observation:write-missing:')) &&
  currentFact(writeMissingProjection, 'file.exists', A)?.value === true &&
  currentFact(writeMissingProjection, 'file.size', A)?.value === 10)

const unverifiedDecision = decisionAssertion('unverified-decision', 'assert',
  { text: 'do not inject' }, 1500, 1500, { verification: 'unverified' })
const unverifiedProjection = project([decisionCreate], [unverifiedDecision])
const unverifiedRender = renderFacts(unverifiedProjection.currentFacts, 4000)
check('unverified semantic facts stay queryable but are never auto-injected',
  currentFact(unverifiedProjection, 'project.decision', DECISION_ENTITY)
    ?.verification === 'unverified' &&
  !unverifiedRender.selected.some((fact) => fact.assertionId === 'unverified-decision') &&
  !unverifiedRender.text.includes('do not inject'))
// Cycle 2 removes the blanket llm suppression in favour of the verification gate:
// only an evidence-derived llm fact may render, and an unverified one never does.
const llmUnverifiedRender = renderFacts([{
  ...originalDecision, assertionId: 'llm-unverified', sourceKind: 'llm',
  verification: 'unverified',
}], 4000)
check('unverified llm-sourced facts are never auto-injected even when structurally valid',
  llmUnverifiedRender.selected.length === 0 && llmUnverifiedRender.suppressedCount === 1 &&
  llmUnverifiedRender.text === '')
const llmDerivedRender = renderFacts([{
  ...originalDecision, assertionId: 'llm-derived', sourceKind: 'llm',
  verification: 'derived',
}], 4000)
check('evidence-backed derived llm facts are injectable after the project source contract change',
  llmDerivedRender.selected.length === 1 && llmDerivedRender.suppressedCount === 0 &&
  llmDerivedRender.text === '项目决策：use SQLite')

const malformedFacts = [
  { predicate: 'project.decision', subjectDisplay: 'project', value: null,
    status: 'active', verification: 'user-confirmed' },
  { predicate: 'file.sha256', subjectDisplay: A, value: 'UPPER',
    status: 'active', verification: 'observed' },
  { predicate: 'no.such.predicate', subjectDisplay: 'x', value: 1,
    status: 'active', verification: 'observed' },
  { predicate: 'file.exists', subjectDisplay: A, value: true,
    status: 'active', verification: 'unverified' },
]
let robustRender = null
try {
  robustRender = renderFacts(malformedFacts, 4000)
} catch {
  robustRender = null
}
check('renderer never throws for invalid values, unknown predicates, or unverified facts',
  robustRender !== null && robustRender.selected.length === 0 &&
  robustRender.invalidCount === 3 && robustRender.suppressedCount === 1 &&
  robustRender.text === '')

const perfObservations = []
for (let index = 0; index < 1000; index++) {
  const subject = `c:/perf/f${index % 100}.txt`
  const isRead = index % 10 === 9
  perfObservations.push({
    eventKey: `perf-${index}`, scope: 'workspace:perf', sid: 'perf', seq: index + 1,
    validAt: 1000 + index, recordedAt: 1000 + index,
    op: isRead ? 'read' : 'write', outcome: 'success',
    subjectEntityId: subject, targetEntityId: null,
    value: isRead ? { size: index } : { size: index, mtime: index, sha256: HASH_A },
    rawRef: null, rawPayload: { index },
    source: { kind: 'observation', authority: 'host' },
  })
}
const perfStarted = performance.now()
const perfProjection = projectLedger({
  observations: perfObservations, assertions: [], reducerVersion: 'r1',
})
const perfMilliseconds = performance.now() - perfStarted
check('1000 pure observations project within the 3s performance budget',
  perfMilliseconds < 3000 && perfProjection.currentFacts.length > 0 &&
  perfProjection.observationPlacements.length === 1000,
  `${perfMilliseconds.toFixed(0)}ms`)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
