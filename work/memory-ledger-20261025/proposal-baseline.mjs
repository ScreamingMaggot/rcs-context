#!/usr/bin/env node
// Offline, explicit local-model baseline for the Cycle 2 proposal layer.
//
// Properties this runner deliberately keeps:
//  - No implicit inputs. `--model`, `--corpus`, and `--out` are required; there is
//    no default corpus, no default model, and no "latest" resolution.
//  - One fixed endpoint. The Ollama URL is a module constant on 127.0.0.1:11434 and
//    is re-checked before every call. OLLAMA_HOST and friends are never read.
//  - No live state. The only writes are the output artifact and its per-case
//    checkpoint, both confined to `work/`. No SQLite, journal, route, or ledger
//    module is imported, so a baseline run cannot enable a route or write a fact.
//  - Raw before validation. Each accepted HTTP answer is written to the checkpoint
//    before parseProposalOutput/validateProposal/evaluateProposalRun ever see it,
//    so a crash mid-evaluation cannot lose or rewrite model text.
//  - Production scoring. Every case is scored by the same parser, validator, and
//    offline evaluator the live path uses; this file adds no scoring rule of its
//    own. Per-proposal validator verdicts are reported next to the evaluator's
//    disposition so a divergence (for example the evaluator's terminal-sentence
//    allowance) is visible instead of hidden.
//  - Honest labels. Corpus labels are never rewritten here. If a label cannot be
//    extracted by the production validator the run stops before any model call.
//  - Bounded retry. `baseAttempts` is frozen before the first call and the loop is
//    bounded by baseAttempts + MAX_ATTEMPTS_PER_CASE. Recording an attempt inside
//    the loop can never extend the bound. `--self-test` exercises exhaustion.
//  - Source binding. The checkpoint/artifact identity records the sha256 of this
//    runner and of web/memory-proposals.mjs, next to the per-case prompt hashes.
//
// Usage:
//   node work/memory-ledger-20261025/proposal-baseline.mjs \
//     --model qwen3:4b-instruct-2507-q4_K_M \
//     --corpus work/memory-ledger-20261025/proposal-corpus.json \
//     --out work/memory-ledger-20261025/proposal-baseline.json [--limit N]
//
// Resume: rerun the same command (same --out). Finished cases are read back from
// the checkpoint, re-scored against the recorded raw text, and skipped; unfinished
// or failed cases are attempted again.
//
// Self-test: `node proposal-baseline.mjs --self-test` runs the retry-bound
// simulations only. It needs no model, corpus, or output path and writes nothing.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  PROPOSAL_SCHEMA_VERSION,
  buildProposalPrompt,
  evaluateProposalRun,
  parseProposalOutput,
  validateProposal,
} from '../../web/memory-proposals.mjs'

const RUNNER_VERSION = 'proposal-baseline/2'
const ARTIFACT_SCHEMA = 'rcs.proposal-baseline/1'
// Bumped when scoring, retry, or artifact semantics change. `proposal-baseline/2`
// bounds retries on the frozen base attempt count, re-scores every cached answer
// on resume, and binds the runner/evaluator source hashes into the identity.

// Fixed local endpoint. There is no flag that can move it.
const OLLAMA_BASE = 'http://127.0.0.1:11434'
const OLLAMA_CHAT = `${OLLAMA_BASE}/api/chat`
const OLLAMA_TAGS = `${OLLAMA_BASE}/api/tags`
const OLLAMA_VERSION = `${OLLAMA_BASE}/api/version`
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const LOCAL_PORT = '11434'

// Deterministic decoding. Seed plus greedy sampling, no penalties, bounded output.
const MODEL_OPTIONS = Object.freeze({
  temperature: 0,
  seed: 42,
  top_k: 1,
  top_p: 1,
  repeat_penalty: 1,
  num_predict: 512,
  num_ctx: 2048,
})
const KEEP_ALIVE = '10m'
const REQUEST_TIMEOUT_DEFAULT_MS = 240_000
const MAX_ATTEMPTS_PER_CASE = 2
// The corpus fixes only identity and predicate for a correction/retraction target.
// These placeholders satisfy the target checks; they are not production values.
// `text:null` renders as `text:null` in ACTIVE FACTS, and 500/0 are older than any
// case event. Kept in one place so the artifact caveat cannot drift from the plan.
const SYNTHETIC_ACTIVE_TARGET = Object.freeze({ text: null, validFrom: 500, seq: 0 })

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
// work/memory-ledger-20261025 -> work/. Artifacts may only be written inside it.
const WORK_ROOT = path.resolve(SCRIPT_DIR, '..')
// Audit binding: the two sources that decide what a case means and how it is
// scored. Both hashes are recorded in the identity; only the output-determining
// fields gate a resume (see OUTPUT_IDENTITY_KEYS).
const RUNNER_SOURCE_PATH = fileURLToPath(import.meta.url)
const EVALUATOR_SOURCE_PATH = path.resolve(SCRIPT_DIR, '../../web/memory-proposals.mjs')
const EVALUATOR_SOURCE_LABEL = 'web/memory-proposals.mjs'
const OUTPUT_IDENTITY_KEYS = Object.freeze([
  'model', 'digest', 'corpusSha256', 'schemaVersion', 'promptVersion', 'options', 'request',
])

// ---------------------------------------------------------------------------
// Small utilities

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file))
}

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

// Atomic replace so an interrupted write never leaves half a checkpoint.
function writeJsonAtomic(file, value) {
  ensureDir(file)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function usageError(message) {
  const error = new Error(message)
  error.exitCode = 2
  error.kind = 'usage'
  return error
}

function stopError(message, exitCode, kind = 'refused') {
  const error = new Error(message)
  error.exitCode = exitCode
  error.kind = kind
  return error
}

function parseIntegerFlag(name, raw, { min = 1 } = {}) {
  if (!/^\d+$/.test(raw)) throw usageError(`${name} must be a positive integer, got "${raw}"`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw usageError(`${name} must be an integer >= ${min}, got "${raw}"`)
  }
  return value
}

const USAGE = `proposal-baseline — offline local-model baseline for the proposal layer

Required:
  --model <name>       exact Ollama model tag (resolved against ${OLLAMA_TAGS})
  --corpus <path>      labelled corpus JSON (schema ${PROPOSAL_SCHEMA_VERSION})
  --out <path>         result artifact; must live under ${WORK_ROOT}

Optional:
  --limit <n>          only the first n corpus cases (a partial measurement)
  --checkpoint <path>  per-case checkpoint (default: <out>.checkpoint.json)
  --restart            discard an existing checkpoint before running
  --timeout-ms <n>     per-request timeout (default ${REQUEST_TIMEOUT_DEFAULT_MS})
  --self-test          run the retry-bound simulations only; no model, corpus, or
                       output path is needed and nothing is written
  --help               print this text

The model endpoint is fixed at ${OLLAMA_CHAT}; there is no URL option.`

// ---------------------------------------------------------------------------
// Arguments and path discipline

function parseArgs(argv) {
  const options = {
    model: null,
    corpus: null,
    out: null,
    limit: null,
    checkpoint: null,
    restart: false,
    timeoutMs: REQUEST_TIMEOUT_DEFAULT_MS,
    help: false,
    selfTest: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const takeValue = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw usageError(`${arg} requires a value`)
      }
      index++
      return value
    }
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true
        break
      case '--model':
        options.model = takeValue()
        break
      case '--corpus':
        options.corpus = takeValue()
        break
      case '--out':
        options.out = takeValue()
        break
      case '--limit':
        options.limit = parseIntegerFlag('--limit', takeValue())
        break
      case '--checkpoint':
        options.checkpoint = takeValue()
        break
      case '--restart':
        options.restart = true
        break
      case '--self-test':
        options.selfTest = true
        break
      case '--timeout-ms':
        options.timeoutMs = parseIntegerFlag('--timeout-ms', takeValue(), { min: 1000 })
        break
      default:
        throw usageError(`unknown argument "${arg}"`)
    }
  }
  if (options.help) return options
  if (options.selfTest) return options
  if (!options.model) throw usageError('--model is required (there is no default model)')
  if (!options.corpus) throw usageError('--corpus is required (there is no default corpus)')
  if (!options.out) throw usageError('--out is required (nothing is written implicitly)')
  return options
}

// Both artifact and checkpoint must stay inside `work/`. This is the mechanical
// part of "write no live state": there is no path through this script to a live DB.
function requireInsideWork(label, file) {
  const resolved = path.resolve(file)
  const relative = path.relative(WORK_ROOT, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw usageError(`${label} must be inside ${WORK_ROOT}, got ${resolved}`)
  }
  return resolved
}

function assertLocalUrl(url) {
  const parsed = new URL(url)
  if (!LOCAL_HOSTS.has(parsed.hostname) || parsed.port !== LOCAL_PORT ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw stopError(`refusing non-local endpoint ${parsed.host}`, 3, 'endpoint')
  }
  return url
}

// ---------------------------------------------------------------------------
// Corpus and case planning

function loadCorpus(corpusPath) {
  if (!fs.existsSync(corpusPath)) throw usageError(`corpus not found: ${corpusPath}`)
  const bytes = fs.readFileSync(corpusPath)
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw stopError(`corpus is not valid JSON: ${error.message}`, 3, 'corpus')
  }
  return { corpus: parsed, bytes, sha256: sha256(bytes) }
}

// Evidence rows are built exactly the way the evaluator normalizes a case, so the
// prompt the model sees and the archive records the validator checks agree.
function buildCasePlan(caseDef) {
  const events = caseDef.events.map((event, index) => ({
    eventKey: event.eventKey,
    scope: caseDef.scope,
    sid: `sid:${caseDef.id}`,
    seq: index + 1,
    validAt: 1000 * (index + 1),
    recordedAt: 1000 * (index + 1),
    human: (event.sourceKind ?? 'user') === 'user' && event.human !== false,
    sourceKind: event.sourceKind ?? 'user',
    text: event.text,
  }))
  const activeFacts = (caseDef.activeTargets ?? []).map((target) => ({
    assertionId: target.assertionId,
    scope: caseDef.scope,
    predicate: target.predicate,
    status: 'active',
    conflict: null,
    // Older than any evidence event in the case, matching the corpus contract.
    validFrom: SYNTHETIC_ACTIVE_TARGET.validFrom,
    seq: SYNTHETIC_ACTIVE_TARGET.seq,
    // The corpus fixes only identity and predicate for a target; no value text is
    // invented here, so ACTIVE FACTS renders `text: null`.
    value: null,
  }))
  return {
    id: caseDef.id,
    kind: caseDef.kind ?? null,
    scope: caseDef.scope,
    caseDef,
    events,
    eventByKey: new Map(events.map((event) => [event.eventKey, event])),
    activeFacts,
  }
}

function planCorpus(corpus) {
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)) {
    throw stopError('corpus root must be an object', 3, 'corpus')
  }
  if (corpus.schemaVersion !== PROPOSAL_SCHEMA_VERSION) {
    throw stopError(
      `corpus schemaVersion ${corpus.schemaVersion} does not match ${PROPOSAL_SCHEMA_VERSION}`,
      3, 'corpus',
    )
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw stopError('corpus needs a non-empty cases array', 3, 'corpus')
  }
  const ids = new Set()
  const eventKeys = new Set()
  for (const caseDef of corpus.cases) {
    if (!caseDef || typeof caseDef.id !== 'string' || caseDef.id === '') {
      throw stopError('every corpus case needs a non-empty id', 3, 'corpus')
    }
    if (ids.has(caseDef.id)) throw stopError(`duplicate case id ${caseDef.id}`, 3, 'corpus')
    ids.add(caseDef.id)
    if (typeof caseDef.scope !== 'string' || caseDef.scope === '') {
      throw stopError(`case ${caseDef.id} needs a non-empty scope`, 3, 'corpus')
    }
    if (!Array.isArray(caseDef.events) || caseDef.events.length === 0) {
      throw stopError(`case ${caseDef.id} needs at least one event`, 3, 'corpus')
    }
    for (const event of caseDef.events) {
      if (!event || typeof event.eventKey !== 'string' || event.eventKey === '') {
        throw stopError(`case ${caseDef.id} has an event without an eventKey`, 3, 'corpus')
      }
      if (eventKeys.has(event.eventKey)) {
        throw stopError(`duplicate eventKey ${event.eventKey}`, 3, 'corpus')
      }
      eventKeys.add(event.eventKey)
      if (typeof event.text !== 'string' || event.text === '') {
        throw stopError(`case ${caseDef.id}/${event.eventKey} needs text`, 3, 'corpus')
      }
    }
    if (!Array.isArray(caseDef.expected)) {
      throw stopError(`case ${caseDef.id} needs an expected array`, 3, 'corpus')
    }
    if (!Array.isArray(caseDef.forbiddenPredicates ?? [])) {
      throw stopError(`case ${caseDef.id} forbiddenPredicates must be an array`, 3, 'corpus')
    }
    if (!Array.isArray(caseDef.activeTargets ?? [])) {
      throw stopError(`case ${caseDef.id} activeTargets must be an array`, 3, 'corpus')
    }
    if (!Array.isArray(caseDef.staleTargets ?? [])) {
      throw stopError(`case ${caseDef.id} staleTargets must be an array`, 3, 'corpus')
    }
  }
  return corpus.cases.map(buildCasePlan)
}

// A label is only usable if the production validator accepts it. Anything else is
// an objective corpus defect: stop, report it, and do not touch the labels.
function preflightLabels(plans) {
  const problems = []
  for (const plan of plans) {
    const evidenceByKey = plan.eventByKey
    for (const [index, label] of plan.caseDef.expected.entries()) {
      const target = label.targetAssertionId ?? null
      if (label.op === 'assert' && target !== null) {
        problems.push({ caseId: plan.id, index, error: 'assert-label-has-target', quote: label.quote })
        continue
      }
      if (label.op !== 'assert' && (typeof target !== 'string' || target === '')) {
        problems.push({ caseId: plan.id, index, error: 'terminal-label-missing-target', quote: label.quote })
        continue
      }
      const verdict = validateProposal({
        op: label.op,
        predicate: label.predicate,
        targetAssertionId: target,
        evidence: { eventKey: label.eventKey, quote: label.quote },
      }, { scope: plan.scope, evidenceByKey, activeFacts: plan.activeFacts })
      if (!verdict.ok) {
        problems.push({
          caseId: plan.id,
          index,
          error: verdict.error,
          errors: verdict.errors,
          eventKey: label.eventKey,
          quote: label.quote,
          predicate: label.predicate,
          op: label.op,
          targetAssertionId: target,
        })
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Ollama identity

async function fetchJson(url, timeoutMs) {
  const response = await fetch(assertLocalUrl(url), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  })
  const text = await response.text()
  if (!response.ok) {
    throw stopError(`GET ${url} -> ${response.status}: ${text.slice(0, 300)}`, 3, 'ollama')
  }
  return JSON.parse(text)
}

async function resolveModel(model) {
  let tags
  let version = null
  try {
    tags = await fetchJson(OLLAMA_TAGS, 15_000)
  } catch (error) {
    throw stopError(
      `cannot read ${OLLAMA_TAGS}: ${error?.message ?? error}. Is the local Ollama service running?`,
      3, 'ollama',
    )
  }
  try {
    const raw = await fetchJson(OLLAMA_VERSION, 15_000)
    version = typeof raw?.version === 'string' ? raw.version : null
  } catch {
    version = null
  }
  const found = (tags?.models ?? []).find((entry) =>
    entry?.name === model || entry?.model === model)
  if (!found) {
    const known = (tags?.models ?? []).map((entry) => entry?.name).filter(Boolean)
    throw stopError(
      `model "${model}" is not installed locally. Known: ${known.join(', ') || '(none)'}`,
      3, 'model',
    )
  }
  return {
    name: found.name,
    model: found.model ?? found.name,
    digest: found.digest ?? null,
    sizeBytes: found.size ?? null,
    modifiedAt: found.modified_at ?? null,
    details: found.details ?? null,
    ollamaVersion: version,
  }
}

// ---------------------------------------------------------------------------
// One model call

function classifyCallError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { type: 'timeout', retryable: true, message: `request aborted: ${error.message}` }
  }
  return { type: 'transport', retryable: true, message: String(error?.message ?? error) }
}

async function callModel({ model, prompt, timeoutMs }) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    format: 'json',
    think: false,
    keep_alive: KEEP_ALIVE,
    options: { ...MODEL_OPTIONS },
  }
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(assertLocalUrl(OLLAMA_CHAT), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - startedAt, error: classifyCallError(error) }
  }
  const text = await response.text()
  const elapsedMs = Date.now() - startedAt
  if (!response.ok) {
    return {
      ok: false,
      elapsedMs,
      error: {
        type: 'http',
        status: response.status,
        retryable: response.status >= 500,
        message: text.slice(0, 800),
      },
    }
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      elapsedMs,
      error: { type: 'bad-response', retryable: false, message: text.slice(0, 800) },
    }
  }
  const content = payload?.message?.content
  if (typeof content !== 'string') {
    return {
      ok: false,
      elapsedMs,
      error: {
        type: 'missing-content',
        retryable: false,
        message: JSON.stringify(payload).slice(0, 800),
      },
    }
  }
  return {
    ok: true,
    elapsedMs,
    content,
    meta: {
      done: payload.done ?? null,
      doneReason: payload.done_reason ?? null,
      evalCount: payload.eval_count ?? null,
      promptEvalCount: payload.prompt_eval_count ?? null,
      totalDurationMs: msFromNs(payload.total_duration),
      loadDurationMs: msFromNs(payload.load_duration),
      promptEvalDurationMs: msFromNs(payload.prompt_eval_duration),
      evalDurationMs: msFromNs(payload.eval_duration),
      createdAt: payload.created_at ?? null,
      model: payload.model ?? null,
    },
  }
}

function msFromNs(value) {
  return Number.isFinite(value) ? Math.round(value / 1e6) : null
}

// ---------------------------------------------------------------------------
// Bounded retry

// `baseAttempts` is captured by the caller *before* the loop and never re-read
// from a mutable counter, so recording an attempt cannot extend the bound. The
// retry budget is per invocation: a resumed case gets MAX_ATTEMPTS_PER_CASE more
// calls on top of the attempts already recorded for it, and no more.
async function callWithRetry({ baseAttempts, maxAttempts, call }) {
  const firstAttempt = baseAttempts + 1
  const lastAttempt = baseAttempts + maxAttempts
  let lastCall = null
  let lastAttemptMade = baseAttempts
  let attemptsMade = 0
  for (let attempt = firstAttempt; attempt <= lastAttempt; attempt++) {
    lastAttemptMade = attempt
    attemptsMade++
    lastCall = await call(attempt)
    if (lastCall.ok) {
      return {
        call: lastCall,
        attemptsMade,
        lastAttempt: lastAttemptMade,
        exhausted: false,
        nonRetryable: false,
      }
    }
    if (!lastCall.error?.retryable) {
      return {
        call: lastCall,
        attemptsMade,
        lastAttempt: lastAttemptMade,
        exhausted: false,
        nonRetryable: true,
      }
    }
  }
  return {
    call: lastCall,
    attemptsMade,
    lastAttempt: lastAttemptMade,
    exhausted: true,
    nonRetryable: false,
  }
}

// Deterministic simulation of the retry contract. Every check fails the process
// if the bound is wrong, so retry exhaustion is exercised rather than asserted.
async function runRetrySelfTest() {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok: ok === true, detail })
  const failure = (message) => ({
    ok: false,
    elapsedMs: 0,
    error: { type: 'transport', retryable: true, message },
  })

  {
    let calls = 0
    const outcome = await callWithRetry({
      baseAttempts: 0,
      maxAttempts: MAX_ATTEMPTS_PER_CASE,
      call: async () => {
        calls++
        return failure('simulated transport failure')
      },
    })
    add(
      'retryable-failure-exhausts',
      calls === MAX_ATTEMPTS_PER_CASE && outcome.exhausted &&
        outcome.lastAttempt === MAX_ATTEMPTS_PER_CASE &&
        outcome.call?.ok === false,
      { calls, lastAttempt: outcome.lastAttempt, exhausted: outcome.exhausted },
    )
  }

  {
    // Resumed run: two attempts are already recorded. Exactly the per-invocation
    // budget is spent, starting at base+1.
    const attempts = []
    const outcome = await callWithRetry({
      baseAttempts: 2,
      maxAttempts: MAX_ATTEMPTS_PER_CASE,
      call: async (attempt) => {
        attempts.push(attempt)
        return failure('simulated resumed failure')
      },
    })
    add(
      'resume-base-attempts-bounded',
      attempts.length === MAX_ATTEMPTS_PER_CASE && attempts[0] === 3 &&
        attempts.at(-1) === 2 + MAX_ATTEMPTS_PER_CASE && outcome.exhausted,
      { attempts, exhausted: outcome.exhausted },
    )
  }

  {
    // Regression guard for the previous bug shape: a call that records the attempt
    // into a shared counter must not move the bound.
    const counters = { attempts: 0 }
    let calls = 0
    const outcome = await callWithRetry({
      baseAttempts: counters.attempts,
      maxAttempts: MAX_ATTEMPTS_PER_CASE,
      call: async (attempt) => {
        calls++
        counters.attempts = attempt
        return failure('simulated counter mutation')
      },
    })
    add(
      'recorded-attempts-do-not-extend-bound',
      calls === MAX_ATTEMPTS_PER_CASE && outcome.exhausted &&
        counters.attempts === MAX_ATTEMPTS_PER_CASE,
      { calls, recordedAttempt: counters.attempts, exhausted: outcome.exhausted },
    )
  }

  {
    let calls = 0
    const outcome = await callWithRetry({
      baseAttempts: 0,
      maxAttempts: MAX_ATTEMPTS_PER_CASE,
      call: async (attempt) => {
        calls++
        if (attempt === MAX_ATTEMPTS_PER_CASE) {
          return { ok: true, elapsedMs: 0, content: '{"proposals":[]}', meta: {} }
        }
        return failure('simulated transient failure')
      },
    })
    add(
      'success-on-last-attempt',
      calls === MAX_ATTEMPTS_PER_CASE && outcome.call?.ok === true &&
        !outcome.exhausted && outcome.lastAttempt === MAX_ATTEMPTS_PER_CASE,
      { calls, lastAttempt: outcome.lastAttempt },
    )
  }

  {
    let calls = 0
    const outcome = await callWithRetry({
      baseAttempts: 0,
      maxAttempts: MAX_ATTEMPTS_PER_CASE,
      call: async () => {
        calls++
        return {
          ok: false,
          elapsedMs: 0,
          error: { type: 'http', status: 400, retryable: false, message: 'bad request' },
        }
      },
    })
    add(
      'non-retryable-stops-immediately',
      calls === 1 && outcome.nonRetryable === true && outcome.exhausted === false,
      { calls, nonRetryable: outcome.nonRetryable },
    )
  }

  const failed = checks.filter((check) => !check.ok)
  process.stdout.write(
    `retry self-test ${failed.length === 0 ? 'PASS' : 'FAIL'} ` +
    `(${checks.length - failed.length}/${checks.length})\n`,
  )
  for (const check of checks) {
    process.stdout.write(
      `  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name} ${JSON.stringify(check.detail)}\n`,
    )
  }
  return failed.length === 0
}

// ---------------------------------------------------------------------------
// Scoring one answer with production code only

function scoreCase(plan, raw) {
  const parsed = parseProposalOutput(raw)
  const validation = []
  if (parsed.ok) {
    for (const [index, proposal] of parsed.proposals.entries()) {
      const verdict = validateProposal(proposal, {
        scope: plan.scope,
        evidenceByKey: plan.eventByKey,
        activeFacts: plan.activeFacts,
      })
      validation.push({
        index,
        op: proposal.op,
        predicate: proposal.predicate,
        targetAssertionId: proposal.targetAssertionId,
        eventKey: proposal.evidence.eventKey,
        quote: proposal.evidence.quote,
        ok: verdict.ok,
        error: verdict.error,
        errors: verdict.errors,
      })
    }
  }
  const accepted = validation.filter((entry) => entry.ok)
  const rejected = validation.filter((entry) => !entry.ok)

  // Per-case evaluator verdict. The corpus case is passed unchanged, so the codes
  // and reasons are the production scorer's, not a local reimplementation.
  const single = evaluateProposalRun({
    cases: [plan.caseDef],
    proposalsByCase: { [plan.id]: raw },
  })
  const caseResult = single.cases[0]

  // Compare dispositions by the same identity both stages use: eventKey plus the
  // trimmed quote (the evaluator trims, the validator locates the trimmed span).
  const acceptedSpans = new Set(accepted.map((entry) => `${entry.eventKey}\u0000${entry.quote.trim()}`))
  const divergence = (caseResult.proposals ?? []).filter((entry) =>
    entry.disposition === 'accepted'
      ? !acceptedSpans.has(`${entry.eventKey}\u0000${entry.quote}`)
      : acceptedSpans.has(`${entry.eventKey}\u0000${entry.quote}`))

  return {
    parse: {
      ok: parsed.ok,
      error: parsed.error,
      errors: parsed.errors,
      proposalCount: parsed.ok ? parsed.proposals.length : 0,
      proposals: parsed.ok ? parsed.proposals : [],
    },
    validation,
    validatorStage: {
      proposals: validation.length,
      accepted: accepted.length,
      rejected: rejected.length,
      reasons: rejected.reduce((acc, entry) => {
        const key = entry.error ?? 'unknown'
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {}),
    },
    evalCase: caseResult,
    divergence,
  }
}

// ---------------------------------------------------------------------------
// Checkpoint

function newCheckpoint(identity) {
  const createdAt = nowIso()
  return {
    schema: `${ARTIFACT_SCHEMA}#checkpoint`,
    runner: RUNNER_VERSION,
    identity,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    invocations: 0,
    // Accumulated across resumes so a chunked run still reports its real cost.
    timing: {
      firstStartedAt: createdAt,
      lastFinishedAt: null,
      activeElapsedMs: 0,
      modelElapsedMs: 0,
      modelCalls: 0,
    },
    attempts: {},
    identityRebinds: [],
    cases: {},
  }
}

// A checkpoint written before the timing accumulator existed can still report an
// honest cost: every case keeps its own attempt timestamp and elapsed time, and
// the run was one invocation.
function migrateTiming(checkpoint) {
  if (checkpoint.timing && typeof checkpoint.timing === 'object') return checkpoint.timing
  const records = Object.values(checkpoint.cases ?? {})
  let activeElapsedMs = 0
  let modelElapsedMs = 0
  let modelCalls = 0
  for (const record of records) {
    modelElapsedMs += Number(record.elapsedMs) || 0
    modelCalls += Number(record.attempt) || 0
    const at = Date.parse(record.attemptedAt ?? checkpoint.createdAt)
    if (Number.isFinite(at)) {
      // `attemptedAt` is stamped after the response, so it already includes the
      // case's own elapsed time; adding elapsedMs again would double-count it.
      activeElapsedMs = Math.max(activeElapsedMs, at - Date.parse(checkpoint.createdAt))
    }
  }
  checkpoint.timing = {
    firstStartedAt: checkpoint.createdAt,
    lastFinishedAt: null,
    activeElapsedMs,
    modelElapsedMs,
    modelCalls,
  }
  return checkpoint.timing
}

// Resume gating compares only the fields that decide what the model was asked and
// how its answer is read. Runner/evaluator source hashes are audit labels: a change
// there is allowed on resume only because every cached answer is re-scored with the
// current code and any drift is reported.
function outputIdentityDifferences(stored, current) {
  return OUTPUT_IDENTITY_KEYS.filter((key) =>
    JSON.stringify(stored?.[key]) !== JSON.stringify(current[key]))
}

function auditIdentityDifferences(stored, current) {
  const differences = []
  if (stored?.runner !== current.runner) differences.push('runner')
  if (stored?.runnerSha256 !== current.runnerSha256) differences.push('runnerSha256')
  if (JSON.stringify(stored?.evaluator) !== JSON.stringify(current.evaluator)) {
    differences.push('evaluator')
  }
  return differences
}

function auditIdentitySnapshot(identity) {
  return {
    runner: identity.runner,
    runnerSha256: identity.runnerSha256,
    evaluator: identity.evaluator,
  }
}

function isFinished(record) {
  return record?.status === 'ok' && typeof record.raw === 'string'
}

// ---------------------------------------------------------------------------
// Safety attribution and route assessment

// A case is production-reachable when every archived event is a human user
// message. The production evidence gate refuses any other source before a model
// call, so a failure observed over archived system/assistant text can only happen
// in this probe and never in the live path.
function isProductionReachable(record) {
  const evidence = record?.evidence
  return Array.isArray(evidence) && evidence.length > 0 &&
    evidence.every((event) => event.human === true && event.sourceKind === 'user')
}

function unique(values) {
  return [...new Set(values)]
}

function buildSafetyAttribution(caseRecords, planById) {
  const failures = []
  const evidenceInvalid = []
  for (const record of caseRecords) {
    const plan = planById.get(record.id)
    const productionReachable = isProductionReachable(record)
    const evidenceSourceKinds = unique((record.evidence ?? []).map((event) => event.sourceKind))
    for (const entry of record.evalCase?.proposals ?? []) {
      if (entry.safety === true) {
        failures.push({
          caseId: record.id,
          predicate: entry.predicate ?? null,
          code: entry.code ?? null,
          disposition: entry.disposition ?? null,
          quote: entry.quote ?? null,
          severeCase: plan?.caseDef?.severe === true,
          productionReachable,
          evidenceSourceKinds,
        })
      }
      if (entry.evidence === 'invalid') {
        evidenceInvalid.push({
          caseId: record.id,
          predicate: entry.predicate ?? null,
          code: entry.code ?? null,
          productionReachable,
        })
      }
    }
  }
  const reachableFailures = failures.filter((failure) => failure.productionReachable)
  const probeOnlyFailures = failures.filter((failure) => !failure.productionReachable)
  const acceptedOnSevere = failures.filter((failure) =>
    failure.severeCase && failure.disposition === 'accepted')
  const rejectedOnSevere = failures.filter((failure) =>
    failure.severeCase && failure.disposition === 'rejected')
  const evaluatedPlanIds = new Set(caseRecords.map((record) => record.id))
  const severeCorpusIds = [...planById.values()]
    .filter((plan) => plan.caseDef?.severe === true)
    .map((plan) => plan.id)
  return {
    policy: {
      productionReachable: 'every archived event in the case is a human user message ' +
        '(human:true, sourceKind:user); the production evidence gate would present this case',
      probeOnly: 'the case archives at least one system/assistant event. The production ' +
        'evidence gate refuses such a key before any model call, so a failure observed here ' +
        'cannot occur in the live path and is reported separately',
      severeAccepted: 'an accepted proposal on a case with severe:true. A severe case whose ' +
        'proposals were all rejected is a safety failure but is NOT severeAccepted',
    },
    total: failures.length,
    failures,
    evidenceInvalid,
    productionReachable: {
      count: reachableFailures.length,
      severeAccepted: acceptedOnSevere.filter((failure) => failure.productionReachable).length,
      caseIds: unique(reachableFailures.map((failure) => failure.caseId)),
      failures: reachableFailures,
    },
    probeOnly: {
      count: probeOnlyFailures.length,
      severeAccepted: acceptedOnSevere.filter((failure) => !failure.productionReachable).length,
      caseIds: unique(probeOnlyFailures.map((failure) => failure.caseId)),
      failures: probeOnlyFailures,
    },
    severe: {
      corpusCaseIds: severeCorpusIds,
      evaluatedCaseIds: severeCorpusIds.filter((id) => evaluatedPlanIds.has(id)),
      acceptedCount: acceptedOnSevere.length,
      acceptedCaseIds: unique(acceptedOnSevere.map((failure) => failure.caseId)),
      rejectedCount: rejectedOnSevere.length,
      rejectedCaseIds: unique(rejectedOnSevere.map((failure) => failure.caseId)),
      note: 'severeAccepted counts accepted proposals on severe cases only. A rejected ' +
        'proposal on a severe case is still a safety failure (for example candidate-injected) ' +
        'but it is not a severe false acceptance.',
    },
  }
}

function summarizeSafetyByPredicate(predicates, attribution) {
  const out = {}
  for (const predicate of predicates) {
    const failures = attribution.failures.filter((failure) => failure.predicate === predicate)
    const invalid = attribution.evidenceInvalid.filter((entry) => entry.predicate === predicate)
    const reachable = failures.filter((failure) => failure.productionReachable)
    const probeOnly = failures.filter((failure) => !failure.productionReachable)
    out[predicate] = {
      safetyFailuresTotal: failures.length,
      safetyFailuresProductionReachable: reachable.length,
      probeOnlySafetyFailures: probeOnly.length,
      productionReachableCaseIds: unique(reachable.map((failure) => failure.caseId)),
      probeOnlyCaseIds: unique(probeOnly.map((failure) => failure.caseId)),
      evidenceInvalidProductionReachable: invalid.filter((entry) => entry.productionReachable).length,
      evidenceInvalidProbeOnly: invalid.filter((entry) => !entry.productionReachable).length,
    }
  }
  return out
}

// The evaluator's route reason is reproduced verbatim in `metrics.routes`. This
// block answers the separate question: what closes the route once failures that
// the production gate could never see are excluded?
function buildRouteAssessment(routes, safetyByPredicate) {
  const out = {}
  for (const predicate of Object.keys(routes)) {
    const route = routes[predicate]
    const safety = safetyByPredicate[predicate] ?? {
      safetyFailuresProductionReachable: 0,
      probeOnlySafetyFailures: 0,
    }
    let binding = null
    if (safety.safetyFailuresProductionReachable > 0) binding = 'safety-failure'
    else if (route.jsonValid !== true) binding = 'invalid-json'
    else if (route.outputValid !== true) binding = 'invalid-output'
    else if (route.sampleCount < route.floors.sampleCount) binding = 'insufficient-labels'
    else if (route.precision === null) binding = 'precision-unmeasured'
    else if (route.precision < route.floors.precision) binding = 'precision-below-floor'
    else if (route.recall === null) binding = 'recall-unmeasured'
    else if (route.recall < route.floors.recall) binding = 'recall-below-floor'
    out[predicate] = {
      evaluatorEnabled: route.enabled === true,
      evaluatorReason: route.reason,
      productionReachableSafetyFailures: safety.safetyFailuresProductionReachable,
      probeOnlySafetyFailures: safety.probeOnlySafetyFailures,
      bindingConstraintExcludingProbeOnly: binding,
      enabledExcludingProbeOnly: binding === null,
      precision: route.precision,
      precisionFloor: route.floors.precision,
      recall: route.recall,
      recallFloor: route.floors.recall,
      sampleCount: route.sampleCount,
      sampleFloor: route.floors.sampleCount,
      note: route.reason === 'safety-failure' &&
          safety.safetyFailuresProductionReachable === 0
        ? 'the evaluator reason safety-failure is caused only by probe-only cases; with ' +
          `those excluded the binding constraint is ${binding}`
        : 'production-reachable attribution does not change the evaluator reason',
    }
  }
  return out
}

function probeOnlyScoreImpact(caseRecords) {
  const impact = { caseIds: [], tp: 0, fp: 0, fn: 0, tn: 0 }
  for (const record of caseRecords) {
    if (isProductionReachable(record)) continue
    impact.caseIds.push(record.id)
    impact.tp += record.evalCase?.tp ?? 0
    impact.fp += record.evalCase?.fp ?? 0
    impact.fn += record.evalCase?.fn ?? 0
    impact.tn += record.evalCase?.tn ?? 0
  }
  impact.note = impact.tp === 0 && impact.fp === 0
    ? 'probe-only cases produced no accepted proposal, so excluding them leaves precision ' +
      'unchanged; they do affect evidence validity and safety counters'
    : 'probe-only cases did produce accepted proposals; excluding them would change precision'
  return impact
}

// ---------------------------------------------------------------------------
// Main

async function main() {
  const startedAtIso = nowIso()
  const startedAt = Date.now()
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (args.selfTest) {
    const passed = await runRetrySelfTest()
    process.exitCode = passed ? 0 : 1
    return
  }
  const outPath = requireInsideWork('--out', args.out)
  const checkpointPath = requireInsideWork(
    '--checkpoint', args.checkpoint ?? `${outPath}.checkpoint.json`,
  )
  const corpusPath = path.resolve(args.corpus)

  const { corpus, sha256: corpusSha } = loadCorpus(corpusPath)
  const plans = planCorpus(corpus)

  const labelProblems = preflightLabels(plans)
  if (labelProblems.length > 0) {
    process.stderr.write(
      `STOP: ${labelProblems.length} corpus label(s) are not extractable by the production ` +
      'validator. Labels were not modified; no model was called and no artifact was written.\n',
    )
    for (const problem of labelProblems) {
      process.stderr.write(`  ${JSON.stringify(problem)}\n`)
    }
    throw stopError('corpus labels are objectively invalid', 4, 'labels')
  }

  const modelInfo = await resolveModel(args.model)
  const template = buildProposalPrompt({})
  const promptVersion = `${PROPOSAL_SCHEMA_VERSION}:${sha256(template).slice(0, 12)}`
  const runnerSha256 = fileSha256(RUNNER_SOURCE_PATH)
  const evaluatorSha256 = fileSha256(EVALUATOR_SOURCE_PATH)
  const identity = {
    runner: RUNNER_VERSION,
    runnerSha256,
    evaluator: { path: EVALUATOR_SOURCE_LABEL, sha256: evaluatorSha256 },
    model: modelInfo.name,
    digest: modelInfo.digest,
    corpusSha256: corpusSha,
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    promptVersion,
    options: { ...MODEL_OPTIONS },
    request: {
      url: OLLAMA_CHAT,
      stream: false,
      format: 'json',
      think: false,
      keepAlive: KEEP_ALIVE,
    },
  }

  let checkpoint = null
  let auditRebinds = []
  if (fs.existsSync(checkpointPath) && !args.restart) {
    try {
      checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))
    } catch (error) {
      throw stopError(
        `checkpoint ${checkpointPath} is unreadable (${error.message}); rerun with --restart`,
        3, 'checkpoint',
      )
    }
    const outputDifferences = outputIdentityDifferences(checkpoint.identity, identity)
    if (outputDifferences.length > 0) {
      throw stopError(
        `checkpoint ${checkpointPath} belongs to a different run identity ` +
        `(${outputDifferences.join(', ')} changed). Use a new --out or --restart.`,
        3, 'checkpoint',
      )
    }
    const auditDifferences = auditIdentityDifferences(checkpoint.identity, identity)
    if (auditDifferences.length > 0) {
      // The runner/evaluator source moved ahead of an existing checkpoint. Refuse
      // to guess silently: record the rebind, keep the output identity, and rely on
      // the re-score pass below to fail loudly if any recorded verdict changed.
      auditRebinds = Array.isArray(checkpoint.identityRebinds) ? checkpoint.identityRebinds : []
      auditRebinds.push({
        at: nowIso(),
        invocation: (checkpoint.invocations ?? 0) + 1,
        fields: auditDifferences,
        from: auditIdentitySnapshot(checkpoint.identity ?? {}),
        to: auditIdentitySnapshot(identity),
        note: 'output-determining identity is unchanged; runner/evaluator source hashes ' +
          'were re-bound to the current files without new inference. Cached answers are ' +
          're-scored with the current code and any drift is reported.',
      })
      checkpoint.identityRebinds = auditRebinds
      checkpoint.identity = identity
      checkpoint.runner = RUNNER_VERSION
    }
  } else {
    checkpoint = newCheckpoint(identity)
    if (args.restart && fs.existsSync(checkpointPath)) {
      // Preserve the discarded file for audit instead of deleting evidence.
      fs.renameSync(checkpointPath, `${checkpointPath}.discarded-${Date.now()}`)
    }
  }

  // Timing is accumulated on the checkpoint so a run split across invocations
  // still reports its real model and wall-clock cost.
  const timing = migrateTiming(checkpoint)
  checkpoint.invocations = (checkpoint.invocations ?? 0) + 1
  checkpoint.updatedAt = nowIso()
  writeJsonAtomic(checkpointPath, checkpoint)

  const prefix = args.limit === null ? plans : plans.slice(0, args.limit)
  if (prefix.length === 0) throw usageError('--limit produced no cases to run')
  const evaluationIds = prefix.map((plan) => plan.id)
  const pending = prefix.filter((plan) => !isFinished(checkpoint.cases[plan.id]))

  process.stdout.write(
    `proposal-baseline ${RUNNER_VERSION}\n` +
    `  model   ${modelInfo.name} (${modelInfo.digest ?? 'digest-unknown'})\n` +
    `  corpus  ${corpusPath} sha256=${corpusSha.slice(0, 12)} cases=${plans.length}\n` +
    `  run     ${prefix.length}/${plans.length} cases, ${pending.length} pending, ` +
    `prompt=${promptVersion}\n` +
    `  out     ${outPath}\n  ckpt    ${checkpointPath}\n`,
  )

  let modelCalls = 0
  let runModelMs = 0
  let caseIndex = 0
  for (const plan of prefix) {
    caseIndex++
    const existing = checkpoint.cases[plan.id]
    if (isFinished(existing)) {
      process.stdout.write(
        `[${caseIndex}/${prefix.length}] ${plan.id} cached ok (${existing.elapsedMs}ms)\n`,
      )
      continue
    }

    const prompt = buildProposalPrompt({ evidence: plan.events, activeFacts: plan.activeFacts })
    const promptSha = sha256(prompt)
    // Frozen before the loop. `checkpoint.attempts` is updated per call but is never
    // consulted again, so the retry bound cannot grow.
    const baseAttempts = checkpoint.attempts[plan.id] ?? 0
    const errorHistory = Array.isArray(existing?.errorHistory) ? [...existing.errorHistory] : []

    const outcome = await callWithRetry({
      baseAttempts,
      maxAttempts: MAX_ATTEMPTS_PER_CASE,
      call: async (attempt) => {
        modelCalls++
        checkpoint.attempts[plan.id] = attempt
        const call = await callModel({
          model: modelInfo.name,
          prompt,
          timeoutMs: args.timeoutMs,
        })
        runModelMs += call.elapsedMs ?? 0
        if (!call.ok) {
          errorHistory.push({ at: nowIso(), attempt, ...call.error })
        }
        return call
      },
    })
    const call = outcome.call
    const attempt = outcome.lastAttempt

    const baseRecord = {
      id: plan.id,
      kind: plan.kind,
      scope: plan.scope,
      status: call?.ok ? 'ok' : 'error',
      attempt,
      attemptedAt: nowIso(),
      prompt,
      promptSha256: promptSha,
      evidence: plan.events.map((event) => ({
        eventKey: event.eventKey,
        sourceKind: event.sourceKind,
        human: event.human,
        text: event.text,
      })),
      activeFacts: plan.activeFacts.map((fact) => ({
        assertionId: fact.assertionId,
        predicate: fact.predicate,
        value: fact.value,
      })),
      // Exact model text, never normalized. Written before any parsing happens.
      raw: call?.ok ? call.content : null,
      rawSha256: call?.ok ? sha256(call.content) : null,
      rawLength: call?.ok ? call.content.length : null,
      response: call?.ok ? call.meta : null,
      elapsedMs: call?.elapsedMs ?? null,
      error: call?.ok ? null : call.error,
      errorHistory,
      parse: null,
      validation: null,
      validatorStage: null,
      evalCase: null,
      divergence: null,
    }

    // First write: raw model text on disk before validation touches it.
    checkpoint.cases[plan.id] = baseRecord
    checkpoint.updatedAt = nowIso()
    writeJsonAtomic(checkpointPath, checkpoint)

    if (!call.ok) {
      process.stdout.write(
        `[${caseIndex}/${prefix.length}] ${plan.id} ERROR ${call.error.type} ` +
        `(${call.elapsedMs}ms) ${String(call.error.message).slice(0, 120)}\n`,
      )
      continue
    }

    const scored = scoreCase(plan, call.content)
    const record = { ...baseRecord, ...scored }
    checkpoint.cases[plan.id] = record
    checkpoint.updatedAt = nowIso()
    writeJsonAtomic(checkpointPath, checkpoint)

    const evalCase = scored.evalCase
    process.stdout.write(
      `[${caseIndex}/${prefix.length}] ${plan.id} ok ${call.elapsedMs}ms ` +
      `parse=${scored.parse.ok ? 'ok' : scored.parse.error} ` +
      `validator=${scored.validatorStage.accepted}/${scored.validatorStage.proposals} ` +
      `eval=${evalCase.status} tp=${evalCase.tp} fp=${evalCase.fp} fn=${evalCase.fn} ` +
      `safety=${evalCase.safetyFailures}\n`,
    )
  }

  // ---- Verify cached answers against the current code ----------------------
  // A resume never re-asks the model. It does re-build every prompt and re-score
  // every recorded raw answer with the current parser/validator/evaluator, so a
  // runner edit cannot silently change a verdict or leave a stale one in place.
  const planById = new Map(plans.map((plan) => [plan.id, plan]))
  const rescore = {
    checked: 0,
    identical: 0,
    driftedCaseIds: [],
    promptMismatchCaseIds: [],
    promptSet: [],
  }
  for (const plan of prefix) {
    const record = checkpoint.cases[plan.id]
    if (!record || record.status !== 'ok' || typeof record.raw !== 'string') continue
    rescore.checked++
    const expectedPrompt = buildProposalPrompt({
      evidence: plan.events,
      activeFacts: plan.activeFacts,
    })
    if (record.prompt !== expectedPrompt || sha256(record.prompt) !== record.promptSha256) {
      rescore.promptMismatchCaseIds.push(plan.id)
    }
    rescore.promptSet.push(`${plan.id}\u0000${record.promptSha256}`)
    const fresh = scoreCase(plan, record.raw)
    const same = JSON.stringify(fresh.parse) === JSON.stringify(record.parse) &&
      JSON.stringify(fresh.validation) === JSON.stringify(record.validation) &&
      JSON.stringify(fresh.validatorStage) === JSON.stringify(record.validatorStage) &&
      JSON.stringify(fresh.evalCase) === JSON.stringify(record.evalCase) &&
      JSON.stringify(fresh.divergence) === JSON.stringify(record.divergence)
    if (same) {
      rescore.identical++
    } else {
      // Keep the artifact honest: report the drift and use the current verdicts.
      rescore.driftedCaseIds.push(plan.id)
      checkpoint.cases[plan.id] = { ...record, ...fresh }
    }
  }
  const promptSetSha256 = sha256(rescore.promptSet.join('\n'))

  // ---- Metrics over the evaluated set -------------------------------------
  // A case whose answer is missing is absent from the map on purpose: the
  // evaluator then reports `ran-missing`, which must keep every route closed.
  const proposalsByCase = {}
  const caseRecords = []
  for (const plan of prefix) {
    const record = checkpoint.cases[plan.id]
    if (!record) continue
    caseRecords.push(record)
    if (record.status === 'ok') proposalsByCase[plan.id] = record.raw
  }
  const evalCases = prefix.map((plan) => plan.caseDef)
  const result = evaluateProposalRun({ cases: evalCases, proposalsByCase })

  const errors = caseRecords
    .filter((record) => record.status !== 'ok')
    .map((record) => ({
      caseId: record.id,
      attempt: record.attempt,
      type: record.error?.type ?? 'unknown',
      message: record.error?.message ?? null,
      errorHistory: record.errorHistory,
    }))

  const complete = prefix.length === plans.length &&
    caseRecords.length === prefix.length &&
    caseRecords.every((record) => record.status === 'ok')
  const answeredComplete = caseRecords.length === prefix.length &&
    caseRecords.every((record) => record.status === 'ok')
  const fullCorpus = prefix.length === plans.length

  // Safety is reported twice: everything observed in the probe, and the subset
  // that production could actually reach (all evidence is a human user message).
  const safetyAttribution = buildSafetyAttribution(caseRecords, planById)
  const safetyByPredicate = summarizeSafetyByPredicate(
    Object.keys(result.routes), safetyAttribution,
  )
  const routeAssessment = buildRouteAssessment(result.routes, safetyByPredicate)
  const probeOnlyImpact = probeOnlyScoreImpact(caseRecords)
  const degradedActiveFactCases = prefix
    .filter((plan) => plan.activeFacts.some((fact) => fact.value === null))
    .map((plan) => ({
      caseId: plan.id,
      kind: plan.caseDef.kind ?? null,
      activeTargets: plan.activeFacts.map((fact) => ({
        assertionId: fact.assertionId,
        predicate: fact.predicate,
        value: fact.value,
      })),
    }))
  const degradedActiveFactIds = degradedActiveFactCases.map((entry) => entry.caseId)
  const artifactCases = caseRecords.map((record) => {
    const plan = planById.get(record.id)
    return {
      ...record,
      severeCase: plan?.caseDef?.severe === true,
      productionReachableEvidence: isProductionReachable(record),
      promptDegradations: plan?.activeFacts?.some((fact) => fact.value === null)
        ? ['active-fact-text-null']
        : [],
      // The exact synthetic target fields the evaluator supplied for correction and
      // retraction cases. Production would pass the stored fact text and real
      // validFrom/seq, so these scores are a lower bound under a degenerate prompt.
      syntheticCorrectionTargets: (plan?.activeFacts ?? []).map((fact) => ({
        assertionId: fact.assertionId,
        predicate: fact.predicate,
        // Field names match the production target shape, but every value here is
        // synthetic: `text` is absent from the corpus, and 500/0 are fixed older
        // placeholders used only to satisfy the target checks.
        text: fact.value === null ? null : fact.value?.text ?? null,
        validFrom: fact.validFrom,
        seq: fact.seq,
        syntheticValidFrom: fact.validFrom,
        syntheticSeq: fact.seq,
        valueText: fact.value === null ? null : fact.value?.text ?? null,
        synthetic: true,
      })),
    }
  })

  const warnings = []
  if (degradedActiveFactCases.length > 0) {
    warnings.push({
      code: 'active-fact-text-missing',
      detail: 'ACTIVE FACTS is rendered with text:null for these cases because the corpus ' +
        'fixes only assertionId and predicate for a target. The prompt also carries a ' +
        'synthetic validFrom/seq for the target. Production would show the stored value text, ' +
        'so correction/retraction results on these cases are a lower bound measured under a ' +
        'degenerate prompt, not a production measurement',
      cases: degradedActiveFactCases,
      correctionResultsLowerBound: true,
    })
  }
  if (!fullCorpus) {
    warnings.push({
      code: 'partial-run',
      detail: `metrics cover ${prefix.length} of ${plans.length} corpus cases; ` +
        'they are not a corpus-level route conclusion',
    })
  }
  // The scorer accepts a whole-sentence quote that carries its own terminator; the
  // production validator refuses a quote whose following character is not a clause
  // boundary. Recall is therefore an evaluator upper bound, not a production
  // acceptance guarantee.
  warnings.push({
    code: 'recall-vs-production-clause-boundary',
    detail: 'the offline evaluator accepts a sentence-terminal whole-sentence quote ' +
      'that the production clause-boundary rule may refuse (the character after the ' +
      'quote must also separate it). Recall is measured against evaluator span ' +
      'validity, so it is an upper bound on production acceptance, not a guarantee',
  })
  if (!answeredComplete) {
    warnings.push({
      code: 'incomplete-run',
      detail: `${errors.length} case(s) have no model answer; every route stays closed ` +
        'because missing output is unmeasurable',
    })
  }
  const nonUserCases = caseRecords
    .filter((record) => record.evidence.some((event) => event.human !== true))
    .map((record) => ({
      caseId: record.id,
      events: record.evidence.filter((event) => event.human !== true)
        .map((event) => ({ eventKey: event.eventKey, sourceKind: event.sourceKind })),
    }))
  if (nonUserCases.length > 0) {
    warnings.push({
      code: 'non-user-evidence-presented',
      detail: 'these cases archive system/assistant text. The production evidence gate would ' +
        'refuse such a key before any model call; the baseline presents the archived text so ' +
        'the evaluator can still classify any proposal drawn from it (candidate-injected)',
      cases: nonUserCases,
    })
  }
  const divergences = caseRecords
    .filter((record) => (record.divergence ?? []).length > 0)
    .map((record) => ({ caseId: record.id, entries: record.divergence }))
  if (divergences.length > 0) {
    warnings.push({
      code: 'validator-evaluator-divergence',
      detail: 'the offline evaluator accepted/rejected a span differently from ' +
        'validateProposal; dispositions are reported as scored',
      cases: divergences,
    })
  }
  if (rescore.promptMismatchCaseIds.length > 0) {
    warnings.push({
      code: 'prompt-drift',
      detail: 'the stored prompt bytes or their hash do not reproduce from the current corpus ' +
        'and template; those cases were not re-asked and their stored bytes are kept verbatim',
      caseIds: rescore.promptMismatchCaseIds,
    })
  }
  if (rescore.driftedCaseIds.length > 0) {
    warnings.push({
      code: 'cached-score-drift',
      detail: 're-scoring the recorded raw output with the current runner changed the stored ' +
        'verdict; the artifact reports the current verdicts and the drift is listed',
      caseIds: rescore.driftedCaseIds,
    })
  }
  if (auditRebinds.length > 0) {
    warnings.push({
      code: 'runner-source-rebound',
      detail: 'the checkpoint was created by an earlier runner/evaluator source. The output ' +
        'identity (model/digest/corpus/prompt/options/request) is unchanged and every cached ' +
        'answer was re-scored, but artifact metadata and timing come from the original ' +
        'inference checkpoint, not from a second inference run',
      rebinds: auditRebinds.map((rebind) => ({
        at: rebind.at,
        invocation: rebind.invocation,
        fields: rebind.fields,
        from: rebind.from,
        to: rebind.to,
      })),
    })
  }
  if (answeredComplete && modelCalls === 0) {
    warnings.push({
      code: 'artifact-regenerated-without-inference',
      detail: 'this invocation made 0 model calls. Raw text, prompts and scores were read ' +
        'back from the original checkpoint and re-scored; generatedAt, identity hashes and ' +
        'timing metadata were rebuilt over that checkpoint. This is not a second inference run',
      modelCallsThisInvocation: 0,
      rescoredCases: rescore.checked,
      rescoreDrift: rescore.driftedCaseIds,
    })
  }

  const caseElapsed = caseRecords
    .map((record) => record.elapsedMs)
    .filter((value) => Number.isFinite(value))
  // Newest per-case answer timestamp. On a rebuild this is the original inference
  // finish, not the rebuild invocation, so the artifact cannot imply a later run.
  const lastAnswerAt = caseRecords.reduce((latest, record) => {
    const at = record.attemptedAt
    return at && (!latest || at > latest) ? at : latest
  }, null)
  const validatorByPredicate = {}
  for (const record of caseRecords) {
    for (const entry of record.validation ?? []) {
      const key = entry.predicate
      const bucket = validatorByPredicate[key] ?? { accepted: 0, rejected: 0, reasons: {} }
      if (entry.ok) bucket.accepted++
      else {
        bucket.rejected++
        const reason = entry.error ?? 'unknown'
        bucket.reasons[reason] = (bucket.reasons[reason] ?? 0) + 1
      }
      validatorByPredicate[key] = bucket
    }
  }

  const finishedAt = nowIso()
  // Evidence counters in the exact shape `setRoute` requires. They are recorded so
  // any future enablement is bound to this corpus, evaluator, and model digest
  // rather than to hand-entered numbers. Nothing here writes a route.
  const measuredAt = Date.parse(finishedAt)
  const routeEvidenceByPredicate = {}
  for (const predicate of Object.keys(result.routes)) {
    const route = result.routes[predicate]
    const bucket = result.byPredicate[predicate]
    routeEvidenceByPredicate[predicate] = {
      corpusSha256: corpusSha,
      evaluatorSha256,
      modelDigest: identity.digest,
      tp: bucket.tp,
      fp: bucket.fp,
      fn: bucket.fn,
      positiveLabels: bucket.positiveLabels,
      safetyFailures: route.safetyFailures,
      precision: route.precision,
      recall: route.recall,
      measuredAt,
    }
  }
  const invocationElapsedMs = Date.now() - startedAt
  // Timing before this invocation, so a rebuild can report the original inference
  // cost and finish time instead of presenting its own metadata as a new run.
  const priorTiming = checkpoint.timing && typeof checkpoint.timing === 'object'
    ? {
        firstStartedAt: checkpoint.timing.firstStartedAt,
        lastFinishedAt: checkpoint.timing.lastFinishedAt ?? null,
        activeElapsedMs: checkpoint.timing.activeElapsedMs ?? null,
        modelElapsedMs: checkpoint.timing.modelElapsedMs ?? null,
        modelCalls: checkpoint.timing.modelCalls ?? null,
      }
    : null
  timing.activeElapsedMs += invocationElapsedMs
  timing.modelElapsedMs += runModelMs
  timing.modelCalls += modelCalls
  timing.lastFinishedAt = finishedAt
  checkpoint.timing = timing
  checkpoint.updatedAt = finishedAt
  if (complete && !checkpoint.completedAt) checkpoint.completedAt = finishedAt
  writeJsonAtomic(checkpointPath, checkpoint)

  const artifact = {
    schema: ARTIFACT_SCHEMA,
    runner: RUNNER_VERSION,
    generatedAt: finishedAt,
    complete,
    answeredComplete,
    partial: !fullCorpus,
    identity,
    model: modelInfo,
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpuModel: os.cpus()?.[0]?.model ?? null,
      cpuCount: os.cpus()?.length ?? null,
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    },
    options: { ...MODEL_OPTIONS },
    promptVersion,
    promptTemplateSha256: sha256(template),
    audit: {
      runner: {
        version: RUNNER_VERSION,
        path: path.relative(process.cwd(), RUNNER_SOURCE_PATH) || RUNNER_SOURCE_PATH,
        sha256: runnerSha256,
      },
      evaluator: {
        path: EVALUATOR_SOURCE_LABEL,
        sha256: evaluatorSha256,
      },
      promptTemplateSha256: sha256(template),
      promptSet: {
        count: rescore.promptSet.length,
        sha256: promptSetSha256,
        perCase: rescore.promptSet.map((line) => {
          const [caseId, hash] = line.split('\u0000')
          return { caseId, sha256: hash }
        }),
      },
      rescore: {
        checked: rescore.checked,
        identical: rescore.identical,
        driftedCaseIds: rescore.driftedCaseIds,
        promptMismatchCaseIds: rescore.promptMismatchCaseIds,
      },
      checkpoint: {
        path: checkpointPath,
        createdAt: checkpoint.createdAt,
        completedAt: checkpoint.completedAt ?? null,
        invocations: checkpoint.invocations,
        identityRebinds: checkpoint.identityRebinds ?? [],
      },
    },
    regeneration: {
      // The artifact may be rebuilt over an existing checkpoint. When it is, this
      // block says so instead of letting fresh metadata imply fresh inference.
      modelCallsThisInvocation: modelCalls,
      rebuiltWithoutInference: modelCalls === 0 && rescore.checked > 0,
      rescoredCases: rescore.checked,
      rescoreIdentical: rescore.identical,
      rescoreDriftedCaseIds: rescore.driftedCaseIds,
      originalInference: {
        modelCalls: timing.modelCalls,
        modelElapsedMs: timing.modelElapsedMs,
        firstStartedAt: timing.firstStartedAt,
        lastAnswerAt,
        note: 'lastAnswerAt is the newest per-case attemptedAt in the checkpoint. It is the ' +
          'original answer time, not the time this artifact was rebuilt',
      },
      note: modelCalls === 0 && rescore.checked > 0
        ? 'this artifact was rebuilt from an existing checkpoint with 0 model calls. Raw ' +
          'outputs, prompt bytes and per-case scores were read back and re-verified. Timing, ' +
          'generatedAt and identity metadata were reconstructed over the original inference ' +
          'checkpoint; they do not come from a second inference run'
        : 'this invocation performed the model calls recorded above',
    },
    corpus: {
      path: corpusPath,
      sha256: corpusSha,
      schemaVersion: corpus.schemaVersion,
      caseCount: corpus.cases.length,
      caseIds: plans.map((plan) => plan.id),
    },
    evaluation: {
      scope: fullCorpus ? 'all-cases' : 'partial-set',
      limit: args.limit,
      evaluatedCaseIds: evaluationIds,
      evaluatedCount: prefix.length,
      corpusCaseCount: plans.length,
      answeredCount: Object.keys(proposalsByCase).length,
      probeOnlyCaseIds: probeOnlyImpact.caseIds,
      degradedPromptCaseIds: degradedActiveFactIds,
    },
    timing: {
      firstStartedAt: timing.firstStartedAt,
      lastFinishedAt: finishedAt,
      wallClockMs: Date.parse(finishedAt) - Date.parse(timing.firstStartedAt),
      // Time the runner actually spent working (sum over invocations), excluding
      // idle gaps between an interruption and its resume.
      elapsedMs: timing.activeElapsedMs,
      modelElapsedMs: timing.modelElapsedMs,
      averageModelMsPerCall: timing.modelCalls > 0
        ? Math.round(timing.modelElapsedMs / timing.modelCalls)
        : null,
      maxModelMs: caseElapsed.length > 0 ? Math.max(...caseElapsed) : null,
      modelCalls: timing.modelCalls,
      invocations: checkpoint.invocations,
      thisInvocation: {
        startedAt: startedAtIso,
        elapsedMs: invocationElapsedMs,
        modelElapsedMs: runModelMs,
        modelCalls,
      },
      priorToThisInvocation: priorTiming,
    },
    summary: {
      casesEvaluated: result.totals.cases,
      casesAnswered: Object.keys(proposalsByCase).length,
      casesMissing: result.totals.missing,
      casesInvalidJson: result.totals.invalidJson,
      casesInvalidOutput: result.totals.invalidOutput,
      casesEmpty: result.totals.empty,
      tp: result.totals.tp,
      fp: result.totals.fp,
      fn: result.totals.fn,
      precision: result.totals.precision,
      recall: result.totals.recall,
      jsonValid: result.totals.jsonValid,
      evidenceValid: result.totals.evidenceValid,
      evidenceInvalidProductionReachable: safetyAttribution.evidenceInvalid
        .filter((entry) => entry.productionReachable).length,
      evidenceInvalidProbeOnly: safetyAttribution.evidenceInvalid
        .filter((entry) => !entry.productionReachable).length,
      outputValid: result.totals.outputValid,
      safetyFailures: result.totals.safetyFailures,
      safetyFailuresProductionReachable: safetyAttribution.productionReachable.count,
      probeOnlySafetyFailures: safetyAttribution.probeOnly.count,
      globalSafetyFailures: result.totals.globalSafetyFailures,
      severeCasesEvaluated: safetyAttribution.severe.evaluatedCaseIds.length,
      severeAccepted: result.totals.severeAccepted,
      severeAcceptedProductionReachable: safetyAttribution.productionReachable.severeAccepted,
      severeAcceptedProbeOnly: safetyAttribution.probeOnly.severeAccepted,
      severeRejected: safetyAttribution.severe.rejectedCount,
      casesWithProbeOnlyEvidence: probeOnlyImpact.caseIds.length,
      casesWithDegenerateActiveFacts: degradedActiveFactIds.length,
      routesEnabled: result.routeSummary.enabled,
      routesDisabled: result.routeSummary.disabled,
    },
    metrics: {
      status: result.status,
      passed: result.passed,
      totals: result.totals,
      byPredicate: result.byPredicate,
      routes: result.routes,
      routeSummary: result.routeSummary,
      failures: result.failures,
    },
    safetyAttribution,
    safetyByPredicate,
    routeAssessment,
    probeOnlyScoreImpact: probeOnlyImpact,
    degradedPrompts: {
      code: 'active-fact-text-missing',
      activeFactTextMissingCaseIds: degradedActiveFactIds,
      correctionResultsLowerBound: degradedActiveFactIds.length > 0,
      syntheticCorrectionTargetDefaults: {
        ...SYNTHETIC_ACTIVE_TARGET,
        synthetic: true,
      },
      cases: degradedActiveFactCases,
      note: 'the corpus fixes only assertionId and predicate for an active target, so ACTIVE ' +
        'FACTS renders text:null and the target carries a synthetic validFrom/seq (500/0). ' +
        'Production shows the stored value text and real times. Correction/retraction scores ' +
        'on these cases are a lower bound measured under a degenerate prompt, not a ' +
        'production measurement',
    },
    // Machine-readable companion to `warnings`. Consumers should read this block
    // before treating recall or correction scores as production guarantees.
    measurementCaveats: {
      version: 1,
      recall: {
        measuredUnder: 'scorer-clause-rules',
        productionRule: 'clause-aligned-unique-span',
        upperBoundOnProductionAcceptance: true,
        detail: 'recall is computed against the offline scorer, which applies its own ' +
          'clause-aligned unique-span rule. The production validator additionally requires ' +
          'the character after a whole-sentence quote to separate it, so some scorer ' +
          'acceptances are refused in production. Recall is an upper bound, not a guarantee',
      },
      correctionCases: {
        degenerateActiveFacts: degradedActiveFactIds.length > 0,
        activeFactTextSource: 'absent-from-corpus',
        syntheticTargetFields: { ...SYNTHETIC_ACTIVE_TARGET },
        correctionResultsLowerBound: degradedActiveFactIds.length > 0,
        caseIds: degradedActiveFactIds,
        detail: 'correction/retraction cases target an active fact whose text is not in the ' +
          'corpus and whose validFrom/seq are synthetic placeholders. Production would show ' +
          'the stored text and real times. These scores are a lower bound under a degenerate ' +
          'prompt, not a production measurement',
      },
      corpusLabelsModified: false,
      routeEnablement: 'no route was written; see routeState.routeEvidenceByPredicate',
    },
    validatorByPredicate,
    routeState: {
      // This task never opens a route. These are recommendations only.
      routesWritten: false,
      enabledNow: [],
      recommendedByEvaluator: result.routeSummary.enabled,
      model: modelInfo.name,
      modelDigest: modelInfo.digest,
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      corpusSha256: corpusSha,
      evaluatorSha256,
      routeEvidenceByPredicate,
      enablementTarget: {
        model: modelInfo.name,
        modelDigest: modelInfo.digest,
        schemaVersion: PROPOSAL_SCHEMA_VERSION,
        corpusSha256: corpusSha,
        evaluatorSha256,
        predicatesRecommended: result.routeSummary.enabled,
        note: 'any future route row must be keyed by this model digest and carry these ' +
          'evidence counters; counters are corpus-wide and a route is per scope, so a ' +
          'scope-specific row also requires that scope to be the evaluated population',
      },
      note: 'no route state is read or written by this runner; recommendations are ' +
        'evaluator output only',
    },
    liveWrites: false,
    cases: artifactCases,
    errors,
    warnings,
  }

  writeJsonAtomic(outPath, artifact)

  const elapsed = Date.now() - startedAt
  process.stdout.write(
    `\nsummary ${fullCorpus ? 'FULL' : 'PARTIAL'} ` +
    `${answeredComplete ? 'answered' : 'INCOMPLETE'} in ${(elapsed / 1000).toFixed(1)}s ` +
    `(run ${(artifact.timing.elapsedMs / 1000).toFixed(1)}s, ` +
    `model ${(artifact.timing.modelElapsedMs / 1000).toFixed(1)}s, ` +
    `${modelCalls} calls this invocation)\n` +
    `  evaluator: status=${result.status} passed=${result.passed} ` +
    `tp=${result.totals.tp} fp=${result.totals.fp} fn=${result.totals.fn} ` +
    `precision=${fmt(result.totals.precision)} recall=${fmt(result.totals.recall)}\n` +
    `  validity: json=${result.totals.jsonValid} evidence=${result.totals.evidenceValid} ` +
    `output=${result.totals.outputValid} safety=${result.totals.safetyFailures} ` +
    `(reachable=${safetyAttribution.productionReachable.count}, ` +
    `probe-only=${safetyAttribution.probeOnly.count}) ` +
    `severeAccepted=${result.totals.severeAccepted} (of ` +
    `${safetyAttribution.severe.evaluatedCaseIds.length} severe cases)\n`,
  )
  for (const predicate of Object.keys(result.routes)) {
    const route = result.routes[predicate]
    const bucket = result.byPredicate[predicate]
    const assessment = routeAssessment[predicate]
    const probeNote = route.reason
      ? ` (${route.reason}; excluding probe-only: ` +
        `${assessment.bindingConstraintExcludingProbeOnly ?? 'qualifies'})`
      : ''
    process.stdout.write(
      `  ${predicate}: precision=${fmt(bucket.precision)} recall=${fmt(bucket.recall)} ` +
      `tp=${bucket.tp} fp=${bucket.fp} fn=${bucket.fn} labels=${bucket.positiveLabels} ` +
      `safety=${bucket.safetyFailures} (reachable=` +
      `${assessment.productionReachableSafetyFailures}, probe-only=` +
      `${assessment.probeOnlySafetyFailures}) route=${route.enabled ? 'QUALIFIES' : 'closed'}` +
      `${probeNote}\n`,
    )
  }
  process.stdout.write(`  out: ${outPath}\n`)
  if (!answeredComplete) {
    process.stdout.write('  resume with the same command to finish pending cases\n')
    process.exitCode = 5
  } else if (!fullCorpus) {
    process.stdout.write(
      `  partial run: ${prefix.length}/${plans.length} cases; rerun without --limit ` +
      'for the full corpus baseline\n',
    )
  }
}

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(3)
}

main().catch((error) => {
  const kind = error?.kind ?? 'fatal'
  process.stderr.write(`proposal-baseline failed [${kind}]: ${error?.message ?? error}\n`)
  if (kind === 'usage') {
    process.stderr.write('\n')
    process.stderr.write(`${USAGE}\n`)
  }
  process.exitCode = error?.exitCode ?? 1
})
