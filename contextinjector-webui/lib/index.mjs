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

// v1.8 可移植：不硬编码本机路径。DSH_HOME 由启动器注入；缺省回落 ~/.dsh（与插件侧同规则，
// 二者必须一致，否则面板读不到 control.json）。显式 env 仍最高优先。
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = process.env.DSH_CONTEXTINJECTOR_STATE_DIR || join(DSH_HOME, 'state-compiler')
const SESSIONS_DIR = join(STATE_DIR, '..', 'sessions')
const CONTROL_FILE = join(STATE_DIR, 'control.json')
// LOGcompiler 运行时配置（与插件 logcompiler.mjs 同区、同文件读写 —— WebUI "同步设置"的中枢）
const LG_CONTROL_FILE = join(STATE_DIR, 'logcompiler.control.json')
const LG_RUNTIME_FILE = join(STATE_DIR, 'logcompiler.runtime.json')
// MEMORY 面板数据源（与 web/memory.mjs 同规则：env 优先，否则 state-compiler/memory）
const MEM_DB = process.env.DSH_MEMORY_DB || join(STATE_DIR, 'memory', 'memory.sqlite')

mkdirSync(STATE_DIR, { recursive: true })

// node:sqlite 懒加载：Node < 22.5 无此模块时面板降级为"不可用"，绝不影响其余端点。
let _sqlitePromise = null
function sqliteModule() {
  if (_sqlitePromise === null) _sqlitePromise = import('node:sqlite').catch(() => null)
  return _sqlitePromise
}
const truthy = (v) => v === true || v === '1'
function memoryFlags(control, env = process.env) {
  return {
    enabled: env.DSH_MEMORY === '0' ? false : (truthy(env.DSH_MEMORY) || control.memoryEnabled === true),
    llmEnabled: env.DSH_MEMORY_LLM === '0' ? false : (truthy(env.DSH_MEMORY_LLM) || control.memoryLlmEnabled === true),
    injectCatalog: env.DSH_MEMORY_INJECT === '0' ? false : control.memoryInjectCatalog !== false,
  }
}
// 环境变量是否真的把某一项钉死（与 web/memory.mjs 的解析同口径）：
//   DSH_MEMORY / DSH_MEMORY_LLM 只认 '0'|'1'；DSH_MEMORY_INJECT 只认 '0'（'1' 不构成强制，默认本就为开）。
//   其余取值视为未设置，面板仍可写 control.json。
function envLockOf(env = process.env) {
  return {
    enabled: env.DSH_MEMORY === '0' || env.DSH_MEMORY === '1',
    llmEnabled: env.DSH_MEMORY_LLM === '0' || env.DSH_MEMORY_LLM === '1',
    injectCatalog: env.DSH_MEMORY_INJECT === '0',
  }
}
// 只读快照：任何一步失败都返回已有结构 + error，面板不空白。
async function memorySnapshot(sessionId = null) {
  const control = readControl()
  const out = {
    flags: memoryFlags(control),
    db: { path: MEM_DB, exists: existsSync(MEM_DB), bytes: 0 },
    totals: { active: 0, resolved: 0, insights: 0, errors: 0, workspaces: 0 },
    kinds: [], workspaces: [], insights: [], recent: [],
    compile: { cursors: 0, last: null },
    // 轻 LLM 编译的显式路由覆盖（control.memoryLlmProvider/Model）；两者都空 = 跟随会话模型。
    llmRoute: {
      provider: typeof control?.memoryLlmProvider === 'string' && control.memoryLlmProvider ? control.memoryLlmProvider : null,
      model: typeof control?.memoryLlmModel === 'string' && control.memoryLlmModel ? control.memoryLlmModel : null,
    },
    inflight: sessionId ? readMemoryInflight(sessionId) : null,
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
    db = new sq.DatabaseSync(MEM_DB, { readOnly: true })
    out.sqlite = true
    const one = (sql, ...args) => { try { return db.prepare(sql).get(...args) } catch { return null } }
    const all = (sql, ...args) => { try { return db.prepare(sql).all(...args) } catch { return [] } }
    const armed = one("SELECT value FROM meta WHERE key='armedPid'")
    const armedAt = one("SELECT value FROM meta WHERE key='armedAt'")
    // pid 可能被重启后的进程复用：再要求 armedAt 不早于本进程启动（留 5s 装载余量）。
    const procStart = Date.now() - process.uptime() * 1000
    out.armed = armed != null && Number(armed.value) === process.pid
      && armedAt != null && Number(armedAt.value) >= procStart - 5000
    const active = Number(one("SELECT COUNT(*) n FROM records WHERE status='active'")?.n ?? 0)
    const resolved = Number(one("SELECT COUNT(*) n FROM records WHERE status='resolved'")?.n ?? 0)
    out.totals.active = active
    out.totals.resolved = resolved
    out.totals.insights = Number(one("SELECT COUNT(*) n FROM records WHERE kind='insight' AND status='active'")?.n ?? 0)
    out.totals.errors = Number(one("SELECT COUNT(*) n FROM records WHERE kind='error' AND status='active'")?.n ?? 0)
    out.totals.workspaces = Number(one("SELECT COUNT(DISTINCT scope) n FROM records WHERE scope LIKE 'ws:%'")?.n ?? 0)
    out.kinds = all("SELECT kind, COUNT(*) n FROM records WHERE status='active' GROUP BY kind ORDER BY n DESC")
      .map((r) => ({ kind: String(r.kind), n: Number(r.n) }))
    out.workspaces = all("SELECT scope, COUNT(*) n, MAX(updated_ts) last FROM records GROUP BY scope ORDER BY last DESC LIMIT 8")
      .map((r) => ({ scope: String(r.scope), n: Number(r.n), last: Number(r.last) }))
    out.insights = all("SELECT key, value, scope, updated_ts FROM records WHERE kind='insight' AND status='active' ORDER BY updated_ts DESC LIMIT 20")
      .map((r) => {
        let v = {}
        try { v = JSON.parse(r.value) } catch { /* keep empty */ }
        return {
          key: String(r.key), summary: String(v.summary ?? ''), confidence: Number(v.confidence ?? 0),
          model: v.model ?? null, scope: String(r.scope), updated_ts: Number(r.updated_ts),
          evidence: Array.isArray(v.evidence) ? v.evidence.length : 0,
          evidenceIds: Array.isArray(v.evidence) ? v.evidence.slice(-8).map(Number) : [],
        }
      })
    out.recent = all("SELECT kind, key, status, scope, updated_ts FROM records ORDER BY updated_ts DESC LIMIT 15")
      .map((r) => ({ kind: String(r.kind), key: String(r.key), status: String(r.status), scope: String(r.scope), updated_ts: Number(r.updated_ts) }))
    out.compile.cursors = Number(one("SELECT COUNT(*) n FROM meta WHERE key LIKE 'compiledThrough:%'")?.n ?? 0)
    const last = one("SELECT key, value FROM meta WHERE key LIKE 'llmThrough:%' ORDER BY CAST(value AS INTEGER) DESC LIMIT 1")
    out.compile.last = last ? { sid: String(last.key).replace(/^llmThrough:/, ''), through: Number(last.value) } : null
    if (sessionId) {
      const sid = normSid(sessionId)
      out.session = {
        sid,
        records: Number(one('SELECT COUNT(*) n FROM records WHERE sid=?', sid)?.n ?? 0),
        turns: Number(one("SELECT COUNT(*) n FROM records WHERE sid=? AND kind='user_turn'", sid)?.n ?? 0),
        injected: Number(one("SELECT COUNT(*) n FROM meta WHERE key=?", 'injected:' + sid)?.n ?? 0) > 0,
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

// 【在飞折叠】「上一轮输出压缩中…」的陈旧闸：后台折叠在飞时进程崩溃会留下孤儿标记文件。
//   超过该时长一律按"没有在飞折叠"上报 —— 绝不让面板永久显示"压缩中"（用户看不到就会以为卡死）。
const FOLD_INFLIGHT_TTL_MS = 10 * 60 * 1000
// 陈旧判定（纯函数，便于单测/复用）：startedAt 非有限数（损坏/缺字段）或年龄 > TTL ⇒ 视为陈旧。
export function isFoldInflightStale(marker, now = Date.now(), ttlMs = FOLD_INFLIGHT_TTL_MS) {
  const t0 = marker ? marker.startedAt : null
  if (typeof t0 !== 'number' || !Number.isFinite(t0)) return true
  return now - t0 > ttlMs
}
// 会话 id 归一（与 contextinjector.mjs 的 normSessionId 同规则：目录名 session-<uuid> ↔ 运行时 uuid）
const normSid = (s) => String(s ?? '').replace(/^session-?/i, '')
const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
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
        memorySnapshot(sid).then((snap) => sendJson(res, 200, { ok: true, plugin: 'MEMORY-webui', ...snap }))
          .catch((err) => sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }))
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
          for (const k of ['memoryEnabled', 'memoryLlmEnabled', 'memoryInjectCatalog']) {
            if (typeof args?.[k] === 'boolean') next[k] = args[k]
          }
          // 编译模型覆盖：两者必须成对；null/空串 = 清除覆盖（回退到会话当前模型）。
          const touchedRoute = args != null && ('memoryLlmProvider' in args || 'memoryLlmModel' in args)
          if (touchedRoute) {
            const p = typeof args?.memoryLlmProvider === 'string' ? args.memoryLlmProvider.trim() : ''
            const m = typeof args?.memoryLlmModel === 'string' ? args.memoryLlmModel.trim() : ''
            if (p && m) { next.memoryLlmProvider = p; next.memoryLlmModel = m }
            else { delete next.memoryLlmProvider; delete next.memoryLlmModel }
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
            envLocked: envLockOf(),
          })
        })
      },
    }))
    ctx.effect(() => () => { for (const d of disposers) d() })
    console.log(`[contextinjector-webui] /api/context-inject/{status,config,session} + /api/logcompiler/{config,export} + /api/memory/{status,config} ready (stateDir=${STATE_DIR})`)
  },
}
