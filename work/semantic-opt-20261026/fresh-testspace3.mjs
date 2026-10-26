// Forward check on the three gate-eligible human messages recovered from the
// TESTspace3 logs. One Qwen call per unique message; no ledger writes.
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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCOPE = 'ws:c:/users/administrator/desktop/testspace3'
const OLLAMA = 'http://127.0.0.1:11434/api/chat'
const MODEL = 'qwen3:4b-instruct-2507-q4_K_M'
const OPTIONS = Object.freeze({
  temperature: 0, seed: 42, top_k: 1, top_p: 1, repeat_penalty: 1,
  num_predict: 1024, num_ctx: 4096,
})
const messages = [
  '耐久规则：项目约定：所有测试统一使用 node:test',
  'OK，请记住：项目约定所有测试统一使用 node:test',
]

async function call(prompt) {
  const started = Date.now()
  const response = await fetch(OLLAMA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: 'json',
      think: false,
      keep_alive: '10m',
      options: OPTIONS,
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) throw new Error(`qwen-http:${response.status}`)
  const body = await response.json()
  return { text: body.message?.content ?? '', elapsedMs: Date.now() - started }
}

const rows = []
for (let index = 0; index < messages.length; index++) {
  const text = messages[index]
  const analysis = analyzeDurableUtterance(text)
  const record = {
    eventKey: `testspace3:${index + 1}:m1`, scope: SCOPE, sid: 'replay', seq: index + 1,
    validAt: 1000 + index, recordedAt: 1000 + index,
    human: true, sourceKind: 'user', text,
  }
  const prompt = buildProposalPrompt({ evidence: [record], activeFacts: [] })
  const response = await call(prompt)
  const parsed = parseProposalOutput(response.text)
  const accepted = []
  const rejected = []
  if (parsed.ok) {
    for (const proposal of parsed.proposals) {
      const quote = proposal.evidence.quote.trim()
      const start = text.indexOf(quote)
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
  rows.push({
    message: text,
    gate: { eligible: analysis.eligible, reason: analysis.reason },
    elapsedMs: response.elapsedMs,
    raw: response.text,
    parseError: parsed.ok ? null : parsed.error,
    accepted,
    rejected,
  })
  console.log(JSON.stringify(rows.at(-1), null, 2))
}
fs.writeFileSync(path.join(HERE, 'fresh-testspace3.json'), `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
