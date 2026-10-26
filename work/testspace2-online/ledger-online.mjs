// Thin DSH host plugin for the isolated online ledger test instance.
//
// This file only wires the host surface to LedgerOnlineBridge:
//   session/event  -> bridge.handleEvent (archive + schedule proposals)
//   agent/pre-step -> next(), then append one verified-facts message
//   dispose        -> flush status, close SQLite
// It is inert unless LEDGER_ONLINE=1. Packaging and launch scripts come later.
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Installed profile copies the bridge next to this file; source checkout keeps it
// under web/. Resolve both forms so the same plugin file can be smoke-tested in place
// and loaded from the isolated DSH profile.
const bridgeModule = await import('./memory-online-bridge.mjs')
  .catch(() => import('../../web/memory-online-bridge.mjs'))
const { LedgerOnlineBridge } = bridgeModule

const NAME = 'LEDGER_ONLINE'
const DEFAULT_MODEL = 'qwen3:4b-instruct-2507-q4_K_M'
const DEFAULT_DIGEST = '0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0'
const PROVIDER = 'ollama-local'
const MAX_TOKENS = 1024

const log = (tag, fields = {}) => {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  console.log(`[${NAME}] ${tag}${detail ? ' ' + detail : ''}`)
}

function isEnabled() {
  return process.env.LEDGER_ONLINE === '1'
}

function stateDirFromEnv() {
  const explicit = process.env.LEDGER_ONLINE_STATE_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'state-compiler', 'ledger-online')
}

function workspaceFromEnv() {
  const value = process.env.LEDGER_ONLINE_WORKSPACE
  // No fallback: a stale default once pointed at an archived test directory, and a
  // silently wrong workspace is worse than a disabled plugin.
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

// Subagent detection mirrors the host-written session meta: origin or a positive
// delegation depth. A subagent's events must never enter the parent's evidence set.
function isSubagentSession(session) {
  const meta = session?.meta ?? {}
  const header = session?.header ?? {}
  if (meta.origin === 'subagent' || header.origin === 'subagent') return true
  const depth = header.delegationDepth ?? meta.delegationDepth ?? session?.delegationDepth
  return typeof depth === 'number' && depth > 0
}

// Closed Qwen channel: the same direct localhost Ollama shape used by the recorded
// offline baseline. The host LLM stream is intentionally bypassed here because the
// online-test profile's compaction stream never completed for this local model.
const OLLAMA_CHAT = 'http://127.0.0.1:11434/api/chat'
const QWEN_OPTIONS = Object.freeze({
  temperature: 0,
  seed: 42,
  top_k: 1,
  top_p: 1,
  repeat_penalty: 1,
  num_predict: MAX_TOKENS,
  num_ctx: 4096,
})

function makeQwenCallModel() {
  return async ({ prompt, model }) => {
    let response
    try {
      response = await fetch(OLLAMA_CHAT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          format: 'json',
          think: false,
          keep_alive: '10m',
          options: QWEN_OPTIONS,
        }),
        signal: AbortSignal.timeout(240_000),
      })
    } catch (error) {
      throw new Error(`qwen-transport:${String(error?.message ?? error)}`)
    }
    if (!response.ok) throw new Error(`qwen-http:${response.status}`)
    const body = await response.json()
    if (body?.done !== true) throw new Error(`qwen-finish:${body?.done_reason ?? 'missing'}`)
    const text = body?.message?.content
    if (typeof text !== 'string' || text.trim() === '') throw new Error('qwen-empty-response')
    return text
  }
}

export default {
  name: NAME,
  inject: ['tools'],
  apply(ctx) {
    if (!isEnabled()) return

    let bridge = null
    let closed = false
    try {
      const stateDir = stateDirFromEnv()
      const workspaceRoot = workspaceFromEnv()
      if (!workspaceRoot) {
        log('disabled', { reason: 'workspace-missing (set LEDGER_ONLINE_WORKSPACE)' })
        return
      }
      bridge = new LedgerOnlineBridge({
        stateDir,
        workspaceRoot,
        qwenModel: process.env.LEDGER_ONLINE_QWEN_MODEL || DEFAULT_MODEL,
        qwenDigest: process.env.LEDGER_ONLINE_QWEN_DIGEST || DEFAULT_DIGEST,
        callModel: makeQwenCallModel(ctx),
        probeFiles: true,
        requireWorkspaceCwd: process.env.LEDGER_ONLINE_REQUIRE_CWD === '1',
        onChange: (status) => log('work-settled', {
          pending: status.pending,
          proposals: status.proposals.state,
          calls: status.qwen.calls,
          succeeded: status.qwen.succeeded,
          failed: status.qwen.failed,
          lastError: status.qwen.lastError,
        }),
      })
      log('armed', {
        stateDir,
        workspaceRoot,
        scope: bridge.scope,
        model: bridge.qwenModel,
        provider: PROVIDER,
        maxTokens: MAX_TOKENS,
        routes: 'closed (candidates only)',
      })
    } catch (error) {
      log('disabled', { reason: `bridge-init-failed: ${String(error?.message ?? error)}` })
      return
    }

    const flushStatus = (reason) => {
      try {
        const status = bridge.status()
        log('status', {
          reason,
          pending: status.pending,
          userMessages: status.archived.userMessages,
          toolObservations: status.archived.toolObservations,
          facts: status.facts.current,
          proposals: status.proposals.state,
          qwenCalls: status.qwen.calls,
        })
      } catch (error) {
        log('status-failed', { reason, error: String(error?.message ?? error) })
      }
    }

    try {
      ctx.on('session/event', (subject, event) => {
        try {
          const session = event === undefined ? (subject?.session ?? subject) : subject
          const ev = event === undefined ? subject : event
          if (!session || isSubagentSession(session)) return
          const sid = session.id
          if (!sid) return
          bridge.handleEvent(session, sid, ev)
          // Flush only on state-changing events; assistant deltas are ignored upstream.
          if (ev?.type === 'user/message' || ev?.type === 'tool/result') {
            flushStatus(ev.type)
          }
        } catch (error) {
          log('event-failed', { error: String(error?.message ?? error) })
        }
      })

      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          const session = payload?.agent?.session ?? null
          if (!session || isSubagentSession(session)) return decision
          const sid = session.id
          if (!sid) return decision
          const message = bridge.preStep(session, sid, decision)
          if (!message) return decision
          const text = message.content[0].text
          log('inject', {
            sid,
            turn: payload?.turn ?? null,
            step: payload?.step ?? null,
            chars: text.length,
            hash: createHash('sha256').update(text).digest('hex'),
          })
          return { ...decision, messages: [...decision.messages, message] }
        } catch (error) {
          log('pre-step-failed', { error: String(error?.message ?? error) })
          return decision
        }
      })
    } catch (error) {
      log('hooks-failed', { error: String(error?.message ?? error) })
      try { bridge.close() } catch { /* ignore */ }
      return
    }

    const dispose = () => {
      if (closed) return
      closed = true
      flushStatus('dispose')
      try { bridge.close() } catch (error) {
        log('close-failed', { error: String(error?.message ?? error) })
      }
      log('disposed', {})
    }
    try {
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
      else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
    } catch (error) {
      log('dispose-registration-failed', { error: String(error?.message ?? error) })
    }
  },
}
