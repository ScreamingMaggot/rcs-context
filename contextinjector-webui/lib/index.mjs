// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// contextinjector-webui (host half) — self-registered HTTP endpoints for the
// WebUI panel. Read/write the CONTEXTinjector state files under
// <$DSH_HOME>/state-compiler/ (control/runtime/last-fold; DSH_HOME 缺省 ~/.dsh, 不依赖本机前缀) and list
// sessions for the whitelist UI.
//
// Endpoint registration shape mirrors dsh-client-connection's '/api' route
// (ctx.webServer.register with exact kind wins over the '/api' prefix), the
// same pattern the context-inject prototype used for its /api/... endpoints.
// Only lossless JSON crosses the wire.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { listTraces, getTrace, exportTraces, clearTraces, TRACE_TRIGGERS } from './trace-read.mjs'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = process.env.DSH_CONTEXTINJECTOR_STATE_DIR || join(DSH_HOME, 'state-compiler')
const SESSIONS_DIR = join(STATE_DIR, '..', 'sessions')
const CONTROL_FILE = join(STATE_DIR, 'control.json')
// LOGcompiler 运行时配置（与插件 logcompiler.mjs 同区、同文件读写 —— WebUI "同步设置"的中枢）
const LG_CONTROL_FILE = join(STATE_DIR, 'logcompiler.control.json')
const LG_RUNTIME_FILE = join(STATE_DIR, 'logcompiler.runtime.json')
// MEMORY 面板数据源（与 web/memory.mjs 同规则：env 优先，否则 state-compiler/memory）
const MEM_DB = process.env.DSH_MEMORY_DB || join(STATE_DIR, 'memory', 'memory.sqlite')
const TRACE_DB = process.env.DSH_MEMORY_TRACE_DB || MEM_DB

mkdirSync(STATE_DIR, { recursive: true })

// node:sqlite 懒加载：Node < 22.5 无此模块时面板降级为"不可用"，绝不影响其余端点。
let _sqlitePromise = null
function sqliteModule() {
  if (_sqlitePromise === null) _sqlitePromise = import('node:sqlite').catch(() => null)
  return _sqlitePromise
}
const truthy = (v) => v === true || v === '1'
function memoryFlags(control, env = process.env) {
  const idleRaw = Number(env.DSH_MEMORY_CONSOLIDATE_IDLE_MS) || Number(control.memoryConsolidateIdleMs) || 15 * 60 * 1000
  const janitorRaw = Number(env.DSH_MEMORY_JANITOR_INTERVAL_MS) || Number(control.memoryJanitorIntervalMs) || 30 * 60 * 1000
  return {
    enabled: env.DSH_MEMORY === '0' ? false : (truthy(env.DSH_MEMORY) || control.memoryEnabled === true),
    llmEnabled: env.DSH_MEMORY_LLM === '0' ? false : (truthy(env.DSH_MEMORY_LLM) || control.memoryLlmEnabled === true),
    injectCatalog: env.DSH_MEMORY_INJECT === '0' ? false : control.memoryInjectCatalog !== false,
    handoff: env.DSH_MEMORY_HANDOFF === '0' ? false : control.memoryHandoff !== false,
    consolidateAuto: env.DSH_MEMORY_CONSOLIDATE === '0' ? false
      : (env.DSH_MEMORY_CONSOLIDATE === '1' || control.memoryConsolidateAuto !== false),
    consolidateIdleMs: Math.max(60_000, Math.min(24 * 3600_000, idleRaw)),
    janitorEnabled: env.DSH_MEMORY_JANITOR === '0' ? false
      : (env.DSH_MEMORY_JANITOR === '1' || control.memoryJanitorEnabled === true),
    janitorIntervalMs: Math.max(60_000, Math.min(24 * 3600_000, janitorRaw)),
    janitorRoute: routePairOf(control.memoryJanitorProvider, control.memoryJanitorModel),
  }
}
// 路由覆盖必须成对；半配置视为未配置（与 memory.mjs 的 routePair 同口径）。
function routePairOf(p, m) {
  return typeof p === 'string' && p && typeof m === 'string' && m ? { provider: p, model: m } : null
}
// 环境变量是否真的把某一项钉死（与 web/memory.mjs 的解析同口径）：
//   DSH_MEMORY / DSH_MEMORY_LLM 只认 '0'|'1'；DSH_MEMORY_INJECT 只认 '0'（'1' 不构成强制，默认本就为开）。
//   其余取值视为未设置，面板仍可写 control.json。
function envLockOf(env = process.env) {
  return {
    enabled: env.DSH_MEMORY === '0' || env.DSH_MEMORY === '1',
    llmEnabled: env.DSH_MEMORY_LLM === '0' || env.DSH_MEMORY_LLM === '1',
    injectCatalog: env.DSH_MEMORY_INJECT === '0',
    handoff: env.DSH_MEMORY_HANDOFF === '0',
    consolidateAuto: env.DSH_MEMORY_CONSOLIDATE === '0' || env.DSH_MEMORY_CONSOLIDATE === '1',
    janitorEnabled: env.DSH_MEMORY_JANITOR === '0' || env.DSH_MEMORY_JANITOR === '1',
  }
}
// 只读快照：任何一步失败都返回已有结构 + error，面板不空白。
// range：all | workspace | session | current（当前工作区 + 本会话私有）；缺省有会话时 current，否则 all。
async function memorySnapshot(sessionId = null, opts = {}) {
  const control = readControl()
  const wsReg = workspaceRegistry()
  const titles = loadSessionTitles()
  const titleCache = new Map()
  const bare = sessionId ? bareSid(sessionId) : null
  const cwd = bare ? sessionCwdOf(bare) : ''
  const curWs = bare ? (wsReg.bySid.get(bare) || (cwd ? workspaceInfo(cwd, wsReg) : null)) : null
  const curWsScope = curWs?.path ? 'ws:' + normWsKey(curWs.path) : null
  const curSessScope = bare ? 'sess:' + bare : null
  const curTitle = bare ? sessionTitleOf(bare, titles, titleCache) : ''
  const reqRange = ['all', 'workspace', 'session', 'current'].includes(String(opts.range ?? ''))
    ? String(opts.range) : (sessionId ? 'current' : 'all')
  let range = reqRange
  if (range === 'workspace' && !curWsScope) range = 'all'
  else if (range === 'session' && !curSessScope) range = 'all'
  else if (range === 'current' && !curWsScope && !curSessScope) range = 'all'
  // 事实钻取/分页：默认仍为 200 条，老调用方不传参数时行为不变。
  const factLimit = Math.max(1, Math.min(1000, Number(opts.factLimit) || 200))
  const focusRaw = String(opts.focusScope ?? '')
  const focusScope = /^(ws|sess):[^|]{1,400}$/.test(focusRaw) ? focusRaw : null
  const sinceRaw = Number(opts.sinceTs)
  const sinceTs = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.min(Date.now(), sinceRaw) : 0
  // 游标分页：updated_ts 相同的记录用 rowid 破平，避免翻页时重复/漏条。
  const cursorRaw = String(opts.cursor ?? '')
  const cursorMatch = /^(\d{1,16}):(\d{1,16})$/.exec(cursorRaw)
  const cursor = cursorMatch ? { ts: Number(cursorMatch[1]), rowid: Number(cursorMatch[2]) } : null
  const flags = memoryFlags(control)
  const out = {
    flags,
    db: { path: MEM_DB, exists: existsSync(MEM_DB), bytes: 0 },
    totals: { active: 0, resolved: 0, insights: 0, errors: 0, workspaces: 0 },
    range: reqRange,
    rangeEffective: range,
    current: null,
    kinds: [], workspaces: [], sessions: [], insights: [], recent: [],
    compile: { cursors: 0, last: null },
    // 轻 LLM 编译的显式路由覆盖（control.memoryLlmProvider/Model）；两者都空 = 跟随会话模型。
    llmRoute: {
      provider: typeof control?.memoryLlmProvider === 'string' && control.memoryLlmProvider ? control.memoryLlmProvider : null,
      model: typeof control?.memoryLlmModel === 'string' && control.memoryLlmModel ? control.memoryLlmModel : null,
    },
    inflight: sessionId ? readMemoryInflight(sessionId) : null,
    // 记忆整理：下次自动时间、进行中阶段、上次结果（均按会话存档；无会话时只有开关与间隔）。
    consolidate: (() => {
      const manualRoute = {
        provider: typeof control?.memoryConsolidateManualProvider === 'string' && control.memoryConsolidateManualProvider ? control.memoryConsolidateManualProvider : null,
        model: typeof control?.memoryConsolidateManualModel === 'string' && control.memoryConsolidateManualModel ? control.memoryConsolidateManualModel : null,
      }
      const base = { auto: flags.consolidateAuto, idleMs: flags.consolidateIdleMs, manualRoute, next: null, inflight: null, last: null }
      if (!sessionId) return base
      const id = normSid(sessionId)
      return {
        ...base,
        next: readJson(memSessionFile('consolidate-next', id)),
        inflight: readConsolidateInflight(id),
        last: readJson(memSessionFile('consolidate-last', id)),
      }
    })(),
    // 文件巡检管家：自动间隔、路由、最近一次结果与在飞标记（均按会话存档）。
    janitor: (() => {
      const base = { enabled: flags.janitorEnabled, intervalMs: flags.janitorIntervalMs, route: flags.janitorRoute, last: null, inflight: null }
      if (!sessionId) return base
      const id = normSid(sessionId)
      return {
        ...base,
        last: readJson(memSessionFile('janitor-last', id)),
        inflight: readJanitorInflight(id),
      }
    })(),
    vector: null,
    session: null,
    // armed=记忆插件在本进程里真正 apply 过（meta.armedPid 与当前 pid 同号）；仅控制层启用还不够。
    armed: false,
    envLocked: envLockOf(),
    sqlite: false,
    error: null,
    timestamp: Date.now(),
  }
  try { if (out.db.exists) out.db.bytes = statSync(MEM_DB).size } catch { /* best-effort */ }
  if (!out.db.exists) return out
  const sq = await sqliteModule()
  if (!sq) { out.error = 'sqlite-unavailable'; return out }
  let db = null
  try {
    db = tuneReadOnly(new sq.DatabaseSync(MEM_DB, { readOnly: true }))
    out.sqlite = true
    out.vector = readVectorHealth(db)
    const one = (sql, ...args) => { try { return db.prepare(sql).get(...args) } catch { return null } }
    const all = (sql, ...args) => { try { return db.prepare(sql).all(...args) } catch { return [] } }
    // 作用域是否真实存在：未知会话不能因为构造出 sess:<sid> 就声称"当前上下文"。
    const scopeHas = (scope) => !!scope && !!one('SELECT 1 x FROM records WHERE scope=? LIMIT 1', scope)
    const knownSession = !!curWs || scopeHas(curSessScope)
    if (range === 'workspace' && !curWs) range = 'all'
    else if (range === 'session' && !curWs && !scopeHas(curSessScope)) range = 'all'
    else if (range === 'current' && !curWs && !scopeHas(curSessScope)) range = 'all'
    out.rangeEffective = range
    const scopes = [curWsScope, curSessScope].filter(Boolean)
    const rangeSql = range === 'all' ? '' : (range === 'current'
      ? ` AND scope IN (${scopes.map(() => '?').join(',')})`
      : ' AND scope=?')
    const rangeArgs = range === 'all' ? [] : (range === 'current' ? scopes : [range === 'workspace' ? curWsScope : curSessScope])
    // 作用域钻取：与客户端 visibleMemoryGraph 的 focus 语义一致。
    //   sess:S → 本会话私有事实 + 由 S 产生的工作区共享事实；
    //   ws:X   → X 的共享事实 + 属于 X 的会话私有事实。
    let focusSql = ''
    let focusArgs = []
    if (focusScope && focusScope.startsWith('sess:')) {
      focusSql = " AND (scope=? OR (scope LIKE 'ws:%' AND sid=?))"
      focusArgs = [focusScope, focusScope.slice(5)]
    } else if (focusScope && focusScope.startsWith('ws:')) {
      const sids = []
      for (const [sid, info] of wsReg.bySid) {
        if (info?.path && ('ws:' + normWsKey(info.path)) === focusScope) sids.push('sess:' + bareSid(sid))
      }
      focusSql = sids.length
        ? ` AND (scope=? OR scope IN (${sids.map(() => '?').join(',')}))`
        : ' AND scope=?'
      focusArgs = [focusScope, ...sids]
    }
    // 时间窗：只过滤事实/最近记录，不改全库 totals 与范围节点本身。
    const sinceSql = sinceTs ? ' AND updated_ts>=?' : ''
    const sinceArgs = sinceTs ? [sinceTs] : []
    // 游标只约束事实页；insights/recent/总数仍按原范围口径。
    const cursorSql = cursor ? ' AND (updated_ts<? OR (updated_ts=? AND rowid<?))' : ''
    const cursorArgs = cursor ? [cursor.ts, cursor.ts, cursor.rowid] : []
    const armed = one("SELECT value FROM meta WHERE key='armedPid'")
    const armedAt = one("SELECT value FROM meta WHERE key='armedAt'")
    // 心跳口径：armedAt 由记忆层每 60s 续期，2.5 分钟内算活着；armedPid 被子实例清 0 不再误报。
    // 若 pid 属于另一个仍在运行的进程，则不把共享库里的新鲜心跳算到本进程头上。
    const armedPid = Number(armed?.value ?? NaN)
    const armedAtMs = Number(armedAt?.value ?? 0)
    out.armed = out.flags.enabled === true
      && armedAtMs > 0 && (Date.now() - armedAtMs) < 150000
      && (armedPid === process.pid || armedPid === 0)
    // Phase 5.0：一次 GROUP BY 取代 5 条全表 COUNT（100k 轮询的主要成本是重复扫整行）。
    const byKindStatus = all("SELECT kind, status, COUNT(*) n FROM records GROUP BY kind, status")
    const kindCounts = new Map()
    let active = 0
    let resolved = 0
    let activeInsights = 0
    let activeErrors = 0
    for (const r of byKindStatus) {
      const n = Number(r.n) || 0
      const kind = String(r.kind)
      if (String(r.status) === 'active') {
        active += n
        kindCounts.set(kind, (kindCounts.get(kind) || 0) + n)
        if (kind === 'insight') activeInsights += n
        if (kind === 'error') activeErrors += n
      } else if (String(r.status) === 'resolved') {
        resolved += n
      }
    }
    out.totals.active = active
    out.totals.resolved = resolved
    out.totals.insights = activeInsights
    out.totals.errors = activeErrors
    out.totals.workspaces = Number(one("SELECT COUNT(DISTINCT scope) n FROM records WHERE scope LIKE 'ws:%'")?.n ?? 0)
    out.kinds = [...kindCounts.entries()]
      .map(([kind, n]) => ({ kind, n }))
      .sort((a, b) => b.n - a.n)
    const byCurrent = (a, b) => (Number(b.current) - Number(a.current)) || (b.last - a.last)
    out.workspaces = all("SELECT scope, COUNT(*) n, MAX(updated_ts) last FROM records WHERE scope LIKE 'ws:%' GROUP BY scope ORDER BY last DESC LIMIT 12")
      .map((r) => {
        const scope = String(r.scope)
        const info = workspaceInfo(scope, wsReg)
        return { scope, kind: 'workspace', label: info.title, path: info.path, n: Number(r.n), last: Number(r.last), current: scope === curWsScope }
      }).sort(byCurrent)
    out.sessions = all("SELECT scope, COUNT(*) n, MAX(updated_ts) last FROM records WHERE scope LIKE 'sess:%' GROUP BY scope ORDER BY last DESC LIMIT 12")
      .map((r) => {
        const scope = String(r.scope)
        const sid = scope.slice(5)
        const title = sessionTitleOf(sid, titles, titleCache)
        const ws = wsReg.bySid.get(bareSid(sid)) || null
        return {
          scope, kind: 'session', sid, label: sessionLabelOf(sid, title), title,
          workspace: ws?.title || '', path: ws?.path || '',
          n: Number(r.n), last: Number(r.last), current: scope === curSessScope,
        }
      }).sort(byCurrent)
    const scopeMeta = (scope, sid) => {
      const s = String(scope || '')
      if (s.startsWith('ws:')) {
        const info = workspaceInfo(s, wsReg)
        return { scopeLabel: '工作区 ' + (info.title || info.path), originTitle: sid ? sessionTitleOf(sid, titles, titleCache) : '' }
      }
      const x = s.startsWith('sess:') ? s.slice(5) : s
      return { scopeLabel: sessionLabelOf(x, sessionTitleOf(x, titles, titleCache)), originTitle: '' }
    }
    out.insights = all(`SELECT key, value, scope, sid, updated_ts FROM records WHERE kind='insight' AND status='active'${rangeSql}${focusSql}${sinceSql} ORDER BY updated_ts DESC LIMIT 20`, ...rangeArgs, ...focusArgs, ...sinceArgs)
      .map((r) => {
        let v = {}
        try { v = JSON.parse(r.value) } catch { /* keep empty */ }
        const m = scopeMeta(r.scope, r.sid)
        return {
          key: String(r.key), summary: String(v.summary ?? ''), confidence: Number(v.confidence ?? 0),
          model: v.model ?? null, scope: String(r.scope), scopeLabel: m.scopeLabel,
          originSid: r.sid ? bareSid(r.sid) : null, originTitle: m.originTitle,
          updated_ts: Number(r.updated_ts),
          evidence: Array.isArray(v.evidence) ? v.evidence.length : 0,
          evidenceIds: Array.isArray(v.evidence) ? v.evidence.slice(-8).map(Number) : [],
        }
      })
    out.recent = all(`SELECT kind, key, status, scope, sid, updated_ts FROM records WHERE 1=1${rangeSql}${focusSql}${sinceSql} ORDER BY updated_ts DESC LIMIT 15`, ...rangeArgs, ...focusArgs, ...sinceArgs)
      .map((r) => {
        const m = scopeMeta(r.scope, r.sid)
        return {
          kind: String(r.kind), key: String(r.key), status: String(r.status), scope: String(r.scope),
          scopeLabel: m.scopeLabel, originSid: r.sid ? bareSid(r.sid) : null, originTitle: m.originTitle,
          updated_ts: Number(r.updated_ts),
        }
      })
    const countScope = (scope) => {
      if (!scope) return { records: 0, insights: 0 }
      return {
        records: Number(one('SELECT COUNT(*) n FROM records WHERE scope=?', scope)?.n ?? 0),
        insights: Number(one("SELECT COUNT(*) n FROM records WHERE scope=? AND kind='insight' AND status='active'", scope)?.n ?? 0),
      }
    }
    const wsCount = countScope(curWsScope)
    const sessCount = countScope(curSessScope)
    if (sessionId && knownSession) {
      out.current = {
        sid: bare,
        title: curTitle,
        workspace: curWs ? {
          scope: curWsScope, title: curWs.title, path: curWs.path,
          records: wsCount.records, insights: wsCount.insights,
        } : null,
        session: { scope: curSessScope, title: curTitle, records: sessCount.records, insights: sessCount.insights },
        records: wsCount.records + sessCount.records,
        insights: wsCount.insights + sessCount.insights,
      }
    }
    // 自动巡检结果按「工作区最近会话」落盘（lastSid:<ws>），新开的同工作区会话不是那个 sid。
    // 当前会话没有自己的记录时回退到工作区最近一次，否则面板在新会话里永远显示“还没有巡检结果”。
    if (knownSession && curWsScope && !out.janitor.last) {
      try {
        const sidRaw = one('SELECT value FROM meta WHERE key=?', 'lastSid:' + curWsScope.slice(3))?.value
        const other = sidRaw ? normSid(sidRaw) : ''
        if (other && other !== normSid(sessionId)) {
          const rec = readJson(memSessionFile('janitor-last', other))
          if (rec) out.janitor.last = { ...rec, fromSid: other }
        }
      } catch { /* best-effort：回退失败就维持空 */ }
    }
    out.graph = null
    out.compile.cursors = Number(one("SELECT COUNT(*) n FROM meta WHERE key LIKE 'compiledThrough:%'")?.n ?? 0)
    const last = one("SELECT key, value FROM meta WHERE key LIKE 'llmThrough:%' ORDER BY CAST(value AS INTEGER) DESC LIMIT 1")
    out.compile.last = last ? { sid: String(last.key).replace(/^llmThrough:/, ''), through: Number(last.value) } : null
    if (sessionId && knownSession) {
      const sid = normSid(sessionId)
      const injRaw = one("SELECT value FROM meta WHERE key=?", 'injected:' + sid)?.value
      let injection = null
      if (injRaw) {
        try {
          const j = JSON.parse(injRaw)
          injection = {
            chars: Number(j.chars ?? 0), handover: !!j.handover, sha1: j.sha1 ?? null,
            at: Number(j.at ?? 0) || null, untrusted: true,
            text: String(j.text ?? '').slice(0, 1600),
          }
        } catch { injection = { legacy: true, untrusted: true } }
      }
      out.session = {
        sid,
        title: curTitle,
        records: Number(one('SELECT COUNT(*) n FROM records WHERE sid=?', sid)?.n ?? 0),
        privateRecords: sessCount.records,
        privateInsights: sessCount.insights,
        workspaceRecords: wsCount.records,
        workspaceInsights: wsCount.insights,
        workspace: curWs ? { title: curWs.title, path: curWs.path, scope: curWsScope } : null,
        turns: Number(one("SELECT COUNT(*) n FROM records WHERE sid=? AND kind='user_turn'", sid)?.n ?? 0),
        injected: !!injRaw,
        injection,
        compiledThrough: Number(one('SELECT value FROM meta WHERE key=?', 'compiledThrough:' + sid)?.value ?? -1),
        llmThrough: Number(one('SELECT value FROM meta WHERE key=?', 'llmThrough:' + sid)?.value ?? -1),
      }
    }
  } catch (err) {
    out.error = String(err?.message ?? err)
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
  return out
}

// 独立图谱端点：只返回 graph 部分（nodes/edges/stats），不含 records/insights/recent 等。
// 用于前端图谱 tab 按需拉取，避免 5s 轮询 /api/memory/status 时携带 64.9% 的图谱负载。
async function memoryGraph(sessionId = null, opts = {}) {
  const out = { ok: true, graph: null, error: null }
  if (!existsSync(MEM_DB)) { out.error = 'db-missing'; return out }
  const sq = await sqliteModule()
  if (!sq) { out.error = 'sqlite-unavailable'; return out }
  let db = null
  try {
    db = tuneReadOnly(new sq.DatabaseSync(MEM_DB, { readOnly: true }))
    const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) ?? null } catch { return null } }
    const all = (sql, ...a) => { try { return db.prepare(sql).all(...a) ?? [] } catch { return [] } }
    const range = String(opts.range ?? 'current')
    const bare = sessionId ? normSid(sessionId) : ''
    const knownSession = !!(sessionId && bare)
    const curSessScope = knownSession ? 'sess:' + bare : null
    const wsReg = workspaceRegistry()
    const curWsScope = knownSession ? (wsReg.bySid.get(bare) ? 'ws:' + normWsKey(wsReg.bySid.get(bare).path) : null) : null
    const curWs = curWsScope ? workspaceInfo(curWsScope, wsReg) : null
    const titles = loadSessionTitles()
    const titleCache = new Map()
    const curTitle = knownSession ? sessionTitleOf(bare, titles, titleCache) : ''
    const focusScopeRaw = opts.focusScope ? String(opts.focusScope) : null
    const focusScope = (focusScopeRaw && (focusScopeRaw.startsWith('ws:') || focusScopeRaw.startsWith('sess:'))) ? focusScopeRaw : null
    const factLimit = Math.max(1, Math.min(1000, Number(opts.factLimit) || 200))
    const sinceTsRaw = opts.sinceTs ? Number(opts.sinceTs) : 0
    const sinceTs = Number.isFinite(sinceTsRaw) && sinceTsRaw > 0 ? sinceTsRaw : 0
    const cursorRaw = String(opts.cursor ?? '')
    const cursorMatch = /^(\d{1,16}):(\d{1,16})$/.exec(cursorRaw)
    const cursor = cursorMatch ? { ts: Number(cursorMatch[1]), rowid: Number(cursorMatch[2]) } : null
    let rangeSql = '', rangeArgs = []
    if (range === 'workspace' && curWsScope) { rangeSql = ' AND scope=?'; rangeArgs = [curWsScope] }
    else if (range === 'session' && curSessScope) { rangeSql = ' AND scope=?'; rangeArgs = [curSessScope] }
    else if (range === 'current') {
      if (curWsScope && curSessScope) { rangeSql = ' AND scope IN (?,?)'; rangeArgs = [curWsScope, curSessScope] }
      else if (curWsScope) { rangeSql = ' AND scope=?'; rangeArgs = [curWsScope] }
      else if (curSessScope) { rangeSql = ' AND scope=?'; rangeArgs = [curSessScope] }
    }
    let focusSql = '', focusArgs = []
    if (focusScope) {
      if (focusScope.startsWith('ws:')) { focusSql = ' AND (scope=? OR (scope LIKE \'sess:%\' AND sid IN (SELECT sid FROM records WHERE scope=?)))'; focusArgs = [focusScope, focusScope] }
      else if (focusScope.startsWith('sess:')) { focusSql = ' AND (scope=? OR scope=?)'; focusArgs = [focusScope, focusScope] }
    }
    let sinceSql = '', sinceArgs = []
    if (sinceTs && Number.isFinite(sinceTs)) { sinceSql = ' AND updated_ts>=?'; sinceArgs = [sinceTs] }
    let cursorSql = '', cursorArgs = []
    if (cursor) { cursorSql = ' AND (updated_ts<? OR (updated_ts=? AND rowid<?))'; cursorArgs = [cursor.ts, cursor.ts, cursor.rowid] }
    const scopeMeta = (scope, sid) => {
      const s = String(scope || '')
      if (s.startsWith('ws:')) {
        const info = workspaceInfo(s, wsReg)
        return { scopeLabel: '工作区 ' + (info.title || info.path), originTitle: sid ? sessionTitleOf(sid, titles, titleCache) : '' }
      }
      const x = s.startsWith('sess:') ? s.slice(5) : s
      return { scopeLabel: sessionLabelOf(x, sessionTitleOf(x, titles, titleCache)), originTitle: '' }
    }
    const wsScopeOfSid = (sid) => {
      const w = wsReg.bySid.get(bareSid(sid))
      return w ? 'ws:' + normWsKey(w.path) : null
    }
    const gWs = new Map()
    const wsRows = all("SELECT scope, COUNT(*) n, MAX(updated_ts) last FROM records WHERE scope LIKE 'ws:%' GROUP BY scope ORDER BY last DESC LIMIT 12")
    for (const r of wsRows) {
      const info = workspaceInfo(r.scope, wsReg)
      gWs.set(r.scope, { id: r.scope, scope: r.scope, kind: 'workspace', label: info.title, path: info.path, n: Number(r.n), last: Number(r.last), current: r.scope === curWsScope, facts: 0 })
    }
    if (curWsScope && !gWs.has(curWsScope)) {
      gWs.set(curWsScope, {
        id: curWsScope, scope: curWsScope, kind: 'workspace', label: curWs?.title || workspaceInfo(curWsScope, wsReg).title,
        path: curWs?.path || workspaceInfo(curWsScope, wsReg).path, n: 0, last: Date.now(), current: true, facts: 0,
      })
    }
    const gSess = new Map()
    const sessRows = all("SELECT scope, COUNT(*) n, MAX(updated_ts) last FROM records WHERE scope LIKE 'sess:%' GROUP BY scope ORDER BY last DESC LIMIT 12")
    for (const r of sessRows) {
      const scope = String(r.scope)
      const sid = scope.slice(5)
      const title = sessionTitleOf(sid, titles, titleCache)
      const ws = wsReg.bySid.get(bareSid(sid)) || null
      gSess.set(scope, {
        id: scope, scope, kind: 'session', sid, label: sessionLabelOf(sid, title), title,
        workspace: ws?.title || '', path: ws?.path || '',
        workspaceScope: ws ? 'ws:' + normWsKey(ws.path) : null,
        n: Number(r.n), last: Number(r.last), current: scope === curSessScope, facts: 0, originFacts: 0,
      })
    }
    if (curSessScope && !gSess.has(curSessScope)) {
      gSess.set(curSessScope, {
        id: curSessScope, scope: curSessScope, kind: 'session', sid: bare, label: sessionLabelOf(bare, curTitle), title: curTitle,
        workspace: curWs?.title || '', path: curWs?.path || '', workspaceScope: curWsScope,
        n: 0, last: Date.now(), current: true, facts: 0, originFacts: 0,
      })
    }
    const sidCounts = new Map(all("SELECT sid, COUNT(*) n, MAX(updated_ts) last FROM records WHERE sid<>'' GROUP BY sid")
      .map((r) => [bareSid(r.sid), { n: Number(r.n), last: Number(r.last) }]))
    const ensureSession = (sid) => {
      const s = bareSid(sid)
      if (!s) return null
      const id = 'sess:' + s
      if (!gSess.has(id)) {
        const wsScope = wsScopeOfSid(s)
        const wsInfo = wsScope ? workspaceInfo(wsScope, wsReg) : null
        const c = sidCounts.get(s) || { n: 0, last: 0 }
        gSess.set(id, {
          id, scope: id, kind: 'session', sid: s, label: sessionLabelOf(s, sessionTitleOf(s, titles, titleCache)),
          title: sessionTitleOf(s, titles, titleCache), workspace: wsInfo?.title || '', path: wsInfo?.path || '',
          workspaceScope: wsScope, n: c.n, last: c.last, current: id === curSessScope, facts: 0, originFacts: 0,
        })
      }
      return gSess.get(id)
    }
    const factRowsRaw = all(`SELECT rowid AS rid, key, value, scope, sid, status, fact_type, updated_ts FROM records
      WHERE kind='insight' AND status IN ('active','stale','historical','superseded')${rangeSql}${focusSql}${sinceSql}${cursorSql}
      ORDER BY updated_ts DESC, rowid DESC LIMIT ?`, ...rangeArgs, ...focusArgs, ...sinceArgs, ...cursorArgs, factLimit + 1)
    const hasMore = factRowsRaw.length > factLimit
    const factRows = hasMore ? factRowsRaw.slice(0, factLimit) : factRowsRaw
    const factTail = factRows[factRows.length - 1] || null
    const nextCursor = hasMore && factTail ? (Number(factTail.updated_ts) + ':' + Number(factTail.rid)) : null
    const factTotal = Number(one(`SELECT COUNT(*) n FROM records
      WHERE kind='insight' AND status IN ('active','stale','historical','superseded')${rangeSql}${focusSql}${sinceSql}`,
      ...rangeArgs, ...focusArgs, ...sinceArgs)?.n ?? 0)
    const scopeFactCounts = new Map(all(`SELECT scope, COUNT(*) n FROM records
      WHERE kind='insight' AND status IN ('active','stale','historical','superseded')${rangeSql}${sinceSql}
      GROUP BY scope`, ...rangeArgs, ...sinceArgs).map((r) => [String(r.scope), Number(r.n) || 0]))
    const factNodes = []
    const edges = []
    const edgeSeen = new Set()
    const addEdge = (source, target, kind) => {
      if (!source || !target) return
      const k = source + '|' + target + '|' + kind
      if (edgeSeen.has(k)) return
      edgeSeen.add(k)
      edges.push({ source, target, kind })
    }
    for (const r of factRows) {
      const scope = String(r.scope)
      let v = {}
      try { v = JSON.parse(r.value) } catch { /* keep empty */ }
      const meta = scopeMeta(scope, r.sid)
      const originSid = r.sid ? bareSid(r.sid) : ''
      const node = {
        id: 'fact:' + scope + '|' + String(r.key), kind: 'fact', key: String(r.key),
        summary: String(v.summary ?? ''), factType: String(r.fact_type || v.type || ''),
        status: String(r.status || ''), confidence: Number(v.confidence ?? 0),
        scope, scopeLabel: meta.scopeLabel, originSid, originTitle: meta.originTitle,
        updated_ts: Number(r.updated_ts), evidence: Array.isArray(v.evidence) ? v.evidence.length : 0,
        model: v.model ?? null,
      }
      factNodes.push(node)
      if (scope.startsWith('ws:')) {
        if (!gWs.has(scope)) {
          const info = workspaceInfo(scope, wsReg)
          gWs.set(scope, { id: scope, scope, kind: 'workspace', label: info.title, path: info.path, n: 0, last: node.updated_ts, current: scope === curWsScope, facts: 0 })
        }
        const w = gWs.get(scope)
        w.facts += 1
        addEdge(node.id, scope, 'shared')
        if (originSid) {
          const s = ensureSession(originSid)
          if (s) { s.originFacts += 1; addEdge(node.id, s.scope, 'origin') }
        }
      } else if (scope.startsWith('sess:')) {
        const s = ensureSession(scope.slice(5))
        if (s) { s.facts += 1; addEdge(node.id, s.scope, 'private') }
      }
    }
    for (const s of gSess.values()) {
      if (s.workspaceScope) {
        if (!gWs.has(s.workspaceScope)) {
          const info = workspaceInfo(s.workspaceScope, wsReg)
          gWs.set(s.workspaceScope, { id: s.workspaceScope, scope: s.workspaceScope, kind: 'workspace', label: info.title, path: info.path, n: 0, last: s.last, current: s.workspaceScope === curWsScope, facts: 0 })
        }
        addEdge(s.scope, s.workspaceScope, 'member')
      }
    }
    for (const w of gWs.values()) w.factTotal = scopeFactCounts.get(w.scope) || 0
    for (const s of gSess.values()) s.factTotal = scopeFactCounts.get(s.scope) || 0
    out.graph = {
      nodes: [...gWs.values(), ...gSess.values(), ...factNodes],
      edges,
      stats: {
        workspaces: gWs.size,
        sessions: gSess.size,
        facts: factNodes.length,
        activeFacts: factNodes.filter((x) => x.status === 'active').length,
        factTotal,
        factLimit,
        sinceTs,
        hasMore,
        nextCursor,
        cursor: cursor ? cursorRaw : null,
        truncated: factTotal > factNodes.length,
        focusScope: focusScope || null,
      },
    }
  } catch (err) {
    out.error = String(err?.message ?? err)
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
  return out
}

// 证据摘要：事件 value 是 JSON 对象，按"人读优先"的字段顺序拼一行；没有已知字段时退回 JSON。
// 只做展示，不参与任何判定；原文另存 raw 供展开。
function evidencePreview(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v !== 'object') return String(v)
  const order = ['summary', 'text', 'cmd', 'pattern', 'question', 'answer', 'path', 'target', 'head', 'tail', 'job_id', 'state', 'status']
  const picks = []
  for (const k of order) {
    const x = v[k]
    if (typeof x === 'string' && x.trim()) picks.push(k + ': ' + x.trim())
  }
  return picks.length ? picks.join(' · ') : JSON.stringify(v)
}

// 只读证据钻取：按 scope+key 取一条 insight 的 evidence ids，再回查 events。
// 不接受任意 SQL 片段；两个参数都只用于参数化查询。
async function memoryEvidence(scope, key) {
  const out = { scope: String(scope ?? ''), key: String(key ?? ''), summary: '', status: '', evidence: [], error: null }
  const sc = out.scope
  if (!/^(ws|sess):[^|]{1,400}$/.test(sc) || !out.key || out.key.length > 300) { out.error = 'bad-request'; return out }
  if (!existsSync(MEM_DB)) { out.error = 'db-missing'; return out }
  const sq = await sqliteModule()
  if (!sq) { out.error = 'sqlite-unavailable'; return out }
  let db = null
  try {
    db = tuneReadOnly(new sq.DatabaseSync(MEM_DB, { readOnly: true }))
    const rec = db.prepare("SELECT value, status, updated_ts FROM records WHERE scope=? AND kind='insight' AND key=?").get(sc, out.key)
    if (!rec) { out.error = 'not-found'; return out }
    let v = {}
    try { v = JSON.parse(rec.value) ?? {} } catch { /* keep key only */ }
    out.summary = String(v.summary ?? '')
    out.status = String(rec.status ?? '')
    const ids = Array.isArray(v.evidence) ? v.evidence.slice(-16) : []
    const numeric = []
    const extras = []
    for (const id of ids) {
      const n = Number(id)
      if (Number.isFinite(n) && n > 0) numeric.push(n)
      else extras.push(String(id))
    }
    const titles = loadSessionTitles()
    const cache = new Map()
    const rows = numeric.length
      ? db.prepare(`SELECT id, ts, sid, seq, kind, key, value, scope FROM events WHERE id IN (${numeric.map(() => '?').join(',')})`).all(...numeric)
      : []
    const byId = new Map(rows.map((r) => [Number(r.id), r]))
    for (const id of numeric) {
      const r = byId.get(id)
      if (!r) { out.evidence.push({ id: 'e:' + id, kind: 'missing', content: '事件 ' + id + ' 已不存在', ts: 0 }); continue }
      let ev = {}
      try { ev = JSON.parse(r.value) ?? {} } catch { /* keep raw-less */ }
      const sid = r.sid ? bareSid(r.sid) : null
      out.evidence.push({
        id: 'e:' + id, eventId: Number(r.id), kind: String(r.kind ?? ''), key: String(r.key ?? ''),
        ts: Number(r.ts) || 0, seq: r.seq == null ? null : Number(r.seq),
        sid, sessionTitle: sid ? sessionTitleOf(sid, titles, cache) : '',
        content: evidencePreview(ev).slice(0, 600),
        raw: JSON.stringify(ev, null, 2).slice(0, 2000),
      })
    }
    for (const id of extras) {
      const kind = id.startsWith('r:') ? 'reset' : (id.startsWith('f:') ? 'probe' : 'ref')
      const label = kind === 'reset' ? '重置事件 ' + id.slice(2) : (kind === 'probe' ? '文件探针 ' + id.slice(2) : '引用 ' + id)
      out.evidence.push({ id, kind, content: label, ts: 0 })
    }
    out.count = out.evidence.length
    out.updated_ts = Number(rec.updated_ts) || 0
  } catch (err) {
    out.error = String(err?.message ?? err)
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
  return out
}
// 【在飞折叠】「上一轮输出压缩中…」的陈旧闸：后台折叠在飞时进程崩溃会留下孤儿标记文件。
//   超过该时长一律按"没有在飞折叠"上报 —— 绝不让面板永久显示"压缩中"（用户看不到就会以为卡死）。
const FOLD_INFLIGHT_TTL_MS = 10 * 60 * 1000
// 陈旧判定（纯函数，便于单测/复用）：startedAt 非有限数（损坏/缺字段）或年龄 > TTL ⇒ 视为陈旧。
export function isFoldInflightStale(marker, now = Date.now(), ttlMs = FOLD_INFLIGHT_TTL_MS) {
  const t0 = marker ? marker.startedAt : null
  if (typeof t0 !== 'number' || !Number.isFinite(t0)) return true
  return now - t0 > ttlMs
}
// 【0.1.38 读时校正】旧 last-fold 的本折比值把首折原样保留的 head 计入分子（真机 101%）。
//   只修"带 head 段且具备原始计数"的记录；新记录写入口径已是同一算式，重算结果不变。
//   为什么在读取侧做：历史文件不重写（保持审计原样），但面板不能继续显示旧口径。
export function normalizeLastFold(lf) {
  if (!lf || typeof lf !== 'object') return lf
  const segs = Array.isArray(lf.segments) ? lf.segments : null
  if (!segs || !segs.some((s) => s && s.kind === 'head')) return lf
  const raw = Number(lf.incrementalRawBytes)
  const ap = Number(lf.appendedBytes)
  const hb = Number(lf.headBytes)
  if (!(raw > 0) || !Number.isFinite(ap) || !Number.isFinite(hb)) return lf
  const fixed = Number((Math.max(0, ap - hb) / raw).toFixed(4))
  lf.foldRatio = fixed
  if (lf.shrink != null) lf.shrink = fixed
  return lf
}
// 会话 id 归一（与 contextinjector.mjs 的 normSessionId 同规则：目录名 session-<uuid> ↔ 运行时 uuid）
const normSid = (s) => String(s ?? '').replace(/^session-?/i, '')
const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
// 记忆整理的状态文件按会话落盘（与 memory.mjs 的 normSid 规则一致）。
const memSessionFile = (dir, sid) => join(STATE_DIR, '.memory', dir,
  normSid(sid).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) + '.json')
// 【无 sid 兜底】逐会话在飞标记**全量**列表（只在请求不带 ?sessionId= 时给出，见下）。
//   为什么需要：会话页「压缩中」小标若因任何原因拿不到当前会话 id，就只能问"全机有几个会话在飞"——
//   客户端据此在**恰好 1 个**时才敢显示（多会话在飞一律不显示，避免张冠李戴）。
//   实现口径与 per-sid 读取完全一致（同目录、同命名、同 10 分钟陈旧闸），只多一次 readdir。
//   纯读、绝不写：不影响任何折叠状态；目录缺失/损坏 → 空数组（绝不让观测面拖垮 /status）。
function listFoldInflight() {
  try {
    const dir = join(STATE_DIR, '.ctxinjector', 'fold-inflight')
    const out = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const m = readJson(join(dir, name))
      if (!m || isFoldInflightStale(m)) continue
      out.push({
        sessionId: typeof m.sessionId === 'string' ? m.sessionId : name.slice(0, -5),
        trigger: typeof m.trigger === 'string' ? m.trigger : null,
        startedAt: m.startedAt,
        step: (typeof m.step === 'number' && Number.isFinite(m.step)) ? m.step : null,
      })
    }
    return out
  } catch { return [] }
}
const writeJson = (p, obj) => {
  try { writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); return true } catch { return false }
}
// v1.10.39：插件自绘状态行（宿主折叠行已被 CSS 隐藏）需要的三个标记。
//   · .memory/compile-inflight/<sid>.json  ← memory.mjs 编译期间写、finally 删
//   · .memory/compile-last/<sid>.json      ← 最近一次编译结果（chip 显示「记忆 +N」30s）
//   · .ctxinjector/native-compaction/<sid>.json ← DSH 原生 compaction 在飞（补回被隐藏的宿主信号）
const markerName = (s) => String(s ?? '').replace(/^session-?/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
function readMemoryInflight(sid) {
  if (!sid) return null
  const m = readJson(join(STATE_DIR, '.memory', 'compile-inflight', markerName(sid) + '.json'))
  return m && !isFoldInflightStale(m) ? { startedAt: m.startedAt } : null
}
// 整理在飞标记与折叠同款陈旧闸：整理进程崩溃留下的孤儿标记不能让面板永久显示「整理中」。
function readConsolidateInflight(sid) {
  if (!sid) return null
  const m = readJson(memSessionFile('consolidate-inflight', sid))
  return m && !isFoldInflightStale(m) ? m : null
}
// 文件巡检在飞标记：同款陈旧闸，孤儿标记不会让面板永久显示「巡检中」。
// 契约文件用 `at`（与 last 同口径），这里统一补出 startedAt 供 TTL 判定与 UI 计时。
function readJanitorInflight(sid) {
  if (!sid) return null
  const m = readJson(memSessionFile('janitor-inflight', sid))
  if (!m) return null
  const startedAt = Number(m.startedAt ?? m.at)
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > FOLD_INFLIGHT_TTL_MS) return null
  return { ...m, startedAt }
}
// 向量层只读诊断：与 MemoryStore._vecCfg()/vecHealth() 同口径，直接用只读连接查。
function readVectorHealth(db) {
  const meta = (k) => { try { return db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value ?? null } catch { return null } }
  const raw = String(process.env.DSH_MEMORY_VEC ?? meta('vec:enabled') ?? 'off').trim().toLowerCase()
  const enabled = raw === 'on' || raw === 'auto' || raw === '1' || raw === 'true'
  let row = null
  try {
    row = db.prepare('SELECT model, dim, COUNT(*) n FROM record_vectors GROUP BY model, dim ORDER BY n DESC LIMIT 1').get()
  } catch { /* pre-Phase-3 库 */ }
  let pending = 0
  try { pending = Number(db.prepare('SELECT COUNT(*) c FROM vec_queue').get()?.c ?? 0) } catch { /* ignore */ }
  const model = String(process.env.DSH_MEMORY_EMBED_MODEL || meta('vec:model') || row?.model || '')
  const dim = Number(process.env.DSH_MEMORY_EMBED_DIM || meta('vec:dim') || row?.dim || 0) || 0
  return {
    enabled,
    mode: enabled ? (raw === 'auto' ? 'auto' : 'on') : 'off',
    state: !enabled ? 'off' : (String(meta('vec:state') || 'ok') || 'ok'),
    model, dim,
    rows: Number(row?.n ?? 0) || 0,
    pending,
    lastError: String(meta('vec:lastError') || ''),
    failAt: Number(meta('vec:failAt') || 0) || null,
  }
}
function readMemoryLast(sid) {
  if (!sid) return null
  const m = readJson(join(STATE_DIR, '.memory', 'compile-last', markerName(sid) + '.json'))
  if (!m) return null
  return {
    t: Number.isFinite(Number(m.t)) ? Number(m.t) : null,
    ok: m.ok === true,
    insights: Number.isFinite(Number(m.insights)) ? Number(m.insights) : 0,
    through: Number.isFinite(Number(m.through)) ? Number(m.through) : null,
    model: typeof m.model === 'string' ? m.model : null,
    reason: typeof m.reason === 'string' ? m.reason : null,
  }
}
function readNativeCompaction(sid) {
  if (!sid) return null
  const m = readJson(join(STATE_DIR, '.ctxinjector', 'native-compaction', markerName(sid) + '.json'))
  return m && !isFoldInflightStale(m) ? { startedAt: m.startedAt } : null
}
// 会话索引优先取自 workspace registry（.dsh/storages/workspace.json）——与左侧栏同源：
// 可读 workspace 标题 + 归档状态（global.archivedSessionIds）。目录扫描仅作兜底。
const WORKSPACE_FILE = join(STATE_DIR, '..', 'storages', 'workspace.json')
const TITLE_FILE = join(STATE_DIR, '..', 'storages', 'session_projcache.json')
// 会话可读标题：host 投影缓存 tables.sessions[<id>].rows.title.val（与左侧栏同源）
function loadSessionTitles() {
  const map = new Map()
  try {
    const reg = readJson(TITLE_FILE)
    const sess = reg?.tables?.sessions ?? {}
    for (const sid of Object.keys(sess)) {
      const v = sess[sid]?.rows?.title?.val
      if (typeof v === 'string' && v.trim()) map.set(sid, v.trim())
    }
  } catch { /* best-effort */ }
  return map
}
function loadWorkspaceIndex() {
  const reg = readJson(WORKSPACE_FILE)
  const bySession = new Map()
  try {
    const workspaces = reg?.tables?.workspaces ?? {}
    const archived = new Set(reg?.global?.archivedSessionIds ?? [])
    for (const meta of Object.values(workspaces)) {
      const title = meta?.title || ''
      for (const sid of meta?.sessionIds ?? []) {
        if (!bySession.has(sid)) bySession.set(sid, { id: sid, workspace: title, archived: archived.has(sid) })
      }
    }
  } catch { /* best-effort */ }
  return bySession
}
function listSessions() {
  const out = [...loadWorkspaceIndex().values()]
  if (out.length === 0) {
    // fallback：目录扫描（headless/SANDBOX 布局与无 registry 部署）
    const seen = new Set()
    const push = (id) => { if (!seen.has(id)) { seen.add(id); out.push({ id, workspace: '', archived: false }) } }
    try {
      for (const top of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
        const p = join(SESSIONS_DIR, top.name)
        if (top.isFile() && top.name.endsWith('.zstd')) push(top.name.replace(/\.zstd$/, ''))
        if (top.isDirectory() && /^session-/.test(top.name)) push(top.name)
        else if (top.isDirectory()) {
          for (const sub of readdirSync(p, { withFileTypes: true })) {
            if (sub.isDirectory() && /^session-/.test(sub.name)) push(sub.name)
          }
        }
      }
    } catch { /* best-effort */ }
  }
  const titles = loadSessionTitles()
  for (const s of out) s.title = titles.get(s.id) || ''
  out.sort((a, b) => (a.workspace + ':' + (a.title || a.id)).localeCompare(b.workspace + ':' + (b.title || b.id)))
  return out
}
// ---- MEMORY 作用域展示：工作区名/会话标题 ----
// 记录里的 ws scope 是小写归一路径，视觉上需要还原成用户认识的工作区名（registry.title）。
const bareSid = (s) => String(s ?? '').replace(/^session-?/i, '')
const normWsKey = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
function workspaceRegistry() {
  const byKey = new Map()
  const bySid = new Map()
  try {
    const reg = readJson(WORKSPACE_FILE)
    for (const meta of Object.values(reg?.tables?.workspaces ?? {})) {
      const path = String(meta?.path ?? '')
      if (!path) continue
      const base = path.split(/[\\/]/).filter(Boolean).pop() || path
      const info = { path, title: String(meta?.title ?? '').trim() || base }
      byKey.set(normWsKey(path), info)
      for (const sid of meta?.sessionIds ?? []) bySid.set(bareSid(sid), info)
    }
  } catch { /* best-effort */ }
  return { byKey, bySid }
}
function workspaceInfo(value, reg) {
  const raw = String(value ?? '').replace(/^ws:/, '')
  const info = reg.byKey.get(normWsKey(raw))
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || raw
  return { path: info?.path || raw, title: info?.title || base || '未命名工作区' }
}
function sessionCwdOf(sid) {
  const s = bareSid(sid)
  if (!s) return ''
  try {
    const j = readJson(join(STATE_DIR, '..', 'storages', 'session_projcache', 'sessions', 'session-' + s + '.json'))
    return String(j?.record?.rows?.workingDirectory?.val || j?.record?.identity?.cwd || '')
  } catch { return '' }
}
function sessionTitleOf(sid, titles, cache) {
  const s = bareSid(sid)
  if (!s) return ''
  const fromReg = titles.get('session-' + s) || titles.get(s)
  if (fromReg) return fromReg
  if (cache.has(s)) return cache.get(s)
  let title = ''
  try {
    const j = readJson(join(STATE_DIR, '..', 'storages', 'session_projcache', 'sessions', 'session-' + s + '.json'))
    title = String(j?.record?.rows?.title?.val ?? '').trim()
    if (!title) title = String(j?.record?.rows?.titleInput?.val?.first?.text ?? '').trim()
  } catch { /* best-effort */ }
  cache.set(s, title)
  return title
}
function sessionLabelOf(sid, title) {
  const s = bareSid(sid)
  return title ? '会话「' + title + '」' : '会话 ' + (s ? s.slice(0, 8) : '未知')
}
function readControl() {
  return readJson(CONTROL_FILE) ?? { enabled: false, sessions: [], updatedAt: null }
}
// ---- LOGcompiler 生效目录（与插件 logsDirOf 同规则；面板「列出文件」与「导出 LOG」共用）----
//   静态 env LOGCOMPILER_OUT / LOGCOMPILER_LOGS_DIR > control.logsDir > 内部默认 <state>/transcripts
//   【取自 RCS-0.1.0 返回包】
function lgLogsDir() {
  const control = readJson(LG_CONTROL_FILE) ?? null
  const envDir = process.env.LOGCOMPILER_LOGS_DIR || ''
  const outFile = process.env.LOGCOMPILER_OUT || ''
  return outFile ? dirname(outFile)
    : (envDir || (control && typeof control.logsDir === 'string' && control.logsDir.trim() ? control.logsDir.trim() : '') || join(STATE_DIR, 'transcripts'))
}
// 转录文件名 key（与插件 normKey 同规则：去 session- 前缀、非法字符换 _、截断 80）【取自 RCS-0.1.0 返回包】
function lgKey(s) {
  return String(s ?? '').replace(/^session-?/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}
// ---- LOGcompiler 摘要（供「注入」面板「日志编译」区）：配置 + 是否装载 + 生效目录 + 各会话转录文件 ----
function logcompilerSnapshot() {
  const control = readJson(LG_CONTROL_FILE) ?? null
  const runtime = readJson(LG_RUNTIME_FILE) ?? null
  // 生效目录收口到 lgLogsDir()：列表与「导出 LOG」共用同一处，两者不会分叉。
  // 【取自 RCS-0.1.0 返回包】构造同插件 logsDirOf：env LOGCOMPILER_OUT / LOGCOMPILER_LOGS_DIR 属插件
  //   进程内操作者覆盖，host 与插件同进程(web profile)时可读到；否则回落 control.logsDir > 内部默认 transcripts/。
  const logsDir = lgLogsDir()
  // 单文件模式（LOGCOMPILER_OUT）：全部会话写进同一个文件、不按 sid 命名 ⇒ 面板必须靠这个标志
  //   判断"有转录"，否则「导出 LOG」按钮/菜单项恒被置灰、功能不可达。
  const outFile = process.env.LOGCOMPILER_OUT || ''
  const files = []
  try {
    for (const name of readdirSync(logsDir)) {
      const m = /^([A-Za-z0-9._-]+)\.log$/.exec(name)
      if (!m) continue
      const st = statSync(join(logsDir, name))
      files.push({ sid: m[1], file: name, bytes: st.size, updated: st.mtimeMs })
    }
    files.sort((a, b) => (b.updated || 0) - (a.updated || 0))
  } catch { /* dir 尚未创建/不可读 */ }
  return {
    control,
    mounted: !!(runtime && runtime.active === true),
    runtime,
    logsDir,
    single: !!outFile,        // true = 单文件模式（客户端据此启用导出，不依赖 files[].sid）
    outFile: outFile || null,
    files,
  }
}
// 最小防越权：exact /api/... 路由不经过 client-connection 的 loopback fence，
// 写操作要求 Host 请求头的 origin/host 属于本机（单用户本地部署姿态）。
function isLocalOrigin(req) {
  const origin = req.headers['origin'] || ''
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return false
  const host = req.headers['host'] || ''
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host.replace(/^\[.*?\]/, '')) || host === 'localhost'
}
function tuneReadOnly(db) {
  for (const p of ['busy_timeout=5000', 'cache_size=-65536', 'synchronous=NORMAL']) {
    try { db.exec('PRAGMA ' + p) } catch { /* read-only connections may reject some pragmas */ }
  }
  return db
}
function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length })
  res.end(buf)
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}
function traceTime(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return 0
  const rel = /^(\d+)([hd])$/i.exec(s)
  if (rel) return Date.now() - Number(rel[1]) * (rel[2].toLowerCase() === 'h' ? 3600_000 : 86400_000)
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? Math.min(Date.now(), n) : NaN
}
function traceCursor(raw) {
  const m = /^(\d{1,16}):(\d{1,16})$/.exec(String(raw ?? ''))
  return m ? { ts: Number(m[1]), id: Number(m[2]) } : null
}

export default {
  name: 'contextinjector-webui',
  inject: ['webServer'],
  apply(ctx) {
    const webServer = ctx.webServer
    const disposers = []
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/context-inject/status',
      handler(req, res) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const control = readControl()
        // #4：可选 ?sessionId= 返回该会话自己的最近折叠（per-session 归档优先），无则回退全局
        const want = /[?&]sessionId=([^&]+)/.exec(String(req.url || ''))
        const sid = want ? decodeURIComponent(want[1]) : null
        let lastFold = null
        let lastFoldPerSession = false
        if (sid) {
          // #4：优先该会话自己的最近折叠（per-sid）；缺失则回退全局 last-fold，
          //   避免注入面板空白（存量/新代码部署前折叠过的会话尚无 per-sid 文件；
          //   再次折叠后会写 per-sid，后续即精确跟随该会话）。
          const bare = String(sid).replace(/^session-?/i, '')
          const per = readJson(join(STATE_DIR, '.ctxinjector', 'last-fold', bare.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) + '.json'))
          lastFold = per || readJson(join(STATE_DIR, 'last-fold.json'))
          lastFoldPerSession = !!per
        } else {
          lastFold = readJson(join(STATE_DIR, 'last-fold.json'))
        }
        // 面板「最近一次折叠」头部标签：trigger 本就在 last-fold.json 内（turn-end；旧记录可能是 pre-step / turn-stopping），
        //   这里显式归一出参（非字符串 → null）——用户靠它判断"本轮结束即折"到底有没有跑过。
        lastFold = normalizeLastFold(lastFold)
        if (lastFold && typeof lastFold.trigger !== 'string') lastFold.trigger = null
        // 「上一轮输出压缩中…」在飞折叠标记（per-sid；无 ?sessionId= / 无标记 / 已陈旧 → null）。
        //   背景：turn-end 触发的是**后台**折叠，浓缩模型要跑几秒~十几秒；这段时间 lastFold
        //   还是上一轮结果，面板看起来"什么都没发生"（用户实测困惑点）。
        //   命名与插件侧 fold-inflight 写入口径完全一致（bare sid → 非法字符换 _ → 截断 120）。
        let foldInflight = null
        if (sid) {
          const bare = String(sid).replace(/^session-?/i, '')
          const m = readJson(join(STATE_DIR, '.ctxinjector', 'fold-inflight', bare.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) + '.json'))
          if (m && !isFoldInflightStale(m)) { // 10 分钟陈旧闸（见 isFoldInflightStale）
            foldInflight = {
              trigger: typeof m.trigger === 'string' ? m.trigger : null,
              startedAt: m.startedAt,
              step: (typeof m.step === 'number' && Number.isFinite(m.step)) ? m.step : null,
            }
          }
        }
        // 【无 sid 兜底】不带 ?sessionId= 时，额外上报**逐会话在飞标记全量列表**：
        //   会话页「压缩中」小标若拿不到会话 id，只靠这一项就能在"全机恰好 1 个在飞"时给出提示
        //   （多会话在飞 → 客户端不显示）。带 sid 时该字段恒为 null（per-sid 路径不与它相干，
        //   且省掉每 500ms 一次 readdir）。
        const foldInflightAll = sid ? null : listFoldInflight()
        // v1.10.39：自绘状态行（宿主折叠行已隐藏）
        const memoryInflight = sid ? readMemoryInflight(sid) : null
        const memoryLast = sid ? readMemoryLast(sid) : null
        const nativeCompaction = sid ? readNativeCompaction(sid) : null
        // 状态条 chip 与记忆面板共用同一份整理标记；chip 读的是本接口（不是 /api/memory/status），
        // 这里必须一并返回，否则「记忆整理中/已整理」永远不会出现。
        const consolidate = sid ? (() => {
          const fl = memoryFlags(control)
          const id = normSid(sid)
          return {
            auto: fl.consolidateAuto,
            idleMs: fl.consolidateIdleMs,
            manualRoute: {
              provider: typeof control?.memoryConsolidateManualProvider === 'string' && control.memoryConsolidateManualProvider ? control.memoryConsolidateManualProvider : null,
              model: typeof control?.memoryConsolidateManualModel === 'string' && control.memoryConsolidateManualModel ? control.memoryConsolidateManualModel : null,
            },
            next: readJson(memSessionFile('consolidate-next', id)),
            inflight: readConsolidateInflight(id),
            last: readJson(memSessionFile('consolidate-last', id)),
          }
        })() : null
        // #5 IVR：该会话（bare sid）的注入经济计量序列（ivr/<sid>.json）；无则 null
        let ivr = null
        if (sid) {
          const bare = String(sid).replace(/^session-?/i, '')
          ivr = readJson(join(STATE_DIR, 'ivr', bare.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) + '.json'))
        }
        sendJson(res, 200, {
          plugin: 'CONTEXTinjector-webui',
          stateDir: STATE_DIR,
          control,
          runtime: readJson(join(STATE_DIR, 'runtime.json')),
          lastFold,
          lastFoldPerSession, // true = 该会话自己的折叠结果；false 时 lastFold 只是全局回退（小标不据此显示）
          foldInflight, // 「上一轮输出压缩中…」：{ trigger, startedAt, step } | null
          foldInflightAll, // 【无 sid 兜底】不带 ?sessionId= 时 = 全机在飞标记数组（[]/1 项/多项）；带 sid 时 = null
          memoryInflight, // 「记忆编译中」：{ startedAt } | null
          memoryLast, // 最近一次记忆编译：{ t, ok, insights, through, model, reason } | null
          consolidate, // 记忆整理：{ auto, idleMs, next, inflight, last } | null（状态条 chip 数据源）
          nativeCompaction, // DSH 原生 compaction 在飞：{ startedAt } | null
          ivr,
          sessions: listSessions(),
          logcompiler: logcompilerSnapshot(), // 「日志编译」区数据源（LOGcompiler 运行时配置）
          timestamp: Date.now(),
        })
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/context-inject/config',
      handler(req, res) {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!isLocalOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        readBody(req).then((args) => {
          const cur = readControl()
          // v1.6：展开 cur 保留面板不认识的额外字段（keepInject 等）——防写回剥字段导致
          // 注入节点避让档位被无声关闭（实测：面板加白名单覆盖 control.json 后 keepInject 丢失）
          const next = {
            ...cur,
            enabled: typeof args?.enabled === 'boolean' ? args.enabled : cur.enabled,
            sessions: Array.isArray(args?.sessions) ? args.sessions.filter((x) => typeof x === 'string') : cur.sessions,
            // v1.5：AI 输出压缩档三态 off|single|double（面板开关写入；缺省保留旧值，无字段=插件默认 off）
            condense: ['off', 'single', 'double'].includes(args?.condense) ? args.condense : cur.condense,
            // A档原型：工具结果结构化折叠（[T]+[V]，toolfold；默认 OFF）。缺省保留旧值。
            toolfoldStructured: typeof args?.toolfoldStructured === 'boolean' ? args.toolfoldStructured : cur.toolfoldStructured,
            // #7 maxtokens：int|null；null=清除覆盖(用内置默认 700/或 env)。显式 set 时校验正数。
            updatedAt: Date.now(),
          }
          // #7：condenseMaxTokens 显式传 null → 删字段(回默认)；传正整数 → 设值
          if (args != null && 'condenseMaxTokens' in args) {
            const v = args.condenseMaxTokens
            if (v === null || v === '') delete next.condenseMaxTokens
            else if (typeof v === 'number' && Number.isFinite(v) && v >= 64) next.condenseMaxTokens = Math.floor(v)
          }
          // 【取自 RCS-0.1.0 返回包】condenseMinBytes：int>=0（0=不设门槛，每条 [A] 都浓缩）；
          //   null/'' 显式传 → 删字段(回内置 240)。与 condenseMaxTokens 同为插件热读字段，免重启生效。
          if (args != null && 'condenseMinBytes' in args) {
            const v = args.condenseMinBytes
            if (v === null || v === '') delete next.condenseMinBytes
            else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) next.condenseMinBytes = Math.floor(v)
          }
          // #10 自定义提示词：prompts={single?,keys?}；single/keys 为 ''/null 表示清除该字段(用内置默认)
          if (args != null && 'prompts' in args) {
            const pr = args.prompts
            if (pr === null) delete next.prompts
            else if (pr && typeof pr === 'object') {
              const curP = (next.prompts && typeof next.prompts === 'object') ? next.prompts : {}
              const np = { ...curP }
              if ('single' in pr) { const s = pr.single; if (typeof s === 'string' && s.trim()) np.single = s.trim(); else delete np.single }
              if ('keys' in pr) { const k = pr.keys; if (typeof k === 'string' && k.trim()) np.keys = k.trim(); else delete np.keys }
              if (Object.keys(np).length) next.prompts = np; else delete next.prompts
            }
          }
          // v1.8 浓缩模型（全局覆盖）：显式 provider/model 优先于"跟随会话模型"；
          // 传 null/'' 表示清除覆盖（回到跟随会话）。二者必须成对，否则忽略（避免半配置）。
          const hasP = args != null && 'condenseProvider' in args
          const hasM = args != null && 'condenseModel' in args
          if (hasP && hasM) {
            const p = args.condenseProvider
            const mm = args.condenseModel
            if (p === null || p === '' || mm === null || mm === '') {
              delete next.condenseProvider
              delete next.condenseModel
            } else {
              next.condenseProvider = String(p)
              next.condenseModel = String(mm)
            }
          }
          const ok = writeJson(CONTROL_FILE, next)
          sendJson(res, ok ? 200 : 500, { ok, config: readControl() })
        })
      },
    }))
    // v1.7：本会话档位写入（composer「压缩模式」选择器；首轮发送前即可选定）。
    // mode: off|single|double = 启用折叠并设该会话档；none = 移出白名单（本会话不折叠）。
    // 与 /config 同为原子读改写：展开 cur 保留未知字段（v1.6 keepInject 被剥的教训）。
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/context-inject/session',
      handler(req, res) {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!isLocalOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        readBody(req).then((args) => {
          const sid = String(args?.sessionId ?? '').trim()
          const mode = String(args?.mode ?? '').trim()
          if (!sid) { sendJson(res, 400, { ok: false, error: 'missing-sessionId' }); return }
          if (!['off', 'single', 'double', 'none'].includes(mode)) { sendJson(res, 400, { ok: false, error: 'bad-mode' }); return }
          const cur = readControl() ?? { enabled: false, sessions: [], updatedAt: null }
          const next = { ...cur }
          const n = normSid(sid)
          const list = (Array.isArray(cur.sessions) ? cur.sessions : []).filter((x) => typeof x === 'string')
          const modes = { ...(cur.sessionModes && typeof cur.sessionModes === 'object' ? cur.sessionModes : {}) }
          // 键形式沿用既有记录（session-<uuid> ↔ uuid 视为同一会话），避免重复选档时键名漂移、
          // 与白名单里保留的形式分裂（离线自检发现的问题，纯审计可读性）
          let key = sid
          for (const k of Object.keys(modes)) {
            if (normSid(k) === n) { key = k; delete modes[k] }
          }
          if (mode === 'none') {
            next.sessions = list.filter((x) => normSid(x) !== n)
          } else {
            next.enabled = true
            if (!list.some((x) => normSid(x) === n)) next.sessions = list.concat(sid)
            modes[key] = mode
          }
          next.sessionModes = modes
          next.updatedAt = Date.now()
          const ok = writeJson(CONTROL_FILE, next)
          sendJson(res, ok ? 200 : 500, { ok, sessionId: sid, mode, config: readControl() })
        })
      },
    }))
    // v1.8：浓缩模型目录 —— 列出 DSH 已注册的 provider/model，供面板下拉选择。
    // llm 服务**软取**（webui 是独立插件；硬 inject 会在服务缺失时令插件 PENDING 且不报错）。
    // ?provider=<id> 时返回该 provider 的模型列表（listModels 可能是网络调用，故按需拉取）。
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/context-inject/models',
      handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
        const control = readControl()
        const current = {
          provider: typeof control?.condenseProvider === 'string' ? control.condenseProvider : null,
          model: typeof control?.condenseModel === 'string' ? control.condenseModel : null,
        }
        if (!llm) { sendJson(res, 200, { ok: true, llmAvailable: false, providers: [], models: [], current }); return }
        const sendModels = (p) => Promise.resolve()
          .then(() => llm.listModels(p))
          .then((ms) => {
            const models = (ms ?? []).map((m) => (typeof m === 'string' ? { id: m } : { id: m?.id, name: m?.name })).filter((m) => !!m.id)
            sendJson(res, 200, { ok: true, llmAvailable: true, provider: p, models, current })
          })
          .catch((err) => sendJson(res, 200, { ok: false, llmAvailable: true, provider: p, models: [], current, error: String(err?.message ?? err) }))
        // 模型列表接受 GET(?provider=) 与 POST(body {provider}) 两种：
        // query 解析在个别路由/代理下可能不可靠，多一条通道不影响正确性。
        if (req.method === 'POST') {
          readBody(req).then((args) => {
            const p = String(args?.provider ?? '').trim()
            if (!p) { sendJson(res, 400, { ok: false, error: 'missing-provider' }); return }
            sendModels(p)
          })
          return
        }
        const q = String(req.url || '')
        const pm = /[?&]provider=([^&]+)/.exec(q)
        if (pm) { sendModels(decodeURIComponent(pm[1])); return }
        let providers = []
        try {
          providers = (llm.listProviders?.() ?? []).map((p) => (typeof p === 'string' ? { id: p, name: p } : { id: p?.id, name: p?.name || p?.id })).filter((p) => !!p.id)
        } catch (err) {
          providers = []
        }
        sendJson(res, 200, { ok: true, llmAvailable: true, providers, models: [], current })
      },
    }))
    // LOGcompiler「导出 LOG」：面板里右键会话（或「当前会话」卡片上的按钮）→ 下载该会话的转录文件（只读）
    //   GET /api/logcompiler/export?sid=<sessionId|bare-id>&full=0
    //   · 文件名按插件同规则归一（normKey）⇒ 不可能越出 logsDir；
    //   · 单文件模式（LOGCOMPILER_OUT）下导出那个文件；
    //   · **默认导出完整转录**：插件超 ROTATE_BYTES(默认 ~1MB) 会把当前段 rename 成 <file>.<n>
    //     （n 越大越新）⇒ 按 .log.1 … .log.<maxN> + 当前段顺序拼接，避免长会话被静默截断；
    //     `full=0` 退回"仅当前段"（排查用）。
    //   · 没有转录文件 → 404 JSON（面板据此把菜单项/按钮置灰并说明原因）。
    //   【取自 RCS-0.1.0 返回包；轮转段与单文件标志为本地补强 2026-09-10】
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/logcompiler/export',
      handler(req, res) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const url = String(req.url || '')
        const m = /[?&]sid=([^&]+)/.exec(url)
        const raw = m ? decodeURIComponent(m[1]) : ''
        if (!String(raw).trim()) { sendJson(res, 400, { ok: false, error: 'bad-sid' }); return }
        const full = !/[?&]full=0(&|$)/.test(url)
        const outFile = process.env.LOGCOMPILER_OUT || ''
        const name = outFile ? 'global.log' : lgKey(raw) + '.log'
        const file = outFile || join(lgLogsDir(), name)
        // 轮转段（仅按会话分文件模式有意义；单文件模式由操作者自管）
        const segs = []
        if (!outFile && full) {
          let maxN = 0
          while (existsSync(file + '.' + (maxN + 1))) maxN += 1
          for (let i = 1; i <= maxN; i++) segs.push(file + '.' + i) // 升序 = 时间顺序（.1 最旧）
        }
        segs.push(file)
        const chunks = []
        for (const f of segs) {
          try { chunks.push(readFileSync(f)) } catch { /* 段不存在则跳过 */ }
        }
        if (!chunks.length) { sendJson(res, 404, { ok: false, error: 'no-log', sid: raw, dir: dirname(file) }); return }
        const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': buf.length,
          'content-disposition': `attachment; filename="${name}"`,
          'cache-control': 'no-store',
          'x-logcompiler-segments': String(chunks.length),
        })
        res.end(buf)
      },
    }))
    // LOGcompiler「日志编译」区配置写入（与插件 logcompiler.mjs 同文件，运行时生效免重启）：
    //   { enabled?:bool, logsDir?:string|null(清除=内部默认), sessionId?+on?:bool(会话记录开关) }
    // 原子读改写 + 保留未知字段；会话键做前缀归一，on=true 或缺省 ⇒ 记录（默认全开），on=false ⇒ 显式关。
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/logcompiler/config',
      handler(req, res) {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!isLocalOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        readBody(req).then((args) => {
          const cur = readJson(LG_CONTROL_FILE) ?? {}
          const next = { ...cur }
          if (typeof args?.enabled === 'boolean') next.enabled = args.enabled
          if (args && 'logsDir' in args) {
            const v = typeof args.logsDir === 'string' ? args.logsDir.trim() : ''
            if (v) next.logsDir = v; else delete next.logsDir
          }
          const sid = String(args?.sessionId ?? '').trim()
          if (sid && 'on' in args) {
            const sm = { ...(next.sessions && typeof next.sessions === 'object' ? next.sessions : {}) }
            const n = normSid(sid)
            for (const k of Object.keys(sm)) { if (normSid(k) === n) delete sm[k] } // 键归一防重复
            if (args.on === false) sm[sid] = false // 显式关（on=true/缺省 ⇒ 记录，不写键）
            next.sessions = sm
          }
          next.updatedAt = Date.now()
          const ok = writeJson(LG_CONTROL_FILE, next)
          sendJson(res, ok ? 200 : 500, { ok, config: readJson(LG_CONTROL_FILE) })
        })
      },
    }))
    // MEMORY「外部记忆」区：只读快照（SQLite 以 readOnly 打开）+ 三个开关的热写。
    //   与 memory.mjs 共用 control.json；环境变量仍是硬覆盖（面板会标出 effective 值）。
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/memory/status',
      handler(req, res) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const m = /[?&]sessionId=([^&]+)/.exec(String(req.url || ''))
        const sid = m ? decodeURIComponent(m[1]) : null
        const rm = /[?&]range=([^&]+)/.exec(String(req.url || ''))
        let range = null
        try { range = rm ? decodeURIComponent(rm[1]) : null } catch { range = null }
        const lm = /[?&]factLimit=([^&]+)/.exec(String(req.url || ''))
        const fm = /[?&]focusScope=([^&]+)/.exec(String(req.url || ''))
        const sm = /[?&]sinceTs=([^&]+)/.exec(String(req.url || ''))
        const cm = /[?&]cursor=([^&]+)/.exec(String(req.url || ''))
        let factLimit = null
        let focusScope = null
        let sinceTs = null
        let cursor = null
        try { factLimit = lm ? Number(decodeURIComponent(lm[1])) : null } catch { factLimit = null }
        try { focusScope = fm ? decodeURIComponent(fm[1]) : null } catch { focusScope = null }
        try { sinceTs = sm ? Number(decodeURIComponent(sm[1])) : null } catch { sinceTs = null }
        try { cursor = cm ? decodeURIComponent(cm[1]) : null } catch { cursor = null }
        memorySnapshot(sid, { range, factLimit, focusScope, sinceTs, cursor }).then((snap) => sendJson(res, 200, { ok: true, plugin: 'MEMORY-webui', ...snap }))
          .catch((err) => sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }))
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/memory/graph',
      handler(req, res) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const m = /[?&]sessionId=([^&]+)/.exec(String(req.url || ''))
        const sid = m ? decodeURIComponent(m[1]) : null
        const rm = /[?&]range=([^&]+)/.exec(String(req.url || ''))
        let range = null
        try { range = rm ? decodeURIComponent(rm[1]) : null } catch { range = null }
        const lm = /[?&]factLimit=([^&]+)/.exec(String(req.url || ''))
        const fm = /[?&]focusScope=([^&]+)/.exec(String(req.url || ''))
        const sm = /[?&]sinceTs=([^&]+)/.exec(String(req.url || ''))
        const cm = /[?&]cursor=([^&]+)/.exec(String(req.url || ''))
        let factLimit = null
        let focusScope = null
        let sinceTs = null
        let cursor = null
        try { factLimit = lm ? Number(decodeURIComponent(lm[1])) : null } catch { factLimit = null }
        try { focusScope = fm ? decodeURIComponent(fm[1]) : null } catch { focusScope = null }
        try { sinceTs = sm ? Number(decodeURIComponent(sm[1])) : null } catch { sinceTs = null }
        try { cursor = cm ? decodeURIComponent(cm[1]) : null } catch { cursor = null }
        memoryGraph(sid, { range, factLimit, focusScope, sinceTs, cursor }).then((g) => sendJson(res, 200, { ok: true, plugin: 'MEMORY-webui', ...g }))
          .catch((err) => sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }))
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/memory/evidence',
      handler(req, res) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        let scope = ''
        let key = ''
        try {
          const sm = /[?&]scope=([^&]+)/.exec(String(req.url || ''))
          const km = /[?&]key=([^&]+)/.exec(String(req.url || ''))
          scope = sm ? decodeURIComponent(sm[1]) : ''
          key = km ? decodeURIComponent(km[1]) : ''
        } catch { sendJson(res, 400, { ok: false, error: 'bad-encoding' }); return }
        memoryEvidence(scope, key)
          .then((ev) => sendJson(res, ev.error === 'bad-request' ? 400 : 200, { ok: !ev.error, plugin: 'MEMORY-webui', ...ev }))
          .catch((err) => sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }))
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/memory/metrics',
      handler(req, res) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        try {
          const metricsFile = join(STATE_DIR, '.memory', 'metrics.json')
          if (!existsSync(metricsFile)) {
            sendJson(res, 200, { ok: true, plugin: 'MEMORY-webui', metrics: null, message: 'no metrics yet' })
            return
          }
          const metrics = JSON.parse(readFileSync(metricsFile, 'utf8'))
          sendJson(res, 200, { ok: true, plugin: 'MEMORY-webui', metrics })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }))
    // Phase 4：检索轨迹。列表/详情/导出/清除都要求本机来源（轨迹含 query 文本）。
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/memory/traces',
      handler(req, res) {
        if (!isLocalOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        let u = null
        try { u = new URL(String(req.url || ''), 'http://localhost') } catch { sendJson(res, 400, { ok: false, error: 'bad-request' }); return }
        const sid = normSid(u.searchParams.get('sessionId') || '').slice(0, 120)
        if (!sid) { sendJson(res, 400, { ok: false, error: 'missing-sessionId' }); return }
        const since = traceTime(u.searchParams.get('since'))
        const until = traceTime(u.searchParams.get('until'))
        if (Number.isNaN(since) || Number.isNaN(until) || (since && until && since > until)) {
          sendJson(res, 400, { ok: false, error: 'bad-range' }); return
        }
        const trigger = String(u.searchParams.get('trigger') || '')
        if (trigger && !TRACE_TRIGGERS.has(trigger)) { sendJson(res, 400, { ok: false, error: 'bad-trigger' }); return }
        const cursorRaw = u.searchParams.get('cursor')
        const cursor = traceCursor(cursorRaw)
        if (cursorRaw && !cursor) { sendJson(res, 400, { ok: false, error: 'bad-cursor' }); return }
        const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit')) || 50))
        const out = listTraces(TRACE_DB, { sid, since, until, limit, cursor, trigger })
        sendJson(res, 200, { ok: true, plugin: 'MEMORY-webui', sessionId: sid, ...out })
      },
    }))
    disposers.push(webServer.register({
      kind: 'prefix',
      // 前缀必须以路径段结尾：宿主匹配规则是 pathname === prefix 或 startsWith(prefix + '/')，
      // 旧值 '/api/memory/traces/' 会要求 '/api/memory/traces//…' ⇒ 详情路由永远落到宿主的
      // 纯文本 404（面板显示 Unexpected token 'o', "not found"）。列表仍由上面的 exact 路由承接。
      path: '/api/memory/traces',
      handler(req, res) {
        if (!isLocalOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        let u = null
        try { u = new URL(String(req.url || ''), 'http://localhost') } catch { sendJson(res, 400, { ok: false, error: 'bad-request' }); return }
        const suffix = decodeURIComponent(u.pathname.slice('/api/memory/traces/'.length).replace(/\/+$/, ''))
        if (suffix === 'clear') {
          if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
          readBody(req).then((args) => {
            const sid = normSid(args?.sessionId).slice(0, 120)
            if (!sid) { sendJson(res, 400, { ok: false, error: 'missing-sessionId' }); return }
            const r = clearTraces(TRACE_DB, sid)
            sendJson(res, r.ok ? 200 : 500, { ok: r.ok, plugin: 'MEMORY-webui', deleted: r.deleted })
          })
          return
        }
        if (suffix === 'export') {
          if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
          const sid = normSid(u.searchParams.get('sessionId') || '').slice(0, 120)
          if (!sid) { sendJson(res, 400, { ok: false, error: 'missing-sessionId' }); return }
          const since = traceTime(u.searchParams.get('since'))
          const until = traceTime(u.searchParams.get('until'))
          if (Number.isNaN(since) || Number.isNaN(until) || (since && until && since > until)) {
            sendJson(res, 400, { ok: false, error: 'bad-range' }); return
          }
          const format = String(u.searchParams.get('format') || 'jsonl').toLowerCase()
          const out = exportTraces(TRACE_DB, { sid, since, until, limit: 5000 })
          const body = format === 'json'
            ? JSON.stringify({ ok: true, plugin: 'MEMORY-webui', available: out.available, traces: out.rows }, null, 2)
            : out.rows.map((r) => JSON.stringify(r)).join('\n')
          const buf = Buffer.from(body + (body ? '\n' : ''))
          const safe = sid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
          res.writeHead(200, {
            'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
            'content-length': buf.length,
            'content-disposition': `attachment; filename="rcs-traces-${safe}.${format === 'json' ? 'json' : 'jsonl'}"`,
            'cache-control': 'no-store',
          })
          res.end(buf)
          return
        }
        if (!/^\d+$/.test(suffix)) { sendJson(res, 404, { ok: false, error: 'not-found' }); return }
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const id = Number(suffix)
        const out = getTrace(TRACE_DB, id)
        if (!out.available) { sendJson(res, 200, { ok: true, plugin: 'MEMORY-webui', available: false, trace: null }); return }
        if (!out.trace) { sendJson(res, 404, { ok: false, error: 'not-found' }); return }
        sendJson(res, 200, { ok: true, plugin: 'MEMORY-webui', ...out })
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/memory/consolidate',
      handler(req, res) {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!isLocalOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        readBody(req).then((args) => {
          const sid = normSid(args?.sessionId)
          if (!sid) { sendJson(res, 400, { ok: false, error: 'missing-sessionId' }); return }
          const dir = join(STATE_DIR, '.memory', 'consolidate-request')
          try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
          const ok = writeJson(join(dir, sid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) + '.json'), { sessionId: sid, at: Date.now() })
          sendJson(res, ok ? 202 : 500, { ok, queued: ok })
        })
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/memory/janitor',
      handler(req, res) {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!isLocalOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        readBody(req).then((args) => {
          const sid = normSid(args?.sessionId)
          if (!sid) { sendJson(res, 400, { ok: false, error: 'missing-sessionId' }); return }
          const workspace = typeof args?.workspace === 'string' ? args.workspace.trim().slice(0, 500) : ''
          const dir = join(STATE_DIR, '.memory', 'janitor-request')
          try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
          const file = join(dir, sid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) + '.json')
          const ok = writeJson(file, { sessionId: sid, workspace: workspace || undefined, at: Date.now() })
          sendJson(res, ok ? 202 : 500, { ok, queued: ok })
        })
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/memory/config',
      handler(req, res) {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!isLocalOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        readBody(req).then((args) => {
          const cur = readControl()
          const next = { ...cur }
          for (const k of ['memoryEnabled', 'memoryLlmEnabled', 'memoryInjectCatalog', 'memoryHandoff', 'memoryConsolidateAuto', 'memoryTrace', 'memoryJanitorEnabled']) {
            if (typeof args?.[k] === 'boolean') next[k] = args[k]
          }
          if ('memoryConsolidateIdleMs' in (args ?? {})) {
            const n = Number(args.memoryConsolidateIdleMs)
            if (Number.isFinite(n) && n > 0) next.memoryConsolidateIdleMs = Math.max(60_000, Math.min(24 * 3600_000, n))
            else delete next.memoryConsolidateIdleMs
          }
          if ('memoryJanitorIntervalMs' in (args ?? {})) {
            const n = Number(args.memoryJanitorIntervalMs)
            if (Number.isFinite(n) && n > 0) next.memoryJanitorIntervalMs = Math.max(60_000, Math.min(24 * 3600_000, n))
            else delete next.memoryJanitorIntervalMs
          }
          // 巡检独立路由：成对写入；空 = 回退到自动整理/编译路由。
          const touchedJanitorRoute = args != null && ('memoryJanitorProvider' in args || 'memoryJanitorModel' in args)
          if (touchedJanitorRoute) {
            const p = typeof args?.memoryJanitorProvider === 'string' ? args.memoryJanitorProvider.trim() : ''
            const m = typeof args?.memoryJanitorModel === 'string' ? args.memoryJanitorModel.trim() : ''
            if (p && m) { next.memoryJanitorProvider = p; next.memoryJanitorModel = m }
            else { delete next.memoryJanitorProvider; delete next.memoryJanitorModel }
          }
          // 编译模型覆盖：两者必须成对；null/空串 = 清除覆盖（回退到会话当前模型）。
          const touchedRoute = args != null && ('memoryLlmProvider' in args || 'memoryLlmModel' in args)
          if (touchedRoute) {
            const p = typeof args?.memoryLlmProvider === 'string' ? args.memoryLlmProvider.trim() : ''
            const m = typeof args?.memoryLlmModel === 'string' ? args.memoryLlmModel.trim() : ''
            if (p && m) { next.memoryLlmProvider = p; next.memoryLlmModel = m }
            else { delete next.memoryLlmProvider; delete next.memoryLlmModel }
          }
          // 手动整理独立路由：两者必须成对；空 = 回退到会话/编译模型。自动整理永远不用它。
          const touchedManualRoute = args != null && ('memoryConsolidateManualProvider' in args || 'memoryConsolidateManualModel' in args)
          if (touchedManualRoute) {
            const p = typeof args?.memoryConsolidateManualProvider === 'string' ? args.memoryConsolidateManualProvider.trim() : ''
            const m = typeof args?.memoryConsolidateManualModel === 'string' ? args.memoryConsolidateManualModel.trim() : ''
            if (p && m) { next.memoryConsolidateManualProvider = p; next.memoryConsolidateManualModel = m }
            else { delete next.memoryConsolidateManualProvider; delete next.memoryConsolidateManualModel }
          }
          next.updatedAt = Date.now()
          const ok = writeJson(CONTROL_FILE, next)
          const ctrlNow = readControl()
          sendJson(res, ok ? 200 : 500, {
            ok,
            flags: memoryFlags(ctrlNow),
            llmRoute: {
              provider: typeof ctrlNow?.memoryLlmProvider === 'string' && ctrlNow.memoryLlmProvider ? ctrlNow.memoryLlmProvider : null,
              model: typeof ctrlNow?.memoryLlmModel === 'string' && ctrlNow.memoryLlmModel ? ctrlNow.memoryLlmModel : null,
            },
            consolidateManualRoute: {
              provider: typeof ctrlNow?.memoryConsolidateManualProvider === 'string' && ctrlNow.memoryConsolidateManualProvider ? ctrlNow.memoryConsolidateManualProvider : null,
              model: typeof ctrlNow?.memoryConsolidateManualModel === 'string' && ctrlNow.memoryConsolidateManualModel ? ctrlNow.memoryConsolidateManualModel : null,
            },
            janitorRoute: routePairOf(ctrlNow?.memoryJanitorProvider, ctrlNow?.memoryJanitorModel),
            envLocked: envLockOf(),
          })
        })
      },
    }))
    ctx.effect(() => () => { for (const d of disposers) d() })
    console.log(`[contextinjector-webui] /api/context-inject/{status,config,session} + /api/logcompiler/{config,export} + /api/memory/{status,config,consolidate,janitor,metrics,traces} ready (stateDir=${STATE_DIR})`)
  },
}
