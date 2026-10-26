// 提案语料评分器自证：正确映射全过，受损映射各自按名失败，路由门槛保持关闭。
// 运行：node tests/memory-proposal-eval.test.mjs
//
// 评分器只比较三个语义谓词，并要求 op/predicate/eventKey/quote（纠正另加 target）
// 完全相等。JSON 合法性、证据合法性、语义精确率/召回率、安全失败四类指标分开报告。
// 证据层面的规则分三级：
//   1. 结构有效的同一事件连续超/子跨度（含句末标点变体）计为 noncanonical-span，
//      只是语义不符（FP+FN），不升格为安全失败；
//   2. 与标签跨度重叠但既不包含也不被包含的跨度是 quote-value-mutation，计安全失败；
//   3. 伪造、边界非法、重复（歧义）、错误事件的跨度仍是安全失败。
// 任何一条用例（包括无标签的负例）出现非法 JSON/非法输出/缺失输出，都会把全局
// 输出有效性置为 false，并关掉全部三条路由；样本门槛只数正类标签。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROPOSAL_PREDICATES,
  PROPOSAL_SCHEMA_VERSION,
  evaluateProposalRun,
  validateProposal,
} from '../web/memory-proposals.mjs'
import {
  ROUTE_PRECISION_FLOOR,
  ROUTE_SAMPLE_FLOOR,
  routeEnabled,
} from '../web/memory-ledger-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// The p1 corpus and its baseline artifact are frozen measurement evidence. The p2
// copy has identical cases and only changes the contract version, so the current
// evaluator guard can move to p2 without rewriting the frozen hash.
const CORPUS_PATH = join(HERE, '..', 'work', 'memory-ledger-20261025', 'proposal-corpus-p2.json')
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'))
const PREDICATES = ['project.decision', 'project.constraint', 'project.preference']
const NEGATIVE_KINDS = [
  'one-off', 'plan', 'injected-system', 'assistant-prose', 'code-dump',
  'transient-error', 'file-fact', 'ambiguity',
]
const RECLASSIFIED = ['pref-05', 'pref-12', 'pref-16', 'neg-02', 'neg-07', 'neg-11']

// --- Map helpers -----------------------------------------------------------

function itemOf(expected) {
  return {
    op: expected.op,
    predicate: expected.predicate,
    targetAssertionId: expected.targetAssertionId ?? null,
    evidence: { eventKey: expected.eventKey, quote: expected.quote },
  }
}

function encode(items) {
  return JSON.stringify({ proposals: items })
}

function caseById(id) {
  return corpus.cases.find((item) => item.id === id)
}

function userEventOf(id) {
  const found = caseById(id)
  return found.events.find((event) => (event.sourceKind ?? 'user') === 'user')
}

function correctMap() {
  return Object.fromEntries(corpus.cases.map((item) => [item.id, encode(item.expected.map(itemOf))]))
}

function withItems(map, id, items) {
  return { ...map, [id]: encode(items) }
}

function withQuote(map, id, index, quote) {
  const items = caseById(id).expected.map(itemOf)
  items[index] = { ...items[index], evidence: { ...items[index].evidence, quote } }
  return withItems(map, id, items)
}

function withPatch(map, id, index, patch) {
  const items = caseById(id).expected.map(itemOf)
  items[index] = { ...items[index], ...patch }
  return withItems(map, id, items)
}

function appendProposal(map, id, item) {
  return withItems(map, id, [...caseById(id).expected.map(itemOf), item])
}

function withoutCase(map, id) {
  const copy = { ...map }
  delete copy[id]
  return copy
}

function run(proposalsByCase, extra = {}) {
  return evaluateProposalRun({ cases: corpus.cases, proposalsByCase, ...extra })
}

function codesOf(result) {
  return [...new Set(result.failures.map((failure) => failure.code))].sort()
}

function caseCodes(result, id) {
  const found = result.cases.find((item) => item.id === id)
  return [...new Set(found.failures.map((failure) => failure.code))].sort()
}

function assertCodes(result, expected) {
  assert.deepEqual(codesOf(result), [...expected].sort())
}

function countExpected(predicate) {
  return corpus.cases.reduce((total, item) => total +
    item.expected.filter((expected) => expected.predicate === predicate).length, 0)
}

function countPositiveCases(predicate) {
  return corpus.cases.filter((item) =>
    item.expected.some((expected) => expected.predicate === predicate)).length
}

function countNegativeCases(predicate) {
  return corpus.cases.filter((item) =>
    !item.expected.some((expected) => expected.predicate === predicate)).length
}

function caseStatus(result, id) {
  return result.cases.find((item) => item.id === id).status
}

function proposalOf(result, id, quote) {
  return result.cases.find((item) => item.id === id).proposals
    .find((proposal) => proposal.quote === quote)
}

function assertAllRoutes(result, enabled, reason) {
  for (const predicate of PREDICATES) {
    const route = result.routes[predicate]
    assert.equal(route.enabled, enabled, `${predicate} route enabled`)
    assert.equal(route.reason, reason, `${predicate} route reason`)
    assert.equal(route.status, enabled ? 'enabled' : 'disabled')
  }
  assert.equal(result.routeSummary.allEnabled, enabled)
}

// 具体到每条谓词的标签数，用于把“一条正例 + 19 条负例”这类切片写死。
const DEC19 = [
  'dec-01', 'dec-02', 'dec-03', 'dec-04', 'dec-06', 'dec-07', 'dec-09', 'dec-10',
  'dec-11', 'dec-12', 'dec-13', 'dec-14', 'dec-15', 'dec-16', 'dec-17', 'dec-18',
  'dec-19', 'dec-20', 'dec-21',
]
const CON19 = [
  'con-01', 'con-02', 'con-03', 'con-04', 'con-05', 'con-06', 'con-07', 'con-08',
  'con-09', 'con-10', 'con-11', 'con-12', 'con-14', 'con-15', 'con-16', 'con-17',
  'con-18', 'con-19', 'con-20',
]
const PREF19 = [
  'pref-01', 'pref-02', 'pref-03', 'pref-04', 'pref-05', 'pref-06', 'pref-07',
  'pref-08', 'pref-09', 'pref-10', 'pref-12', 'pref-13', 'pref-14', 'pref-15',
  'pref-16', 'pref-17', 'pref-18', 'pref-19', 'pref-20',
]
const GATE_19 = [...DEC19, ...CON19, ...PREF19]
const ORDINARY_NEGATIVES = [
  'neg-01', 'neg-02', 'neg-03', 'neg-04', 'neg-05', 'neg-06', 'neg-07', 'neg-08',
  'neg-09', 'neg-10', 'neg-11', 'neg-12', 'neg-13', 'neg-14', 'neg-15', 'neg-16',
]

function casesOf(ids) {
  return ids.map((id) => caseById(id))
}

// --- Corpus as a labelled, self-consistent artifact ------------------------

test('corpus is a p1 artifact with at least 20 positive-label cases per predicate', () => {
  assert.equal(corpus.schemaVersion, PROPOSAL_SCHEMA_VERSION)
  assert.equal(Array.isArray(corpus.cases), true)
  assert.ok(corpus.cases.length >= 60, `corpus has only ${corpus.cases.length} cases`)
  const ids = new Set()
  const keys = new Set()
  for (const item of corpus.cases) {
    assert.equal(typeof item.id, 'string')
    assert.equal(ids.has(item.id), false, `duplicate case id ${item.id}`)
    ids.add(item.id)
    assert.equal(typeof item.scope, 'string')
    assert.ok(item.scope.length > 0)
    assert.ok(Array.isArray(item.events) && item.events.length > 0, `${item.id} has no events`)
    assert.ok(Array.isArray(item.expected), `${item.id} has no expected array`)
    for (const event of item.events) {
      assert.equal(keys.has(event.eventKey), false, `duplicate eventKey ${event.eventKey}`)
      keys.add(event.eventKey)
      assert.ok(typeof event.text === 'string' && event.text.length > 0)
    }
    for (const expected of item.expected) {
      assert.ok(PREDICATES.includes(expected.predicate), `${item.id} predicate ${expected.predicate}`)
      assert.ok(['assert', 'correct', 'retract'].includes(expected.op), `${item.id} op ${expected.op}`)
    }
  }
  for (const predicate of PREDICATES) {
    const positiveCases = countPositiveCases(predicate)
    assert.ok(positiveCases >= 20,
      `${predicate} has only ${positiveCases} durable positive cases`)
    assert.ok(positiveCases >= ROUTE_SAMPLE_FLOOR)
    // The route gate counts positive labels, so the label total (not the case total)
    // is what has to clear the floor; multi-label cases count once per label.
    assert.ok(countExpected(predicate) >= 20, `${predicate} has too few positive labels`)
    assert.ok(countExpected(predicate) >= positiveCases)
  }
  assert.equal(new Set([...PROPOSAL_PREDICATES]).size, 3)
})

test('corpus covers every durable class and every required negative class', () => {
  const kinds = new Set(corpus.cases.map((item) => item.kind))
  for (const kind of ['durable', 'correction', 'retraction', 'conflict', ...NEGATIVE_KINDS, 'severe']) {
    assert.equal(kinds.has(kind), true, `corpus is missing the ${kind} class`)
  }
  const negative = corpus.cases.filter((item) => item.expected.length === 0)
  assert.ok(negative.length >= 12, `only ${negative.length} negative cases`)
  for (const item of negative) {
    assert.equal(item.forbiddenPredicates.length > 0, true,
      `${item.id} must declare the predicates its absence tests`)
    for (const predicate of item.forbiddenPredicates) {
      assert.ok(PREDICATES.includes(predicate))
    }
  }
})

test('corpus severe negatives are empty and labelled severe', () => {
  const severe = corpus.cases.filter((item) => item.severe === true)
  assert.ok(severe.length >= 1, 'corpus needs at least one severe negative')
  for (const item of severe) {
    assert.equal(item.expected.length, 0, `${item.id} must never expect an extraction`)
    assert.equal(item.forbiddenPredicates.length, PREDICATES.length, `${item.id} forbids all predicates`)
  }
})

test('corpus documents the relabelled and de-ambiguated cases with a rationale', () => {
  for (const item of corpus.cases) {
    if (!Object.hasOwn(item, 'rationale')) continue
    assert.equal(typeof item.rationale, 'string', `${item.id} rationale must be a string`)
    assert.ok(item.rationale.trim() !== '', `${item.id} rationale must not be blank`)
  }
  // pref-05/12/16 were rewritten from one-off requests to an explicit durable stance;
  // neg-02/07/11 were rewritten so the negative reading is unambiguous. Both decisions
  // are recorded next to the case instead of only in the report.
  for (const id of RECLASSIFIED) {
    const found = caseById(id)
    assert.ok(found, `${id} is missing from the corpus`)
    assert.equal(typeof found.rationale, 'string', `${id} must carry a rationale`)
    assert.ok(found.rationale.trim().length > 0)
  }
  for (const id of ['pref-05', 'pref-12', 'pref-16']) {
    const quote = caseById(id).expected[0].quote
    assert.equal(caseById(id).kind, 'durable', `${id} stays a durable preference`)
    assert.equal(quote, caseById(id).events[0].text)
    assert.equal(/以后|每次|始终|偏好/.test(quote), true,
      `${id} must state the stance durably: ${quote}`)
  }
})

test('every expected label is an extractable, exact, unique, source-typed span', () => {
  for (const item of corpus.cases) {
    const evidenceByKey = new Map(item.events.map((event, index) => [event.eventKey, {
      eventKey: event.eventKey,
      scope: item.scope,
      sid: `sid:${item.id}`,
      seq: index + 1,
      validAt: 1000 * (index + 1),
      recordedAt: 1000 * (index + 1),
      human: (event.sourceKind ?? 'user') === 'user' && event.human !== false,
      sourceKind: event.sourceKind ?? 'user',
      text: event.text,
    }]))
    const activeFacts = (item.activeTargets ?? []).map((target) => ({
      assertionId: target.assertionId,
      scope: item.scope,
      predicate: target.predicate,
      status: 'active',
      conflict: null,
      validFrom: 500,
      seq: 0,
    }))
    for (const expected of item.expected) {
      const event = evidenceByKey.get(expected.eventKey)
      assert.ok(event, `${item.id}/${expected.eventKey} is not in this case's evidence`)
      const quote = expected.quote
      assert.equal(event.text.includes(quote), true, `${item.id} quote is not verbatim: ${quote}`)
      assert.equal(event.text.indexOf(quote), event.text.lastIndexOf(quote),
        `${item.id} quote is not unique: ${quote}`)
      assert.equal(event.sourceKind, 'user', `${item.id} expects evidence from non-user text`)
      const validated = validateProposal({
        op: expected.op,
        predicate: expected.predicate,
        targetAssertionId: expected.targetAssertionId ?? null,
        evidence: { eventKey: expected.eventKey, quote },
      }, { scope: item.scope, evidenceByKey, activeFacts })
      assert.equal(validated.ok, true,
        `${item.id} expected label is not extractable: ${validated.error}`)
      if (expected.op !== 'assert') {
        assert.ok(typeof expected.targetAssertionId === 'string' && expected.targetAssertionId !== '',
          `${item.id} ${expected.op} must name its active target`)
        assert.equal((item.staleTargets ?? []).includes(expected.targetAssertionId), false,
          `${item.id} expects a correction against a stale target`)
      } else {
        assert.equal(expected.targetAssertionId ?? null, null)
      }
    }
  }
})

// --- The correct map: the scorer must not invent failures ------------------

test('the correct map passes every corpus case and opens no route by accident', () => {
  const result = run(correctMap())

  assert.equal(result.passed, true)
  assert.deepEqual(result.failures, [])
  assert.equal(result.cases.length, corpus.cases.length)
  assert.equal(result.cases.every((item) => item.status === 'scored'), true)
  assert.equal(result.totals.empty, 0)
  assert.equal(result.totals.invalidJson, 0)
  assert.equal(result.totals.invalidOutput, 0)
  assert.equal(result.totals.missing, 0)
  assert.equal(result.totals.unmeasured, 0)
  assert.equal(result.totals.safetyFailures, 0)
  assert.equal(result.totals.globalSafetyFailures, 0)
  assert.equal(result.totals.outputValid, true)
  assert.equal(result.totals.jsonValid, true)
  assert.equal(result.totals.positiveLabels,
    PREDICATES.reduce((sum, predicate) => sum + countExpected(predicate), 0))

  for (const predicate of PREDICATES) {
    const aggregate = result.byPredicate[predicate]
    assert.equal(aggregate.tp, countExpected(predicate), `${predicate} true positives`)
    assert.equal(aggregate.fp, 0)
    assert.equal(aggregate.fn, 0)
    assert.equal(aggregate.precision, 1)
    assert.equal(aggregate.recall, 1)
    assert.equal(aggregate.safetyFailures, 0)
    assert.equal(aggregate.globalSafetyFailures, 0)
    assert.equal(aggregate.jsonValid, true)
    assert.equal(aggregate.evidenceValid, true)
    assert.equal(aggregate.outputValid, true)
    assert.equal(aggregate.positiveLabels, countExpected(predicate))
    assert.equal(aggregate.negativeLabels, countNegativeCases(predicate))
    assert.equal(aggregate.sampleCount, aggregate.positiveLabels)
    assert.ok(aggregate.sampleCount >= ROUTE_SAMPLE_FLOOR)
    assert.ok(aggregate.negativeLabels > aggregate.positiveLabels,
      'the corpus is mostly negatives: precision must come from acceptance restraint')

    const route = result.routes[predicate]
    assert.equal(route.enabled, true, `${predicate} must be open on a perfect run`)
    assert.equal(route.reason, null)
    assert.equal(route.status, 'enabled')
    assert.equal(route.precision, 1)
    assert.equal(route.recall, 1)
    assert.equal(route.safetyFailures, 0)
    assert.equal(route.positiveLabels, aggregate.positiveLabels)
    assert.equal(route.sampleCount, aggregate.positiveLabels)
    assert.equal(routeEnabled({
      sampleCount: route.sampleCount,
      precision: route.precision,
      recall: route.recall,
      safetyFailures: route.safetyFailures,
    }), true)
  }
  assert.deepEqual(result.routeSummary.enabled.slice().sort(), PREDICATES.slice().sort())
  assert.equal(result.routeSummary.allEnabled, true)
})

// --- Broken maps: one per named reason ------------------------------------

test('a false acceptance is reported as a false positive and lowers precision', () => {
  let map = correctMap()
  // Six ordinary negatives get a durable-sounding decision with a perfectly valid
  // verbatim span: the evidence is real, the semantics are not.
  for (const id of ['neg-01', 'neg-02', 'neg-05', 'neg-06', 'neg-07', 'neg-08']) {
    const event = userEventOf(id)
    map = appendProposal(map, id, {
      op: 'assert',
      predicate: 'project.decision',
      targetAssertionId: null,
      evidence: { eventKey: event.eventKey, quote: event.text },
    })
  }
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['false-acceptance', 'forbidden-predicate'])
  assert.equal(result.byPredicate['project.decision'].fp, 6)
  assert.equal(result.byPredicate['project.decision'].tp, countExpected('project.decision'))
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 0,
    'a real span on the wrong semantics is a precision failure, not an evidence failure')
  assert.equal(result.byPredicate['project.decision'].evidenceValid, true)
  assert.ok(result.byPredicate['project.decision'].precision < 1)
  assert.ok(result.byPredicate['project.decision'].precision < ROUTE_PRECISION_FLOOR)
  assert.equal(result.routes['project.decision'].enabled, false)
  assert.equal(result.routes['project.decision'].reason, 'precision-below-floor')
  assert.equal(result.routes['project.constraint'].enabled, true)
  assert.equal(result.routes['project.preference'].enabled, true)
})

test('a missed extraction is a false negative and recall is reported, not gated', () => {
  const map = withItems(correctMap(), 'con-02', [])
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['missed-extraction'])
  assert.deepEqual(caseCodes(result, 'con-02'), ['missed-extraction'])
  assert.equal(result.byPredicate['project.constraint'].fn, 1)
  assert.equal(result.byPredicate['project.constraint'].tp, countExpected('project.constraint') - 1)
  assert.equal(result.byPredicate['project.constraint'].precision, 1)
  assert.equal(result.byPredicate['project.constraint'].recall,
    (countExpected('project.constraint') - 1) / countExpected('project.constraint'))
  assert.equal(result.byPredicate['project.constraint'].safetyFailures, 0)
  assert.equal(result.routes['project.constraint'].enabled, true)
  assert.equal(result.routes['project.constraint'].reason, null)
})

// --- Structural span classification (I1) ----------------------------------

test('a narrower clause-aligned subspan is a noncanonical span, not a safety failure', () => {
  const label = caseById('dec-09').expected[0]
  const narrower = '理由是本地模型成本不可控'
  assert.equal(label.quote.includes(narrower), true)
  const result = run(withQuote(correctMap(), 'dec-09', 0, narrower))

  assert.equal(result.passed, false)
  assertCodes(result, ['missed-extraction', 'noncanonical-span'])
  assert.deepEqual(caseCodes(result, 'dec-09'), ['missed-extraction', 'noncanonical-span'])
  const entry = proposalOf(result, 'dec-09', narrower)
  assert.equal(entry.disposition, 'accepted', 'the span is real text, so it is accepted')
  assert.equal(entry.code, 'noncanonical-span')
  assert.equal(entry.safety, false)
  assert.equal(entry.evidence, 'valid')
  assert.equal(result.byPredicate['project.decision'].fp, 1)
  assert.equal(result.byPredicate['project.decision'].fn, 1)
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 0)
  assert.equal(result.byPredicate['project.decision'].evidenceValid, true)
  assert.equal(result.byPredicate['project.decision'].precision,
    (countExpected('project.decision') - 1) / countExpected('project.decision'))
  assert.equal(result.byPredicate['project.decision'].recall,
    (countExpected('project.decision') - 1) / countExpected('project.decision'))
  assert.equal(result.totals.safetyFailures, 0)
  // Not a safety failure means not a hard block: 23/24 = 0.958 stays above the
  // specified 0.95 precision floor, so the route stays open and the FP/FN pair is
  // reported instead of being converted into a fabricated-failure shutdown.
  assert.equal(result.routes['project.decision'].enabled, true)
  assert.equal(result.routes['project.decision'].reason, null)
})

test('a wider clause-aligned superspan is a noncanonical span, not a safety failure', () => {
  const label = caseById('con-01').expected[0]
  const superset = '接口端口固定为 8848，不要再改'
  assert.equal(superset.includes(label.quote), true)
  const result = run(withQuote(correctMap(), 'con-01', 0, superset))

  assert.equal(result.passed, false)
  assertCodes(result, ['missed-extraction', 'noncanonical-span'])
  assert.deepEqual(caseCodes(result, 'con-01'), ['missed-extraction', 'noncanonical-span'])
  const entry = proposalOf(result, 'con-01', superset)
  assert.equal(entry.code, 'noncanonical-span')
  assert.equal(entry.safety, false)
  assert.equal(result.byPredicate['project.constraint'].fp, 1)
  assert.equal(result.byPredicate['project.constraint'].fn, 1)
  assert.equal(result.byPredicate['project.constraint'].safetyFailures, 0)
  assert.equal(result.totals.safetyFailures, 0)
})

test('a span that only adds the terminal period is a noncanonical span', () => {
  const label = caseById('dec-05').expected[0]
  const variant = `${label.quote}。`
  assert.equal(label.quote, '决定一：提案路由默认关闭')
  assert.equal(variant, '决定一：提案路由默认关闭。')
  const result = run(withQuote(correctMap(), 'dec-05', 0, variant))

  assert.equal(result.passed, false)
  assertCodes(result, ['missed-extraction', 'noncanonical-span'])
  const entry = proposalOf(result, 'dec-05', variant)
  assert.equal(entry.disposition, 'accepted',
    'a quote that carries its own sentence terminator is a whole clause')
  assert.equal(entry.code, 'noncanonical-span')
  assert.equal(entry.safety, false)
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 0)
  // The second label of the same case still matches, so only one FP/FN pair exists.
  assert.equal(result.byPredicate['project.decision'].fp, 1)
  assert.equal(result.byPredicate['project.decision'].fn, 1)
})

test('a mutation outside containment stays an evidence safety failure', () => {
  // Both spans are real, unique, clause-aligned clauses of the same event, but the
  // accepted one starts inside the labelled clause and ends outside it: the value was
  // rewritten across the label boundary, which containment cannot explain.
  const overlapCase = {
    id: 'syn-overlap',
    kind: 'durable',
    scope: 'workspace:project-zeta',
    events: [{
      eventKey: 'syn-overlap:e1',
      text: '决定用 SQLite，并保留只读快照，迁移必须可回滚。',
    }],
    expected: [{
      op: 'assert',
      predicate: 'project.decision',
      eventKey: 'syn-overlap:e1',
      quote: '决定用 SQLite，并保留只读快照',
    }],
    forbiddenPredicates: [],
    severe: false,
  }
  const mutated = '并保留只读快照，迁移必须可回滚'
  const result = evaluateProposalRun({
    cases: [overlapCase],
    proposalsByCase: {
      'syn-overlap': encode([{
        op: 'assert',
        predicate: 'project.decision',
        targetAssertionId: null,
        evidence: { eventKey: 'syn-overlap:e1', quote: mutated },
      }]),
    },
  })

  assert.equal(result.passed, false)
  assertCodes(result, ['missed-extraction', 'quote-value-mutation'])
  const entry = proposalOf(result, 'syn-overlap', mutated)
  assert.equal(entry.disposition, 'accepted')
  assert.equal(entry.safety, true)
  assert.equal(entry.evidence, 'invalid')
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 1)
  assert.equal(result.byPredicate['project.decision'].evidenceValid, false)
  assert.equal(result.routes['project.decision'].enabled, false)
  assert.equal(result.routes['project.decision'].reason, 'safety-failure')
})

test('a fabricated span is rejected and counted as a safety failure', () => {
  const map = withQuote(correctMap(), 'dec-05', 0, '决定一：提案路由默认开启')
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['invalid-evidence-span', 'missed-extraction'])
  const entry = proposalOf(result, 'dec-05', '决定一：提案路由默认开启')
  assert.equal(entry.disposition, 'rejected')
  assert.equal(entry.safety, true)
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 1)
  assert.equal(result.byPredicate['project.decision'].evidenceValid, false)
  assert.equal(result.routes['project.decision'].reason, 'safety-failure')
})

test('a mid-clause span is an invalid boundary, still a safety failure', () => {
  const fragment = '路由默认关闭'
  const map = withQuote(correctMap(), 'dec-05', 0, fragment)
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['invalid-evidence-span', 'missed-extraction'])
  assert.equal(proposalOf(result, 'dec-05', fragment).safety, true)
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 1)
})

test('a complete sub-clause after a full-width colon is noncanonical, not fabricated', () => {
  // "决定一：提案路由默认关闭。" — the clause after the colon is a whole clause,
  // so the new boundary policy accepts the span. It is a sub-span of the label,
  // which is a semantic mismatch (FP+FN), not a fabricated value.
  const fragment = '提案路由默认关闭'
  const map = withQuote(correctMap(), 'dec-05', 0, fragment)
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['noncanonical-span', 'missed-extraction'])
  assert.equal(proposalOf(result, 'dec-05', fragment).safety, false)
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 0)
})

test('an ambiguous (non-unique) span is a safety failure', () => {
  const ambiguousCase = {
    id: 'syn-ambiguous',
    kind: 'ambiguity',
    scope: 'workspace:project-zeta',
    events: [{
      eventKey: 'syn-ambiguous:e1',
      text: '决定缓存 TTL 用 60 秒。决定缓存 TTL 用 60 秒。',
    }],
    expected: [],
    forbiddenPredicates: PREDICATES,
    severe: false,
  }
  const repeated = '决定缓存 TTL 用 60 秒'
  const result = evaluateProposalRun({
    cases: [ambiguousCase],
    proposalsByCase: {
      'syn-ambiguous': encode([{
        op: 'assert',
        predicate: 'project.decision',
        targetAssertionId: null,
        evidence: { eventKey: 'syn-ambiguous:e1', quote: repeated },
      }]),
    },
  })

  assert.equal(result.passed, false)
  assertCodes(result, ['invalid-evidence-span'])
  const entry = proposalOf(result, 'syn-ambiguous', repeated)
  assert.equal(entry.disposition, 'rejected')
  assert.equal(entry.safety, true)
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 1)
})

test('cross-scope evidence is named and blocked even when the quote really exists', () => {
  const foreign = userEventOf('con-01')
  const map = appendProposal(correctMap(), 'dec-01', {
    op: 'assert',
    predicate: 'project.constraint',
    targetAssertionId: null,
    evidence: { eventKey: foreign.eventKey, quote: caseById('con-01').expected[0].quote },
  })
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['cross-scope-evidence'])
  assert.deepEqual(caseCodes(result, 'dec-01'), ['cross-scope-evidence'])
  assert.equal(result.byPredicate['project.constraint'].safetyFailures, 1)
  assert.equal(result.routes['project.constraint'].reason, 'safety-failure')
  assert.equal(result.routes['project.decision'].enabled, true)
})

test('a candidate injected as evidence is never accepted', () => {
  const prose = caseById('neg-04')
  const event = prose.events[0]
  assert.equal(event.sourceKind, 'assistant')
  const map = withItems(correctMap(), 'neg-04', [{
    op: 'assert',
    predicate: 'project.decision',
    targetAssertionId: null,
    evidence: { eventKey: event.eventKey, quote: event.text },
  }])
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['candidate-injected'])
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 1)
  assert.equal(result.cases.find((item) => item.id === 'neg-04').proposals
    .every((proposal) => proposal.disposition === 'rejected'), true)
})

test('a correction aimed at a stale fact is a safety failure', () => {
  const found = caseById('dec-06')
  const stale = found.staleTargets[0]
  const map = withPatch(correctMap(), 'dec-06', 0, { targetAssertionId: stale })
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['missed-extraction', 'stale-target'])
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 1)
  assert.equal(result.routes['project.decision'].reason, 'safety-failure')
})

test('a severe negative can never be accepted and blocks its route', () => {
  const severeId = 'sev-01'
  const event = userEventOf(severeId)
  const map = appendProposal(correctMap(), severeId, {
    op: 'assert',
    predicate: 'project.decision',
    targetAssertionId: null,
    evidence: { eventKey: event.eventKey, quote: event.text },
  })
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['false-acceptance', 'forbidden-predicate', 'severe-false-acceptance'])
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 1)
  assert.ok(result.byPredicate['project.decision'].precision >= ROUTE_PRECISION_FLOOR)
  assert.equal(result.routes['project.decision'].enabled, false)
  assert.equal(result.routes['project.decision'].reason, 'safety-failure')
})

test('an unsupported predicate is a global safety failure that blocks every route', () => {
  const event = userEventOf('dec-03')
  const map = appendProposal(correctMap(), 'dec-03', {
    op: 'assert',
    predicate: 'project.style',
    targetAssertionId: null,
    evidence: { eventKey: event.eventKey, quote: event.text },
  })
  const result = run(map)

  assert.equal(result.passed, false)
  assertCodes(result, ['unsupported-predicate'])
  // No semantic predicate exists for the entry, so it can never be attributed to one
  // bucket; it must still block all three routes.
  assert.equal(result.totals.safetyFailures, 1)
  assert.equal(result.totals.globalSafetyFailures, 1)
  // The predicate itself is outside the layer, not a fabricated span, so evidence
  // validity stays clean while safety still blocks: the two dimensions stay separate.
  assert.equal(result.totals.evidenceValid, true)
  assert.equal(result.cases.find((item) => item.id === 'dec-03').evidenceValid, true)
  for (const predicate of PREDICATES) {
    assert.equal(result.byPredicate[predicate].safetyFailures, 0)
    assert.equal(result.byPredicate[predicate].globalSafetyFailures, 1)
  }
  assertAllRoutes(result, false, 'safety-failure')
  for (const predicate of PREDICATES) {
    assert.equal(result.routes[predicate].safetyFailures, 1)
    assert.ok(result.routes[predicate].precision >= ROUTE_PRECISION_FLOOR)
  }
})

// --- JSON validity and measurement are global, not per-predicate (C1) ------

test('malformed JSON in a positive case is reported separately from semantic scores', () => {
  const map = { ...correctMap(), 'dec-02': '{"proposals":[' }
  const result = run(map)

  assert.equal(result.passed, false)
  assert.equal(caseStatus(result, 'dec-02'), 'invalid-json')
  assert.equal(result.cases.find((item) => item.id === 'dec-02').jsonValid, false)
  assertCodes(result, ['invalid-json', 'missed-extraction'])
  assert.equal(result.totals.invalidJson, 1)
  assert.equal(result.totals.unmeasured, 1)
  assert.equal(result.totals.jsonValid, false)
  assert.equal(result.totals.outputValid, false)
  for (const predicate of PREDICATES) {
    assert.equal(result.byPredicate[predicate].jsonValid, false)
    assert.equal(result.byPredicate[predicate].outputValid, false)
    assert.equal(result.routes[predicate].jsonValid, false)
  }
  // Invalid JSON anywhere in the corpus disables every route, not only the affected
  // predicate: the run as a whole is not measurable.
  assertAllRoutes(result, false, 'invalid-json')
})

test('malformed JSON in a label-free negative case still disables every route', () => {
  const map = { ...correctMap(), 'neg-05': '{"proposals":' }
  const result = run(map)

  assert.equal(result.passed, false)
  assert.equal(caseStatus(result, 'neg-05'), 'invalid-json')
  // A negative case has no label to miss, so invalid JSON is the only code raised.
  assertCodes(result, ['invalid-json'])
  assert.deepEqual(caseCodes(result, 'neg-05'), ['invalid-json'])
  assert.equal(result.totals.invalidJson, 1)
  assert.equal(result.totals.unmeasured, 1)
  assert.equal(result.totals.jsonValid, false)
  assert.equal(result.totals.outputValid, false)
  assert.equal(result.totals.safetyFailures, 0)
  for (const predicate of PREDICATES) {
    assert.equal(result.byPredicate[predicate].jsonValid, false)
    assert.equal(result.byPredicate[predicate].outputValid, false)
    assert.equal(result.byPredicate[predicate].evidenceValid, true)
    assert.equal(result.byPredicate[predicate].precision, 1)
  }
  assertAllRoutes(result, false, 'invalid-json')

  // Control: the same corpus with a valid empty answer in that negative case scores
  // perfectly, so the block above is caused by the invalid JSON itself.
  const control = run({ ...correctMap(), 'neg-05': encode([]) })
  assert.equal(control.passed, true)
  assert.equal(control.totals.outputValid, true)
  assertAllRoutes(control, true, null)
})

test('schema-refused output in a negative case is invalid-output and blocks every route', () => {
  const map = { ...correctMap(), 'neg-05': '{"proposals":[{"op":"assert"}]}' }
  const result = run(map)

  assert.equal(result.passed, false)
  assert.equal(caseStatus(result, 'neg-05'), 'invalid-output')
  assertCodes(result, ['invalid-output'])
  assert.equal(result.totals.invalidOutput, 1)
  assert.equal(result.totals.invalidJson, 0)
  assert.equal(result.totals.missing, 0)
  assert.equal(result.totals.jsonValid, false)
  assert.equal(result.totals.outputValid, false)
  assertAllRoutes(result, false, 'invalid-output')
})

test('a missing output is ran-missing, distinct from a non-string invalid-output', () => {
  const missing = run(withoutCase(correctMap(), 'neg-06'))
  assert.equal(caseStatus(missing, 'neg-06'), 'ran-missing')
  assert.deepEqual(caseCodes(missing, 'neg-06'), ['ran-missing'])
  assertCodes(missing, ['ran-missing'])
  assert.equal(missing.totals.missing, 1)
  assert.equal(missing.totals.invalidOutput, 0)
  assert.equal(missing.totals.invalidJson, 0)
  assert.equal(missing.totals.unmeasured, 1)
  assertAllRoutes(missing, false, 'missing-output')

  const nonString = run({ ...correctMap(), 'neg-08': 42 })
  assert.equal(caseStatus(nonString, 'neg-08'), 'invalid-output')
  assert.deepEqual(caseCodes(nonString, 'neg-08'), ['invalid-output'])
  assertCodes(nonString, ['invalid-output'])
  assert.equal(nonString.totals.invalidOutput, 1)
  assert.equal(nonString.totals.missing, 0)
  assertAllRoutes(nonString, false, 'invalid-output')

  // The two statuses and codes never collapse into each other.
  assert.notEqual(caseStatus(missing, 'neg-06'), caseStatus(nonString, 'neg-08'))
  assert.notDeepEqual(caseCodes(missing, 'neg-06'), caseCodes(nonString, 'neg-08'))
})

test('an empty output is ran-empty: a measured miss, never an error', () => {
  const map = Object.fromEntries(corpus.cases.map((item) => [item.id, '']))
  const result = run(map)

  assert.equal(result.passed, false)
  assert.equal(result.cases.every((item) => item.status === 'ran-empty'), true)
  assert.equal(result.totals.empty, corpus.cases.length)
  assert.equal(result.totals.unmeasured, 0)
  assert.deepEqual(codesOf(result), ['missed-extraction'])
  assert.equal(result.totals.jsonValid, true)
  assert.equal(result.totals.outputValid, true)
  assert.equal(result.byPredicate['project.decision'].recall, 0)
  assert.equal(result.byPredicate['project.decision'].precision, null)
  assert.equal(result.byPredicate['project.decision'].positiveLabels,
    countExpected('project.decision'))
  assertAllRoutes(result, false, 'precision-unmeasured')
})

// --- Exact identity -------------------------------------------------------

test('scoring requires exact op, predicate and quote identity', () => {
  const wrongPredicate = withPatch(correctMap(), 'con-03', 0, { predicate: 'project.preference' })
  const predicateResult = run(wrongPredicate)
  assertCodes(predicateResult, ['false-acceptance', 'missed-extraction'])
  assert.equal(predicateResult.byPredicate['project.constraint'].fn, 1)
  assert.equal(predicateResult.byPredicate['project.preference'].fp, 1)

  const wrongOp = withPatch(correctMap(), 'pref-01', 0, { op: 'retract', targetAssertionId: null })
  const opResult = run(wrongOp)
  assertCodes(opResult, ['missed-extraction', 'missing-target'])
  assert.equal(opResult.byPredicate['project.preference'].tp, countExpected('project.preference') - 1)
})

test('outer whitespace is trimmed exactly like the production validator', () => {
  const label = caseById('dec-01').expected[0].quote
  const padded = `  ${label}\n`
  const result = run(withQuote(correctMap(), 'dec-01', 0, padded))

  // Production trims `evidence.quote` before locating the span, so the scorer must
  // judge the trimmed value; being stricter would report a safety failure for a
  // proposal the engine actually accepts.
  assert.equal(result.passed, true)
  assert.deepEqual(codesOf(result), [])
  assert.equal(result.byPredicate['project.decision'].tp, countExpected('project.decision'))
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 0)
  assert.equal(proposalOf(result, 'dec-01', label).disposition, 'accepted')
})

test('a quote longer than the production limit is an evidence safety failure', () => {
  const longText = `决定采用长标识，${'a'.repeat(340)}。`
  const longCase = {
    id: 'syn-long',
    kind: 'ambiguity',
    scope: 'workspace:project-zeta',
    events: [{ eventKey: 'syn-long:e1', text: longText }],
    expected: [],
    forbiddenPredicates: PREDICATES,
    severe: false,
  }
  assert.ok(longText.length > 300)
  const result = evaluateProposalRun({
    cases: [longCase],
    proposalsByCase: {
      'syn-long': encode([
        {
          op: 'assert',
          predicate: 'project.decision',
          targetAssertionId: null,
          evidence: { eventKey: 'syn-long:e1', quote: longText },
        },
        {
          op: 'assert',
          predicate: 'project.decision',
          targetAssertionId: null,
          evidence: { eventKey: 'syn-long:e1', quote: '决定采用长标识' },
        },
      ]),
    },
  })

  assert.equal(result.passed, false)
  assertCodes(result, ['false-acceptance', 'forbidden-predicate', 'quote-too-long'])
  const tooLong = proposalOf(result, 'syn-long', longText)
  assert.equal(tooLong.disposition, 'rejected')
  assert.equal(tooLong.safety, true)
  assert.equal(tooLong.evidence, 'invalid')
  const short = proposalOf(result, 'syn-long', '决定采用长标识')
  assert.equal(short.disposition, 'accepted', 'an in-limit aligned span is still a span')
  assert.equal(short.code, 'false-acceptance')
  assert.equal(short.safety, false)
  assert.equal(result.byPredicate['project.decision'].safetyFailures, 1)
})

// --- Expected-label overrides (I5) ----------------------------------------

test('a label override through expectedByCase is honoured', () => {
  const cases = casesOf(['dec-01', 'con-01', 'pref-01'])
  const result = evaluateProposalRun({
    cases,
    proposalsByCase: correctMap(),
    expectedByCase: { 'dec-01': [] },
  })
  assert.equal(result.passed, false)
  assertCodes(result, ['false-acceptance'])
  assert.equal(result.cases.find((item) => item.id === 'dec-01').expectedCount, 0)
  assert.equal(result.byPredicate['project.decision'].positiveLabels, 0)
  assert.equal(result.byPredicate['project.decision'].fp, 1)

  const structured = evaluateProposalRun({
    cases,
    proposalsByCase: correctMap(),
    expectedByCase: { 'con-01': { expected: [], severe: false } },
  })
  assertCodes(structured, ['false-acceptance'])
  assert.equal(structured.byPredicate['project.constraint'].fp, 1)
})

test('override labels must pass the same exact unique clause-aligned span checks', () => {
  const cases = casesOf(['dec-01'])
  const override = (expected) => () => evaluateProposalRun({
    cases,
    proposalsByCase: { 'dec-01': encode([]) },
    expectedByCase: { 'dec-01': expected },
  })

  // Fabricated: the quote is not in the event at all.
  assert.throws(override([{
    op: 'assert',
    predicate: 'project.decision',
    eventKey: 'dec-01:e1',
    quote: '我们决定采用向量检索作为唯一事实源。',
  }]), /not a verbatim span/)

  // Misaligned: a mid-clause fragment of a real event.
  assert.throws(override([{
    op: 'assert',
    predicate: 'project.decision',
    eventKey: 'dec-01:e1',
    quote: '采用隔离账本',
  }]), /not clause aligned/)

  // Wrong event: the label names an event the case does not contain.
  assert.throws(override([{
    op: 'assert',
    predicate: 'project.decision',
    eventKey: 'dec-01:e9',
    quote: '我们决定采用隔离账本作为唯一事实源。',
  }]), /not in the case/)

  // Ambiguous: the quote occurs twice in its own event.
  const ambiguousCase = {
    id: 'syn-ambiguous',
    kind: 'ambiguity',
    scope: 'workspace:project-zeta',
    events: [{
      eventKey: 'syn-ambiguous:e1',
      text: '决定缓存 TTL 用 60 秒。决定缓存 TTL 用 60 秒。',
    }],
    expected: [],
    forbiddenPredicates: PREDICATES,
    severe: false,
  }
  assert.throws(() => evaluateProposalRun({
    cases: [ambiguousCase],
    proposalsByCase: { 'syn-ambiguous': encode([]) },
    expectedByCase: {
      'syn-ambiguous': [{
        op: 'assert',
        predicate: 'project.decision',
        eventKey: 'syn-ambiguous:e1',
        quote: '决定缓存 TTL 用 60 秒',
      }],
    },
  }), /not unique/)

  // A valid override still scores, so the guard rejects only bad spans.
  const valid = evaluateProposalRun({
    cases,
    proposalsByCase: { 'dec-01': encode([]) },
    expectedByCase: {
      'dec-01': [{
        op: 'assert',
        predicate: 'project.decision',
        eventKey: 'dec-01:e1',
        quote: '我们决定采用隔离账本作为唯一事实源。',
      }],
    },
  })
  assertCodes(valid, ['missed-extraction'])
  assert.equal(valid.byPredicate['project.decision'].negativeLabels, 0)
  assert.equal(valid.byPredicate['project.decision'].positiveLabels, 1)
})

// --- Route floors and gate policy (I3, I6) --------------------------------

test('the route gate counts positive labels and stays closed at 19', () => {
  const short = evaluateProposalRun({
    cases: casesOf([...GATE_19, ...ORDINARY_NEGATIVES]),
    proposalsByCase: correctMap(),
  })
  for (const predicate of PREDICATES) {
    assert.equal(short.byPredicate[predicate].positiveLabels, 19)
    // Cases of the other two predicates are negatives for this one, so the negative
    // count is every case without a positive label for it.
    assert.equal(short.byPredicate[predicate].negativeLabels,
      GATE_19.length + ORDINARY_NEGATIVES.length - 19)
    assert.equal(short.routes[predicate].sampleCount, 19)
    assert.equal(short.routes[predicate].enabled, false)
    assert.equal(short.routes[predicate].reason, 'insufficient-labels')
    assert.equal(short.routes[predicate].precision, 1)
  }

  const exact = evaluateProposalRun({
    cases: casesOf([...GATE_19, ...ORDINARY_NEGATIVES, 'dec-22', 'con-21', 'pref-21']),
    proposalsByCase: correctMap(),
  })
  for (const predicate of PREDICATES) {
    assert.equal(exact.byPredicate[predicate].positiveLabels, 20)
    assert.equal(exact.routes[predicate].sampleCount, 20)
    assert.equal(exact.routes[predicate].precision, 1)
    assert.equal(exact.routes[predicate].safetyFailures, 0)
    assert.equal(exact.routes[predicate].enabled, true)
    assert.equal(exact.routes[predicate].reason, null)
  }
})

test('one positive plus 19 negatives stays closed: negatives are not samples', () => {
  const ids = ['dec-01', ...ORDINARY_NEGATIVES, 'sev-01', 'sev-02', 'sev-03']
  const cases = casesOf(ids)
  const result = evaluateProposalRun({ cases, proposalsByCase: correctMap() })

  assert.equal(result.byPredicate['project.decision'].positiveLabels, 1)
  assert.equal(result.byPredicate['project.decision'].negativeLabels, 19)
  assert.equal(result.byPredicate['project.decision'].labels, undefined,
    'the ambiguous `labels` counter must be gone')
  assert.equal(result.routes['project.decision'].sampleCount, 1)
  assert.equal(result.routes['project.decision'].enabled, false)
  assert.equal(result.routes['project.decision'].reason, 'insufficient-labels')
  for (const predicate of PREDICATES) {
    assert.equal(result.routes[predicate].enabled, false)
    assert.ok(result.routes[predicate].positiveLabels < ROUTE_SAMPLE_FLOOR)
  }
})

test('one false positive at 24 positive labels stays enabled at the 0.95 gate', () => {
  const event = userEventOf('neg-01')
  const map = appendProposal(correctMap(), 'neg-01', {
    op: 'assert',
    predicate: 'project.decision',
    targetAssertionId: null,
    evidence: { eventKey: event.eventKey, quote: event.text },
  })
  const result = run(map)
  const aggregate = result.byPredicate['project.decision']

  assert.equal(aggregate.positiveLabels, countExpected('project.decision'))
  assert.equal(aggregate.fp, 1)
  assert.equal(aggregate.tp, countExpected('project.decision'))
  assert.equal(aggregate.fn, 0)
  assert.equal(aggregate.recall, 1, 'recall must be reported, not assumed')
  assert.equal(aggregate.precision,
    countExpected('project.decision') / (countExpected('project.decision') + 1))
  assert.ok(aggregate.precision >= ROUTE_PRECISION_FLOOR)
  assert.equal(ROUTE_PRECISION_FLOOR, 0.95, 'the specified floor is 0.95, not tightened')
  // The gate is deliberately the specified observed precision: one FP in 25 decisions
  // is 0.96, so the route stays open and the FP is reported instead of hidden.
  assert.equal(result.routes['project.decision'].enabled, true)
  assert.equal(result.routes['project.decision'].reason, null)
  assert.equal(result.routes['project.decision'].precision, aggregate.precision)
  assert.equal(result.routes['project.decision'].recall, 1)
  assert.equal(result.totals.safetyFailures, 0)
  assertCodes(result, ['false-acceptance', 'forbidden-predicate'])
})

test('route recommendations always equal the derived gate', () => {
  const maps = [
    correctMap(),
    withQuote(correctMap(), 'dec-09', 0, '理由是本地模型成本不可控'),
    { ...correctMap(), 'dec-02': '{"proposals":[' },
    { ...correctMap(), 'neg-05': '{"proposals":' },
    withoutCase(correctMap(), 'neg-06'),
    Object.fromEntries(corpus.cases.map((item) => [item.id, ''])),
  ]
  for (const map of maps) {
    const result = run(map)
    for (const predicate of PREDICATES) {
      const route = result.routes[predicate]
      const journalGate = routeEnabled({
        sampleCount: route.sampleCount,
        precision: route.precision ?? Number.NaN,
        recall: route.recall ?? Number.NaN,
        safetyFailures: route.safetyFailures,
      })
      // The evaluator may be stricter than the journal gate (invalid or missing
      // output never opens a route), but it can never be looser.
      assert.equal(route.enabled, journalGate && route.reason === null,
        `${predicate} route disagrees with the derived gate`)
      assert.equal(route.status, route.enabled ? 'enabled' : 'disabled')
      assert.equal(route.sampleCount, result.byPredicate[predicate].positiveLabels)
      assert.equal(route.safetyFailures,
        result.byPredicate[predicate].safetyFailures +
        result.byPredicate[predicate].globalSafetyFailures)
    }
  }
})

test('the evaluator rejects an empty corpus instead of claiming a pass', () => {
  assert.throws(() => evaluateProposalRun({ cases: [], proposalsByCase: {} }), TypeError)
  assert.throws(() => evaluateProposalRun({ cases: corpus.cases }), TypeError)
})

test('the evaluator treats a label outside its own evidence as a corpus error', () => {
  const broken = {
    ...caseById('dec-01'),
    expected: [{
      op: 'assert',
      predicate: 'project.decision',
      eventKey: 'dec-01:missing',
      quote: '我们决定采用隔离账本作为唯一事实源。',
    }],
  }
  assert.throws(() => evaluateProposalRun({
    cases: [broken],
    proposalsByCase: { 'dec-01': encode([]) },
  }), TypeError)
})
