// Controlled attribution experiment: model ability vs quote-boundary policy.
// Models see identical evidence/prompts; one raw response is scored under both
// the strict production boundary and a colon-left-margin relaxation.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildProposalPrompt,
  parseProposalOutput,
  validateProposal,
} from '../../web/memory-proposals.mjs'

const BASE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CORPUS = path.join(BASE, 'semantic-attribution-corpus.json')
const DEFAULT_OUT = path.join(BASE, 'semantic-attribution-result.json')
const OLLAMA = 'http://127.0.0.1:11434/api/chat'
const SPARK = 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions'
const SCOPE = 'ws:c:/users/administrator/desktop/testworkspace'
const MODEL_OPTS = Object.freeze({
  temperature: 0,
  seed: 42,
  top_k: 1,
  top_p: 1,
  repeat_penalty: 1,
  num_predict: 1024,
  num_ctx: 4096,
})

function args() {
  const out = { qwenReps: 6, sparkReps: 6, caseLimit: 0, corpus: DEFAULT_CORPUS, output: DEFAULT_OUT }
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i]
    const value = process.argv[i + 1]
    if (key === '--qwen-reps') { out.qwenReps = Number(value); i++ }
    else if (key === '--spark-reps') { out.sparkReps = Number(value); i++ }
    else if (key === '--case-limit') { out.caseLimit = Number(value); i++ }
    else if (key === '--corpus') { out.corpus = path.resolve(value); i++ }
    else if (key === '--out') { out.output = path.resolve(value); i++ }
  }
  return out
}

const opts = args()
const corpus = JSON.parse(fs.readFileSync(opts.corpus, 'utf8'))
const cases = opts.caseLimit > 0 ? corpus.cases.slice(0, opts.caseLimit) : corpus.cases
if (!cases.length) throw new Error('corpus is empty')

function evidenceFor(item) {
  return {
    eventKey: `${item.id}:m1`, scope: SCOPE, sid: 's1', seq: 1,
    validAt: 1000, recordedAt: 1000, human: true, sourceKind: 'user', text: item.text,
  }
}

function relaxedText(text) {
  return text.replaceAll('：', '：\n')
}

function normalized(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

function acceptedUnder(item, parsed, relaxed) {
  const record = evidenceFor(item)
  const map = new Map()
  const accepted = []
  for (const proposal of parsed.proposals) {
    const quote = relaxed ? relaxedText(proposal.evidence.quote) : proposal.evidence.quote
    const evidenceRecord = relaxed ? { ...record, text: relaxedText(record.text) } : record
    map.set(record.eventKey, evidenceRecord)
    const result = validateProposal(
      { ...proposal, evidence: { ...proposal.evidence, quote } },
      { scope: SCOPE, evidenceByKey: map, activeFacts: [] },
    )
    if (result.ok) {
      accepted.push({
        predicate: proposal.predicate,
        quote,
        value: result.proposal.value.text,
      })
    }
  }
  const seen = new Set()
  return accepted.filter((proposal) => {
    const key = `${proposal.predicate}\u0000${normalized(proposal.quote)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function score(item, parsed, relaxed) {
  const accepted = acceptedUnder(item, parsed, relaxed)
  if (item.expected.length === 0) {
    return { accepted, correct: 0, falsePositive: accepted.length, hit: accepted.length === 0 }
  }
  let correct = 0
  for (const expected of item.expected) {
    if (accepted.some((proposal) =>
      proposal.predicate === expected.predicate &&
      normalized(proposal.quote).includes(normalized(expected.phrase)))) {
      correct++
    }
  }
  return {
    accepted,
    correct,
    falsePositive: Math.max(0, accepted.length - correct),
    hit: correct === item.expected.length,
  }
}

async function qwen(prompt) {
  const response = await fetch(OLLAMA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3:4b-instruct-2507-q4_K_M',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: 'json',
      think: false,
      keep_alive: '10m',
      options: MODEL_OPTS,
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) throw new Error(`qwen-http:${response.status}`)
  const body = await response.json()
  return { text: body.message?.content ?? '', finish: body.done_reason ?? null }
}

async function spark(prompt) {
  const key = process.env.SPARK_API_KEY
  if (!key) throw new Error('SPARK_API_KEY missing')
  const response = await fetch(SPARK, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'spark-x2.6',
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
  return { text: body.choices?.[0]?.message?.content ?? '', finish: body.choices?.[0]?.finish_reason ?? null }
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function summarize(raw, model, reps) {
  const positive = cases.filter((item) => item.expected.length > 0)
  const negative = cases.filter((item) => item.expected.length === 0)
  const perRep = []
  for (let rep = 1; rep <= reps; rep++) {
    const rows = raw.filter((r) => r.model === model && r.rep === rep)
    const strictHits = rows.filter((r) => r.item.expected.length > 0 && r.strict.hit).length
    const relaxedHits = rows.filter((r) => r.item.expected.length > 0 && r.relaxed.hit).length
    const strictFP = rows.filter((r) => r.strict.falsePositive > 0).length
    const relaxedFP = rows.filter((r) => r.relaxed.falsePositive > 0).length
    const acceptedStrict = rows.reduce((n, r) => n + r.strict.accepted.length, 0)
    const acceptedRelaxed = rows.reduce((n, r) => n + r.relaxed.accepted.length, 0)
    const correctStrict = rows.reduce((n, r) => n + r.strict.correct, 0)
    const correctRelaxed = rows.reduce((n, r) => n + r.relaxed.correct, 0)
    perRep.push({
      rep,
      recallStrict: strictHits / positive.length,
      recallRelaxed: relaxedHits / positive.length,
      negativeCaseFPRateStrict: strictFP / negative.length,
      negativeCaseFPRateRelaxed: relaxedFP / negative.length,
      precisionStrict: acceptedStrict ? correctStrict / acceptedStrict : null,
      precisionRelaxed: acceptedRelaxed ? correctRelaxed / acceptedRelaxed : null,
      boundaryRescues: rows.filter((r) => r.boundaryRescue).length,
      invalidJSON: rows.filter((r) => r.parseError === 'invalid-json').length,
      otherParseErrors: rows.filter((r) => r.parseError && r.parseError !== 'invalid-json').length,
      empty: rows.filter((r) => r.parseError === null && r.rawProposals === 0).length,
    })
  }
  const means = {}
  for (const field of Object.keys(perRep[0]).filter((key) => key !== 'rep')) {
    const values = perRep.map((row) => row[field]).filter((value) => value !== null)
    if (!values.length) { means[field] = null; continue }
    means[field] = values.reduce((a, b) => a + b, 0) / values.length
    means[`${field}Min`] = Math.min(...values)
    means[`${field}Max`] = Math.max(...values)
  }
  const perCase = cases.map((item) => {
    const rows = raw.filter((r) => r.model === model && r.item.id === item.id)
    return {
      id: item.id,
      class: item.class,
      expected: item.expected,
      strictHits: rows.filter((r) => r.strict.hit).length,
      relaxedHits: rows.filter((r) => r.relaxed.hit).length,
      strictAccepted: rows.reduce((n, r) => n + r.strict.accepted.length, 0),
      relaxedAccepted: rows.reduce((n, r) => n + r.relaxed.accepted.length, 0),
      boundaryRescues: rows.filter((r) => r.boundaryRescue).length,
      quotes: [...new Set(rows.flatMap((r) => r.relaxed.accepted.map((p) => p.quote)))].slice(0, 5),
    }
  })
  return { reps, positiveCases: positive.length, negativeCases: negative.length, perRep, means, perCase }
}

const cache = new Map()
if (fs.existsSync(opts.output)) {
  try {
    for (const row of JSON.parse(fs.readFileSync(opts.output, 'utf8')).raw ?? []) {
      cache.set(`${row.model}\u0000${row.rep}\u0000${row.item.id}`, row)
    }
  } catch { /* replace a corrupt partial artifact */ }
}

const raw = []
const models = [
  { name: 'qwen3:4b', reps: opts.qwenReps, call: qwen },
  { name: 'spark-x2.6', reps: opts.sparkReps, call: spark },
]
for (const model of models) {
  for (let rep = 1; rep <= model.reps; rep++) {
    for (const item of cases) {
      const key = `${model.name}\u0000${rep}\u0000${item.id}`
      let row = cache.get(key)
      if (!row) {
        const evidence = evidenceFor(item)
        const prompt = buildProposalPrompt({ evidence: [evidence], activeFacts: [] })
        const started = Date.now()
        let response
        let error = null
        try {
          response = await model.call(prompt)
          const parsed = parseProposalOutput(response.text)
          const strict = parsed.ok
            ? score(item, parsed, false)
            : { accepted: [], correct: 0, falsePositive: 0, hit: item.expected.length === 0 }
          const relaxed = parsed.ok
            ? score(item, parsed, true)
            : { accepted: [], correct: 0, falsePositive: 0, hit: item.expected.length === 0 }
          row = {
            model: model.name,
            rep,
            item,
            prompt,
            raw: response.text,
            finish: response.finish,
            elapsedMs: Date.now() - started,
            parseError: parsed.ok ? null : parsed.error,
            rawProposals: parsed.ok ? parsed.proposals.length : 0,
            strict,
            relaxed,
            boundaryRescue: parsed.ok && !strict.hit && relaxed.hit &&
              strict.accepted.length === 0 && relaxed.accepted.length > 0,
            error: null,
          }
        } catch (failure) {
          error = String(failure?.message ?? failure)
          row = {
            model: model.name, rep, item, prompt, raw: '', finish: null,
            elapsedMs: Date.now() - started, parseError: 'call-failed',
            rawProposals: 0,
            strict: { accepted: [], correct: 0, falsePositive: 0, hit: item.expected.length === 0 },
            relaxed: { accepted: [], correct: 0, falsePositive: 0, hit: item.expected.length === 0 },
            boundaryRescue: false, error,
          }
        }
        cache.set(key, row)
        console.log(`${model.name} rep=${rep} case=${item.id} parse=${row.parseError ?? 'ok'} strict=${row.strict.hit} relaxed=${row.relaxed.hit} ms=${row.elapsedMs}${error ? ' error=' + error : ''}`)
      }
      raw.push(row)
    }
    fs.writeFileSync(opts.output, JSON.stringify({
      version: 'attribution-result-1',
      corpus: opts.corpus,
      models: models.map((m) => ({ name: m.name, reps: m.reps })),
      updatedAt: new Date().toISOString(),
      raw,
    }, null, 2) + '\n', 'utf8')
  }
}

const summary = {
  corpus: opts.corpus,
  cases: cases.length,
  models: Object.fromEntries(models.map((model) => [
    model.name,
    summarize(raw, model.name, model.reps),
  ])),
  strictVsRelaxed: Object.fromEntries(models.map((model) => {
    const rows = raw.filter((r) => r.model === model.name)
    return [model.name, {
      boundaryRescueSamples: rows.filter((r) => r.boundaryRescue).length,
      strictRejectedRelaxedAccepted: rows.filter((r) =>
        r.strict.accepted.length === 0 && r.relaxed.accepted.length > 0).length,
      strictOnlyFalseNegatives: rows.filter((r) =>
        r.item.expected.length > 0 && !r.strict.hit && r.relaxed.hit).length,
      modelFalsePositivesRelaxed: rows.reduce((n, r) => n + r.relaxed.falsePositive, 0),
    }]
  })),
  elapsed: {
    qwenP50: percentile(raw.filter((r) => r.model === 'qwen3:4b').map((r) => r.elapsedMs), 0.5),
    qwenP95: percentile(raw.filter((r) => r.model === 'qwen3:4b').map((r) => r.elapsedMs), 0.95),
    sparkP50: percentile(raw.filter((r) => r.model === 'spark-x2.6').map((r) => r.elapsedMs), 0.5),
    sparkP95: percentile(raw.filter((r) => r.model === 'spark-x2.6').map((r) => r.elapsedMs), 0.95),
  },
}
const payload = {
  version: 'attribution-result-1',
  corpus: opts.corpus,
  models: models.map((m) => ({ name: m.name, reps: m.reps })),
  updatedAt: new Date().toISOString(),
  summary,
  raw,
}
fs.writeFileSync(opts.output, JSON.stringify(payload, null, 2) + '\n', 'utf8')
console.log(JSON.stringify(summary, null, 2))
