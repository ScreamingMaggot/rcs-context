import { createHash } from 'node:crypto'

function encodeCanonical(value, ancestors) {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'))
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
      return Object.is(value, -0) ? '0' : JSON.stringify(value)
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonical JSON rejects ${typeof value}`)
    case 'object':
      break
    default:
      throw new TypeError('canonical JSON rejects unknown value type')
  }

  if (ancestors.has(value)) throw new TypeError('canonical JSON rejects cyclic objects')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => encodeCanonical(item, ancestors)).join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON accepts only plain objects and arrays')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('canonical JSON rejects symbol keys')
    }

    const keys = Object.keys(value)
    if (keys.length === 1 && keys[0] === '$set') {
      if (!Array.isArray(value.$set)) throw new TypeError('canonical set wrapper requires an array')
      const elements = Array.from(value.$set, (item) => encodeCanonical(item, ancestors)).sort()
      return `{"$set":[${elements.join(',')}]}`
    }

    const entries = keys.map((key) => [key.normalize('NFC'), value[key]])
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    for (let index = 1; index < entries.length; index++) {
      if (entries[index - 1][0] === entries[index][0]) {
        throw new TypeError('canonical JSON rejects key collisions after NFC normalization')
      }
    }
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${encodeCanonical(item, ancestors)}`).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalJson(value) {
  return encodeCanonical(value, new Set())
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

const fileContract = {
  allowedSources: ['observation', 'probe'],
  cardinality: 'single',
  mutable: true,
  entityBound: true,
  invalidationRule: 'observation-or-entity-generation',
  conflictRule: 'causal-order',
  injectable: true,
  // Deterministic facts keep their historical observation/probe ordering. Their
  // conflict rule is causal order, so this list is documentation of the static
  // rank rather than an input to a value conflict.
  sourceAuthorityOrder: ['observation', 'probe'],
}

const projectContract = {
  // `llm` is the only non-user source a project fact may carry, and only through
  // the proposal engine: deterministic quote validation derives the value from an
  // archived user message and stores `verification: 'derived'`. File and synthetic
  // predicates still refuse it, and rendering keeps refusing non-injectable
  // verification, so a hand-written unverified llm assertion stays queryable but
  // never enters injected context.
  allowedSources: ['user', 'llm'],
  cardinality: 'single',
  mutable: true,
  entityBound: false,
  invalidationRule: 'explicit-correction-or-retraction',
  conflictRule: 'equal-authority-conflict',
  // Static, registry-declared authority. The model can never declare it. A user
  // statement outranks an LLM proposal that merely restates the same archived
  // message, so a lower-authority duplicate can neither conflict out the user fact
  // nor render a second copy of it.
  sourceAuthorityOrder: ['user', 'llm'],
  injectable: true,
  valueSchema: {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string', minLength: 1, nonBlank: true } },
  },
}

export const ASSERTION_OPERATIONS = new Set(['assert', 'correct', 'retract'])
export const VERIFICATION_VALUES = new Set([
  'observed', 'user-confirmed', 'derived', 'unverified', 'conflicted',
])
// Only evidence-backed verification may enter automatic shadow injection in Cycle 1.
// `unverified` and `conflicted` stay queryable for explicit audit but never render.
export const INJECTABLE_VERIFICATIONS = new Set(['observed', 'user-confirmed', 'derived'])

// LLM facts may only describe project semantics, and only through the proposal
// engine's exact-quote evidence object. The ledger stores no wall clock or model
// text in that evidence: proposalId/eventKey/start/end/quote/model/schemaVersion are
// the complete, closed set.
export const LLM_PREDICATES = new Set([
  'project.decision', 'project.constraint', 'project.preference',
])
export const LLM_EVIDENCE_FIELDS = new Set([
  'proposalId', 'eventKey', 'start', 'end', 'quote', 'model', 'modelDigest', 'schemaVersion',
])

// Route capability is never a stored flag: enablement is recomputed from the
// evidence counters on every read, so a hand-edited row cannot turn a route on.
// It lives in the core because both the journal and the ledger read gate depend on
// the exact same thresholds, and because the counters themselves are bound to the
// evaluation evidence that produced them.
export const ROUTE_SAMPLE_FLOOR = 20
export const ROUTE_PRECISION_FLOOR = 0.95
export const ROUTE_RECALL_FLOOR = 0.5

export function routeEnabled({ sampleCount, precision, recall, safetyFailures } = {}) {
  return Number.isInteger(sampleCount) && sampleCount >= ROUTE_SAMPLE_FLOOR &&
    typeof precision === 'number' && Number.isFinite(precision) &&
    precision >= ROUTE_PRECISION_FLOOR &&
    typeof recall === 'number' && Number.isFinite(recall) &&
    recall >= ROUTE_RECALL_FLOOR &&
    safetyFailures === 0
}

function hexSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

// A route row is only executable when its stored counters are the exact arithmetic
// result of the evaluation evidence that accompanies it. Nothing here trusts a
// caller-supplied precision/recall pair: `sampleCount` must equal the number of
// positive labels, precision and recall are recomputed from tp/fp/fn, and the
// safety counter must agree with the evidence.
export function routeEvidenceValid(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false
  if (!hexSha256(evidence.corpusSha256) || !hexSha256(evidence.evaluatorSha256)) return false
  if (typeof evidence.modelDigest !== 'string' || evidence.modelDigest.trim() === '') return false
  if (!nonNegativeInteger(evidence.tp) || !nonNegativeInteger(evidence.fp) ||
      !nonNegativeInteger(evidence.fn) || !nonNegativeInteger(evidence.positiveLabels) ||
      !nonNegativeInteger(evidence.safetyFailures)) {
    return false
  }
  if (!Number.isFinite(evidence.measuredAt)) return false
  if (evidence.sampleCount !== undefined && evidence.sampleCount !== evidence.positiveLabels) {
    return false
  }
  if (evidence.tp + evidence.fn !== evidence.positiveLabels) return false
  if (evidence.tp + evidence.fp === 0) return false
  const precision = evidence.tp / (evidence.tp + evidence.fp)
  const recall = evidence.tp / (evidence.tp + evidence.fn)
  if (evidence.precision !== undefined && evidence.precision !== precision) return false
  if (evidence.recall !== recall) return false
  return true
}

export function routeRowValid({
  sampleCount, precision, recall, safetyFailures, evidence, modelDigest,
} = {}) {
  if (typeof modelDigest !== 'string' || modelDigest.trim() === '') return false
  if (!routeEvidenceValid(evidence)) return false
  if (evidence.modelDigest !== modelDigest) return false
  if (sampleCount !== evidence.positiveLabels) return false
  if (safetyFailures !== evidence.safetyFailures) return false
  const derivedPrecision = evidence.tp / (evidence.tp + evidence.fp)
  if (precision !== derivedPrecision || recall !== evidence.recall) return false
  return routeEnabled({ sampleCount, precision, recall, safetyFailures })
}

// Static authority rank from the predicate registry. Lower rank is higher
// authority; an unknown source is lower than every declared source, and a
// predicate with no declared order returns null (no static ordering).
export function sourceAuthorityRank(predicate, sourceKind) {
  const contract = typeof predicate === 'string' ? PREDICATES[predicate] : predicate
  const order = contract?.sourceAuthorityOrder
  if (!Array.isArray(order) || order.length === 0) return null
  const index = order.indexOf(sourceKind)
  return index === -1 ? order.length : index
}

// A project fact is duplicated by a lower-authority claim when the claim's exact
// text either equals or contains the higher-authority text. Containment covers the
// common model behaviour of quoting the whole sentence around an existing
// constraint; both forms add no information and must not render twice.
export function duplicatesHigherAuthorityValue(predicate, incumbent, candidate) {
  const incumbentRank = sourceAuthorityRank(predicate, incumbent?.sourceKind)
  const candidateRank = sourceAuthorityRank(predicate, candidate?.sourceKind)
  if (incumbentRank === null || candidateRank === null) return false
  if (candidateRank <= incumbentRank) return false
  const incumbentText = incumbent?.value?.text
  const candidateText = candidate?.value?.text
  return typeof incumbentText === 'string' && incumbentText !== '' &&
    typeof candidateText === 'string' &&
    (candidateText === incumbentText || candidateText.includes(incumbentText))
}

export function matchesValueSchema(schema, value) {
  if (!schema || typeof schema !== 'object') return false
  switch (schema.type) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) &&
        (schema.minimum === undefined || value >= schema.minimum)
    case 'string':
      if (typeof value !== 'string') return false
      if (schema.minLength !== undefined && value.length < schema.minLength) return false
      if (schema.nonBlank === true && value.trim() === '') return false
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return false
      return true
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) return false
      }
      for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(value, key) && !matchesValueSchema(propertySchema, value[key])) {
          return false
        }
      }
      return true
    }
    default:
      return false
  }
}

export function registryEntry(predicate) {
  return typeof predicate === 'string' && Object.hasOwn(PREDICATES, predicate)
    ? PREDICATES[predicate]
    : null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// A `sourceKind:'llm'` assertion is not a free-form claim: it must reproduce the
// engine's exact-quote provenance or it is refused before archiving. Evidence-less,
// unverified, observed or non-project LLM facts are therefore unrepresentable, not
// merely non-injectable.
function validateLlmAssertion(assertion, errors) {
  if (!LLM_PREDICATES.has(assertion.predicate)) errors.push('llm-predicate-not-allowed')
  if (assertion.sourceAuthority !== 'user-evidence') {
    errors.push('llm-authority-not-user-evidence')
  }
  if (assertion.verification !== 'derived') errors.push('llm-verification-not-derived')

  const evidence = assertion.evidence
  if (!isRecord(evidence)) {
    errors.push('llm-evidence-missing')
    return
  }
  for (const key of Object.keys(evidence)) {
    if (!LLM_EVIDENCE_FIELDS.has(key)) errors.push(`llm-evidence-unknown:${key}`)
  }
  for (const field of ['proposalId', 'eventKey', 'quote', 'model', 'modelDigest', 'schemaVersion']) {
    if (!nonEmptyString(evidence[field])) errors.push(`llm-evidence-invalid:${field}`)
  }
  if (!Number.isInteger(evidence.start) || evidence.start < 0) {
    errors.push('llm-evidence-invalid:start')
  }
  if (!Number.isInteger(evidence.end)) errors.push('llm-evidence-invalid:end')
  if (Number.isInteger(evidence.start) && Number.isInteger(evidence.end)) {
    if (evidence.end <= evidence.start) errors.push('llm-evidence-invalid:span')
    else if (nonEmptyString(evidence.quote) &&
        evidence.end - evidence.start !== evidence.quote.length) {
      errors.push('llm-evidence-span-mismatch')
    }
  }
  // A retraction carries no value; its quote is only the retraction evidence. Every
  // value-bearing LLM fact must quote exactly the text it asserts.
  if (assertion.op !== 'retract' &&
      (!isRecord(assertion.value) || assertion.value.text !== evidence.quote)) {
    errors.push('llm-evidence-quote-mismatch')
  }
}

export function validateAssertionInput(assertion) {
  const errors = []
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
    return { valid: false, errors: ['not-an-object'] }
  }
  for (const field of ['assertionId', 'scope', 'subjectEntityId']) {
    if (!nonEmptyString(assertion[field])) errors.push(`missing-field:${field}`)
  }
  if (!nonEmptyString(assertion.sid)) errors.push('missing-field:sid')
  if (!Number.isInteger(assertion.seq)) errors.push('invalid-field:seq')
  if (!Number.isFinite(assertion.validAt)) errors.push('invalid-field:validAt')
  if (!Number.isFinite(assertion.recordedAt)) errors.push('invalid-field:recordedAt')
  if (assertion.qualifiers != null &&
      (typeof assertion.qualifiers !== 'object' || Array.isArray(assertion.qualifiers))) {
    errors.push('invalid-field:qualifiers')
  }

  const contract = registryEntry(assertion.predicate)
  if (!contract) errors.push('unknown-predicate')
  if (!ASSERTION_OPERATIONS.has(assertion.op)) errors.push('unsupported-operation')
  if (!VERIFICATION_VALUES.has(assertion.verification)) errors.push('invalid-verification')
  if (contract && !contract.allowedSources.includes(assertion.sourceKind)) {
    errors.push('source-not-allowed')
  }
  if (assertion.op === 'assert' && assertion.targetAssertionId != null) {
    errors.push('unexpected-target-assertion')
  }
  if ((assertion.op === 'correct' || assertion.op === 'retract') &&
      !nonEmptyString(assertion.targetAssertionId)) {
    errors.push('missing-target-assertion')
  }
  if (contract && assertion.op !== 'retract' &&
      !matchesValueSchema(contract.valueSchema, assertion.value)) {
    errors.push('value-schema-invalid')
  }
  if (assertion.sourceKind === 'llm') validateLlmAssertion(assertion, errors)
  return { valid: errors.length === 0, errors }
}

export const PREDICATES = {
  'file.exists': {
    ...fileContract,
    valueSchema: { type: 'boolean' },
    // Auto-injection renders only positive existence. `exists=false` remains a
    // legitimate current fact for explicit audit, but absence markers are not
    // injected into the model context: a renderer returning null contributes no line.
    renderer: (fact) => (fact.value === true ? `文件路径为 ${fact.subjectDisplay}，当前存在` : null),
  },
  'file.size': {
    ...fileContract,
    valueSchema: { type: 'number', minimum: 0 },
    renderer: (fact) => `文件 ${fact.subjectDisplay} 的大小为 ${fact.value} 字节`,
  },
  'file.mtime': {
    ...fileContract,
    valueSchema: { type: 'number', minimum: 0 },
    renderer: (fact) => `文件 ${fact.subjectDisplay} 的修改时间为 ${fact.value}`,
  },
  'file.sha256': {
    ...fileContract,
    valueSchema: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    renderer: (fact) => `文件 ${fact.subjectDisplay} 的 SHA-256 为 ${fact.value}`,
  },
  'file.lines': {
    ...fileContract,
    injectable: false,
    invalidationRule: 'disabled-pending-encoding-and-newline-contract',
    valueSchema: { type: 'number', minimum: 0 },
    renderer: (fact) => `文件 ${fact.subjectDisplay} 的行数为 ${fact.value}`,
  },
  'project.decision': {
    ...projectContract,
    renderer: (fact) => `项目决策：${fact.value.text}`,
  },
  'project.constraint': {
    ...projectContract,
    renderer: (fact) => `项目约束：${fact.value.text}`,
  },
  'project.preference': {
    ...projectContract,
    renderer: (fact) => `项目偏好：${fact.value.text}`,
  },
  'synthetic.set': {
    allowedSources: [],
    cardinality: 'multi',
    mutable: true,
    entityBound: false,
    invalidationRule: 'test-only',
    conflictRule: 'test-only',
    injectable: false,
    valueSchema: { type: 'object' },
    renderer: (fact) => `测试集合元素：${canonicalJson(fact.value)}`,
  },
}

export function factKey(fact) {
  const predicate = registryEntry(fact.predicate)
  if (!predicate) throw new TypeError(`unknown predicate: ${fact.predicate}`)

  const qualifiers = fact.qualifiers === undefined ? null : fact.qualifiers
  const parts = [fact.scope, fact.subjectEntityId, fact.generation, fact.predicate, canonicalJson(qualifiers)]
  if (predicate.cardinality === 'multi') parts.push(canonicalJson(fact.valueKey))
  return parts.join('/')
}

export function renderFacts(facts, budget) {
  const lines = []
  const selected = []
  let text = ''
  let overflowCount = 0
  let suppressedCount = 0
  let invalidCount = 0

  for (const fact of facts) {
    const predicate = registryEntry(fact.predicate)
    // Unknown predicates and schema-invalid values are reported, never thrown: a
    // corrupt archived fact must not take down the whole rendering path.
    if (!predicate) {
      invalidCount++
      continue
    }
    if (!predicate.injectable || (fact.status !== undefined && fact.status !== 'active')) {
      overflowCount++
      continue
    }
    // Evidence-backed LLM facts (`derived`) may render after the project source
    // contract was extended; an unverified or conflicted value still never does.
    // Legacy snapshots remain suppressed regardless of their verification claim.
    if (fact.conflict != null || fact.sourceKind === 'legacy' ||
        (fact.verification !== undefined && !INJECTABLE_VERIFICATIONS.has(fact.verification))) {
      suppressedCount++
      continue
    }
    if (!matchesValueSchema(predicate.valueSchema, fact.value)) {
      invalidCount++
      continue
    }

    let line
    try {
      line = predicate.renderer(fact)
    } catch {
      invalidCount++
      continue
    }
    // A null line means the predicate is a legitimate current fact that must not be
    // auto-injected (for example `file.exists=false`). It is suppressed, not overflow.
    if (line === null || line === undefined) {
      suppressedCount++
      continue
    }

    const candidate = lines.length === 0 ? line : `${text}\n${line}`
    if (candidate.length <= budget) {
      lines.push(line)
      selected.push(fact)
      text = candidate
    } else {
      overflowCount++
    }
  }

  return { text, selected, overflowCount, suppressedCount, invalidCount }
}

const OBSERVATION_FIELDS = {
  exists: 'file.exists',
  size: 'file.size',
  mtime: 'file.mtime',
  sha256: 'file.sha256',
}
const WRITE_INVALIDATED_FIELDS = ['size', 'mtime', 'sha256']

function lexicalCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function causalCompare(a, b) {
  return (a[0] - b[0]) || lexicalCompare(a[1], b[1]) || (a[2] - b[2]) || lexicalCompare(a[3], b[3])
}

function observationKind(observation) {
  if (observation.op !== 'probe') return observation.op
  return observation.value?.exists === false ? 'probe-missing' : 'probe-present'
}

function observationSource(observation) {
  return {
    sourceKind: observation.source?.kind ?? observation.sourceKind ??
      (observation.op === 'probe' ? 'probe' : 'observation'),
    sourceAuthority: observation.source?.authority ?? observation.sourceAuthority ?? null,
  }
}

export function projectLedger({ observations, assertions, reducerVersion }) {
  const entityStates = new Map()
  const observationPlacements = []
  const assertionPlacements = []
  const assertionPlacementById = new Map()
  const assertionById = new Map()
  const factVersions = []
  const pendingFacts = []
  const dead = []

  // Archived input is untrusted: a single malformed assertion must be dead-lettered
  // with a stable reason, never thrown, and never allowed to poison an otherwise valid
  // scope. Structural validation runs before any placement or causal ordering.
  const assertionInputs = Array.isArray(assertions) ? assertions : []
  const validAssertions = []
  for (let index = 0; index < assertionInputs.length; index++) {
    const assertion = assertionInputs[index]
    const validation = validateAssertionInput(assertion)
    if (!validation.valid) {
      dead.push({
        assertionId: nonEmptyString(assertion?.assertionId)
          ? assertion.assertionId
          : `assertion:index:${index}`,
        reason: validation.errors[0],
        errors: validation.errors,
      })
      continue
    }
    validAssertions.push(assertion)
  }

  const terminalCounts = new Map()
  for (const assertion of validAssertions) {
    if (assertion.op !== 'correct' && assertion.op !== 'retract') continue
    terminalCounts.set(assertion.targetAssertionId, (terminalCounts.get(assertion.targetAssertionId) ?? 0) + 1)
  }
  const duplicateTerminalIds = new Set(validAssertions.filter((assertion) =>
    (assertion.op === 'correct' || assertion.op === 'retract') &&
    terminalCounts.get(assertion.targetAssertionId) > 1).map((assertion) => assertion.assertionId))
  for (const assertion of validAssertions) {
    if (!duplicateTerminalIds.has(assertion.assertionId)) continue
    dead.push({
      assertionId: assertion.assertionId,
      targetAssertionId: assertion.targetAssertionId,
      reason: 'duplicate-terminal-operation',
    })
  }

  const changes = [
    ...observations.map((observation) => ({
      kind: 'observation', value: observation,
      causalOrder: [observation.validAt, observation.sid, observation.seq, `observation:${observation.eventKey}`],
    })),
    ...validAssertions.map((assertion) => ({
      kind: 'assertion', value: assertion,
      causalOrder: [assertion.validAt, assertion.sid, assertion.seq, `assertion:${assertion.assertionId}`],
    })),
  ].sort((a, b) => causalCompare(a.causalOrder, b.causalOrder))

  function entityState(scope, entityId) {
    const key = `${scope}\u0000${entityId}`
    if (!entityStates.has(key)) {
      entityStates.set(key, { scope, entityId, generations: [], lastValidAt: null, lastRecordedAt: null })
    }
    return entityStates.get(key)
  }

  function currentGeneration(state) {
    return state.generations[state.generations.length - 1] ?? null
  }

  function openGeneration(state) {
    return state.generations.find((generation) => generation.closedBy === null) ?? null
  }

  function createGeneration(state, openedBy, validAt) {
    const previous = currentGeneration(state)
    if (previous) previous.replacedAt = validAt
    const generation = {
      number: (previous?.number ?? 0) + 1,
      openedBy,
      closedBy: null,
      presence: true,
      replacedAt: null,
    }
    state.generations.push(generation)
    return generation
  }

  function closeGeneration(state, causalOrder) {
    let generation = openGeneration(state)
    if (!generation && state.generations.length === 0) {
      generation = createGeneration(state, causalOrder, causalOrder[0])
    }
    if (!generation) return currentGeneration(state)
    generation.closedBy = causalOrder
    generation.presence = false
    return generation
  }

  function placeObservation(observation, role, entityId, generation, reason = null) {
    observationPlacements.push({
      eventKey: observation.eventKey,
      scope: observation.scope,
      entityId,
      role,
      generation: generation?.number ?? null,
      unplaced: generation === null,
      reason,
      causalOrder: [observation.validAt, observation.sid, observation.seq, `observation:${observation.eventKey}`],
    })
  }

  function placeAssertion(assertionId, observation, generation, reason = null) {
    const placement = {
      assertionId,
      scope: observation.scope,
      entityId: observation.subjectEntityId,
      generation: generation?.number ?? null,
      unplaced: generation === null,
      reason,
      causalOrder: [observation.validAt, observation.sid, observation.seq, assertionId],
    }
    assertionPlacements.push(placement)
    assertionPlacementById.set(assertionId, placement)
  }

  function deriveAssertion(observation, role, generation, predicate, op, value) {
    const assertionId = `observation:${observation.eventKey}:${role}:${predicate}:${op}`
    const subjectEntityId = role === 'target' ? observation.targetEntityId : observation.subjectEntityId
    const source = observationSource(observation)
    return {
      fact: {
        scope: observation.scope,
        subjectEntityId,
        subjectDisplay: subjectEntityId,
        generation: generation.number,
        predicate,
        qualifiers: null,
        value: op === 'invalidate' ? null : value,
        assertionId,
        evidence: { eventKey: observation.eventKey, rawRef: observation.rawRef ?? null },
        causalOrder: [observation.validAt, observation.sid, observation.seq, assertionId],
        validFrom: observation.validAt,
        validTo: null,
        recordedAt: observation.recordedAt,
        retiredAt: null,
        status: op === 'invalidate' ? 'invalidated' : 'active',
        verification: 'observed',
        conflict: null,
        op,
        sid: observation.sid,
        seq: observation.seq,
        reducerVersion,
        ...source,
      },
      generation,
      subjectEntityId,
    }
  }

  function derivedForObservation(observation, role, generation) {
    const kind = observationKind(observation)
    const value = observation.value ?? {}
    const derived = []
    const assert = (predicate, factValue) => {
      // Observation adapters should never mint a value that contradicts the registry
      // schema. If archived input does, the measurement is unknown, not a poison fact.
      const contract = registryEntry(predicate)
      if (!contract || !matchesValueSchema(contract.valueSchema, factValue)) return
      derived.push(deriveAssertion(observation, role, generation, predicate, 'assert', factValue))
    }
    const invalidate = (predicate) => {
      derived.push(deriveAssertion(observation, role, generation, predicate, 'invalidate', null))
    }

    if (kind === 'scope_init') return derived
    if (kind === 'create' || kind === 'write' || kind === 'probe-present') {
      assert('file.exists', true)
      if (kind === 'create' || kind === 'write') {
        for (const field of WRITE_INVALIDATED_FIELDS) {
          if (!Object.hasOwn(value, field)) invalidate(OBSERVATION_FIELDS[field])
        }
      }
      for (const field of WRITE_INVALIDATED_FIELDS) {
        if (Object.hasOwn(value, field)) assert(OBSERVATION_FIELDS[field], value[field])
      }
    } else if (kind === 'read' || kind === 'stat') {
      for (const field of Object.keys(OBSERVATION_FIELDS)) {
        if (Object.hasOwn(value, field)) assert(OBSERVATION_FIELDS[field], value[field])
      }
    } else if (kind === 'delete' || kind === 'probe-missing' || kind === 'rename-source') {
      assert('file.exists', false)
      for (const field of WRITE_INVALIDATED_FIELDS) invalidate(OBSERVATION_FIELDS[field])
    } else if (kind === 'rename-target') {
      assert('file.exists', true)
    }

    return derived.sort((a, b) => causalCompare(a.fact.causalOrder, b.fact.causalOrder))
  }

  function applyDerived(observation, role, generation, kindOverride = null) {
    const effectiveObservation = kindOverride === null ? observation : { ...observation, op: kindOverride }
    const derived = derivedForObservation(effectiveObservation, role, generation)
    for (const item of derived) {
      pendingFacts.push(item)
      assertionById.set(item.fact.assertionId, item.fact)
      placeAssertion(item.fact.assertionId, {
        ...observation,
        subjectEntityId: item.subjectEntityId,
      }, generation)
    }
  }

  function processObservation(observation) {
    const successful = observation.outcome === 'success' || observation.outcome === 'observed'
    const state = entityState(observation.scope, observation.subjectEntityId)
    if (!successful) {
      const role = observation.op === 'rename' ? 'source' : 'subject'
      placeObservation(observation, role, observation.subjectEntityId, null, `outcome-${observation.outcome}`)
      if (observation.op === 'rename' && observation.targetEntityId != null) {
        placeObservation(observation, 'target', observation.targetEntityId, null, `outcome-${observation.outcome}`)
      }
      return
    }

    const kind = observationKind(observation)
    if (kind === 'scope_init') {
      const generation = openGeneration(state) ?? createGeneration(state,
        [observation.validAt, observation.sid, observation.seq, `observation:${observation.eventKey}`], observation.validAt)
      state.lastValidAt = observation.validAt
      state.lastRecordedAt = observation.recordedAt
      placeObservation(observation, 'subject', observation.subjectEntityId, generation)
      applyDerived(observation, 'subject', generation)
      return
    }

    // A success report that itself says the entity is absent is contradictory evidence.
    // It degrades to unknown instead of minting exists=true or asserting stale metadata.
    // delete/probe-missing are the legitimate absence transitions and bypass this guard.
    if ((kind === 'create' || kind === 'write' || kind === 'probe-present' ||
        kind === 'read' || kind === 'stat') && observation.value?.exists === false) {
      placeObservation(observation, 'subject', observation.subjectEntityId, null,
        'reported-exists-false')
      return
    }

    if (kind === 'create' || kind === 'write' || kind === 'probe-present') {
      const generation = openGeneration(state) ?? createGeneration(state,
        [observation.validAt, observation.sid, observation.seq, `observation:${observation.eventKey}`], observation.validAt)
      state.lastValidAt = observation.validAt
      state.lastRecordedAt = observation.recordedAt
      placeObservation(observation, 'subject', observation.subjectEntityId, generation)
      applyDerived(observation, 'subject', generation)
      return
    }

    if (kind === 'read' || kind === 'stat') {
      const generation = openGeneration(state)
      placeObservation(observation, 'subject', observation.subjectEntityId, generation,
        generation ? null : 'no-matching-generation')
      if (generation) {
        state.lastValidAt = observation.validAt
        state.lastRecordedAt = observation.recordedAt
        applyDerived(observation, 'subject', generation)
      }
      return
    }

    if (kind === 'delete' || kind === 'probe-missing') {
      const generation = closeGeneration(state,
        [observation.validAt, observation.sid, observation.seq, `observation:${observation.eventKey}`])
      state.lastValidAt = observation.validAt
      state.lastRecordedAt = observation.recordedAt
      placeObservation(observation, 'subject', observation.subjectEntityId, generation)
      applyDerived(observation, 'subject', generation)
      return
    }

    if (kind === 'rename') {
      const targetState = entityState(observation.scope, observation.targetEntityId)
      const sourceOpen = openGeneration(state)
      const targetOpen = openGeneration(targetState)
      if (observation.subjectEntityId === observation.targetEntityId && sourceOpen) {
        placeObservation(observation, 'source', observation.subjectEntityId, sourceOpen)
        placeObservation(observation, 'target', observation.targetEntityId, sourceOpen)
        return
      }
      if (!sourceOpen || targetOpen) {
        const reason = !sourceOpen ? 'source-not-open' : 'target-exists'
        placeObservation(observation, 'source', observation.subjectEntityId, null, reason)
        placeObservation(observation, 'target', observation.targetEntityId, null, reason)
        return
      }
      const causalOrder = [observation.validAt, observation.sid, observation.seq, `observation:${observation.eventKey}`]
      const sourceGeneration = closeGeneration(state, causalOrder)
      const targetGeneration = createGeneration(targetState, causalOrder, observation.validAt)
      state.lastValidAt = observation.validAt
      state.lastRecordedAt = observation.recordedAt
      targetState.lastValidAt = observation.validAt
      targetState.lastRecordedAt = observation.recordedAt
      placeObservation(observation, 'source', observation.subjectEntityId, sourceGeneration)
      placeObservation(observation, 'target', observation.targetEntityId, targetGeneration)
      applyDerived(observation, 'source', sourceGeneration, 'rename-source')
      applyDerived(observation, 'target', targetGeneration, 'rename-target')
      return
    }

    placeObservation(observation, 'subject', observation.subjectEntityId, null, 'unsupported-operation')
  }

  function processAssertion(assertion) {
    let generation = null
    let reason = null
    if (assertion.op === 'correct' || assertion.op === 'retract') {
      const target = assertionPlacementById.get(assertion.targetAssertionId)
      if (target && !target.unplaced) generation = { number: target.generation }
      else reason = 'target-unplaced'
    } else {
      const state = entityStates.get(`${assertion.scope}\u0000${assertion.subjectEntityId}`)
      generation = state ? openGeneration(state) : null
      if (!generation) reason = 'no-matching-generation'
    }
    const placement = {
      assertionId: assertion.assertionId,
      scope: assertion.scope,
      entityId: assertion.subjectEntityId,
      generation: generation?.number ?? null,
      unplaced: generation === null,
      reason,
      causalOrder: [assertion.validAt, assertion.sid, assertion.seq, `assertion:${assertion.assertionId}`],
    }
    assertionPlacements.push(placement)
    assertionPlacementById.set(assertion.assertionId, placement)
    if (!duplicateTerminalIds.has(assertion.assertionId) &&
        (generation || assertion.op === 'correct' || assertion.op === 'retract')) {
      const fact = {
        scope: assertion.scope,
        subjectEntityId: assertion.subjectEntityId,
        subjectDisplay: assertion.subjectEntityId,
        generation: generation?.number ?? null,
        predicate: assertion.predicate,
        qualifiers: assertion.qualifiers ?? null,
        value: assertion.op === 'retract' || assertion.op === 'invalidate' ? null : assertion.value,
        assertionId: assertion.assertionId,
        evidence: assertion.evidence ?? null,
        causalOrder: [assertion.validAt, assertion.sid, assertion.seq, `assertion:${assertion.assertionId}`],
        validFrom: assertion.validAt,
        validTo: null,
        recordedAt: assertion.recordedAt,
        retiredAt: null,
        status: assertion.op === 'invalidate' ? 'invalidated' : 'active',
        verification: assertion.verification,
        conflict: null,
        op: assertion.op,
        targetAssertionId: assertion.targetAssertionId ?? null,
        sid: assertion.sid,
        seq: assertion.seq,
        reducerVersion,
        sourceKind: assertion.sourceKind,
        sourceAuthority: assertion.sourceAuthority ?? null,
      }
      pendingFacts.push({ fact, generation, subjectEntityId: assertion.subjectEntityId })
      assertionById.set(assertion.assertionId, fact)
    }
  }

  const deferredAssertions = []
  for (const change of changes) {
    if (change.kind === 'observation') processObservation(change.value)
    else if ((change.value.op === 'correct' || change.value.op === 'retract') &&
        !assertionPlacementById.has(change.value.targetAssertionId)) {
      deferredAssertions.push(change.value)
    } else processAssertion(change.value)
  }
  while (deferredAssertions.length) {
    const waiting = deferredAssertions.splice(0)
    let placedTarget = false
    for (const assertion of waiting) {
      if (assertionPlacementById.has(assertion.targetAssertionId)) {
        processAssertion(assertion)
        placedTarget = true
      } else deferredAssertions.push(assertion)
    }
    if (!placedTarget) {
      for (const assertion of deferredAssertions.splice(0)) processAssertion(assertion)
    }
  }

  function generationFor(fact) {
    const state = entityStates.get(`${fact.scope}\u0000${fact.subjectEntityId}`)
    return state?.generations.find((generation) => generation.number === fact.generation) ?? null
  }

  function sameRowValue(a, b) {
    return canonicalJson(a.value) === canonicalJson(b.value) &&
      canonicalJson(a.conflict) === canonicalJson(b.conflict)
  }

  function systemRowKey(fact) {
    return `${fact.factKey}\u0000${fact.assertionId}\u0000${fact.validFrom}`
  }

  // Per-fact key cache: canonicalizing qualifiers once per fact removes the repeated
  // full-row canonicalization that dominated the old whole-prefix snapshot loop.
  const factKeyCache = new WeakMap()
  function cachedFactKey(fact) {
    let key = factKeyCache.get(fact)
    if (key === undefined) {
      key = factKey(fact)
      factKeyCache.set(fact, key)
    }
    return key
  }

  // System-version rows are immutable except for retiredAt (excluded from the
  // signature), so their canonical signature is safe to cache across events.
  const systemSignatureCache = new WeakMap()
  function rowSignature(row) {
    return canonicalJson({ ...row, recordedAt: null, retiredAt: null })
  }
  function cachedRowSignature(row) {
    let signature = systemSignatureCache.get(row)
    if (signature === undefined) {
      signature = rowSignature(row)
      systemSignatureCache.set(row, signature)
    }
    return signature
  }

  function removeAliveClaim(group, assertionId) {
    const index = group.alive.findIndex((fact) => fact.assertionId === assertionId)
    if (index !== -1) group.alive.splice(index, 1)
  }

  function applyClaimState(group, fact) {
    if (fact.op === 'invalidate') {
      group.latestInvalidation = fact.causalOrder
      group.alive.length = 0
      return
    }
    if (fact.op === 'correct' || fact.op === 'retract') {
      group.terminated.add(fact.targetAssertionId)
      removeAliveClaim(group, fact.targetAssertionId)
    }
    if ((fact.op === 'assert' || fact.op === 'correct') &&
        !group.terminated.has(fact.assertionId)) {
      group.alive.push(fact)
    }
  }

  function rebuildClaimState(group) {
    group.alive = []
    group.terminated = new Set()
    group.latestInvalidation = null
    for (const fact of group.items) applyClaimState(group, fact)
  }

  function claimsForAlive(group, contract) {
    if (contract.conflictRule === 'causal-order') {
      const last = group.alive[group.alive.length - 1]
      return last ? [last] : []
    }
    if (contract.conflictRule === 'equal-authority-conflict' && group.alive.length) {
      return conflictClaimsForAlive(group.alive, contract)
    }
    return group.alive.slice()
  }

  // Authority-aware conflict grouping for semantic predicates. Only claims at the
  // highest static authority present can become current. A lower-authority claim is
  // carried as `shadowed`, rendered as conflicted for audit, and can never force the
  // higher fact into conflict or duplicate its text. Among equal-authority claims the
  // original rule still applies: distinct values conflict instead of "newest wins".
  function conflictClaimsForAlive(alive, contract) {
    const order = Array.isArray(contract.sourceAuthorityOrder)
      ? contract.sourceAuthorityOrder
      : null
    const latestByValue = (claims) => {
      const latest = new Map()
      for (const fact of claims) latest.set(canonicalJson(fact.value), fact)
      return [...latest.values()]
    }
    if (!order || order.length === 0) return latestByValue(alive)

    const rankOf = (fact) => {
      const index = order.indexOf(fact.sourceKind)
      return index === -1 ? order.length : index
    }
    let best = Infinity
    for (const fact of alive) best = Math.min(best, rankOf(fact))
    const top = alive.filter((fact) => rankOf(fact) === best)
    const lower = alive.filter((fact) => rankOf(fact) > best)
    const topClaims = latestByValue(top)
    const higherAuthorityIds = topClaims.map((fact) => fact.assertionId).sort(lexicalCompare)
    const claims = [...topClaims]
    for (const fact of lower) {
      claims.push({ ...fact, shadowed: true, higherAuthorityIds })
    }
    return claims
  }

  function clampRow(row, nextValidAt) {
    row.validTo = nextValidAt
    const generation = generationFor(row)
    const closedAt = generation?.closedBy?.[0] ?? null
    if (generation?.replacedAt !== null && generation?.replacedAt !== undefined &&
        (row.validTo === null || generation.replacedAt < row.validTo)) {
      row.validTo = generation.replacedAt
    }
    if (registryEntry(row.predicate)?.entityBound && closedAt !== null && row.validFrom < closedAt &&
        (row.validTo === null || closedAt < row.validTo)) {
      row.validTo = closedAt
    }
    return row
  }

  function rowsForCurrent(key, claims, current) {
    const primary = claims.filter((fact) => fact.shadowed !== true)
    const conflicted = primary.length > 1
    const conflictIds = conflicted
      ? primary.map((fact) => fact.assertionId).sort(lexicalCompare)
      : null
    const nextRows = claims.map((fact) => {
      const { shadowed, higherAuthorityIds, ...base } = fact
      if (shadowed === true) {
        // A lower-authority claim is preserved for audit but is never active and
        // never renders. Its conflict record points at the authority that shadows it.
        const assertionIds = [...new Set([
          ...(Array.isArray(higherAuthorityIds) ? higherAuthorityIds : []),
          fact.assertionId,
        ])].sort(lexicalCompare)
        return {
          ...base,
          factKey: key,
          validFrom: current.validFrom,
          validTo: null,
          status: 'conflicted',
          conflict: { assertionIds, reason: 'lower-authority-shadowed' },
        }
      }
      return {
        ...base,
        factKey: key,
        validFrom: current.validFrom,
        validTo: null,
        status: conflicted ? 'conflicted' : 'active',
        conflict: conflicted
          ? { assertionIds: conflictIds, reason: 'equal-authority-overlap' }
          : null,
      }
    })
    if (current.op === 'invalidate' && nextRows.length === 0) {
      nextRows.push({ ...current, factKey: key, validFrom: current.validFrom, validTo: null })
    }
    return nextRows
  }

  function mergeOrPush(rows, row) {
    const previous = rows[rows.length - 1]
    if (previous && previous.validTo === row.validFrom && previous.assertionId === row.assertionId &&
        previous.factKey === row.factKey && previous.status === row.status &&
        sameRowValue(previous, row)) {
      previous.validTo = row.validTo
    } else {
      rows.push(row)
    }
  }

  // Bounded fallback used when a late fact lands in the middle of a group's causal
  // order. It mirrors the original whole-prefix semantics for that group only.
  function computeGroupRows(key, items) {
    const rows = []
    for (let index = 0; index < items.length; index++) {
      const terminated = new Set()
      let latestInvalidation = null
      for (let prior = 0; prior <= index; prior++) {
        const fact = items[prior]
        if (fact.op === 'correct' || fact.op === 'retract') terminated.add(fact.targetAssertionId)
        if (fact.op === 'invalidate') latestInvalidation = fact.causalOrder
      }

      let claims = items.slice(0, index + 1).filter((fact) =>
        (fact.op === 'assert' || fact.op === 'correct') && !terminated.has(fact.assertionId) &&
        (!latestInvalidation || causalCompare(fact.causalOrder, latestInvalidation) > 0))
      const contract = registryEntry(items[index].predicate)
      if (!contract) continue
      if (contract.conflictRule === 'causal-order') {
        claims = claims.length ? [claims[claims.length - 1]] : []
      } else if (contract.conflictRule === 'equal-authority-conflict' && claims.length) {
        claims = conflictClaimsForAlive(claims, contract)
      }

      const current = items[index]
      const nextRows = rowsForCurrent(key, claims, current)
      const nextValidAt = items[index + 1]?.validFrom ?? null
      for (const row of nextRows) mergeOrPush(rows, clampRow(row, nextValidAt))
    }
    for (const row of rows) {
      if (row.status === 'active' && row.validTo !== null) row.status = 'superseded'
    }
    return rows
  }

  // Monotonic append fast path: only the current group's final interval is closed,
  // new claims are derived from maintained alive-claim state, and one interval is
  // emitted. Total work for a group becomes linear instead of quadratic.
  function appendGroupIncremental(key, group, fact) {
    for (const row of group.rows) {
      if (row.validTo === null) clampRow(row, fact.validFrom)
    }
    applyClaimState(group, fact)
    const claims = claimsForAlive(group, registryEntry(fact.predicate))
    for (const row of rowsForCurrent(key, claims, fact)) {
      mergeOrPush(group.rows, clampRow(row, null))
    }
    for (const row of group.rows) {
      if (row.status === 'active' && row.validTo !== null) row.status = 'superseded'
    }
    return group.rows
  }

  function updateGroupRows(key, group, fact) {
    const last = group.items[group.items.length - 1]
    if (!last || causalCompare(last.causalOrder, fact.causalOrder) <= 0) {
      group.items.push(fact)
      return appendGroupIncremental(key, group, fact)
    }
    let low = 0
    let high = group.items.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (causalCompare(group.items[middle].causalOrder, fact.causalOrder) <= 0) low = middle + 1
      else high = middle
    }
    group.items.splice(low, 0, fact)
    group.rows = computeGroupRows(key, group.items)
    rebuildClaimState(group)
    return group.rows
  }

  const systemFacts = pendingFacts.slice().sort((a, b) =>
    (a.fact.recordedAt - b.fact.recordedAt) || lexicalCompare(a.fact.sourceKind, b.fact.sourceKind) ||
    lexicalCompare(a.fact.assertionId, b.fact.assertionId))
  const applied = []
  const appliedById = new Map()
  const terminatedTargets = new Set()
  const groupSnapshots = new Map()
  const systemRowsByGroup = new Map()

  for (const item of systemFacts) {
    const fact = item.fact
    if (fact.op === 'correct' || fact.op === 'retract') {
      const target = appliedById.get(fact.targetAssertionId)
      let reason = null
      if (!target) reason = 'target-unresolved'
      else if (terminatedTargets.has(target.assertionId)) reason = 'duplicate-terminal-operation'
      else if (target.scope !== fact.scope || target.subjectEntityId !== fact.subjectEntityId ||
          target.predicate !== fact.predicate ||
          canonicalJson(target.qualifiers) !== canonicalJson(fact.qualifiers)) reason = 'target-contract-mismatch'
      else if (fact.validFrom < target.validFrom) reason = 'terminal-valid-at-before-target'
      if (reason) {
        dead.push({ assertionId: fact.assertionId, targetAssertionId: fact.targetAssertionId, reason })
        continue
      }
      terminatedTargets.add(target.assertionId)
    }

    applied.push(item)
    appliedById.set(fact.assertionId, fact)

    const key = cachedFactKey(fact)
    let group = groupSnapshots.get(key)
    if (!group) {
      group = {
        key, items: [], rows: [], alive: [], terminated: new Set(), latestInvalidation: null,
      }
      groupSnapshots.set(key, group)
    }
    const nextSnapshot = updateGroupRows(key, group, fact)
    const previousRows = systemRowsByGroup.get(key) ?? []
    const previousByKey = new Map(previousRows.map((row) => [systemRowKey(row), row]))
    const nextByKey = new Map(nextSnapshot.map((row) => [systemRowKey(row), row]))
    const nextSystemRows = []

    for (const [rowKey, previous] of previousByKey) {
      const nextRow = nextByKey.get(rowKey)
      if (!nextRow || cachedRowSignature(previous) !== rowSignature(nextRow)) {
        previous.retiredAt = fact.recordedAt
      }
    }
    for (const [rowKey, row] of nextByKey) {
      const previous = previousByKey.get(rowKey)
      if (previous && previous.retiredAt === null) {
        nextSystemRows.push(previous)
      } else {
        const version = { ...row, recordedAt: fact.recordedAt, retiredAt: null }
        systemSignatureCache.set(version, rowSignature(version))
        factVersions.push(version)
        nextSystemRows.push(version)
      }
    }
    systemRowsByGroup.set(key, nextSystemRows)
  }

  const systemRows = [...systemRowsByGroup.values()].flat()

  const entities = []
  const currentGenerationKeys = new Set()
  for (const state of entityStates.values()) {
    const generation = currentGeneration(state)
    if (!generation) continue
    entities.push({
      scope: state.scope,
      entityId: state.entityId,
      generation: generation.number,
      presence: generation.presence,
      openedBy: generation.openedBy,
      closedBy: generation.closedBy,
      lastValidAt: state.lastValidAt,
      lastRecordedAt: state.lastRecordedAt,
    })
    currentGenerationKeys.add(`${state.scope}\u0000${state.entityId}\u0000${generation.number}`)
  }

  const currentFacts = systemRows.filter((fact) =>
    currentGenerationKeys.has(`${fact.scope}\u0000${fact.subjectEntityId}\u0000${fact.generation}`) &&
    (fact.op === 'assert' || fact.op === 'correct') &&
    (fact.status === 'active' || fact.status === 'conflicted') &&
    fact.validTo === null && fact.retiredAt === null)

  entities.sort((a, b) => lexicalCompare(a.scope, b.scope) || lexicalCompare(a.entityId, b.entityId))
  factVersions.sort((a, b) => causalCompare(a.causalOrder, b.causalOrder) ||
    (a.recordedAt - b.recordedAt) || lexicalCompare(a.factKey, b.factKey) || (a.validFrom - b.validFrom))
  currentFacts.sort((a, b) => lexicalCompare(a.factKey, b.factKey) || lexicalCompare(a.assertionId, b.assertionId))

  return {
    reducerVersion,
    entities,
    observationPlacements,
    assertionPlacements,
    factVersions,
    currentFacts,
    dead,
  }
}

export function factsAt(projection, { validAt, recordedAt }) {
  return projection.factVersions.filter((fact) =>
    fact.recordedAt <= recordedAt && (fact.retiredAt === null || recordedAt < fact.retiredAt) &&
    fact.validFrom <= validAt && (fact.validTo === null || validAt < fact.validTo) &&
    (fact.status === 'active' || fact.status === 'superseded' || fact.status === 'conflicted'))
    .sort((a, b) => lexicalCompare(a.factKey, b.factKey) || lexicalCompare(a.assertionId, b.assertionId))
}

export function projectionHash(projection) {
  const facts = projection.currentFacts
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
    .sort((a, b) => lexicalCompare(a.fact_key, b.fact_key) || lexicalCompare(a.assertion_id, b.assertion_id))
  return sha256Canonical({ reducer_version: projection.reducerVersion, facts })
}
