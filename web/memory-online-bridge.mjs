// Host bridge for the isolated RCS online test instance.
//
// Responsibilities, in order of trust:
//   1. Consume real DSH `session/event` emissions (user/message, tool/call, tool/result).
//   2. Archive only host-classified human text and paired tool observations in MemoryLedger.
//   3. Ask ProposalEngine (Qwen) for closed-schema proposals at most one run at a time.
//   4. Expose only deterministic, injectable current facts for `agent/pre-step`.
//
// Boundaries that are deliberate, not configurable:
//   - The workspace is fixed by the constructor. A session cwd is recorded when it
//     differs but never used to place files or select a scope.
//   - No route is ever written here. ProposalEngine therefore leaves every proposal
//     in candidate isolation, and renderCurrent() cannot render candidate text.
//   - Qwen output is untrusted: its failures are archived as failed runs and never
//     touch the deterministic fact projection.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyUserMessage } from '../condense/chunk.mjs'
import { MemoryLedger } from './memory-ledger.mjs'
import { ProposalJournal } from './memory-proposal-store.mjs'
import {
  PROPOSAL_SCHEMA_VERSION,
  ProposalEngine,
} from './memory-proposals.mjs'
import {
  observationFromProbe,
  observationFromTool,
  observationFromUserMessage,
} from './memory-observations.mjs'

export const LEDGER_ONLINE_PREFIX = '[LEDGER MEMORY — verified current facts]'
export const LEDGER_ONLINE_SOURCE_KIND = 'plugin:LEDGER_ONLINE'
export const DEFAULT_LEDGER_ONLINE_BUDGET = 2400

const NON_TOOL_OPS = ['user_message', 'scope_init', 'legacy_snapshot']
const FALLBACK_SEQ_BASE = 1_000_000_000

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

// Workspace identity: backslashes become slashes, repeated slashes collapse, a
// trailing slash is removed, and the result is lowercased. The same normalized
// path is used for the ledger scope, so two spellings of one workspace can never
// split into two ledgers.
export function normalizeWorkspacePath(value) {
  if (!nonEmptyString(value)) throw new TypeError('workspace path must be a non-empty string')
  const unified = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const stripped = unified === '/' ? '/' : unified.replace(/\/+$/, '')
  return (stripped === '' ? '/' : stripped).toLowerCase()
}

export function scopeForWorkspace(value) {
  return `ws:${normalizeWorkspacePath(value)}`
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function messageText(data) {
  if (!data || typeof data !== 'object') return ''
  const direct = contentText(data.content)
  if (direct !== '') return direct
  return contentText(data.message?.content)
}

function identifier(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    return String(value)
  }
  return null
}

function firstMeasurement(sources, field) {
  for (const source of sources) {
    if (!source) continue
    const nested = asObject(source.value)
    const value = source[field] ?? nested?.[field]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

// Extract the call id and only the measurements the host actually reported.
// A text-only tool result has no size/hash; that stays unknown instead of being
// fabricated from the tool name or the arguments.
export function extractToolResult(event) {
  const data = asObject(event?.data) ?? {}
  const message = asObject(data.message) ?? {}
  const blocks = Array.isArray(message.content)
    ? message.content.filter((block) => asObject(block) && block.type === 'tool-result')
    : []
  const block = blocks[0] ?? null
  const callId = identifier(
    block?.toolCallId, message.toolCallId, message.callId,
    block?.callId, data.callId, data.toolCallId,
  )
  const blockError = blocks.some((item) => item?.isError === true)
  const isError = blocks.length > 0
    ? blockError
    : (typeof message.isError === 'boolean' ? message.isError
      : (typeof block?.isError === 'boolean' ? block.isError
        : (typeof data.result?.isError === 'boolean' ? data.result.isError
          : (typeof data.isError === 'boolean' ? data.isError : undefined))))

  const sources = [
    block, block?.value, message, message.value, data.result, data.value, data,
  ].map(asObject)
  const measured = {}
  for (const field of ['exists', 'size', 'mtime', 'mtimeMs', 'sha256']) {
    const value = firstMeasurement(sources, field)
    if (value !== undefined) measured[field] = value
  }
  if (measured.mtime === undefined && measured.mtimeMs !== undefined) {
    measured.mtime = measured.mtimeMs
  }
  delete measured.mtimeMs

  if (typeof isError === 'boolean') measured.isError = isError
  if (isError === true && measured.error === undefined) {
    const text = contentText(block?.content) || contentText(message.content)
    measured.error = text === '' ? 'tool-error' : text
  }
  return { callId, result: measured, isError }
}

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex')
}

function finiteTime(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export class LedgerOnlineBridge {
  constructor({
    stateDir, workspaceRoot, qwenModel, qwenDigest, callModel, now, budget, onChange,
    probeFiles = false, requireWorkspaceCwd = false,
  } = {}) {
    if (!nonEmptyString(stateDir)) throw new TypeError('stateDir must be a non-empty string')
    if (!nonEmptyString(workspaceRoot)) {
      throw new TypeError('workspaceRoot must be a non-empty string')
    }
    if (!nonEmptyString(qwenModel)) throw new TypeError('qwenModel must be a non-empty string')
    if (!nonEmptyString(qwenDigest)) throw new TypeError('qwenDigest must be a non-empty string')
    if (typeof callModel !== 'function') throw new TypeError('callModel must be a function')
    if (now !== undefined && typeof now !== 'function') {
      throw new TypeError('now must be a function when provided')
    }
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
      throw new TypeError('budget must be a positive number when provided')
    }
    if (onChange !== undefined && typeof onChange !== 'function') {
      throw new TypeError('onChange must be a function when provided')
    }
    if (typeof probeFiles !== 'boolean') throw new TypeError('probeFiles must be boolean')
    if (typeof requireWorkspaceCwd !== 'boolean') {
      throw new TypeError('requireWorkspaceCwd must be boolean')
    }

    this.onChange = onChange ?? null
    this.probeFiles = probeFiles
    // Live sessions span several workspaces. When this is on, a session whose
    // reported cwd differs from the fixed workspace is neither archived nor
    // injected into: its messages must not pollute another project's scope, and
    // this project's verified facts must not leak into it. An unknown cwd is
    // allowed because older hosts and tests do not report one.
    this.requireWorkspaceCwd = requireWorkspaceCwd
    this.stateDir = stateDir
    this.workspaceRoot = workspaceRoot
    this.qwenModel = qwenModel
    this.qwenDigest = qwenDigest
    this.callModel = callModel
    this.now = now ?? (() => Date.now())
    this.budget = budget ?? DEFAULT_LEDGER_ONLINE_BUDGET
    this.scope = scopeForWorkspace(workspaceRoot)
    this.dbPath = join(stateDir, 'ledger.sqlite')
    this.statusPath = join(stateDir, 'status.json')
    this.closed = false

    mkdirSync(stateDir, { recursive: true })
    this.ledger = new MemoryLedger(this.dbPath)
    this.journal = new ProposalJournal(this.ledger.db)
    this.engine = new ProposalEngine({
      ledger: this.ledger,
      journal: this.journal,
      now: this.now,
      callModel: async (request) => {
        this._qwen.calls += 1
        try {
          return await this.callModel(request)
        } catch (error) {
          this._qwen.modelErrors += 1
          throw error
        }
      },
    })

    // Event dedupe and pairing state.
    this._seen = new Set()
    this._fallbackSeq = new Map()
    this._pendingCalls = new Map()
    this._cwdWarned = new Set()
    this._cwdMismatches = 0
    this._lastCwdMismatch = null

    // Proposal serialization: one chain per scope+session keeps Qwen CPU work from
    // overlapping while leaving unrelated sessions independent.
    this._chains = new Map()
    this._tasks = new Set()

    this._qwen = {
      calls: 0,
      modelErrors: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      last: null,
      lastError: null,
    }
    this._lastInjected = new Map()
    this._injection = { count: 0, skipped: 0, last: null }
    this._errors = { count: 0, last: null }
  }

  // Public entry point for `session/event`. It never throws into the host: an
  // event that cannot be classified or archived is counted and skipped.
  handleEvent(session, sid, event) {
    try {
      return this._handleEvent(session, sid, event)
    } catch (error) {
      this._recordError('handleEvent', error, { sid, type: event?.type })
      return false
    }
  }

  _handleEvent(session, sid, event) {
    if (!event || typeof event.type !== 'string') return false
    const sidValue = identifier(sid, session?.id, session?.sessionId)
    if (!sidValue) return false
    const mismatch = this._checkCwd(session, sidValue)
    if (this.requireWorkspaceCwd && mismatch) return false
    const type = event.type === 'tool-call' ? 'tool/call' : event.type
    if (type === 'user/message') return this._handleUserMessage(sidValue, event)
    if (type === 'tool/call') return this._handleToolCall(sidValue, event)
    if (type === 'tool/result') return this._handleToolResult(sidValue, event)
    return false
  }

  // Pure cwd comparison. Null means "no known mismatch": an absent cwd is allowed,
  // and a path that cannot be normalized is not evidence of a foreign workspace.
  _cwdMismatchOf(session) {
    const sessionCwd = identifier(
      session?.cwd, session?.meta?.cwd, session?.header?.cwd,
      session?.workspace, session?.workspaceRoot,
    )
    if (!sessionCwd) return null
    let normalized
    try { normalized = normalizeWorkspacePath(sessionCwd) } catch { return null }
    let expected
    try { expected = normalizeWorkspacePath(this.workspaceRoot) } catch { return null }
    if (normalized === expected) return null
    return { sessionCwd, normalized, expected }
  }

  // The session cwd is evidence about the host's intent, not an instruction. It is
  // compared with the fixed workspace and recorded once per offending value.
  // Returns true when a known cwd differs from the fixed workspace.
  _checkCwd(session, sid) {
    const mismatch = this._cwdMismatchOf(session)
    if (!mismatch) return false
    this._cwdMismatches += 1
    this._lastCwdMismatch = {
      sid,
      sessionCwd: mismatch.sessionCwd,
      workspaceRoot: this.workspaceRoot,
      at: this.now(),
    }
    const key = `${sid}\u0000${mismatch.sessionCwd}`
    if (!this._cwdWarned.has(key)) {
      this._cwdWarned.add(key)
      console.warn(
        `[LEDGER_ONLINE] cwd-mismatch sid=${sid} session=${mismatch.sessionCwd} ` +
        `fixed=${this.workspaceRoot}; session cwd ignored`,
      )
    }
    return true
  }

  _seqOf(event, sid) {
    for (const candidate of [event?.seq, event?.data?.seq, event?.data?.message?.seq]) {
      if (candidate === undefined || candidate === null || candidate === '') continue
      const value = Number(candidate)
      if (Number.isInteger(value) && value >= 0) return value
    }
    const next = this._fallbackSeq.get(sid) ?? FALLBACK_SEQ_BASE
    this._fallbackSeq.set(sid, next + 1)
    return next
  }

  _timeOf(event) {
    return finiteTime(event?.t, finiteTime(event?.data?.t, this.now()))
  }

  _handleUserMessage(sid, event) {
    if (classifyUserMessage(event).cls !== 'user') return false
    const text = messageText(event.data)
    if (text === '') return false
    const seq = this._seqOf(event, sid)
    const eventKey = `${sid}:${seq}:user`
    if (this._seen.has(eventKey)) return false
    const at = this._timeOf(event)
    const channel = event.data?.source?.channel
    const observation = observationFromUserMessage({
      scope: this.scope,
      sid,
      seq,
      validAt: at,
      recordedAt: at,
      text,
      speaker: 'user',
      ...(typeof channel === 'string' && channel.trim() !== ''
        ? { source: { channel } }
        : {}),
    })
    this.ledger.appendObservation(observation)
    this._seen.add(eventKey)
    // Never await the model in the event handler; the host must not stall on Qwen.
    // One Qwen worker per workspace: concurrent sessions share CPU and the same
    // proposal evidence, so they must not overlap model calls.
    this._enqueue(`${this.scope}\u0000proposal`, () => this._runProposal(sid, eventKey))
    return true
  }

  _handleToolCall(sid, event) {
    const data = asObject(event.data) ?? {}
    const callId = identifier(data.callId, data.toolCallId, data.id)
    if (!callId) return false
    const seq = this._seqOf(event, sid)
    const key = `${sid}:${seq}:call:${callId}`
    if (this._seen.has(key)) return false
    this._seen.add(key)
    this._pendingCalls.set(`${sid}\u0000${callId}`, {
      call: {
        callId,
        name: data.name ?? data.toolName,
        arguments: data.arguments ?? data.args,
      },
      seq,
      t: this._timeOf(event),
    })
    return true
  }

  _handleToolResult(sid, event) {
    const { callId, result } = extractToolResult(event)
    if (!callId) return false
    const pendingKey = `${sid}\u0000${callId}`
    const pending = this._pendingCalls.get(pendingKey)
    // A result with no matching call has no trustworthy operation name. Archive
    // nothing rather than inventing a task/file entity for it.
    if (!pending) return false
    this._pendingCalls.delete(pendingKey)
    const seq = this._seqOf(event, sid)
    const key = `${sid}:${seq}:result:${callId}`
    if (this._seen.has(key)) return false
    const at = this._timeOf(event)
    const observation = observationFromTool({
      scope: this.scope,
      sid,
      seq,
      recordedAt: at,
      cwd: this.workspaceRoot,
      call: pending.call,
      result,
    })
    this.ledger.appendObservation(observation)
    this._seen.add(key)
    const resolvedPath = observation.source?.resolvedPath
    if (this.probeFiles && observation.outcome === 'success' &&
        typeof resolvedPath === 'string' && resolvedPath !== '') {
      const probeId = `${sid}:${seq}:probe:${callId}`
      this._enqueue(`${this.scope}\u0000probe\u0000${sid}`, () => this._probePath({
        sid, probeId, path: resolvedPath, at,
      }))
    }
    return true
  }

  async _probePath({ sid, probeId, path, at }) {
    // The probe happens *after* the tool result. Using the older tool-event time
    // lets the write's content-invalidation win the causal tie and hides the very
    // hash this probe measured. Anchor it at the later of event time and probe time.
    const observedAt = Math.max(Number.isFinite(at) ? at : 0, this.now())
    const observation = await observationFromProbe({
      scope: this.scope,
      probeId,
      validAt: observedAt,
      recordedAt: observedAt,
      path,
      io: { stat, readFile, realpath },
    })
    this.ledger.appendObservation(observation)
  }

  _enqueue(key, task) {
    const previous = this._chains.get(key) ?? Promise.resolve()
    const run = previous.then(task)
    const settled = run
      .catch((error) => this._recordError('proposal', error))
      .finally(() => {
        this._tasks.delete(settled)
        if (this._chains.get(key) === settled) this._chains.delete(key)
        try {
          const status = this.status()
          this.onChange?.(status)
        } catch (error) {
          this._recordError('status-after-proposal', error)
        }
      })
    this._chains.set(key, settled)
    this._tasks.add(settled)
    return settled
  }

  async _runProposal(sid, evidenceEventKey) {
    let result
    try {
      result = await this.engine.run({
        scope: this.scope,
        evidenceEventKeys: [evidenceEventKey],
        model: this.qwenModel,
        modelDigest: this.qwenDigest,
        schemaVersion: PROPOSAL_SCHEMA_VERSION,
      })
    } catch (error) {
      this._qwen.failed += 1
      this._qwen.last = {
        status: 'error',
        at: this.now(),
        sid,
        evidenceEventKey,
        accepted: 0,
        candidate: 0,
        rejected: 0,
      }
      this._qwen.lastError = String(error?.message ?? error)
      return
    }
    const skipped = result?.status === 'skipped'
    const failed = result?.status !== 'succeeded' && !skipped
    if (failed) this._qwen.failed += 1
    else if (skipped) this._qwen.skipped += 1
    else this._qwen.succeeded += 1
    this._qwen.last = {
      status: result?.status ?? 'unknown',
      runId: result?.runId ?? null,
      at: this.now(),
      sid,
      evidenceEventKey,
      accepted: result?.accepted ?? 0,
      candidate: result?.candidate ?? 0,
      rejected: result?.rejected ?? 0,
      reason: result?.reason ?? result?.failedReason ?? null,
      gate: result?.gate ?? null,
    }
    this._qwen.lastError = failed
      ? String(result?.failedReason ?? 'proposal-run-failed')
      : null
  }

  // Resolve all proposal work queued so far (including work that settles while
  // draining). Used by tests and by any harness that needs a quiet point.
  async drain() {
    while (this._tasks.size > 0) {
      await Promise.allSettled([...this._tasks])
    }
  }

  // Return at most one plugin message. The rendering path is the ledger's
  // read-time gate: LLM routes are closed and candidate text has no fact version,
  // so only deterministic current facts can reach the prefix.
  preStep(session, sid, decision) {
    try {
      if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
        return null
      }
      const sidValue = identifier(sid, session?.id, session?.sessionId)
      if (!sidValue) return null
      if (this.requireWorkspaceCwd && this._cwdMismatchOf(session)) {
        this._injection.skipped += 1
        return null
      }
      const rendered = this.ledger.renderCurrent(this.scope, this.budget)
      if (!rendered || typeof rendered.text !== 'string' || rendered.text.trim() === '') {
        return null
      }
      const text = `${LEDGER_ONLINE_PREFIX}\n${rendered.text}`
      const hash = contentHash(text)
      if (this._lastInjected.get(sidValue)?.hash === hash) {
        this._injection.skipped += 1
        return null
      }
      const at = this.now()
      this._lastInjected.set(sidValue, { hash, chars: text.length, at })
      this._injection.count += 1
      this._injection.last = {
        sid: sidValue, hash, chars: text.length, at,
      }
      return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: LEDGER_ONLINE_SOURCE_KIND },
      }
    } catch (error) {
      this._recordError('preStep', error, { sid })
      return null
    }
  }

  // Measured status. Counts come from the archive and the journal, not from
  // counters that could drift; only the injection/qwen observations are local.
  status() {
    const scope = this.scope
    const count = (sql, ...params) => {
      const row = this.ledger.db.prepare(sql).get(...params)
      return row?.count ?? 0
    }
    const archived = {
      userMessages: count(
        "SELECT count(*) AS count FROM ledger_observations WHERE scope = ? AND op = 'user_message'",
        scope,
      ),
      toolObservations: count(
        `SELECT count(*) AS count FROM ledger_observations
         WHERE scope = ? AND op NOT IN (${NON_TOOL_OPS.map(() => '?').join(',')})`,
        scope, ...NON_TOOL_OPS,
      ),
      total: count(
        'SELECT count(*) AS count FROM ledger_observations WHERE scope = ?',
        scope,
      ),
    }
    let currentFacts = []
    let injectableFacts = []
    let projection = null
    try {
      currentFacts = this.ledger.currentFacts(scope)
      injectableFacts = this.ledger.currentFacts(scope, { injectableOnly: true })
      projection = this.ledger.projectionStatus(scope)
    } catch (error) {
      this._recordError('status-facts', error, { scope })
    }
    let metrics = null
    try {
      metrics = this.journal.metrics(scope)
    } catch (error) {
      this._recordError('status-proposals', error, { scope })
    }
    const predicates = [...new Set(currentFacts.map((fact) => fact.predicate))].sort()
    const result = {
      scope,
      workspaceRoot: this.workspaceRoot,
      stateDir: this.stateDir,
      dbPath: this.dbPath,
      archived,
      facts: {
        current: currentFacts.length,
        injectable: injectableFacts.length,
        predicates,
      },
      projection: projection
        ? {
          status: projection.status,
          projectionHash: projection.projectionHash,
          reason: projection.reason,
        }
        : null,
      proposals: {
        state: metrics?.state ?? 'not-run',
        runs: metrics?.runs ?? { total: 0, succeeded: 0, failed: 0 },
        applications: metrics?.applications ?? { applied: 0, failed: 0, closed: 0 },
        accepted: metrics?.proposals?.accepted ?? 0,
        candidates: metrics?.proposals?.candidate ?? 0,
        rejections: metrics?.proposals?.rejected ?? 0,
        promoted: metrics?.proposals?.promoted ?? 0,
        lastRun: metrics?.lastRun ?? null,
        rejectionReasons: metrics?.rejectionReasons ?? {},
      },
      qwen: {
        model: this.qwenModel,
        digest: this.qwenDigest,
        calls: this._qwen.calls,
        modelErrors: this._qwen.modelErrors,
        succeeded: this._qwen.succeeded,
        failed: this._qwen.failed,
        skipped: this._qwen.skipped,
        last: this._qwen.last,
        lastError: this._qwen.lastError,
      },
      pending: this._tasks.size,
      seenEvents: this._seen.size,
      injection: {
        count: this._injection.count,
        skipped: this._injection.skipped,
        last: this._injection.last,
      },
      cwdMismatches: this._cwdMismatches,
      lastCwdMismatch: this._lastCwdMismatch,
      errors: {
        count: this._errors.count,
        last: this._errors.last,
      },
      updatedAt: this.now(),
    }
    writeFileSync(this.statusPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  }

  _recordError(stage, error, context = {}) {
    this._errors.count += 1
    this._errors.last = {
      stage,
      message: String(error?.message ?? error),
      at: this.now(),
      ...context,
    }
    console.error(`[LEDGER_ONLINE] ${stage} error: ${String(error?.message ?? error)}`)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.ledger.close()
  }
}

export default LedgerOnlineBridge
