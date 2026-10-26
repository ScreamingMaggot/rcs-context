// Read-only breakdown of the 864-sample attribution run. Re-parses and re-validates
// every stored raw model output under both boundary policies; no model calls.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseProposalOutput,
  validateProposal,
} from '../../web/memory-proposals.mjs'

const BASE = path.dirname(fileURLToPath(import.meta.url))
const INPUT = path.join(BASE, '..', 'testspace2-online', 'semantic-attribution-result.json')
const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'))
const SCOPE = 'ws:c:/users/administrator/desktop/testworkspace'

function evidenceFor(item) {
  return {
    eventKey: `${item.id}:m1`, scope: SCOPE, sid: 's1', seq: 1,
    validAt: 1000, recordedAt: 1000, human: true, sourceKind: 'user', text: item.text,
  }
}
const relaxedText = (text) => text.replaceAll('：', '：\n')
const norm = (text) => String(text).replace(/\s+/g, ' ').trim()

function scoreRow(row, relaxed) {
  const base = evidenceFor(row.item)
  const record = relaxed ? { ...base, text: relaxedText(base.text) } : base
  const out = { accepted: [], rejected: [] }
  const parsed = parseProposalOutput(row.raw)
  if (!parsed.ok) return { ...out, parseError: parsed.error }
  const map = new Map([[record.eventKey, record]])
  for (const proposal of parsed.proposals) {
    const quote = relaxed ? relaxedText(proposal.evidence.quote) : proposal.evidence.quote
    const result = validateProposal(
      { ...proposal, evidence: { ...proposal.evidence, quote } },
      { scope: SCOPE, evidenceByKey: map, activeFacts: [] },
    )
    if (result.ok) out.accepted.push({ predicate: proposal.predicate, quote, value: result.proposal.value.text })
    else out.rejected.push({ predicate: proposal.predicate, quote, error: result.error })
  }
  return out
}

function contentMatches(accepted, expected) {
  return expected.length > 0 && expected.every((item) =>
    accepted.some((proposal) => norm(proposal.quote).includes(norm(item.phrase))))
}

const cases = new Map()
const byModel = {}
for (const row of data.raw) {
  const item = row.item
  if (!cases.has(item.id)) cases.set(item.id, item)
  const model = (byModel[row.model] ??= {
    rows: 0, rawProposals: 0, parseErrors: 0, empty: 0,
    cases: {}, rejectReasons: {}, predicateWrong: {}, accepted: 0, rejected: 0,
  })
  model.rows++
  const strict = scoreRow(row, false)
  const relaxed = scoreRow(row, true)
  const parsed = parseProposalOutput(row.raw)
  if (!parsed.ok) model.parseErrors++
  else {
    model.rawProposals += parsed.proposals.length
    if (parsed.proposals.length === 0) model.empty++
    for (const proposal of parsed.proposals) {
      const rejected = relaxed.rejected.find((entry) => entry.quote === relaxedText(proposal.evidence.quote))
      if (rejected) model.rejectReasons[rejected.error] = (model.rejectReasons[rejected.error] ?? 0) + 1
    }
  }
  model.accepted += relaxed.accepted.length
  model.rejected += relaxed.rejected.length
  const entry = (model.cases[item.id] ??= {
    id: item.id, class: item.class, samples: 0, rawProposals: 0, emptySamples: 0,
    strictAccepted: 0, relaxedAccepted: 0, contentStrict: 0, contentRelaxed: 0,
    predicateHits: 0, rawQuotes: {}, relaxedRejects: {},
  })
  entry.samples++
  entry.rawProposals += parsed.ok ? parsed.proposals.length : 0
  if (parsed.ok && parsed.proposals.length === 0) entry.emptySamples++
  entry.strictAccepted += strict.accepted.length
  entry.relaxedAccepted += relaxed.accepted.length
  if (contentMatches(strict.accepted, item.expected)) entry.contentStrict++
  if (contentMatches(relaxed.accepted, item.expected)) entry.contentRelaxed++
  if (item.expected.length > 0 && item.expected.every((expected) =>
    relaxed.accepted.some((proposal) => proposal.predicate === expected.predicate &&
      norm(proposal.quote).includes(norm(expected.phrase))))) entry.predicateHits++
  for (const proposal of parsed.ok ? parsed.proposals : []) {
    const key = `${proposal.predicate} | ${proposal.evidence.quote}`
    entry.rawQuotes[key] = (entry.rawQuotes[key] ?? 0) + 1
  }
  for (const rejection of relaxed.rejected) {
    entry.relaxedRejects[rejection.error] = (entry.relaxedRejects[rejection.error] ?? 0) + 1
  }
}

const summary = {
  models: Object.fromEntries(Object.entries(byModel).map(([name, model]) => [name, {
    rows: model.rows,
    avgRawProposals: +(model.rawProposals / model.rows).toFixed(3),
    emptyRate: +(model.empty / model.rows).toFixed(3),
    parseErrorRate: +(model.parseErrors / model.rows).toFixed(3),
    rejectReasons: model.rejectReasons,
    accepted: model.accepted,
    rejected: model.rejected,
    cases: Object.fromEntries(Object.values(model.cases).map((entry) => [entry.id, {
      id: entry.id,
      class: entry.class,
      samples: entry.samples,
      avgRaw: +(entry.rawProposals / entry.samples).toFixed(2),
      emptyRate: +(entry.emptySamples / entry.samples).toFixed(2),
      strictAccepted: entry.strictAccepted,
      relaxedAccepted: entry.relaxedAccepted,
      contentStrictRate: +(entry.contentStrict / entry.samples).toFixed(3),
      contentRelaxedRate: +(entry.contentRelaxed / entry.samples).toFixed(3),
      predicateHitRate: +(entry.predicateHits / entry.samples).toFixed(3),
      relaxedRejects: entry.relaxedRejects,
      topQuotes: Object.entries(entry.rawQuotes)
        .sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([quote, count]) => ({ count, quote })),
    }])),
  }])),
}

fs.writeFileSync(path.join(BASE, 'analysis.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')

// Compact console view: per model, negatives then positives.
for (const [name, model] of Object.entries(summary.models)) {
  console.log(`\n=== ${name} rows=${model.rows} avgRaw=${model.avgRawProposals} empty=${model.emptyRate} parseErr=${model.parseErrorRate}`)
  console.log('rejectReasons', model.rejectReasons)
  for (const entry of Object.values(model.cases)) {
    if (entry.class === 'task' || entry.class === 'question') {
      console.log(`NEG ${entry.id} samples=${entry.samples} avgRaw=${entry.avgRaw} empty=${entry.emptyRate} accepted=${entry.relaxedAccepted} rejects=${JSON.stringify(entry.relaxedRejects)}`)
      for (const quote of entry.topQuotes) console.log(`   ${quote.count}x ${quote.quote.slice(0, 110)}`)
    }
  }
  for (const entry of Object.values(model.cases)) {
    if (entry.class !== 'task' && entry.class !== 'question') {
      console.log(`POS ${entry.id} samples=${entry.samples} contentR=${entry.contentRelaxedRate} predicateR=${entry.predicateHitRate} accepted=${entry.relaxedAccepted} rejects=${JSON.stringify(entry.relaxedRejects)}`)
      for (const quote of entry.topQuotes) console.log(`   ${quote.count}x ${quote.quote.slice(0, 110)}`)
    }
  }
}
