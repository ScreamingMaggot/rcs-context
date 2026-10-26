// Forward check with the new prompt on the strong model. Same corpus and gate as
// fresh-qwen.mjs; the API key is read from the environment and never logged.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeDurableUtterance,
  quoteWithinSpans,
} from '../../web/memory-durability.mjs'
import {
  buildProposalPrompt,
  parseProposalOutput,
  validateProposal,
} from '../../web/memory-proposals.mjs'

const BASE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(BASE, '..', '..')
const corpus = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'work', 'testspace2-online', 'semantic-attribution-corpus.json'), 'utf8'))
const SCOPE = 'ws:c:/users/administrator/desktop/testworkspace'
const ENDPOINT = 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions'
const MODEL = 'spark-x2.6'
const KEY = process.env.SPARK_API_KEY
if (!KEY) throw new Error('SPARK_API_KEY missing')
const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const contains = (outer, inner) => norm(outer).includes(norm(inner))

async function call(prompt) {
  const started = Date.now()
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 4096,
      stream: false,
      reasoning_effort: 'none',
    }),
    signal: AbortSignal.timeout(180000),
  })
  if (!response.ok) throw new Error(`spark-http:${response.status}`)
  const body = await response.json()
  return {
    text: body.choices?.[0]?.message?.content ?? '',
    finish: body.choices?.[0]?.finish_reason ?? null,
    elapsedMs: Date.now() - started,
  }
}

function recordFor(item) {
  return {
    eventKey: `${item.id}:m1`, scope: SCOPE, sid: 's1', seq: 1,
    validAt: 1000, recordedAt: 1000, human: true, sourceKind: 'user', text: item.text,
  }
}

const rows = []
for (const item of corpus.cases) {
  const analysis = analyzeDurableUtterance(item.text)
  if (!analysis.eligible) {
    rows.push({ id: item.id, class: item.class, status: 'skipped', reason: analysis.reason })
    console.log(`${item.id} skipped reason=${analysis.reason}`)
    continue
  }
  const record = recordFor(item)
  const prompt = buildProposalPrompt({ evidence: [record], activeFacts: [] })
  const response = await call(prompt)
  const parsed = parseProposalOutput(response.text)
  const accepted = []
  const rejected = []
  if (parsed.ok) {
    for (const proposal of parsed.proposals) {
      const quote = proposal.evidence.quote.trim()
      const start = item.text.indexOf(quote)
      if (start < 0 || !quoteWithinSpans(analysis.spans, start, start + quote.length)) {
        rejected.push('quote-outside-durable')
        continue
      }
      const result = validateProposal(proposal, {
        scope: SCOPE,
        evidenceByKey: new Map([[record.eventKey, record]]),
        activeFacts: [],
        enforceDurability: true,
      })
      if (result.ok) {
        accepted.push({
          predicate: result.proposal.predicate,
          quote: result.proposal.value?.text ?? result.proposal.span.quote,
          adjustment: result.predicateAdjustment ?? null,
        })
      } else {
        rejected.push(result.error)
      }
    }
  }
  const content = item.expected.length > 0 && item.expected.every((expected) =>
    accepted.some((entry) => contains(entry.quote, expected.phrase)))
  const predicate = item.expected.length > 0 && item.expected.every((expected) =>
    accepted.some((entry) =>
      entry.predicate === expected.predicate && contains(entry.quote, expected.phrase)))
  rows.push({
    id: item.id, class: item.class, status: parsed.ok ? 'scored' : parsed.error,
    elapsedMs: response.elapsedMs, finish: response.finish,
    rawProposals: parsed.ok ? parsed.proposals.length : 0,
    accepted, rejected, content, predicate,
    raw: response.text,
  })
  console.log(`${item.id} ${parsed.ok ? 'ok' : parsed.error} proposals=${parsed.ok ? parsed.proposals.length : 0} ` +
    `accepted=${accepted.length} content=${content} predicate=${predicate} ms=${response.elapsedMs}`)
}

const positives = rows.filter((row) => row.class !== 'task' && row.class !== 'question')
const negatives = rows.filter((row) => row.class === 'task' || row.class === 'question')
const summary = {
  policyVersion: 'durable-v1',
  promptVersion: 'p2-durable',
  model: MODEL,
  negatives: negatives.length,
  negativesSkipped: negatives.filter((row) => row.status === 'skipped').length,
  modelCalls: rows.filter((row) => row.status !== 'skipped').length,
  positives: positives.length,
  contentRate: positives.filter((row) => row.content).length / positives.length,
  predicateRate: positives.filter((row) => row.predicate).length / positives.length,
  predicateAdjustments: positives.reduce((sum, row) =>
    sum + row.accepted.filter((entry) => entry.adjustment).length, 0),
  rows,
}
fs.writeFileSync(path.join(BASE, 'fresh-spark.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  negatives: summary.negatives,
  negativesSkipped: summary.negativesSkipped,
  modelCalls: summary.modelCalls,
  positives: summary.positives,
  contentRate: summary.contentRate,
  predicateRate: summary.predicateRate,
  predicateAdjustments: summary.predicateAdjustments,
}, null, 2))
