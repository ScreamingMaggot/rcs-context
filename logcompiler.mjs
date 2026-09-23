// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// LOGcompiler — pure-rule event transcriber for the F+ event-sequence
// architecture. Subscribes to `session/event` and appends immutable five-class
// rows ([ROUND]/[U]/[A]/[T]/[M]) to a durable, append-only log.
// No LLM, no model-facing state: each arriving event maps mechanically to new
// row(s); old rows are never touched (byte-monotonic prefix guarantee). This is
// the compile-side authority (external state) that CONTEXTinjector folds a live
// view from; LOGcompiler keeps the full, byte-monotonic record per session.
//
// v3 changes (for public use / beta; see 版本说明文档/v3-运行时配置与WebUI设置.md):
//   - **runtime configuration** read from <state>/logcompiler.control.json
//     (throttled ~500ms cache, no restart), written by the StateCompiler WebUI
//     panel (host /api/logcompiler/config). Fields:
//       enabled: boolean          master switch (default true)
//       logsDir: string|null      abs dir override; null => internal default
//                                 (<state-compiler>/transcripts)
//       sessions: {<sid>:bool}    per-session override map; absent sid => record
//   - WebUI status surfaces via the CONTEXTinjector webui panel (merged /status).
//   - writes a <state>/logcompiler.runtime.json marker on load so the WebUI can
//     tell whether the plugin is actually mounted.
//   - storage defaults to the DSH-internal region $DSH_HOME/state-compiler (no
//     dev-machine SANDBOX path); user may override the directory in the WebUI.
//   - env overrides preserved: LOGCOMPILER_OUT (legacy single-file headless/e2e,
//     forces global shared buffer), LOGCOMPILER_LOGS_DIR (operator, beats control).
//
// Format (设计_事件序列注入方案.md §二 v1 + v2 §13):
//   [ROUND] n            round delimiter —— **仅真人轮**递增（source.kind==='user'）
//   [U] <text>           verbatim user input（真人）
//   [A] <text>           verbatim assistant text
//   [T] op | path | OK/ERR   ONE row per tool call, written when its result arrives
//   [M] <TASK START|PAUSE|RESUME|BLOCKED|DONE|ARCHIVED> (goal:id)
// v2 §13 新增（系统注入专用行类，**不计 ROUND**）：
//   [C] <text>           skill 目录（source.kind='skill-catalog' / form='catalog'）
//   [S] <sections 摘要>  runtime 快照（form='snapshot'，每 step 重注入 ⇒ 只存摘要）
//   [N] <sub> | <text>   通知类：job（tool-jobs）/ approval（user-approval）/ subagent（subagent-settled）
//   [V] <text>           subagent 报告正文（配合 [T] subagent | <id> | OK，不计 ROUND）
// 注：ROUND 语义由 v1「所有 role=user」改为 v2「仅真人轮」，历史日志轮号不可比。
//
// The tiny callId -> {op,path} map is transcript bookkeeping only (never exposed
// to the model). Every tool/call receives exactly one tool/result, so no [T] row
// is orphaned.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
// A档：结构化工具折叠（与 CONTEXTinjector 同源 toolfold；默认随其 control.toolfoldStructured 关闭）。
import { foldOne as foldToolResult } from '../toolfold/toolfold.mjs'
// §13 消息来源分型（condense/ 共享纯模块，仿 ../toolfold 顶层兄弟目录惯例）：
//   ROUND 仅计真人轮（source.kind==='user'）；subagent 回传/skill目录/系统快照等注入
//   不再漏进 [U]。设计见 docs/v2-优化设计.md §13 与分析报告 §4-B/§7。
import { classifyUserMessage, subagentIdOf, snapshotSummary, INJECTED_USER_PREFIXES } from '../condense/chunk.mjs'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// 状态根与 CONTEXTinjector 同区（两插件共用 $DSH_HOME/state-compiler）。
const STATE_COMPILER = process.env.LOGCOMPILER_STATE_DIR
  || process.env.DSH_CONTEXTINJECTOR_STATE_DIR
  || join(DSH_HOME, 'state-compiler')
const CONTROL_FILE = join(STATE_COMPILER, 'logcompiler.control.json')
const RUNTIME_FILE = join(STATE_COMPILER, 'logcompiler.runtime.json')

// env overrides（operator / headless-e2e）
const OUT_FILE = process.env.LOGCOMPILER_OUT || '' // 单文件 override（强制全局共享缓冲，兼容 v1 语义）
const ENV_LOGS_DIR = process.env.LOGCOMPILER_LOGS_DIR || '' // 静态目录覆盖（最高优先于 control）
const ROTATE_BYTES = Math.max(1024, Number(process.env.LOGCOMPILER_MAX_BYTES ?? (1 << 20))) // 默认 ~1MB

mkdirSync(STATE_COMPILER, { recursive: true })
if (OUT_FILE) mkdirSync(dirname(OUT_FILE), { recursive: true })

// ---- helpers ---------------------------------------------------------------

function sessionIdOf(subject) {
  return subject?.id ?? subject?.sessionId ?? subject?.name ?? null
}
function normKey(s) {
  return String(s ?? '').replace(/^session-?/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}
function normSid(s) {
  return String(s ?? '').replace(/^session-?/i, '')
}
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
}
function targetPathOf(argsJson) {
  try {
    const args = JSON.parse(argsJson ?? '{}')
    if (typeof args.file_path === 'string' && args.file_path.trim()) return args.file_path
    if (typeof args.path === 'string' && args.path.trim()) return args.path
  } catch { /* not JSON */ }
  return '-'
}
function escapeInline(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').trim()
}

// ---- runtime control (throttled read of logcompiler.control.json) ----------
let _ctrlCache = null
let _ctrlAt = 0
function readControl() {
  const now = Date.now()
  if (_ctrlCache !== null && now - _ctrlAt < 500) return _ctrlCache
  _ctrlAt = now
  try { _ctrlCache = JSON.parse(readFileSync(CONTROL_FILE, 'utf8')) }
  catch { _ctrlCache = null }
  return _ctrlCache
}
function lookupSid(ctrl, sid) {
  const sm = ctrl && ctrl.sessions
  if (!sid || !sm || typeof sm !== 'object') return undefined
  const n = normSid(sid)
  for (const k of Object.keys(sm)) if (normSid(k) === n) return sm[k]
  return undefined
}
// 记录某会话与否：全局关 → false；OUT_FILE 单文件模式忽略 per-session，只看全局；
// control.sessions 为对象覆盖表：缺省（未保存过 / 未显式关）→ 记录；显式 false → 不记录。
function enabledFor(sid) {
  const ctrl = readControl()
  if (ctrl && ctrl.enabled === false) return false
  if (OUT_FILE) return true
  if (!ctrl) return true
  const v = lookupSid(ctrl, sid)
  return v !== false
}
// 输出目录：静态 env > control.logsDir(用户指定) > 内部默认 <state>/transcripts
function logsDirOf(ctrl) {
  if (OUT_FILE) return dirname(OUT_FILE)
  if (ENV_LOGS_DIR) return ENV_LOGS_DIR
  if (ctrl && typeof ctrl.logsDir === 'string' && ctrl.logsDir.trim()) return ctrl.logsDir.trim()
  return join(STATE_COMPILER, 'transcripts')
}

// ---- per-session transcriber state ----------------------------------------
// OUT_FILE 单文件模式固定 key='global'（保留 v1 全局编号语义）；否则 key=normKey(sid)
const GLOBAL = 'global'
const states = new Map() // key -> { round, pendingCalls:Map, buf:[] }
function stateFor(key) {
  let st = states.get(key)
  if (!st) { st = { round: 0, pendingCalls: new Map(), buf: [] }; states.set(key, st) }
  return st
}
function fileOf(st) { return st.file }
function fileSize(path) {
  try { return statSync(path).size } catch { return 0 }
}
// 断点续传（跨进程重启/会话重开）：DSH 装载 session 不重放历史事件，round 纯内存会复位。
// 创建某会话状态时，从它既有的 <sid>.log（含轮转段）里读出最大 [ROUND] n 作起始，续编号不重复。
function lastRoundInDir(dir, key) {
  let mx = 0
  const base = join(dir, key + '.log')
  try {
    for (const seg of [base, base + '.1', base + '.2', base + '.3']) {
      let txt = ''
      try { txt = readFileSync(seg, 'utf8') } catch { continue }
      for (const ln of txt.split('\n')) {
        const m = /^\[ROUND\]\s*(\d+)/.exec(ln)
        if (m) { const n = Number(m[1]); if (n > mx) mx = n }
      }
    }
  } catch { /* best-effort */ }
  return mx
}
function row(st, line) { st.buf.push(line) }

function ensureDir(dir) { try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ } }

// 轮转：文件超阈值即在写入前改名 <file>.<n>；仅 per-session 模式轮转（OUT_FILE 单文件不做）。
function rotateIfNeeded(file) {
  if (OUT_FILE) return
  if (fileSize(file) < ROTATE_BYTES) return
  let n = 1
  while (true) { try { statSync(file + '.' + n); n += 1 } catch { break } }
  try { renameSync(file, file + '.' + n) } catch (err) { console.error('[logcompiler] rotate failed:', err?.message ?? err) }
}

// 容错：追加失败（磁盘满/权限瞬时）不清空 buf → 下个事件 flush 时重试，不丢行。
function flush(st) {
  if (!st.buf.length) return
  try {
    rotateIfNeeded(st.file)
    appendFileSync(st.file, st.buf.join('\n') + '\n', 'utf8')
    st.buf = []
  } catch (err) {
    console.error('[logcompiler] append failed (retrying next flush):', err?.message ?? err)
  }
}

// A档结构化档：随 CONTEXTinjector 的 control.toolfoldStructured（同 control.json）开启，默认 OFF
const CTXINJ_CONTROL = join(STATE_COMPILER, 'control.json')
let _tfOnCache = null; let _tfOnAt = 0
function ctxToolfoldOn() {
  const now = Date.now()
  if (_tfOnCache !== null && now - _tfOnAt < 1000) return _tfOnCache
  _tfOnAt = now
  try { _tfOnCache = JSON.parse(readFileSync(CTXINJ_CONTROL, 'utf8'))?.toolfoldStructured === true } catch { _tfOnCache = false }
  return _tfOnCache
}
function argsOf(json) { try { const a = JSON.parse(json ?? '{}'); return (a && typeof a === 'object') ? a : {} } catch { return {} } }
const TDOM = { read: 'fs', read_image: 'fs', write: 'fs', edit: 'fs', str_replace: 'fs', glob: 'fs-search', grep: 'fs-search', pwsh: 'shell', bash: 'shell', create_goal: 'goal', get_goal: 'goal', update_goal: 'goal', job_list: 'jobs', job_output: 'jobs', job_kill: 'jobs', ask_user_question: 'ask-user', web_search: 'web', web_fetch: 'web', todo_write: 'todo', subagent: 'subagent' }
const tdom = (op) => TDOM[op] || op
function resultMsgText(d) {
  const blocks = Array.isArray(d?.message?.content) ? d.message.content : []
  const parts = []
  for (const b of blocks) {
    if (b && b.type === 'text' && b.text) parts.push(b.text)
    else if (b && b.type === 'tool-result' && typeof b.content === 'string' && b.content) parts.push(b.content)
  }
  return parts.join('\n')
}
function write(st, ev) {
  switch (ev.type) {
    case 'user/message': {
      const data = ev.data ?? {}
      const text = escapeInline(textOf(data.message?.content ?? data.content))
      if (!text) return
      // §13：按 source 分型。user/message 的 source 在 **data.source**（无 data.message 层；
      // 旧代码取 data.message?.source 恒为 undefined ⇒ 检查从未生效）。ROUND 仅真人轮递增，
      // subagent 回传/系统注入走 [C]/[S]/[N]/(subagent 走 [T]/[V])，不计 ROUND。
      const cls = classifyUserMessage(ev)
      // source 缺失（DSH 规定必填，缺失属异常）⇒ 回退旧文本前缀启发式，避免丢真人轮
      // 【#2 修复（取自 RCS-0.1.0 返回包）】与注入器共用同一前缀集（chunk.mjs INJECTED_USER_PREFIXES），
      //   杜绝"同一事件一侧跳过、一侧计 ROUND"的轮号分叉。
      if (cls.cls === 'opaque' && !data.source) {
        if (INJECTED_USER_PREFIXES.some((p) => text.startsWith(p))) return
        st.round += 1
        row(st, `[ROUND] ${st.round}`)
        row(st, `[U] ${text}`)
        return
      }
      switch (cls.cls) {
        case 'user': // 仅真人输入递增 ROUND
          st.round += 1
          row(st, `[ROUND] ${st.round}`)
          row(st, `[U] ${text}`)
          return
        case 'catalog': // skill 目录：系统注入，不计 ROUND
          row(st, `[C] ${text}`)
          return
        case 'snapshot': // runtime 快照（每 step 重注入）：只存摘要，防膨胀
          row(st, `[S] ${snapshotSummary(cls.sections)}`)
          return
        case 'notice': // job 通知 / 审批变更 / subagent 结束：不计 ROUND
          row(st, `[N] ${cls.sub} | ${text}`)
          return
        case 'relay': {
          // subagent 报告：语义接近工具结果 ⇒ [T]/[V] 通道带 subagent 锚点，内容保留但不计 ROUND
          row(st, `[T] subagent | ${subagentIdOf(text) ?? cls.agentId ?? '?'} | OK`)
          row(st, `[V] ${text}`)
          return
        }
        case 'extreason': {
          // 【extreason 接入（取自 RCS-0.1.0）】外置推理简报：文本本身已是 `[R] …` 行 ⇒ 逐行原样转录、
          //   不计 ROUND。与 contextinjector 的分支同一口径（chunk.mjs classifyMessageSource 是唯一分型源）。
          const raw = Array.isArray(data.message?.content ?? data.content)
            ? (data.message?.content ?? data.content).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
            : String(data.message?.content ?? data.content ?? '')
          let n = 0
          for (const line of raw.split('\n')) {
            const s = line.trim()
            if (/^\[R\] /.test(s)) { row(st, s); n += 1 }
          }
          if (n === 0 && text) row(st, `[R] ${text}`) // 兜底：拿不到原始行时至少留一条
          return
        }
        default:
          return // self（本插件折叠注入）/ opaque（未知来源）⇒ 不转录
      }
    }
    case 'assistant/message': {
      const data = ev.data ?? {}
      const text = escapeInline(textOf(data.message?.content ?? data.content))
      if (!text) return
      row(st, `[A] ${text}`)
      return
    }
    case 'tool/call': {
      const d = ev.data ?? {}
      if (!d.callId) return
      st.pendingCalls.set(d.callId, { op: d.name ?? '?', path: targetPathOf(d.arguments), args: argsOf(d.arguments) })
      return
    }
    case 'tool/result': {
      const d = ev.data ?? {}
      const blocks = Array.isArray(d.message?.content) ? d.message.content : []
      const resultBlocks = blocks.filter((b) => b.type === 'tool-result')
      const isErr = resultBlocks.some((b) => b.isError === true)
      const callId = resultBlocks[0]?.toolCallId
      const { op, path, args } = st.pendingCalls.get(callId) ?? { op: '?', path: '?', args: {} }
      st.pendingCalls.delete(callId)
      if (ctxToolfoldOn()) {
        const text = resultMsgText(d)
        const { t, vs } = foldToolResult({ action: op, args: args || {}, text, isError: isErr, fs: { readFileSync }, tool: tdom(op) })
        for (const v of vs) row(st, v)
        row(st, t)
      } else {
        row(st, `[T] ${op} | ${path} | ${isErr ? 'ERR' : 'OK'}`)
      }
      return
    }
    case 'goal/change': {
      const d = ev.data ?? {}
      const op = d.operation
      const label = { create: 'TASK START', complete: 'DONE', pause: 'PAUSE', resume: 'RESUME', block: 'BLOCKED', clear: 'ARCHIVED' }[op] ?? String(op).toUpperCase()
      row(st, `[M] ${label} (goal:${d.goalId ?? '?'})`)
      return
    }
    default:
      return
  }
}

// ---- plugin ----------------------------------------------------------------
export default {
  name: 'logcompiler',
  apply(ctx) {
    try {
      writeFileSync(RUNTIME_FILE, JSON.stringify({ active: true, version: 'v3', pid: process.pid, startedAt: Date.now(), stateDir: STATE_COMPILER }) + '\n', 'utf8')
    } catch { /* best-effort marker */ }
    ctx.on('session/event', (subject, event) => {
      try {
        const sid = sessionIdOf(subject)
        if (!enabledFor(sid)) return // 全局关 / 该会话被显式关闭 → 不记录
        const ctrl = readControl()
        const dir = logsDirOf(ctrl)
        if (!OUT_FILE) {
          if (!sid) return
          ensureDir(dir)
        }
        const key = OUT_FILE ? GLOBAL : normKey(sid)
        const st = stateFor(key)
        st.file = OUT_FILE ? OUT_FILE : join(dir, key + '.log')
        // §13.6 迁移标记：新建（空）日志首行标注 ROUND 语义。旧日志无此行 ⇒ 可区分、不混算。
        if (!OUT_FILE && !st.semanticsWritten) {
          st.semanticsWritten = true
          let hasContent = false
          try { hasContent = statSync(st.file).size > 0 } catch { hasContent = false }
          if (!hasContent) row(st, '# roundSemantics=v2-source')
        }
        // 断点续传：per-session 且本进程首见该会话时，从既有 <sid>.log 续编号（round 不归零）
        if (!OUT_FILE && st.round === 0) {
          const r = lastRoundInDir(dir, key)
          if (r > 0) { st.round = r; st.seeded = true }
        }
        write(st, event)
        // 即时落盘：user 轮 / goal 锚点 / 工具结果 三类必须即时写（assistant 行缓冲到下个 flush）
        if (event.type === 'user/message' || event.type === 'goal/change' || event.type === 'tool/result') flush(st)
      } catch (err) {
        console.error('[logcompiler] error:', err?.message ?? err)
      }
    })
    const mode = OUT_FILE ? `single:${OUT_FILE}` : (ENV_LOGS_DIR ? `dir:${ENV_LOGS_DIR}` : `dir:<control|${join(STATE_COMPILER, 'transcripts')}>`)
    console.log(`[logcompiler] v3 transcribing session/event (control=${CONTROL_FILE}) -> ${mode}`)
  },
}
