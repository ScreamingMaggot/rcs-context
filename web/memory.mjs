// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// memory.mjs — 外部记忆（第一切片：确定性抽取 + SQLite + 只读查询工具）
//
// 设计前提（2026-10-21 真实状态普查）：
//   · 折叠默认关，88 个真实会话只有 33 个折过；把记忆编译挂在 fold 提交上最多覆盖 37.5%。
//     ⇒ 写源是 session/event，自带 compiledThrough 游标；折叠只是同一事件流上的另一个消费者。
//   · 可复用事实主要在 [T] 的结构化字段（size/sha8/lines/cmd/exit/pattern/...），
//     [V] 只是错误/答复补充。故本层复用 toolfold.foldOne + parseRow，不另写解析器。
//   · raw 的 user 消息 93.5% 是注入噪音 ⇒ 只收 classifyMessageSource 判定为真人轮的 user/message。
//   · 每条记录带 (sid, seq, callId) 指针；events 追加、records 是当前视图、meta 存游标。
//   · 零 LLM、只读工具、失败开放：任何一步失败都不影响主会话或折叠。
//
// 开关：DSH_MEMORY=1 或 control.json { memoryEnabled: true }；默认关。
// 数据：$STATE_DIR/memory/memory.sqlite（memoryEnabled 打开后创建）。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { foldOne, parseRow } from '../toolfold/toolfold.mjs'
import { classifyUserMessage } from '../condense/chunk.mjs'

let DatabaseSync = null
try { ({ DatabaseSync } = await import('node:sqlite')) } catch { /* Node < 22.5: layer stays off */ }

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = process.env.DSH_CONTEXTINJECTOR_STATE_DIR || join(DSH_HOME, 'state-compiler')
const MEMORY_DIR = join(STATE_DIR, 'memory')
const DB_FILE = process.env.DSH_MEMORY_DB || join(MEMORY_DIR, 'memory.sqlite')
// v1.10.39：编译状态标记（WebUI 自绘「记忆编译中」脉冲 /「记忆 +N」）。
//   与折叠的 fold-inflight 同款语义：开始时写、finally 删；last 文件留最近一次结果。
const COMPILE_INFLIGHT_DIR = join(STATE_DIR, '.memory', 'compile-inflight')
const COMPILE_LAST_DIR = join(STATE_DIR, '.memory', 'compile-last')
function markCompileStart(sid) {
  try {
    mkdirSync(COMPILE_INFLIGHT_DIR, { recursive: true })
    writeFileSync(join(COMPILE_INFLIGHT_DIR, sid + '.json'), JSON.stringify({ sessionId: sid, startedAt: Date.now() }) + '\n', 'utf8')
  } catch { /* 观测面：绝不影响编译 */ }
}
function markCompileEnd(sid) {
  try { rmSync(join(COMPILE_INFLIGHT_DIR, sid + '.json'), { force: true }) } catch { /* ignore */ }
}
function markCompileLast(sid, r) {
  try {
    mkdirSync(COMPILE_LAST_DIR, { recursive: true })
    writeFileSync(join(COMPILE_LAST_DIR, sid + '.json'), JSON.stringify({
      t: Date.now(), ok: r?.ok === true, insights: r?.insights ?? 0, through: r?.through ?? null,
      model: r?.model ?? null, reason: r?.reason ?? null,
    }) + '\n', 'utf8')
  } catch { /* ignore */ }
}
const RAW_DIR = join(STATE_DIR, '.ctxinjector', 'raw')
const CAP_USER_TEXT = 4000

const sha1 = (s) => createHash('sha1').update(String(s ?? '')).digest('hex')
const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
const normSid = (s) => String(s ?? '').replace(/^session-?/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown'
const cap = (s, n) => { const t = String(s ?? ''); return { text: t.slice(0, n), truncated: t.length > n, bytes: t.length } }
const firstLine = (s) => String(s ?? '').split('\n')[0] ?? ''
// [T] 的 head/tail/matches 经过 parseRow 的通用反斜杠反转义，换行会变成 n；
// 记忆层额外留一份原样 preview，精确值仍以 raw 指针为准。
const previewOf = (s, n = 2000) => { const c = cap(s, n); return { preview: c.text, previewTruncated: c.truncated } }

export function normPath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/\//, '/')
}
const keyOfPath = (p) => 'file:' + normPath(p).toLowerCase()

// ── 作用域 ─────────────────────────────────────────────────────────────
// 项目事实（文件/命令/搜索/错误/任务/回答）按工作区共享：同一个 cwd 的多个会话
// 看到同一份当前视图；用户轮次属于会话上下文，仍按 sid 隔离。没有 cwd 时整体退化为会话级。
const SESSION_KINDS = new Set(['user_turn'])

export function workspaceOf(session) {
  const cwd = session?.header?.cwd ?? session?.cwd ?? null
  if (typeof cwd !== 'string' || !cwd.trim()) return null
  return normPath(cwd).toLowerCase().replace(/\/$/, '')
}

export function scopeOf(kind, sid, workspace = null) {
  const s = normSid(sid)
  if (SESSION_KINDS.has(kind) || !workspace) return 'sess:' + s
  return 'ws:' + workspace
}

function blockText(c) {
  if (c === null || c === undefined) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(blockText).join('')
  if (typeof c === 'object') {
    if (typeof c.text === 'string') return c.text
    if (c.content !== undefined) return blockText(c.content)
    try { return JSON.stringify(c) } catch { return '' }
  }
  return String(c)
}

function splitEscaped(s) {
  const out = []
  let cur = ''
  let esc = false
  for (const ch of String(s)) {
    if (esc) { cur += ch; esc = false; continue }
    if (ch === '\\') { esc = true; cur += ch; continue }
    if (ch === '|') { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

function unescapeV(s) {
  let t = String(s ?? '')
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1)
  let out = ''
  let esc = false
  for (const ch of t) {
    if (esc) { out += ch === 'n' ? '\n' : (ch === 'r' ? '\r' : ch); esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    out += ch
  }
  return esc ? out + '\\' : out
}

function vValue(vs, field) {
  for (const line of vs ?? []) {
    const parts = splitEscaped(String(line).replace(/^\[V\]\s*/, ''))
    if (parts.length >= 6 && parts[4].trim() === field) return unescapeV(parts.slice(5).join('|'))
  }
  return null
}

const TOOL_DOMAIN = {
  read: 'fs', read_image: 'fs', write: 'fs', edit: 'fs', str_replace: 'fs',
  glob: 'fs-search', grep: 'fs-search', pwsh: 'shell', bash: 'shell',
  create_goal: 'goal', get_goal: 'goal', update_goal: 'goal',
  job_list: 'jobs', job_output: 'jobs', job_kill: 'jobs',
  ask_user_question: 'ask-user', web_search: 'web', web_fetch: 'web',
  todo_write: 'todo', subagent: 'subagent',
}
const domainOf = (action) => TOOL_DOMAIN[action] || action
const FILE_ACTIONS = new Set(['read', 'write', 'edit', 'str_replace'])
const SHELL_ACTIONS = new Set(['pwsh', 'bash'])
const SEARCH_ACTIONS = new Set(['grep', 'glob', 'web_search', 'web_fetch'])
const MEMORY_TOOLS = new Set(['memory_catalog', 'memory_search', 'memory_get'])

// Windows PowerShell/cmd 的常见失败即使 exit=0 也只打在输出里（实测 `type` 不存在文件：
// exit 0、isError=false、out 里是"找不到路径"）。只认强特征，避免把日志里的 error 行误判。
const SHELL_FAIL_RE = /(找不到路径|系统找不到指定的文件|不是内部或外部命令|无法将.*识别为|is not recognized as the name|No such file or directory|CommandNotFoundException|Unhandled exception)/i

// 单条工具结果 → 0..n 条记忆记录。纯函数，可直接离线测。
export function recordsFromToolResult({ sid, seq, callId = null, action = '?', args = {}, text = '', isError = false, ts = Date.now(), fs = { readFileSync } }) {
  const sidN = normSid(sid)
  const seqN = Number(seq)
  if (!Number.isFinite(seqN)) return []
  // 读记忆本身不该写进记忆：否则每次查询都会长出一条无价值的 tool_unknown。
  if (MEMORY_TOOLS.has(action)) return []
  const source = { sid: sidN, seq: seqN, callId: callId ?? null, ts }
  const { t, vs } = foldOne({ action, args, text, isError: isError === true, fs, tool: domainOf(action) })
  const row = parseRow(t)
  if (!row) return []
  const fields = row.fields || {}
  const target = row.target || fields.path || '-'
  const status = row.status || (isError ? 'FAIL' : 'OK')
  const act = row.action || action || '?'
  const base = { action: act, target, status }
  const out = []

  if (FILE_ACTIONS.has(act)) {
    out.push({ kind: 'file_state', key: keyOfPath(target), value: {
      ...base, path: target, size: toInt(fields.size), lines: toInt(fields.lines),
      sha8: fields.sha8 ?? null, chars: toInt(fields.chars), err: fields.err ?? null,
    }, source })
  } else if (SHELL_ACTIONS.has(act)) {
    const cmd = fields.cmd ?? args?.cmd ?? args?.command ?? args?.arguments ?? ''
    out.push({ kind: 'command', key: 'cmd:' + sha1(cmd).slice(0, 16), value: {
      ...base, cmd: String(cmd).slice(0, 2000), exit: fields.exit ?? null,
      out_n: toInt(fields.out_n), head: fields.head ?? null, tail: fields.tail ?? null,
      tee: fields.tee ?? null, err: fields.err ?? null, ...previewOf(text),
    }, source })
  } else if (SEARCH_ACTIONS.has(act)) {
    const pattern = fields.pattern ?? fields.q ?? args?.pattern ?? args?.query ?? args?.url ?? target
    out.push({ kind: 'search', key: 'search:' + act + ':' + sha1(pattern).slice(0, 16), value: {
      ...base, pattern: String(pattern).slice(0, 2000), count: toInt(fields.count),
      matches: fields.matches ?? null, trunc: fields.trunc ?? null, err: fields.err ?? null, ...previewOf(text),
    }, source })
  } else if (act === 'ask_user_question') {
    const question = fields.q ?? args?.question ?? '-'
    const answer = vValue(vs, 'val') ?? text
    const a = cap(answer, CAP_USER_TEXT)
    out.push({ kind: 'user_answer', key: 'answer:' + sha1(question).slice(0, 16), value: {
      ...base, question: String(question).slice(0, 2000), answer: a.text, answerBytes: a.bytes,
      truncated: a.truncated,
    }, source })
  } else if (act === 'job_output') {
    const id = fields.job_id ?? args?.job_id ?? target
    out.push({ kind: 'job', key: 'job:' + String(id).slice(0, 120), value: {
      ...base, job_id: String(id), state: fields.state ?? null,
      out_n: toInt(fields.out_n), tail: fields.tail ?? null, err: fields.err ?? null, ...previewOf(text),
    }, source })
  } else {
    out.push({ kind: 'tool_unknown', key: 'tool:' + String(callId ?? seqN), value: {
      ...base, fields, callId: callId ?? null,
    }, source })
  }

  const shellFailish = SHELL_ACTIONS.has(act) && String(fields.exit ?? '0') === '0' && SHELL_FAIL_RE.test(String(text ?? ''))
  if (status === 'FAIL' || fields.err || shellFailish) {
    // 错误键挂在"同一次调用的主记录键"上（文件路径/命令哈希/检索哈希），
    // 才能被后续同类成功结果精确消解；用 [T] 的 target 会把所有 shell 错误挤到同一个键。
    out.push({ kind: 'error', key: 'err:' + act + ':' + (out[0]?.key ?? String(target).slice(0, 120)), value: {
      ...base, err: fields.err ?? (shellFailish ? firstLine(String(text ?? '')) : firstLine(text)), callId: callId ?? null,
    }, source })
  }
  return out.map((r) => ({ sid: sidN, seq: seqN, ts, ...r }))
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  sid TEXT NOT NULL,
  seq INTEGER,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  extractor TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_sid ON events(sid, id);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE TABLE IF NOT EXISTS records (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  updated_ts INTEGER NOT NULL,
  UNIQUE(scope, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_records_sid_kind ON records(sid, kind);
CREATE INDEX IF NOT EXISTS idx_records_scope_kind ON records(scope, kind);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(sid UNINDEXED, kind UNINDEXED, key UNINDEXED, value);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

// v1 库（records 无 scope）自动迁移：事实归到会话作用域，之后由新事件重建工作区视图。
function ensureSchema(db) {
  const hasRecords = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get()
  if (!hasRecords) { db.exec(SCHEMA); return }
  const cols = db.prepare('PRAGMA table_info(records)').all().map((c) => c.name)
  if (!cols.includes('scope')) {
    db.exec('BEGIN')
    try {
      db.exec('ALTER TABLE records RENAME TO records_v1')
      db.exec(`CREATE TABLE records (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        sid TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
        value TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        updated_ts INTEGER NOT NULL, UNIQUE(scope, kind, key))`)
      db.exec(`INSERT INTO records (rowid, sid, scope, kind, key, value, source, status, updated_ts)
        SELECT rowid, sid, 'sess:' || sid, kind, key, value, source, status, updated_ts FROM records_v1`)
      db.exec('DROP TABLE records_v1')
      db.exec('CREATE INDEX IF NOT EXISTS idx_records_sid_kind ON records(sid, kind)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_records_scope_kind ON records(scope, kind)')
      db.exec('DELETE FROM records_fts')
      db.exec('INSERT INTO records_fts(rowid, sid, kind, key, value) SELECT rowid, sid, kind, key, value FROM records')
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
  }
  const ecols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name)
  if (!ecols.includes('scope')) db.exec("ALTER TABLE events ADD COLUMN scope TEXT NOT NULL DEFAULT ''")
}

function parseRecordRow(r) {
  if (!r) return null
  return {
    rowid: r.rowid,
    scope: r.scope,
    kind: r.kind,
    key: r.key,
    value: (() => { try { return JSON.parse(r.value) } catch { return r.value } })(),
    source: (() => { try { return JSON.parse(r.source) } catch { return r.source } })(),
    status: r.status,
    updated_ts: r.updated_ts,
  }
}

function ftsQuery(q) {
  const words = String(q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8)
  return words.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' OR ')
}

export class MemoryStore {
  constructor(db, { stateDir = STATE_DIR, rawDir = RAW_DIR } = {}) {
    this.db = db
    this.stateDir = stateDir
    this.rawDir = rawDir
    ensureSchema(db)
    this.q = {
      insertEvent: db.prepare('INSERT OR IGNORE INTO events (dedupe, ts, sid, seq, kind, key, value, source, extractor, confidence, scope) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
      upsert: db.prepare(`INSERT INTO records (sid, scope, kind, key, value, source, status, updated_ts) VALUES (?,?,?,?,?,?,'active',?)
        ON CONFLICT(scope, kind, key) DO UPDATE SET sid=excluded.sid, value=excluded.value, source=excluded.source, status='active', updated_ts=excluded.updated_ts`),
      rowid: db.prepare('SELECT rowid FROM records WHERE scope=? AND kind=? AND key=?'),
      delFts: db.prepare('DELETE FROM records_fts WHERE rowid=?'),
      insFts: db.prepare('INSERT INTO records_fts(rowid, sid, kind, key, value) VALUES (?,?,?,?,?)'),
      setMeta: db.prepare('INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key=?'),
      ftsIds: db.prepare('SELECT rowid FROM records_fts WHERE records_fts MATCH ? LIMIT ?'),
    }
  }

  // 可见性：session 只本会话；project 为本工作区全部事实 ∪ 本会话轮次。
  _vis(mode, sid, workspace) {
    const s = normSid(sid)
    if (mode === 'session' || !workspace) return { where: 'sid=?', args: [s] }
    return { where: '(scope=? OR sid=?)', args: ['ws:' + workspace, s] }
  }

  getCursor(sid) {
    const r = this.q.getMeta.get('compiledThrough:' + normSid(sid))
    const n = Number(r?.value)
    return Number.isFinite(n) ? n : -1
  }

  getMetaRaw(key) { return this.q.getMeta.get(String(key))?.value ?? null }

  setMetaRaw(key, value) { this.q.setMeta.run(String(key), String(value)) }

  // 轻 LLM 编译候选：本会话仍未被编译的事件（按 seq 升序，限量）。
  eventsSince(sid, seq, limit = 40) {
    const s = normSid(sid)
    const from = Number.isFinite(Number(seq)) ? Number(seq) : -1
    return this.db.prepare('SELECT id, seq, kind, key, value FROM events WHERE sid=? AND seq>? ORDER BY seq ASC LIMIT ?')
      .all(s, from, Math.max(1, Math.min(200, Number(limit) || 40)))
  }

  insights(scope, limit = 20) {
    return this.db.prepare("SELECT key, value FROM records WHERE scope=? AND kind='insight' ORDER BY updated_ts DESC LIMIT ?")
      .all(String(scope), Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((r) => { try { return { key: r.key, ...JSON.parse(r.value) } } catch { return { key: r.key } } })
  }

  // 生命周期①：同类调用成功后，把之前挂起的错误标记为 resolved（保留记录与证据，不删）。
  resolveError({ scope, act, primaryKey, seq, ts = Date.now() }) {
    const key = 'err:' + act + ':' + primaryKey
    const row = this.db.prepare("SELECT rowid, sid, value FROM records WHERE scope=? AND kind='error' AND key=? AND status='active'").get(String(scope), key)
    if (!row) return 0
    let v = {}
    try { v = JSON.parse(row.value) } catch { /* keep raw */ }
    v.resolvedBy = seq
    v.resolvedTs = ts
    const value = JSON.stringify(v)
    this.db.prepare("UPDATE records SET status='resolved', value=?, updated_ts=? WHERE rowid=?").run(value, ts, row.rowid)
    this.q.delFts.run(row.rowid)
    this.q.insFts.run(row.rowid, row.sid, 'error', key, value)
    return 1
  }

  // 生命周期②：file_state 是"抽取时刻"的快照；读取时按当前磁盘复核（仅单条 get，成本可控）。
  freshness(rec, fs = { statSync }) {
    if (rec?.kind !== 'file_state' || !rec.value?.path) return null
    try {
      const st = fs.statSync(rec.value.path)
      const size = Number(st?.size)
      return { exists: true, size, changed: Number.isFinite(size) && rec.value.size !== undefined && size !== rec.value.size }
    } catch {
      return { exists: false, changed: rec.value.size !== undefined }
    }
  }

  setCursor(sid, seq) {
    const n = Number(seq)
    if (!Number.isFinite(n)) return
    if (n <= this.getCursor(sid)) return
    this.q.setMeta.run('compiledThrough:' + normSid(sid), String(n))
  }

  // 幂等：同一 (sid, seq, kind, key) 只写一次 events；records 再做一次 upsert。
  ingest(rec) {
    const sid = normSid(rec.sid ?? rec.source?.sid)
    const seqSrc = rec.seq ?? rec.source?.seq
    const seq = Number.isFinite(Number(seqSrc)) ? Number(seqSrc) : null
    const kind = String(rec.kind)
    const key = String(rec.key)
    const scope = String(rec.scope ?? scopeOf(kind, sid, rec.workspace ?? null))
    const dedupe = `${sid}|${seq ?? ''}|${kind}|${key}`
    const ts = Number.isFinite(rec.ts) ? rec.ts : Date.now()
    const value = JSON.stringify(rec.value ?? null)
    const source = JSON.stringify(rec.source ?? { sid, seq })
    const res = this.q.insertEvent.run(dedupe, ts, sid, seq, kind, key, value, source, rec.extractor ?? 'rule', Number(rec.confidence ?? 1), scope)
    if (res.changes === 0) return false
    this.q.upsert.run(sid, scope, kind, key, value, source, ts)
    const rid = this.q.rowid.get(scope, kind, key)?.rowid
    if (rid !== undefined) {
      this.q.delFts.run(rid)
      this.q.insFts.run(rid, sid, kind, key, value)
    }
    return true
  }

  catalog({ sid, scope = 'project', workspace = null }, limit = 20) {
    const s = normSid(sid)
    const v = this._vis(scope, s, workspace)
    const lim = Math.max(1, Math.min(100, Number(limit) || 20))
    const counts = this.db.prepare(`SELECT kind, COUNT(*) AS n, MAX(updated_ts) AS last FROM records WHERE ${v.where} AND status='active' GROUP BY kind ORDER BY n DESC`).all(...v.args)
      .map((r) => ({ kind: r.kind, n: Number(r.n), last: Number(r.last) }))
    const recent = this.db.prepare(`SELECT rowid, scope, kind, key, status, updated_ts FROM records WHERE ${v.where} ORDER BY updated_ts DESC LIMIT ?`).all(...v.args, lim)
      .map((r) => ({ rowid: r.rowid, scope: r.scope, kind: r.kind, key: r.key, status: r.status, updated_ts: Number(r.updated_ts) }))
    return { total: counts.reduce((a, x) => a + x.n, 0), counts, recent }
  }

  search({ sid, scope = 'project', workspace = null, query = '', kind = '', key = '', status = 'active', limit = 10 }) {
    const s = normSid(sid)
    const v = this._vis(scope, s, workspace)
    const n = Math.max(1, Math.min(50, Number(limit) || 10))
    const st = status === 'all' ? '' : ' AND status=?'
    const sta = status === 'all' ? [] : [String(status === 'resolved' ? 'resolved' : 'active')]
    const SELECT = 'SELECT rowid, scope, kind, key, value, source, status, updated_ts FROM records'
    const kf = kind ? ' AND kind=?' : ''
    const ka = kind ? [String(kind)] : []
    if (key) {
      const rows = this.db.prepare(`${SELECT} WHERE ${v.where} AND key=?${st}${kf} ORDER BY updated_ts DESC LIMIT ?`)
        .all(...v.args, String(key), ...sta, ...ka, n)
      return { mode: 'key', results: rows.map(parseRecordRow).filter(Boolean) }
    }
    if (!String(query).trim()) {
      const rows = this.db.prepare(`${SELECT} WHERE ${v.where}${st}${kf} ORDER BY updated_ts DESC LIMIT ?`).all(...v.args, ...sta, ...ka, n)
      return { mode: 'recent', results: rows.map(parseRecordRow).filter(Boolean) }
    }
    const fq = ftsQuery(query)
    if (fq) {
      try {
        const ids = this.q.ftsIds.all(fq, n * 4).map((r) => Number(r.rowid)).filter(Number.isFinite)
        if (ids.length) {
          const sql = `${SELECT} WHERE rowid IN (${ids.map(() => '?').join(',')}) AND ${v.where}${st}${kf} ORDER BY updated_ts DESC LIMIT ?`
          const rows = this.db.prepare(sql).all(...ids, ...v.args, ...sta, ...ka, n).map(parseRecordRow).filter(Boolean)
          if (rows.length) return { mode: 'fts', results: rows }
        }
      } catch { /* fall through to LIKE */ }
    }
    const pat = '%' + String(query).trim() + '%'
    const rows = this.db.prepare(`${SELECT} WHERE ${v.where} AND (key LIKE ? OR value LIKE ?)${st}${kf} ORDER BY updated_ts DESC LIMIT ?`)
      .all(...v.args, pat, pat, ...sta, ...ka, n).map(parseRecordRow).filter(Boolean)
    return { mode: 'like', results: rows }
  }

  get({ sid, scope = 'project', workspace = null, kind = '', key = '', status = 'active', rowid = null }) {
    const s = normSid(sid)
    const v = this._vis(scope, s, workspace)
    if (rowid !== null && rowid !== undefined && Number.isFinite(Number(rowid))) {
      return parseRecordRow(this.db.prepare(`SELECT rowid, scope, kind, key, value, source, status, updated_ts FROM records WHERE rowid=? AND ${v.where}`).get(Number(rowid), ...v.args))
    }
    if (!kind || !key) return null
    const st = status === 'all' ? '' : ' AND status=?'
    const sta = status === 'all' ? [] : [String(status === 'resolved' ? 'resolved' : 'active')]
    return parseRecordRow(this.db.prepare(`SELECT rowid, scope, kind, key, value, source, status, updated_ts FROM records WHERE ${v.where} AND kind=? AND key=?${st}`).get(...v.args, String(kind), String(key), ...sta))
  }

  resolveRaw(sid, seq) {
    const s = normSid(sid)
    const n = Number(seq)
    if (!Number.isFinite(n)) return { resolved: false, reason: 'bad-seq' }
    const candidates = [join(this.rawDir, 'session-' + s + '.jsonl'), join(this.rawDir, s + '.jsonl')]
    const file = candidates.find((f) => existsSync(f))
    if (!file) return { resolved: false, reason: 'no-raw-file', tried: candidates }
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let rec = null
        try { rec = JSON.parse(line) } catch { continue }
        if (Number(rec?.seq) !== n) continue
        const text = blockText(rec?.msg?.content)
        const c = cap(text, 2000)
        return { resolved: true, file, seq: n, preview: c.text, truncated: c.truncated, bytes: c.bytes }
      }
    } catch (err) {
      return { resolved: false, reason: 'read-failed', error: String(err?.message ?? err) }
    }
    return { resolved: false, reason: 'seq-not-in-raw', file }
  }

  close() { try { this.db.close() } catch { /* already closed */ } }
}

export function openStore(file = DB_FILE, opts = {}) {
  if (!DatabaseSync) return null
  try {
    mkdirSync(dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    return new MemoryStore(db, opts)
  } catch (err) {
    console.error('[MEMORY] store open failed:', err?.message ?? err)
    return null
  }
}

function normalizeArgs(a) {
  if (a && typeof a === 'object') return a
  if (typeof a === 'string') { try { const v = JSON.parse(a); return v && typeof v === 'object' ? v : {} } catch { return {} } }
  return {}
}

function resultInfo(ev) {
  const d = ev?.data ?? {}
  const m = d.message ?? {}
  const blocks = Array.isArray(m.content) ? m.content : []
  const tr = blocks.find((b) => b?.type === 'tool-result')
  const callId = tr?.toolCallId ?? tr?.callId ?? m.toolCallId ?? m.callId ?? m.source?.callId ?? d.callId ?? null
  const isError = tr?.isError !== undefined ? tr.isError === true : (m.isError === true || !!d.error)
  let text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
  if (tr && tr.content !== undefined) text += (text ? '\n' : '') + blockText(tr.content)
  if (!text && d.error) text = String(d.error?.message ?? d.error)
  return { callId: callId ? String(callId) : null, isError, text }
}

function textOfMessage(m) {
  const blocks = Array.isArray(m?.content) ? m.content : []
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
}

function buildCallIndex(events) {
  const calls = new Map()
  for (const ev of events ?? []) {
    if (ev?.type !== 'tool/call' && ev?.type !== 'tool-call') continue
    const d = ev.data ?? {}
    const id = d.callId ?? d.toolCallId ?? d.id
    if (id === undefined || id === null || id === '') continue
    calls.set(String(id), { action: d.name ?? d.toolName ?? '?', args: normalizeArgs(d.arguments) })
  }
  return calls
}

export class MemoryIngestor {
  constructor(store, { fs = { readFileSync } } = {}) {
    this.store = store
    this.fs = fs
  }

  processEvent(sid, ev, calls = new Map(), { workspace = null } = {}) {
    const s = normSid(sid)
    const ws = workspace ? String(workspace) : null
    const seq = Number(ev?.seq)
    if (!Number.isFinite(seq)) return false
    const ts = Number.isFinite(Number(ev?.t)) ? Number(ev.t) : Date.now()
    if (ev.type === 'tool/call' || ev.type === 'tool-call') {
      const d = ev.data ?? {}
      const id = d.callId ?? d.toolCallId ?? d.id
      if (id !== undefined && id !== null && id !== '') {
        calls.set(String(id), { action: d.name ?? d.toolName ?? '?', args: normalizeArgs(d.arguments) })
      }
      this.store.setCursor(s, seq)
      return true
    }
    if (ev.type === 'tool/result') {
      const info = resultInfo(ev)
      const call = info.callId ? calls.get(info.callId) : null
      const records = recordsFromToolResult({
        sid: s, seq, callId: info.callId, action: call?.action ?? '?', args: call?.args ?? {},
        text: info.text, isError: info.isError, ts, fs: this.fs,
      })
      for (const r of records) this.store.ingest({ ...r, scope: scopeOf(r.kind, s, ws) })
      // 生命周期：同类调用成功 ⇒ 之前同一主键的挂起错误自动 resolved（记录保留，可审计）。
      // 但本次结果自己产出了错误（如输出级失败）时不能立刻消解自己。
      const errKeys = new Set(records.filter((r) => r.kind === 'error').map((r) => r.key))
      const okRec = records.find((r) => r.kind !== 'error' && r.kind !== 'tool_unknown' && r.value?.status === 'OK')
      if (okRec && !errKeys.has('err:' + okRec.value.action + ':' + okRec.key)) {
        try {
          this.store.resolveError({ scope: scopeOf(okRec.kind, s, ws), act: okRec.value.action, primaryKey: okRec.key, seq, ts })
        } catch { /* best-effort */ }
      }
      this.store.setCursor(s, seq)
      return records.length > 0
    }
    if (ev.type === 'user/message') {
      const cls = classifyUserMessage(ev)
      if (cls.cls !== 'user') { this.store.setCursor(s, seq); return false }
      const text = textOfMessage(ev.data?.message ?? ev.data)
      if (!text) { this.store.setCursor(s, seq); return false }
      const c = cap(text, CAP_USER_TEXT)
      this.store.ingest({
        sid: s, seq, kind: 'user_turn', key: 'turn:' + seq, scope: 'sess:' + s,
        value: { text: c.text, bytes: c.bytes, truncated: c.truncated },
        source: { sid: s, seq, ts }, extractor: 'rule', confidence: 1, ts,
      })
      this.store.setCursor(s, seq)
      return true
    }
    if (ev.type === 'goal/change') {
      const d = ev.data ?? {}
      const op = d.operation ?? '?'
      const label = ({ create: 'TASK START', complete: 'DONE', pause: 'PAUSE', resume: 'RESUME', block: 'BLOCKED', clear: 'ARCHIVED' })[op] ?? String(op).toUpperCase()
      const goalId = String(d.goalId ?? d.goal_id ?? 'current')
      this.store.ingest({
        sid: s, seq, kind: 'task', key: 'task:' + goalId, scope: scopeOf('task', s, ws),
        value: { label, operation: op, goalId }, source: { sid: s, seq, ts }, extractor: 'rule', confidence: 1, ts,
      })
      this.store.setCursor(s, seq)
      return true
    }
    return false
  }

  // 首次见到某会话：从持久事件里补课；call index 先建，跨游标的 call↔result 也能配对。
  ingestSession(session, sid) {
    const s = normSid(sid)
    const workspace = workspaceOf(session)
    const events = allEvents(session)
    if (!events?.length) return { processed: 0, workspace }
    const calls = buildCallIndex(events)
    const cursor = this.store.getCursor(s)
    let n = 0
    for (const ev of events) {
      const seq = Number(ev?.seq)
      if (!Number.isFinite(seq) || seq <= cursor) continue
      if (this.processEvent(s, ev, calls, { workspace })) n += 1
    }
    return { processed: n, cursor: this.store.getCursor(s), calls: calls.size, workspace }
  }
}

export function allEvents(subject) {
  const s = subject?.session ?? subject
  if (typeof s?.ownEvents === 'function') { try { return s.ownEvents() } catch { return [] } }
  if (typeof s?.snapshotEvents === 'function') { try { return s.snapshotEvents() } catch { return [] } }
  return s?.events ?? []
}

// ================= 轻 LLM 编译层（第三切片，默认关） =================
// 取"上次编译之后的新事件"做一次小上下文调用，产出 insight 记录（kind='insight'）。
// 纪律：只在成功解析后推进游标；失败进入冷却，候选保留到下次；没有真人轮或候选太少不调用。
const LLM_DEFAULTS = {
  minEvents: 1,
  maxEvents: 40,
  maxInsights: 4,
  maxChars: 4000,
  maxTokens: 2048,
  cooldownMs: 60_000,
}

const COMPILE_SYSTEM = [
  'You maintain a project memory for a coding agent.',
  'From the NEW EVENTS, extract at most 4 durable, reusable facts that will help future sessions in this project.',
  'Prefer: decisions and constraints, fixed values (ports, paths, IDs), file roles, recurring commands, resolved errors, user preferences.',
  'Skip: ephemeral chatter, code dumps, tool noise, anything derivable by reading the repo.',
  'Reuse an existing insight key when updating it. Keep summaries under 200 characters.',
  'Copy all numbers, paths and identifiers verbatim. Never round, recompute or alter them.',
  'Output STRICT JSON only, no prose, no code fences:',
  '{"insights":[{"key":"placeholder-do-not-copy","summary":"...","confidence":0.8}]}',
  'The key must be a short English slug describing the fact itself (e.g. test-command, api-port, db-path). Never output the placeholder key.',
  'If nothing durable is present, output {"insights":[]}.',
].join('\n')

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// 候选事件 → 紧凑文本；预算从**最新**往回装，保证最近的工作不被截掉。
export function digestOf(rows, maxChars = LLM_DEFAULTS.maxChars) {
  const lines = []
  for (const r of rows ?? []) {
    let v = ''
    try { v = JSON.stringify(JSON.parse(r.value)) } catch { v = String(r.value ?? '') }
    lines.push(`#${r.id} ${r.kind} ${r.key} | ${clip(v, 300)}`)
  }
  const out = []
  let n = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length && n + lines[i].length + 1 > maxChars) break
    out.unshift(lines[i])
    n += lines[i].length + 1
  }
  return out.join('\n')
}

// 宽容解析：剥代码围栏/前后废话，只认合法 key 与 summary；越界置信度夹到 [0,1]。
// 4B 实测会把键名写成 `{"insights:[]}`（少一个引号）；这类单点语法伤不应让整批归零。
function parseJsonLoose(s) {
  try { return JSON.parse(s) } catch { /* 继续修复 */ }
  const repaired = s
    .replace(/"([A-Za-z0-9_-]+)\s*:\s*\[/g, '"$1":[')
    .replace(/,\s*([\]}])/g, '$1')
  try { return JSON.parse(repaired) } catch { return null }
}

export function parseInsights(text, { max = LLM_DEFAULTS.maxInsights } = {}) {
  if (typeof text !== 'string' || !text.trim()) return []
  const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return []
  const obj = parseJsonLoose(t.slice(a, b + 1))
  if (!obj) return []
  const arr = Array.isArray(obj?.insights) ? obj.insights : []
  const out = []
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue
    const key = String(x.key ?? '').trim().toLowerCase()
    const summary = clip(x.summary, 500)
    if (!/^[a-z0-9][a-z0-9:_.-]{0,79}$/.test(key)) continue
    // 瞬时执行型 key 不是持久事实（4B 爱把一次 echo 的调用名当 insight）；
    // 只拦工具/轮次/会话前缀，error-/file-/job- 等概念型 key 保留。
    if (/^(pwsh|bash|cmd|command|tool|turn|step|round|session)[:_.-]/.test(key)) continue
    if (key === 'placeholder-do-not-copy' || key === 'short-stable-slug') continue
    if (!summary) continue
    const c = Number(x.confidence)
    out.push({ key, summary, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.6 })
    if (out.length >= max) break
  }
  return out
}

async function compileUserMessage(text) {
  const content = [{ type: 'text', text }]
  const source = { kind: 'plugin:MEMORY' }
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    if (typeof createUserMessage === 'function') return createUserMessage({ content, source })
  } catch { /* 退回手写值 */ }
  return { id: 'mem-' + Date.now().toString(36), role: 'user', content, source }
}

async function callCompileLlm(llm, route, system, user, maxTokens) {
  const messages = [await compileUserMessage(user)]
  let text = ''
  let finish = null
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system,
      temperature: 0,
      maxTokens,
      purpose: 'compaction', // 宿主只接受 compaction / session-title；记忆编译属于历史压缩
      reasoningEffort: 'off',
    })) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk?.type === 'finish') finish = chunk.reason
    }
  } catch (err) {
    console.error('[MEMORY] compile call failed:', err?.message ?? err)
    return null
  }
  if (String(finish?.kind ?? '') !== 'stop') return null
  return text.trim() || null
}

function compilePrompt(existing, digest) {
  const ex = existing.length
    ? existing.map((x) => `- ${x.key}: ${clip(x.summary, 120)}`).join('\n')
    : '(none)'
  return [
    'EXISTING INSIGHTS (update by reusing the same key):',
    ex,
    '',
    'NEW EVENTS:',
    digest,
  ].join('\n')
}

// 数字幻觉闸：摘要里 ≥3 位的数字必须能在候选原文/现存摘要里逐字找到。
// 小模型实测会把 8848 抄成 8840；这类错误比"少一条记忆"更贵，直接丢弃该条。
const bigNumbers = (s) => (String(s ?? '').match(/\d+(?:\.\d+)?/g) ?? []).filter((x) => x.length >= 3)
// 标识符闸：含字母+数字的长 token（模型名/版本/会话 id 等）也必须逐字出现。
//   4B 实测把 qwen3:4b-instruct-2507-q4_K_M 抄成 qwen3:4-4b-...；数字闸只看到 2507 仍在，挡不住。
const identTokens = (s) => (String(s ?? '').match(/[A-Za-z0-9][A-Za-z0-9_.:\/-]{5,}/g) ?? [])
  .filter((x) => /\d/.test(x) && /[A-Za-z]/.test(x))

export function groundedInsight(item, haystack) {
  const hs = String(haystack ?? '')
  return bigNumbers(item?.summary).every((n) => hs.includes(n)) &&
    identTokens(item?.summary).every((t) => hs.includes(t))
}

// 用户显式说"记住/写入记忆"时，不把小模型的"这是闲聊"判断当作最终裁决：
// 原话逐字落成一条 insight（键由文本哈希保证稳定），模型返回的条目再与之归并。
function memoryDirectiveText(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const patterns = [
    /\b(?:add|put|store|save|keep)\b[^:：]{0,80}?\b(?:in|to|into)\s+(?:your\s+)?memory\b\s*(?:[:：\-—]\s*)?(.+)$/i,
    /(?:^|[.!?]\s+|[,;]\s*|\b(?:now|please)\s+)remember\b\s+(?:that\s+)?(.+)$/i,
    /(?:请)?(?:记住|记一下|记下来|帮我记住)[：:，,\s]*(.+)$/,
    /(?:写入|加到|存到|加入)(?:你的)?记忆[：:，,\s]*(.+)$/,
  ]
  for (const re of patterns) {
    const m = s.match(re)
    const out = String(m?.[1] ?? '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
    if (out.length >= 4) return out
  }
  return ''
}

export function explicitMemoryItems(rows) {
  const out = []
  for (const r of rows ?? []) {
    if (r.kind !== 'user_turn') continue
    let v = null
    try { v = JSON.parse(r.value) } catch { continue }
    const statement = memoryDirectiveText(v?.text)
    if (!statement) continue
    const h = createHash('sha1').update(statement.toLowerCase()).digest('hex').slice(0, 8)
    const slug = (statement.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 4).join('-').slice(0, 40)
    out.push({
      key: 'user-memo:' + (slug ? slug + '-' : '') + h,
      summary: clip(statement, 500),
      confidence: 0.95,
    })
  }
  return out
}

// 同义归并：跨轮/跨 key 的近重复摘要收敛到已有 key，避免同一事实堆成多条。
// 归一化去空白/标点后取字符二元组 Jaccard；长度比 <0.7 直接判不相似，防止短句被长句吞并。
const MERGE_SIMILARITY = 0.86
function summaryNorm(s) { return String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') }
export function summarySimilarity(a, b) {
  const x = summaryNorm(a)
  const y = summaryNorm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 4 || y.length < 4) return 0
  if (Math.min(x.length, y.length) / Math.max(x.length, y.length) < 0.7) return 0
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ma = grams(x)
  const mb = grams(y)
  let inter = 0
  for (const [g, n] of ma) inter += Math.min(n, mb.get(g) ?? 0)
  return inter / (x.length - 1 + y.length - 1 - inter)
}

// 归并还要求数字集合一致：小模型常把同一模板里的端口/尺寸改一个字，
// 文本相似度会高到 0.85 左右，但那是两条不同事实，不能并。
export function mergeableInsight(a, b) {
  if (summarySimilarity(a, b) < MERGE_SIMILARITY) return false
  const na = new Set(bigNumbers(a))
  const nb = new Set(bigNumbers(b))
  if (na.size !== nb.size) return false
  for (const n of na) if (!nb.has(n)) return false
  return true
}

export class MemoryCompiler {
  constructor(store, opts = {}) {
    this.store = store
    this.opts = { ...LLM_DEFAULTS, ...opts }
    this.busy = new Set()
  }

  async compileSession({ sid, session, workspace = null, llm = null, route = null }) {
    const s = normSid(sid)
    if (!llm) return { ok: false, reason: 'no-llm' }
    if (!route?.provider || !route?.model) return { ok: false, reason: 'no-route' }
    if (this.busy.has(s)) return { ok: false, reason: 'busy' }
    const through = Number(this.store.getMetaRaw('llmThrough:' + s) ?? -1)
    const rows = this.store.eventsSince(s, through, this.opts.maxEvents)
    if (rows.length < this.opts.minEvents) return { ok: false, reason: 'too-few', pending: rows.length }
    if (!rows.some((r) => r.kind === 'user_turn')) return { ok: false, reason: 'no-user-turn' }
    const failAt = Number(this.store.getMetaRaw('llmFailAt:' + s) ?? 0)
    if (Date.now() - failAt < this.opts.cooldownMs) return { ok: false, reason: 'cooldown' }

    this.busy.add(s)
    try {
      const lastSeq = Math.max(...rows.map((r) => Number(r.seq)).filter(Number.isFinite))
      const scope = scopeOf('file_state', s, workspace)
      const existing = this.store.insights(scope, 20)
      const digest = digestOf(rows, this.opts.maxChars)
      const haystack = digest + '\n' + existing.map((x) => String(x.summary ?? '')).join('\n')
      const text = await callCompileLlm(llm, route, COMPILE_SYSTEM, compilePrompt(existing, digest), this.opts.maxTokens)
      if (text == null) {
        this.store.setMetaRaw('llmFailAt:' + s, Date.now())
        return { ok: false, reason: 'llm-failed' }
      }
      const parsed = parseInsights(text, { max: this.opts.maxInsights })
      const grounded = parsed.filter((x) => groundedInsight(x, haystack))
      const items = [...explicitMemoryItems(rows), ...grounded]
      const dropped = parsed.length - grounded.length
      const now = Date.now()
      const evidence = rows.slice(-20).map((r) => Number(r.id))
      // 归并：同批重复先并；跨 key 的近重复收敛到已有 key（并集只留一条当前视图）。
      const accepted = []
      let merged = 0
      for (const it of items) {
        const dup = accepted.find((x) => x.key === it.key || mergeableInsight(x.summary, it.summary))
        if (dup) {
          dup.confidence = Math.max(dup.confidence, it.confidence)
          if (String(it.summary).length > String(dup.summary).length) dup.summary = it.summary
          merged += 1
          continue
        }
        const sameKey = existing.find((x) => x.key === it.key)
        const near = sameKey ? null : existing.find((x) => mergeableInsight(x.summary, it.summary))
        if (near) {
          accepted.push({ key: near.key, summary: it.summary, confidence: Math.max(Number(near.confidence) || 0, it.confidence) })
          merged += 1
        } else {
          accepted.push(it)
        }
      }
      for (const it of accepted) {
        this.store.ingest({
          sid: s, seq: lastSeq, kind: 'insight', key: it.key, scope,
          value: {
            summary: it.summary, confidence: it.confidence,
            evidence,
            model: route.provider + '/' + route.model, compiledAt: now,
          },
          source: { sid: s, seq: lastSeq, extractor: 'llm', model: route.model },
          extractor: 'llm', confidence: it.confidence, ts: now,
        })
      }
      this.store.setMetaRaw('llmThrough:' + s, lastSeq)
      return { ok: true, insights: accepted.length, dropped, merged, through: lastSeq, model: route.model }
    } finally {
      this.busy.delete(s)
    }
  }
}

export function routeForCompile(session, ctrl) {
  const p = ctrl?.memoryLlmProvider
  const m = ctrl?.memoryLlmModel
  if (typeof p === 'string' && p && typeof m === 'string' && m) return { provider: p, model: m, via: 'control' }
  try {
    const c = session?.requestHeader?.()?.config
    if (c && typeof c.provider === 'string' && typeof c.model === 'string' && c.provider && c.model) {
      return { provider: c.provider, model: c.model, via: 'session' }
    }
  } catch { /* best-effort */ }
  return null
}

// ================= 目录注入（第四切片） =================
// 每会话一次：把"记忆里已有什么"作为上下文尾巴注入，agent 不必先想到调用工具。
// 只注入语义摘要：不出现 kind/count/key，也不注入 user_turn（对话本身已存在）；
// 没有 insight 时不注入；子代理不注入；用 meta 标记跨重启只注入一次。
export function catalogDigest(store, { sid, workspace = null, maxChars = 700 }) {
  const s = normSid(sid)
  let ins = []
  try { ins = store.insights(workspace ? 'ws:' + workspace : 'sess:' + s, 8) } catch { return '' }
  ins = ins.filter((x) => String(x.summary ?? '').trim())
  if (!ins.length) return ''
  const parts = ['Known project memory (read-only; details via memory_search):']
  for (const x of ins) parts.push('- ' + clip(x.summary, 100))
  const text = parts.join('\n')
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text
}

function isSubagentAgent(agent) {
  try {
    const m = agent?.session?.meta ?? {}
    const depth = agent?.session?.header?.delegationDepth ?? agent?.session?.delegationDepth
    return m.origin === 'subagent' || (Number.isFinite(Number(depth)) && Number(depth) > 0)
  } catch { return false }
}

function sessionOf(a, ev) {
  const cand = (a && (a.id || a.sessionId || a.surface)) ? a : (ev?.session ?? a?.session ?? null)
  return cand?.session ?? cand
}

function sidOf(session) {
  return session?.id ?? session?.sessionId ?? session?.goalId ?? session?.name ?? null
}

const TEXT_OUT = (schema) => ({
  schema,
  render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
})

const OUTPUT_OK = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    sid: { type: 'string' },
    total: { type: 'integer' },
    counts: { type: 'array', items: { type: 'object' } },
    recent: { type: 'array', items: { type: 'object' } },
    mode: { type: 'string' },
    count: { type: 'integer' },
    results: { type: 'array', items: { type: 'object' } },
    record: { type: 'object' },
    raw: { type: 'object' },
    error: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: true,
}

function compactValue(v, max = 800) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…' : v
  if (Array.isArray(v)) return v.map((x) => compactValue(x, max))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = compactValue(x, max)
    return out
  }
  return v
}

export function makeMemoryTools(store) {
  const sidOfExec = (args, exec) => normSid(args?.sid || sidOf(exec?.agent?.session) || '')
  const wsOfExec = (exec) => workspaceOf(exec?.agent?.session)
  const scopeOfArgs = (args) => (args?.scope === 'session' ? 'session' : 'project')
  const SCOPE_PARAM = {
    type: 'string',
    enum: ['project', 'session'],
    description: 'project (default): facts from every session in this workspace plus this session\'s turns. session: only this session.',
  }

  const catalog = {
    name: 'memory_catalog',
    description: 'List external memory: record kinds, counts, and the most recent keys. Defaults to the current workspace (facts shared by all sessions in this directory) plus this session\'s turns. Call this before memory_search when you do not know what is stored.',
    parameters: {
      type: 'object',
      properties: {
        sid: { type: 'string', description: 'Session id; defaults to the current session.' },
        scope: SCOPE_PARAM,
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output: TEXT_OUT(OUTPUT_OK),
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const sid = sidOfExec(args, exec)
      if (!sid || sid === 'unknown') return { ok: false, error: 'no-session-scope' }
      const scope = scopeOfArgs(args)
      const workspace = wsOfExec(exec)
      const c = store.catalog({ sid, scope, workspace }, args?.limit ?? 20)
      return { ok: true, sid, scope, workspace: workspace ?? null, ...c }
    },
  }

  const search = {
    name: 'memory_search',
    description: 'Search external memory by text, exact key, or kind. Defaults to the current workspace plus this session. Returns matching records with their source (session, event seq, call id). Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search in keys and values.' },
        key: { type: 'string', description: 'Exact record key.' },
        kind: { type: 'string', description: 'Filter by kind: file_state, command, search, error, user_answer, job, task, user_turn, insight, tool_unknown.' },
        scope: SCOPE_PARAM,
        status: { type: 'string', enum: ['active', 'resolved', 'all'], description: 'Record lifecycle status; default active (resolved errors are hidden).' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        sid: { type: 'string', description: 'Session id; defaults to the current session.' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUT(OUTPUT_OK),
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const sid = sidOfExec(args, exec)
      if (!sid || sid === 'unknown') return { ok: false, error: 'no-session-scope' }
      const scope = scopeOfArgs(args)
      const workspace = wsOfExec(exec)
      const r = store.search({ sid, scope, workspace, status: args?.status ?? 'active', query: args?.query ?? '', kind: args?.kind ?? '', key: args?.key ?? '', limit: args?.limit ?? 10 })
      // 搜索是目录级视图：每条值截到 800 字符，避免一条 4KB 用户轮把结果撑爆；细节走 memory_get。
      return { ok: true, sid, scope, workspace: workspace ?? null, mode: r.mode, compacted: true, count: r.results.length, results: r.results.map((x) => ({ ...x, value: compactValue(x.value) })) }
    },
  }

  const get = {
    name: 'memory_get',
    description: 'Read one memory record by kind and key (or rowid). Defaults to the current workspace plus this session. File records are checked against the current disk (fresh.changed). Set includeRaw=true to resolve its source pointer back to the archived raw event (preview only). Read-only.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        key: { type: 'string' },
        rowid: { type: 'integer' },
        includeRaw: { type: 'boolean' },
        checkFresh: { type: 'boolean', description: 'For file_state: stat the path now and report fresh.changed (default true).' },
        scope: SCOPE_PARAM,
        status: { type: 'string', enum: ['active', 'resolved', 'all'], description: 'Record lifecycle status; default active.' },
        sid: { type: 'string', description: 'Session id; defaults to the current session.' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUT(OUTPUT_OK),
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const sid = sidOfExec(args, exec)
      if (!sid || sid === 'unknown') return { ok: false, error: 'no-session-scope' }
      const scope = scopeOfArgs(args)
      const workspace = wsOfExec(exec)
      const rec = store.get({ sid, scope, workspace, status: args?.status ?? 'active', kind: args?.kind ?? '', key: args?.key ?? '', rowid: args?.rowid ?? null })
      if (!rec) return { ok: false, sid, scope, workspace: workspace ?? null, error: 'not-found' }
      const raw = args?.includeRaw === true ? store.resolveRaw(sid, rec.source?.seq) : undefined
      const fresh = args?.checkFresh === false ? null : store.freshness(rec)
      return { ok: true, sid, scope, workspace: workspace ?? null, record: rec, ...(fresh ? { fresh } : {}), ...(raw ? { raw } : {}) }
    },
  }

  return [catalog, search, get]
}

function controlNow() {
  try { return JSON.parse(readFileSync(join(STATE_DIR, 'control.json'), 'utf8')) ?? {} } catch { return {} }
}

function enabledNow(ctrl = controlNow()) {
  if (process.env.DSH_MEMORY === '0') return false
  if (process.env.DSH_MEMORY === '1') return true
  return ctrl?.memoryEnabled === true
}

function llmEnabledNow(ctrl) {
  if (process.env.DSH_MEMORY_LLM === '0') return false
  if (process.env.DSH_MEMORY_LLM === '1') return true
  return ctrl?.memoryLlmEnabled === true
}

function llmServiceOf(ctx) {
  try { return ctx.get?.('llm') ?? ctx.llm ?? null } catch { return null }
}

export default {
  name: 'MEMORY',
  inject: ['tools'],
  apply(ctx) {
    const ctrl = controlNow()
    if (!enabledNow(ctrl)) {
      console.log('[MEMORY] disabled (set DSH_MEMORY=1 or control.memoryEnabled=true)')
      return
    }
    if (!DatabaseSync) {
      console.error('[MEMORY] node:sqlite unavailable; layer stays off')
      return
    }
    const store = openStore()
    if (!store) { console.error('[MEMORY] store unavailable; layer stays off'); return }
    // WebUI 用：记录"本进程已武装"，配合 pid 判断面板上是「待重启」还是「运行中」。
    store.setMetaRaw('armedPid', String(process.pid))
    store.setMetaRaw('armedAt', String(Date.now()))
    const ingestor = new MemoryIngestor(store)
    let compiler = null
    let paused = false
    const seen = new Set()
    const callsBySid = new Map()

    ctx.on('session/event', (a, b) => {
      try {
        const ctrlNow = controlNow()
        // 记忆层热停写/恢复：已武装的进程即时生效；启动时未启用的层仍需重启才能注册工具。
        if (!enabledNow(ctrlNow)) { paused = true; return }
        // 停写期间错过的事件不丢：恢复后清一次 seen，让下一次事件走 ingestSession 补课。
        if (paused) { paused = false; seen.clear() }
        const ev = (b && typeof b === 'object' && typeof b.type === 'string') ? b
          : (a && typeof a === 'object' && typeof a.type === 'string' ? a : null)
        if (!ev) return
        const session = sessionOf(a, ev)
        const sid = normSid(sidOf(session) ?? ev?.session?.id ?? '')
        if (!sid || sid === 'unknown') return
        if (!seen.has(sid)) {
          seen.add(sid)
          const r = ingestor.ingestSession(session, sid)
          callsBySid.set(sid, buildCallIndex(allEvents(session)))
          if (r.processed) console.log(`[MEMORY] catch-up sid=${sid} processed=${r.processed} cursor=${r.cursor} ws=${r.workspace ?? '-'}`)
        }
        const calls = callsBySid.get(sid) ?? new Map()
        const workspace = workspaceOf(session)
        ingestor.processEvent(sid, ev, calls, { workspace })

        // 轻 LLM 编译只在活轮结束后触发（补课不触发，避免历史会话一开机就被重编译）。
        // 每次 turn/end 重读开关 ⇒ 面板关掉后下一轮即停（无需重启）；重新打开则惰性重建编译器。
        if (ev.type === 'turn/end') {
          if (!llmEnabledNow(ctrlNow)) { compiler = null; return }
          if (!compiler) compiler = new MemoryCompiler(store)
          const route = routeForCompile(session, ctrlNow)
          markCompileStart(sid)
          compiler.compileSession({ sid, session, workspace, llm: llmServiceOf(ctx), route })
            .then((r) => {
              markCompileLast(sid, r)
              if (r.ok) console.log(`[MEMORY] compiled sid=${sid} insights=${r.insights} dropped=${r.dropped ?? 0} merged=${r.merged ?? 0} through=${r.through} model=${r.model}`)
              else if (r.reason === 'llm-failed' || r.reason === 'no-route' || r.reason === 'no-llm') {
                console.error(`[MEMORY] compile skipped sid=${sid} reason=${r.reason}`)
              }
            })
            .catch((err) => {
              markCompileLast(sid, { ok: false, reason: 'error' })
              console.error('[MEMORY] compile error:', err?.message ?? err)
            })
            .finally(() => markCompileEnd(sid))
        }
      } catch (err) {
        console.error('[MEMORY] event failed:', err?.message ?? err)
      }
    })

    // 目录注入：每会话一次，作为 pre-step 决策的末尾消息（与 EXTREASON 同一落点/形态）。
    // 每步重读开关（控制面板承诺可热切）；env 仍为硬覆盖。
    {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          const ctrlNow = controlNow()
          if (!enabledNow(ctrlNow)) return decision
          if (process.env.DSH_MEMORY_INJECT === '0' || ctrlNow.memoryInjectCatalog === false) return decision
          const agent = payload?.agent
          const sid = normSid(agent?.session?.id ?? '')
          if (!sid || sid === 'unknown' || isSubagentAgent(agent)) return decision
          if (store.getMetaRaw('injected:' + sid) === '1') return decision
          const text = catalogDigest(store, { sid, workspace: workspaceOf(agent.session) })
          if (!text) return decision
          if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
          store.setMetaRaw('injected:' + sid, '1')
          console.log(`[MEMORY] inject-catalog sid=${sid} chars=${text.length}`)
          return {
            ...decision,
            messages: [...decision.messages, {
              id: 'mem-catalog-' + sid,
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'plugin:MEMORY' },
            }],
          }
        } catch (err) {
          console.error('[MEMORY] inject-catalog failed:', err?.message ?? err)
          return decision
        }
      }, { prepend: true })
    }

    let disposers = []
    try {
      disposers = makeMemoryTools(store).map((d) => ctx.tools.register(d))
      console.log('[MEMORY] armed tools=memory_catalog,memory_search,memory_get db=' + DB_FILE
        + ' llm=' + (llmEnabledNow(controlNow()) ? 'on' : 'off'))
    } catch (err) {
      console.error('[MEMORY] tool registration failed:', err?.message ?? err)
    }
    const dispose = () => {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
      disposers = []
      try { store.setMetaRaw('armedPid', '0') } catch { /* best-effort */ }
      store.close()
    }
    try {
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
      else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
    } catch { /* best-effort */ }
  },
}
