// Production-policy replay: the stored raw model outputs are re-validated by the
// current parseProposalOutput + validateProposal (durable gate, boundary, predicate
// resolution). No model is called and no ledger/database is touched.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseProposalOutput,
  validateProposal,
} from '../../web/memory-proposals.mjs'
import {
  analyzeDurableUtterance,
  DURABILITY_POLICY_VERSION,
} from '../../web/memory-durability.mjs'

const BASE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(BASE, '..', '..')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const SCOPE = 'ws:c:/users/administrator/desktop/testworkspace'

function attributionRecord(item) {
  return {
    eventKey: `${item.id}:m1`, scope: SCOPE, sid: 's1', seq: 1,
    validAt: 1000, recordedAt: 1000, human: true, sourceKind: 'user', text: item.text,
  }
}

function acceptedFor(item, raw, record, { activeFacts = [], scope = SCOPE } = {}) {
  const parsed = parseProposalOutput(raw)
  if (!parsed.ok) return { parsedError: parsed.error, accepted: [], rejected: [] }
  const map = new Map([[record.eventKey, record]])
  const accepted = []
  const rejected = []
  for (const proposal of parsed.proposals) {
    const result = validateProposal(proposal, {
      scope, evidenceByKey: map, activeFacts, enforceDurability: true,
    })
    if (result.ok) {
      accepted.push({
        predicate: result.proposal.predicate,
        quote: result.proposal.value?.text ?? result.proposal.span.quote,
        op: result.proposal.op,
        adjustment: result.predicateAdjustment ?? null,
      })
    } else {
      rejected.push({ predicate: proposal.predicate, quote: proposal.evidence.quote, error: result.error })
    }
  }
  return { parsedError: null, accepted, rejected }
}

function contains(outer, inner) {
  return norm(outer).includes(norm(inner))
}

// The evaluator treats a contiguous sub/super-span of a label as a noncanonical
// match (real evidence, same meaning), not a fabrication. Mirror that relation.
function equivalentQuote(a, b) {
  return contains(a, b) || contains(b, a)
}

function runAttribution() {
  const data = readJson(path.join(ROOT, 'work', 'testspace2-online', 'semantic-attribution-result.json'))
  const out = {}
  for (const model of ['qwen3:4b', 'spark-x2.6']) {
    const stats = {
      model, rows: 0, negativeSamples: 0, negativeAcceptedSamples: 0,
      positiveSamples: 0, contentHits: 0, predicateHits: 0,
      accepted: 0, rejected: 0, rejectionReasons: {}, predicateAdjustments: 0,
      fpExamples: [], missExamples: [],
    }
    for (const row of data.raw.filter((entry) => entry.model === model)) {
      stats.rows++
      const record = attributionRecord(row.item)
      const result = acceptedFor(row.item, row.raw, record)
      stats.accepted += result.accepted.length
      stats.rejected += result.rejected.length
      for (const rejection of result.rejected) {
        stats.rejectionReasons[rejection.error] = (stats.rejectionReasons[rejection.error] ?? 0) + 1
      }
      for (const accepted of result.accepted) {
        if (accepted.adjustment) stats.predicateAdjustments++
      }
      if (row.item.expected.length === 0) {
        stats.negativeSamples++
        if (result.accepted.length > 0) {
          stats.negativeAcceptedSamples++
          if (stats.fpExamples.length < 4) {
            stats.fpExamples.push({
              id: row.item.id,
              accepted: result.accepted.map((item) => ({ predicate: item.predicate, quote: item.quote })),
            })
          }
        }
        continue
      }
      stats.positiveSamples++
      const content = row.item.expected.every((expected) =>
        result.accepted.some((accepted) => contains(accepted.quote, expected.phrase)))
      const predicate = row.item.expected.every((expected) =>
        result.accepted.some((accepted) =>
          accepted.predicate === expected.predicate && contains(accepted.quote, expected.phrase)))
      if (content) stats.contentHits++
      if (predicate) stats.predicateHits++
      if (!content && stats.missExamples.length < 4) {
        stats.missExamples.push({
          id: row.item.id,
          expected: row.item.expected,
          accepted: result.accepted.map((item) => ({ predicate: item.predicate, quote: item.quote })),
          rejected: result.rejected.slice(0, 2),
        })
      }
    }
    stats.contentRate = stats.contentHits / stats.positiveSamples
    stats.predicateRate = stats.predicateHits / stats.positiveSamples
    stats.negativeFPRate = stats.negativeAcceptedSamples / stats.negativeSamples
    out[model] = stats
  }
  return out
}

function baselineContext(row) {
  const scope = row.scope ?? 'workspace:test'
  const evidence = (row.evidence ?? []).map((event, index) => ({
    scope,
    sid: `sid:${row.id}`,
    seq: index + 1,
    validAt: 1000 * (index + 1),
    recordedAt: 1000 * (index + 1),
    human: true,
    sourceKind: 'user',
    ...event,
  }))
  const activeFacts = (row.activeFacts ?? []).map((fact) => ({
    scope,
    status: 'active',
    conflict: null,
    validFrom: 0,
    seq: 0,
    ...fact,
  }))
  return { scope, evidence, activeFacts, byKey: new Map(evidence.map((event) => [event.eventKey, event])) }
}

function runBaseline() {
  const corpus = readJson(path.join(ROOT, 'work', 'memory-ledger-20261025', 'proposal-corpus.json'))
  const baseline = readJson(path.join(ROOT, 'work', 'memory-ledger-20261025', 'proposal-baseline.json'))
  const caseById = new Map(corpus.cases.map((item) => [item.id, item]))
  const stats = {
    cases: 0, tp: 0, fp: 0, fn: 0, negativeFPs: 0,
    accepted: 0, rejected: 0, rejectionReasons: {}, predicateAdjustments: 0,
    predicateOnlyErrors: 0, fpDetails: [], fnDetails: [],
  }
  for (const row of baseline.cases) {
    const item = caseById.get(row.id)
    if (!item) continue
    stats.cases++
    const context = baselineContext(row)
    const parsed = parseProposalOutput(row.raw ?? '')
    const accepted = []
    if (parsed.ok) {
      for (const proposal of parsed.proposals) {
        const result = validateProposal(proposal, {
          scope: context.scope,
          evidenceByKey: context.byKey,
          activeFacts: context.activeFacts,
          enforceDurability: true,
        })
        if (result.ok) {
          accepted.push({
            op: result.proposal.op,
            predicate: result.proposal.predicate,
            quote: result.proposal.value?.text ?? result.proposal.span.quote,
            adjustment: result.predicateAdjustment ?? null,
          })
          if (result.predicateAdjustment) stats.predicateAdjustments++
        } else {
          stats.rejected++
          stats.rejectionReasons[result.error] = (stats.rejectionReasons[result.error] ?? 0) + 1
        }
      }
    }
    stats.accepted += accepted.length
    for (const expected of item.expected) {
      const hit = accepted.some((entry) =>
        (entry.op ?? 'assert') === expected.op &&
        entry.predicate === expected.predicate &&
        equivalentQuote(entry.quote, expected.quote))
      if (hit) stats.tp++
      else {
        stats.fn++
        if (stats.fnDetails.length < 8) {
          stats.fnDetails.push({ id: item.id, expected, accepted })
        }
      }
    }
    for (const entry of accepted) {
      const hit = item.expected.some((expected) =>
        (entry.op ?? 'assert') === expected.op &&
        entry.predicate === expected.predicate &&
        equivalentQuote(entry.quote, expected.quote))
      if (!hit) {
        stats.fp++
        if (item.expected.length === 0) stats.negativeFPs++
        if (stats.fpDetails.length < 8) {
          stats.fpDetails.push({ id: item.id, accepted: entry, expected: item.expected })
        }
      }
    }
  }
  stats.precision = stats.tp + stats.fp > 0 ? stats.tp / (stats.tp + stats.fp) : null
  stats.recall = stats.tp + stats.fn > 0 ? stats.tp / (stats.tp + stats.fn) : null
  return stats
}

const result = {
  policyVersion: DURABILITY_POLICY_VERSION,
  generatedAt: new Date().toISOString(),
  attribution: runAttribution(),
  baseline: runBaseline(),
}
fs.writeFileSync(path.join(BASE, 'replay-production.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(result, null, 2))
