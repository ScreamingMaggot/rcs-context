// Host bridge for the isolated online test instance: real DSH session events in,
// deterministic ledger facts and candidate-isolated proposals out.
// Run: node tests/memory-online-bridge.test.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  LEDGER_ONLINE_PREFIX,
  LedgerOnlineBridge,
  normalizeWorkspacePath,
} from '../web/memory-online-bridge.mjs'
import { PROPOSAL_SCHEMA_VERSION } from '../web/memory-proposals.mjs'

const ROOT = mkdtempSync(join(tmpdir(), 'rcs-ledger-online-'))
const WS = join(ROOT, 'workspace')
const STATE = join(ROOT, 'state')
const MODEL = 'qwen3:4b-instruct-2507-q4_K_M'
const DIGEST = '0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0'
const T0 = 1_700_000_000_000
const USER_TEXT = '记下，接口端口固定为 8848，不要再改。'
const CANDIDATE_QUOTE = '接口端口固定为 8848'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SCOPE = `ws:${normalizeWorkspacePath(WS)}`

let fails = 0
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!condition) fails++
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const json = (value) => JSON.stringify(value)

let clock = T0
const bridges = []
let stateIndex = 0
const makeBridge = (callModel, overrides = {}) => {
  const stateDir = join(STATE, String(++stateIndex))
  const bridge = new LedgerOnlineBridge({
    stateDir,
    workspaceRoot: overrides.workspaceRoot ?? WS,
    qwenModel: MODEL,
    qwenDigest: DIGEST,
    callModel,
    now: () => clock,
    budget: 4000,
    ...overrides,
  })
  bridges.push(bridge)
  return bridge
}

const userEvent = (text, { seq, t, sid = 's1', source = { kind: 'user' } } = {}) => ({
  type: 'user/message',
  seq,
  t,
  data: {
    source,
    message: { role: 'user', content: [{ type: 'text', text }] },
  },
})

const toolCall = (callId, name, args, { seq, t } = {}) => ({
  type: 'tool/call',
  seq,
  t,
  data: { callId, name, arguments: json(args) },
})

const toolResult = (callId, { seq, t, result = {}, isError = false } = {}) => ({
  type: 'tool/result',
  seq,
  t,
  data: {
    callId,
    result: { ...result, ...(isError ? { isError: true } : {}) },
    message: {
      role: 'tool',
      isError,
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError,
        content: isError ? 'tool failed' : 'ok',
      }],
    },
  },
})

const writeEvents = (callId, path, result, seqBase, { sid = 's1' } = {}) => [
  toolCall(callId, 'write', { path }, { seq: seqBase, t: T0 + seqBase }),
  toolResult(callId, { seq: seqBase + 1, t: T0 + seqBase + 1, result }),
]

// Fake model with per-call observable requests. Outputs are either strings or
// functions of the request; an Error instance is thrown.
const fakeModel = (...outputs) => {
  const calls = []
  const fn = async (request) => {
    calls.push(request)
    const output = outputs[Math.min(calls.length - 1, outputs.length - 1)]
    const value = typeof output === 'function' ? output(request) : output
    if (value instanceof Error) throw value
    return value
  }
  fn.calls = calls
  return fn
}

const emptyOutput = json({ proposals: [] })
const candidateOutput = json({
  proposals: [{
    op: 'assert',
    predicate: 'project.constraint',
    targetAssertionId: null,
    evidence: { eventKey: 's1:3:user', quote: CANDIDATE_QUOTE },
  }],
})

const factMap = (bridge) => {
  const map = {}
  for (const fact of bridge.ledger.currentFacts(bridge.scope)) {
    if (!map[fact.predicate]) map[fact.predicate] = []
    map[fact.predicate].push(fact.value)
  }
  return map
}
const injectedText = (message) => message?.content?.[0]?.text ?? null

try {
  // ---------------------------------------------------------------------------
  // 1. Human user/message is archived verbatim; non-human text never is.
  // ---------------------------------------------------------------------------
  {
    const model = fakeModel(emptyOutput)
    const bridge = makeBridge(model)
    bridge.handleEvent({ id: 's1' }, 's1', userEvent(USER_TEXT, { seq: 3, t: T0 + 3 }))
    const archived = bridge.ledger.getObservation('s1:3:user', { scope: SCOPE })
    check('human user message is archived under the fixed workspace scope',
      archived?.scope === SCOPE && archived.op === 'user_message')
    check('archived user message keeps the complete text and host-derived human source',
      archived?.rawPayload?.text === USER_TEXT &&
      archived?.value?.human === true && archived?.value?.speaker === 'user' &&
      archived?.source?.kind === 'user' && archived?.source?.authority === 'user')
    await bridge.drain()
    const status = bridge.status()
    check('status reports one archived user message',
      status.archived.userMessages === 1 && status.archived.toolObservations === 0)
    check('scope status and workspace are reported verbatim',
      status.scope === SCOPE && status.workspaceRoot === WS)

    const before = bridge.ledger.currentFacts(SCOPE).length
    bridge.handleEvent({ id: 's1' }, 's1', {
      type: 'user/message', seq: 4, t: T0 + 4,
      data: {
        source: { kind: 'plugin:CONTEXTinjector' },
        message: { role: 'user', content: [{ type: 'text', text: 'plugin injected text' }] },
      },
    })
    bridge.handleEvent({ id: 's1' }, 's1', {
      type: 'user/message', seq: 5, t: T0 + 5,
      data: {
        source: { kind: 'assistant' },
        message: { role: 'user', content: [{ type: 'text', text: 'assistant text' }] },
      },
    })
    bridge.handleEvent({ id: 's1' }, 's1', {
      type: 'assistant/message', seq: 6, t: T0 + 6,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'model prose' }] } },
    })
    await bridge.drain()
    check('non-human user/message sources and assistant messages are ignored',
      bridge.ledger.getObservation('s1:4:user', { scope: SCOPE }) === null &&
      bridge.ledger.getObservation('s1:5:user', { scope: SCOPE }) === null &&
      bridge.status().archived.userMessages === 1 &&
      model.calls.length === 1 &&
      bridge.ledger.currentFacts(SCOPE).length === before)
  }

  // ---------------------------------------------------------------------------
  // 2. Candidate text is never injected; verified file facts are.
  // ---------------------------------------------------------------------------
  {
    const model = fakeModel(candidateOutput)
    const bridge = makeBridge(model)
    for (const event of writeEvents('c-w', 'notes.txt',
      { exists: true, size: 12, mtime: T0 + 1, sha256: SHA_A }, 1)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    bridge.handleEvent({ id: 's1' }, 's1', userEvent(USER_TEXT, { seq: 3, t: T0 + 3 }))
    await bridge.drain()
    const status = bridge.status()
    check('proposal run with the closed schema reaches candidate isolation',
      status.proposals.runs.succeeded === 1 && status.proposals.candidates === 1 &&
      status.proposals.accepted === 0 && status.proposals.rejections === 0)
    const decision = { kind: 'enter', messages: [{ role: 'user', content: [] }] }
    const message = bridge.preStep({ id: 's1' }, 's1', decision)
    const text = injectedText(message)
    check('pre-step returns exactly one clearly prefixed plugin message',
      message?.role === 'user' && message?.source?.kind === 'plugin:LEDGER_ONLINE' &&
      typeof text === 'string' && text.startsWith(LEDGER_ONLINE_PREFIX))
    check('pre-step injects the deterministic file facts',
      text.includes('notes.txt') && text.includes('的大小为 12 字节'))
    check('pre-step never injects candidate text or its quote',
      !text.includes(CANDIDATE_QUOTE) && !text.includes('接口端口') && !text.includes('8848'))
  }

  // ---------------------------------------------------------------------------
  // 3. Malformed Qwen output and model failure never change verified facts.
  // ---------------------------------------------------------------------------
  {
    const model = fakeModel('{not json')
    const bridge = makeBridge(model)
    for (const event of writeEvents('c-m', 'malformed.txt',
      { exists: true, size: 21, sha256: SHA_A }, 1)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    bridge.handleEvent({ id: 's1' }, 's1', userEvent(USER_TEXT, { seq: 3, t: T0 + 3 }))
    await bridge.drain()
    const status = bridge.status()
    check('malformed model output is archived as a failed run, not a crash',
      status.proposals.runs.failed === 1 && status.proposals.runs.succeeded === 0)
    check('malformed model error is surfaced as the last Qwen error',
      typeof status.qwen.lastError === 'string' &&
      status.qwen.lastError.startsWith('invalid-output'))
    const text = injectedText(bridge.preStep({ id: 's1' }, 's1',
      { kind: 'enter', messages: [] }))
    check('verified file facts survive a malformed model output',
      text.includes('malformed.txt') && text.includes('的大小为 21 字节'))
  }
  {
    const model = fakeModel(new Error('timeout'))
    const bridge = makeBridge(model)
    for (const event of writeEvents('c-t', 'timeout.txt',
      { exists: true, size: 34, sha256: SHA_A }, 1)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    bridge.handleEvent({ id: 's1' }, 's1', userEvent(USER_TEXT, { seq: 3, t: T0 + 3 }))
    await bridge.drain()
    const status = bridge.status()
    check('model timeout is recorded as a failed run with an error',
      status.proposals.runs.failed === 1 &&
      typeof status.qwen.lastError === 'string' &&
      status.qwen.lastError.includes('model-error'))
    const text = injectedText(bridge.preStep({ id: 's1' }, 's1',
      { kind: 'enter', messages: [] }))
    check('verified file facts survive a model timeout',
      text.includes('timeout.txt') && text.includes('的大小为 34 字节'))
  }

  // ---------------------------------------------------------------------------
  // 4. Tool call/result pairing drives deterministic file facts.
  // ---------------------------------------------------------------------------
  {
    const bridge = makeBridge(fakeModel(emptyOutput))
    for (const event of writeEvents('c1', 'notes.txt',
      { exists: true, size: 12, mtime: T0 + 1, sha256: SHA_A }, 1)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    let facts = factMap(bridge)
    check('write observation derives exists/size/mtime/sha256 facts',
      facts['file.exists']?.includes(true) && facts['file.size']?.includes(12) &&
      facts['file.mtime']?.includes(T0 + 1) && facts['file.sha256']?.includes(SHA_A))

    bridge.handleEvent({ id: 's1' }, 's1',
      toolCall('c2', 'read', { path: 'notes.txt' }, { seq: 3, t: T0 + 3 }))
    bridge.handleEvent({ id: 's1' }, 's1',
      toolResult('c2', { seq: 4, t: T0 + 4, result: { exists: true, size: 20, sha256: SHA_B } }))
    facts = factMap(bridge)
    check('read observation updates measured size and hash deterministically',
      facts['file.size']?.includes(20) && facts['file.sha256']?.includes(SHA_B))

    bridge.handleEvent({ id: 's1' }, 's1',
      toolCall('c3', 'delete', { path: 'notes.txt' }, { seq: 5, t: T0 + 5 }))
    bridge.handleEvent({ id: 's1' }, 's1',
      toolResult('c3', { seq: 6, t: T0 + 6, result: {} }))
    facts = factMap(bridge)
    check('delete observation closes the file and retires measured facts',
      facts['file.exists']?.includes(false) &&
      !Object.hasOwn(facts, 'file.size') &&
      !Object.hasOwn(facts, 'file.sha256'))
    check('status reports every paired tool observation',
      bridge.status().archived.toolObservations === 3)
  }

  // ---------------------------------------------------------------------------
  // 4b. Optional real filesystem probe upgrades textual tool results.
  // ---------------------------------------------------------------------------
  {
    mkdirSync(WS, { recursive: true })
    const realPath = join(WS, 'real-probe.txt')
    writeFileSync(realPath, 'alpha-7', 'utf8')
    const bridge = makeBridge(fakeModel(emptyOutput), {
      probeFiles: true,
      // Probe time is later than the tool event, as it is in a real host.
      now: () => T0 + 10_000,
    })
    for (const event of writeEvents('cprobe', 'real-probe.txt', {}, 40)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    await bridge.drain()
    const facts = factMap(bridge)
    check('real file probe records size, mtime, and sha256',
      facts['file.exists']?.includes(true) &&
      facts['file.size']?.includes(7) &&
      facts['file.sha256']?.includes(sha256('alpha-7')) &&
      facts['file.mtime']?.some((value) => Number.isFinite(value)))
  }

  // ---------------------------------------------------------------------------
  // 5. Repeated emissions are idempotent; unpaired results are not guessed.
  // ---------------------------------------------------------------------------
  {
    const model = fakeModel(emptyOutput)
    const bridge = makeBridge(model)
    const event = userEvent(USER_TEXT, { seq: 7, t: T0 + 7 })
    bridge.handleEvent({ id: 's1' }, 's1', event)
    bridge.handleEvent({ id: 's1' }, 's1', event)
    bridge.handleEvent({ id: 's1' }, 's1', event)
    await bridge.drain()
    const status = bridge.status()
    check('duplicate user/message emission is archived once and proposed once',
      status.archived.userMessages === 1 && model.calls.length === 1)
    check('duplicate event keys are counted as seen',
      status.seenEvents >= 1)

    const ghost = toolResult('ghost', { seq: 8, t: T0 + 8, result: { size: 1 } })
    bridge.handleEvent({ id: 's1' }, 's1', ghost)
    bridge.handleEvent({ id: 's1' }, 's1', ghost)
    check('tool result without a paired call archives nothing',
      bridge.status().archived.toolObservations === 0 &&
      bridge.status().pending === 0)
  }

  // ---------------------------------------------------------------------------
  // 6. Cross-session same workspace sees the same deterministic facts.
  // ---------------------------------------------------------------------------
  {
    const bridge = makeBridge(fakeModel(emptyOutput))
    for (const event of writeEvents('cx', 'shared.txt',
      { exists: true, size: 55, sha256: SHA_A }, 1)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    bridge.handleEvent({ id: 's2' }, 's2', userEvent('看看共享文件', { seq: 9, t: T0 + 9 }))
    await bridge.drain()
    const text = injectedText(bridge.preStep({ id: 's2' }, 's2',
      { kind: 'enter', messages: [] }))
    check('a second session in the same workspace sees the same current facts',
      text?.includes('shared.txt') && text?.includes('的大小为 55 字节'))
    check('both sessions share one scope in status',
      bridge.status().scope === SCOPE && bridge.status().archived.userMessages === 1)
  }

  // ---------------------------------------------------------------------------
  // 7. Injection is deduplicated per session by text hash, not globally.
  // ---------------------------------------------------------------------------
  {
    const bridge = makeBridge(fakeModel(emptyOutput))
    for (const event of writeEvents('cd', 'dedupe.txt',
      { exists: true, size: 5, sha256: SHA_A }, 1)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    const decision = { kind: 'enter', messages: [] }
    const first = bridge.preStep({ id: 's1' }, 's1', decision)
    const second = bridge.preStep({ id: 's1' }, 's1', decision)
    const otherSession = bridge.preStep({ id: 's2' }, 's2', decision)
    check('first pre-step injects and the identical second pre-step is null',
      first !== null && second === null)
    check('dedupe is per session, not per scope',
      otherSession !== null && injectedText(otherSession) === injectedText(first))
    const expectedHash = sha256(injectedText(first))
    const injection = bridge.status().injection
    check('status records the injected text hash and character count',
      injection.last?.hash === expectedHash &&
      injection.last?.chars === injectedText(first).length &&
      injection.count === 2 && injection.skipped === 1)

    for (const event of writeEvents('cd2', 'dedupe.txt',
      { exists: true, size: 77, sha256: SHA_B }, 3)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    const changed = bridge.preStep({ id: 's1' }, 's1', decision)
    check('a changed verified fact set injects again in the same session',
      changed !== null && injectedText(changed).includes('的大小为 77 字节') &&
      bridge.status().injection.last?.hash === sha256(injectedText(changed)))
  }

  // ---------------------------------------------------------------------------
  // 8. Pre-step contract: only enter decisions with a messages array.
  // ---------------------------------------------------------------------------
  {
    const bridge = makeBridge(fakeModel(emptyOutput))
    for (const event of writeEvents('cp', 'enter.txt',
      { exists: true, size: 9, sha256: SHA_A }, 1)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    check('pre-step ignores non-enter decisions',
      bridge.preStep({ id: 's1' }, 's1', { kind: 'skip', messages: [] }) === null)
    check('pre-step ignores enter decisions without a messages array',
      bridge.preStep({ id: 's1' }, 's1', { kind: 'enter', messages: {} }) === null)
  }

  // ---------------------------------------------------------------------------
  // 9. Status metrics are measured and distinguish not-run from ran-empty.
  // ---------------------------------------------------------------------------
  {
    const bridge = makeBridge(fakeModel(emptyOutput, '{bad'))
    const initial = bridge.status()
    check('status distinguishes not-run from a completed empty run',
      initial.proposals.state === 'not-run' && initial.qwen.last === null &&
      initial.qwen.calls === 0 && initial.injection.count === 0 &&
      initial.pending === 0)
    const onDisk = JSON.parse(readFileSync(join(bridge.stateDir, 'status.json'), 'utf8'))
    check('status writes the same measured JSON it returns',
      onDisk.scope === initial.scope && onDisk.archived.userMessages === 0 &&
      onDisk.proposals.state === 'not-run')

    bridge.handleEvent({ id: 's1' }, 's1', userEvent(USER_TEXT, { seq: 1, t: T0 + 1 }))
    await bridge.drain()
    const emptyRun = bridge.status()
    check('a successful empty proposal run reports ran-empty, not not-run',
      emptyRun.proposals.state === 'ran-empty' &&
      emptyRun.proposals.runs.succeeded === 1 && emptyRun.qwen.calls === 1)

    bridge.handleEvent({ id: 's1' }, 's1', userEvent('约束：日志保留 7 天。', { seq: 2, t: T0 + 2 }))
    await bridge.drain()
    const failedRun = bridge.status()
    check('failed runs are counted separately from successful empty runs',
      failedRun.proposals.runs.succeeded === 1 && failedRun.proposals.runs.failed === 1 &&
      failedRun.qwen.calls === 2 && failedRun.qwen.succeeded === 1 &&
      failedRun.qwen.failed === 1 &&
      failedRun.qwen.lastError?.startsWith('invalid-output'))
  }

  // ---------------------------------------------------------------------------
  // 9b. Non-durable messages are skipped before the model call.
  // ---------------------------------------------------------------------------
  {
    const model = fakeModel(emptyOutput)
    const bridge = makeBridge(model)
    bridge.handleEvent({ id: 's1' }, 's1',
      userEvent('运行 npm test 然后把结果贴给我。', { seq: 1, t: T0 + 1 }))
    bridge.handleEvent({ id: 's1' }, 's1',
      userEvent('金额和折扣规则是什么？', { seq: 2, t: T0 + 2 }))
    await bridge.drain()
    const skipped = bridge.status()
    check('task and question messages are skipped without a model call',
      model.calls.length === 0 && skipped.qwen.calls === 0 &&
      skipped.qwen.skipped === 2 && skipped.qwen.succeeded === 0 &&
      skipped.proposals.runs.total === 0)
    bridge.handleEvent({ id: 's1' }, 's1',
      userEvent('项目约定：所有测试统一使用 node:test。', { seq: 3, t: T0 + 3 }))
    await bridge.drain()
    const resumed = bridge.status()
    check('a durable message after skipped ones still reaches the model',
      model.calls.length === 1 && resumed.qwen.calls === 1 &&
      resumed.qwen.skipped === 2 && resumed.qwen.succeeded === 1 &&
      resumed.qwen.last?.gate?.eligible === 1)
  }

  // ---------------------------------------------------------------------------
  // 10. No route rows are ever written, so candidates can never be facts.
  // ---------------------------------------------------------------------------
  {
    const model = fakeModel(candidateOutput)
    const bridge = makeBridge(model)
    bridge.handleEvent({ id: 's1' }, 's1', userEvent(USER_TEXT, { seq: 3, t: T0 + 3 }))
    await bridge.drain()
    const inspector = new DatabaseSync(join(bridge.stateDir, 'ledger.sqlite'), { readOnly: true })
    try {
      const routes = inspector.prepare(
        'SELECT count(*) AS count FROM ledger_proposal_routes WHERE scope = ?',
      ).get(SCOPE).count
      const proposals = inspector.prepare(
        'SELECT verdict, count(*) AS count FROM ledger_proposals WHERE scope = ? GROUP BY verdict',
      ).all(SCOPE)
      check('the bridge never writes a proposal route row',
        routes === 0)
      check('all proposals stay candidates with no accepted assertion',
        proposals.length === 1 && proposals[0].verdict === 'candidate' &&
        bridge.ledger.currentFacts(SCOPE).every((fact) => fact.sourceKind !== 'llm'))
    } finally {
      inspector.close()
    }
  }

  // ---------------------------------------------------------------------------
  // 11. Unknown tools and malformed results do not mutate file facts.
  // ---------------------------------------------------------------------------
  {
    const bridge = makeBridge(fakeModel(emptyOutput))
    for (const event of writeEvents('cu', 'stable.txt',
      { exists: true, size: 4, sha256: SHA_A }, 1)) {
      bridge.handleEvent({ id: 's1' }, 's1', event)
    }
    const beforeFacts = json(bridge.ledger.currentFacts(SCOPE))
    bridge.handleEvent({ id: 's1' }, 's1',
      toolCall('c9', 'mystery_tool', { path: 'stable.txt' }, { seq: 3, t: T0 + 3 }))
    bridge.handleEvent({ id: 's1' }, 's1',
      toolResult('c9', { seq: 4, t: T0 + 4, result: { size: 999 } }))
    check('an unknown tool operation archives nothing that changes current facts',
      json(bridge.ledger.currentFacts(SCOPE)) === beforeFacts &&
      bridge.status().archived.toolObservations === 2)
  }

  // ---------------------------------------------------------------------------
  // 12. Session cwd never overrides the fixed workspace; mismatches are recorded.
  // ---------------------------------------------------------------------------
  {
    const bridge = makeBridge(fakeModel(emptyOutput))
    bridge.handleEvent({ id: 's1', cwd: 'C:/somewhere/else' }, 's1',
      userEvent(USER_TEXT, { seq: 1, t: T0 + 1 }))
    const status = bridge.status()
    check('a conflicting session cwd is recorded, not used',
      status.cwdMismatches === 1 &&
      status.lastCwdMismatch?.sessionCwd === 'C:/somewhere/else' &&
      bridge.ledger.getObservation('s1:1:user', { scope: SCOPE }) !== null)
    const sameCwd = normalizeWorkspacePath(WS)
    bridge.handleEvent({ id: 's2', cwd: sameCwd }, 's2',
      userEvent('同一工作区', { seq: 2, t: T0 + 2, sid: 's2' }))
    check('an equivalent session cwd (normalized) is not a mismatch',
      bridge.status().cwdMismatches === 1)
  }

  // ---------------------------------------------------------------------------
  // 12b. In live mode a mismatched session is rejected, not just recorded.
  // ---------------------------------------------------------------------------
  {
    const model = fakeModel(emptyOutput)
    const bridge = makeBridge(model, { requireWorkspaceCwd: true })
    const rejected = bridge.handleEvent({ id: 's1', cwd: 'C:/somewhere/else' }, 's1',
      userEvent(USER_TEXT, { seq: 1, t: T0 + 1 }))
    await bridge.drain()
    check('a required matching cwd rejects a foreign session before archiving',
      rejected === false && bridge.status().archived.userMessages === 0 &&
      bridge.status().cwdMismatches === 1 && model.calls.length === 0)
    const accepted = bridge.handleEvent({ id: 's2', cwd: WS }, 's2',
      userEvent(USER_TEXT, { seq: 2, t: T0 + 2 }))
    await bridge.drain()
    check('a required matching cwd accepts a session in the fixed workspace',
      accepted === true && bridge.status().archived.userMessages === 1 &&
      bridge.status().cwdMismatches === 1 && model.calls.length === 1)
    const unknown = bridge.handleEvent({ id: 's3' }, 's3',
      userEvent(USER_TEXT, { seq: 3, t: T0 + 3 }))
    await bridge.drain()
    check('a required cwd rejects a session that reports no cwd',
      unknown === false && bridge.status().cwdUnknown === 1 &&
      bridge.status().lastCwdUnknown?.sid === 's3' &&
      bridge.status().archived.userMessages === 1 && model.calls.length === 1)
  }

  // ---------------------------------------------------------------------------
  // 12c. Without require-cwd a missing cwd is diagnostic only; the event still
  // archives, so ordinary local use is not silently disabled.
  // ---------------------------------------------------------------------------
  {
    const model = fakeModel(emptyOutput)
    const bridge = makeBridge(model)
    const accepted = bridge.handleEvent({ id: 's1' }, 's1',
      userEvent(USER_TEXT, { seq: 1, t: T0 + 1 }))
    await bridge.drain()
    check('a missing cwd is recorded but archived when cwd is not required',
      accepted === true && bridge.status().cwdUnknown === 1 &&
      bridge.status().cwdMismatches === 0 &&
      bridge.status().archived.userMessages === 1 && model.calls.length === 1)
  }

  // ---------------------------------------------------------------------------
  // 13. Scope normalization is fixed by the constructor.
  // ---------------------------------------------------------------------------
  {
    const bridge = makeBridge(fakeModel(emptyOutput), {
      workspaceRoot: 'C:\\Users\\Admin\\TEST Workspace\\',
    })
    check('scope normalizes separators, trailing slash, and case',
      bridge.scope === 'ws:c:/users/admin/test workspace' &&
      normalizeWorkspacePath('C:\\A\\B\\') === 'c:/a/b')
  }

  // ---------------------------------------------------------------------------
  // 14. Qwen call identity and per-session serialization.
  // ---------------------------------------------------------------------------
  {
    const model = fakeModel(emptyOutput)
    const bridge = makeBridge(model)
    bridge.handleEvent({ id: 's1' }, 's1', userEvent('约束：日志保留 7 天。', { seq: 1, t: T0 + 1 }))
    bridge.handleEvent({ id: 's1' }, 's1', userEvent('约束：日志保留 30 天。', { seq: 2, t: T0 + 2 }))
    await bridge.drain()
    check('proposal runs carry the configured Qwen model, digest, and fixed schema',
      model.calls.length === 2 &&
      model.calls.every((call) => call.model === MODEL &&
        call.modelDigest === DIGEST && call.schemaVersion === PROPOSAL_SCHEMA_VERSION))
    check('each proposal run receives its own archived evidence key',
      model.calls[0].prompt.includes('s1:1:user') &&
      model.calls[1].prompt.includes('s1:2:user') &&
      !model.calls[1].prompt.includes('s1:1:user'))
  }
  {
    let active = 0
    let maxActive = 0
    const model = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return emptyOutput
    }
    const bridge = makeBridge(model)
    bridge.handleEvent({ id: 's1' }, 's1', userEvent('并发一', { seq: 1, t: T0 + 1 }))
    bridge.handleEvent({ id: 's2' }, 's2', userEvent('并发二', { seq: 2, t: T0 + 2, sid: 's2' }))
    await bridge.drain()
    check('proposal runs are serialized across sessions in one workspace (Qwen CPU)',
      maxActive === 1 && bridge.status().proposals.runs.succeeded === 2)
  }

  // ---------------------------------------------------------------------------
  // 15. drain() waits for pending work scheduled by handleEvent.
  // ---------------------------------------------------------------------------
  {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const model = async () => { await gate; return emptyOutput }
    const bridge = makeBridge(model)
    bridge.handleEvent({ id: 's1' }, 's1', userEvent('约束：等待模型完成后再继续。', { seq: 1, t: T0 + 1 }))
    check('proposal work is pending but not blocking the event handler',
      bridge.status().pending === 1)
    release()
    await bridge.drain()
    check('drain() awaits pending proposal work and clears the counter',
      bridge.status().pending === 0 && bridge.status().proposals.runs.succeeded === 1)
    const persisted = JSON.parse(readFileSync(join(bridge.stateDir, 'status.json'), 'utf8'))
    check('proposal completion refreshes the persisted status',
      persisted.pending === 0 && persisted.proposals.runs.succeeded === 1)
  }
} catch (error) {
  console.error('UNEXPECTED ERROR', error)
  fails++
} finally {
  for (const bridge of bridges) {
    try { bridge.close() } catch { /* already closed */ }
  }
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
if (fails !== 0) process.exitCode = 1
