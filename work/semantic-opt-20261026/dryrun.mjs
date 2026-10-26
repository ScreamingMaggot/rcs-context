// Dry-run the durability policy against both labelled corpora and the stored 864
// model outputs. No production file or model is touched.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeDurableUtterance,
  quoteWithinSpans,
  resolveQuotePredicate,
} from '../../web/memory-durability.mjs'
import { parseProposalOutput } from '../../web/memory-proposals.mjs'

const BASE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(BASE, '..', '..')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

function predicateForQuote(analysis, messageText, quote) {
  const start = messageText.indexOf(quote)
  if (start < 0) return resolveQuotePredicate(quote)
  const span = analysis.spans.find((item) =>
    start >= item.start && start + quote.length <= item.end)
  return resolveQuotePredicate(span ? messageText.slice(span.start, span.end) : quote)
}

const corpus85 = readJson(path.join(ROOT, 'work', 'memory-ledger-20261025', 'proposal-corpus.json'))
const corpus24 = readJson(path.join(ROOT, 'work', 'testspace2-online', 'semantic-attribution-corpus.json'))
const baseline = readJson(path.join(ROOT, 'work', 'memory-ledger-20261025', 'proposal-baseline.json'))
const attribution = readJson(path.join(ROOT, 'work', 'testspace2-online', 'semantic-attribution-result.json'))

function checkCorpus(name, cases) {
  const problems = []
  for (const item of cases) {
    const events = item.events ?? [{ eventKey: `${item.id}:m1`, text: item.text, sourceKind: 'user' }]
    const userEvents = events.filter((event) => (event.sourceKind ?? 'user') === 'user')
    const analyses = userEvents.map((event) => ({ event, analysis: analyzeDurableUtterance(event.text) }))
    const eligible = analyses.some(({ analysis }) => analysis.eligible)
    if (item.expected.length > 0 && !eligible) {
      problems.push({ id: item.id, kind: item.kind ?? item.class, problem: 'positive-ineligible', text: userEvents.map((e) => e.text).join(' || '), reasons: analyses.map(({ analysis }) => analysis.reason) })
    }
    if (item.expected.length === 0 && eligible) {
      problems.push({ id: item.id, kind: item.kind ?? item.class, problem: 'negative-eligible', text: userEvents.map((e) => e.text).join(' || '), spans: analyses.flatMap(({ analysis }) => analysis.spans) })
    }
    // Predicate labels: resolve on each expected quote where it can be located.
    for (const expected of item.expected) {
      const quote = expected.quote ?? expected.phrase
      const event = userEvents.find((e) => e.text.includes(quote))
      if (!event) continue
      const analysis = analyzeDurableUtterance(event.text)
      const resolved = predicateForQuote(analysis, event.text, quote)
      if (resolved && resolved.predicate !== expected.predicate) {
        problems.push({ id: item.id, kind: item.kind ?? item.class, problem: 'predicate-mismatch', expected: expected.predicate, got: resolved, quote })
      }
    }
  }
  console.log(`\n=== ${name}: ${cases.length} cases, ${problems.length} problems`)
  for (const problem of problems) console.log(JSON.stringify(problem))
  return problems
}

const p85 = checkCorpus('85-case corpus', corpus85.cases)
const p24 = checkCorpus('24-case corpus', corpus24.cases)

// Replay the 85-case single Qwen outputs through the gate + predicate resolver.
// Boundary / evidence validation is added after production integration.
const caseById = new Map(corpus85.cases.map((item) => [item.id, item]))
const replay85 = { tp: 0, fp: 0, fn: 0, gateRejects: {}, accepted: 0, predicateFixed: 0, fnDetails: [], fpDetails: [] }
for (const row of baseline.cases) {
  const item = caseById.get(row.id)
  if (!item) continue
  const parsed = parseProposalOutput(row.raw ?? '')
  const accepted = []
  if (parsed.ok) {
    for (const proposal of parsed.proposals) {
      const event = item.events.find((e) => e.eventKey === proposal.evidence.eventKey)
      if (!event) continue
      if ((event.sourceKind ?? 'user') !== 'user') continue
      const analysis = analyzeDurableUtterance(event.text)
      if (!analysis.eligible) {
        replay85.gateRejects[analysis.reason] = (replay85.gateRejects[analysis.reason] ?? 0) + 1
        continue
      }
      const quote = proposal.evidence.quote.trim()
      const start = event.text.indexOf(quote)
      if (start < 0 || !quoteWithinSpans(analysis.spans, start, start + quote.length)) {
        replay85.gateRejects['quote-outside-spans'] = (replay85.gateRejects['quote-outside-spans'] ?? 0) + 1
        continue
      }
      const resolved = predicateForQuote(analysis, event.text, quote)
      if (resolved && resolved.predicate !== proposal.predicate) replay85.predicateFixed++
      const predicate = resolved?.predicate ?? proposal.predicate
      accepted.push({ predicate, quote })
    }
  }
  replay85.accepted += accepted.length
  for (const expected of item.expected) {
    const hit = accepted.some((p) =>
      p.predicate === expected.predicate &&
      (norm(p.quote).includes(norm(expected.quote)) || norm(expected.quote).includes(norm(p.quote))))
    if (hit) replay85.tp++
    else {
      replay85.fn++
      replay85.fnDetails.push({ id: item.id, expected, accepted })
    }
  }
  for (const p of accepted) {
    const expectedHit = item.expected.some((expected) =>
      expected.predicate === p.predicate &&
      (norm(p.quote).includes(norm(expected.quote)) || norm(expected.quote).includes(norm(p.quote))))
    if (!expectedHit) {
      replay85.fp++
      replay85.fpDetails.push({ id: item.id, accepted: p, expected: item.expected })
    }
  }
}
console.log('\n=== 85-case Qwen replay (gate + predicate only)')
console.log(JSON.stringify(replay85, null, 2))

// Replay the 864 attribution outputs under the gate + predicate resolver.
for (const model of ['qwen3:4b', 'spark-x2.6']) {
  const stats = {
    model, rows: 0, negatives: 0, negativeAccepted: 0, positiveSamples: 0,
    contentHit: 0, predicateHit: 0, gateRejects: {}, predicateFixed: 0,
    negativeQuotes: {},
  }
  for (const row of attribution.raw.filter((r) => r.model === model)) {
    stats.rows++
    const item = row.item
    const analysis = analyzeDurableUtterance(item.text)
    const parsed = parseProposalOutput(row.raw)
    const accepted = []
    if (parsed.ok && analysis.eligible) {
      for (const proposal of parsed.proposals) {
        const quote = proposal.evidence.quote.trim()
        const start = item.text.indexOf(quote)
        if (start < 0 || !quoteWithinSpans(analysis.spans, start, start + quote.length)) {
          stats.gateRejects['quote-outside-spans'] = (stats.gateRejects['quote-outside-spans'] ?? 0) + 1
          continue
        }
        const resolved = predicateForQuote(analysis, item.text, quote)
        if (resolved && resolved.predicate !== proposal.predicate) stats.predicateFixed++
        accepted.push({ predicate: resolved?.predicate ?? proposal.predicate, quote })
      }
    } else if (parsed.ok && !analysis.eligible) {
      stats.gateRejects[analysis.reason] = (stats.gateRejects[analysis.reason] ?? 0) + 1
      for (const proposal of parsed.proposals) {
        const key = `${proposal.predicate} | ${proposal.evidence.quote.trim()}`
        stats.negativeQuotes[key] = (stats.negativeQuotes[key] ?? 0) + 1
      }
    }
    if (item.expected.length === 0) {
      stats.negatives++
      if (accepted.length > 0) stats.negativeAccepted++
      continue
    }
    stats.positiveSamples++
    const content = item.expected.every((expected) =>
      accepted.some((p) => norm(p.quote).includes(norm(expected.phrase))))
    const predicate = item.expected.every((expected) =>
      accepted.some((p) => p.predicate === expected.predicate && norm(p.quote).includes(norm(expected.phrase))))
    if (content) stats.contentHit++
    if (predicate) stats.predicateHit++
  }
  stats.contentRate = stats.contentHit / stats.positiveSamples
  stats.predicateRate = stats.predicateHit / stats.positiveSamples
  stats.negativeFPRate = stats.negativeAccepted / stats.negatives
  stats.topNegativeQuotes = Object.entries(stats.negativeQuotes).sort((a, b) => b[1] - a[1]).slice(0, 6)
  console.log(`\n=== ${model} 864 replay (gate + predicate only)`)
  console.log(JSON.stringify(stats, null, 2))
}

console.log(`\nproblems85=${p85.length} problems24=${p24.length}`)
