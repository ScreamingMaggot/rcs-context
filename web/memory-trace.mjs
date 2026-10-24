// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// memory-trace.mjs — Phase 4 retrieval traces (audit only, never a fact source).
//
// A trace records *how* a retrieval decision was made (scope, stages, candidates,
// selected) — never memory bodies, prompts or vectors. Writes go through a
// process-local queue on a separate SQLite connection; every failure is swallowed
// so tracing can never break a tool call or the injection path.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const TRACE_TRIGGERS = new Set(['tool', 'ls', 'recall', 'inject', 'handover'])

const sha1 = (s) => createHash('sha1').update(String(s ?? '')).digest('hex')
const hash8 = (s) => '#' + sha1(s).slice(0, 8)
const clip = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t
}
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const clean = (s, n) => clip(String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), n)

export const TRACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS retrieval_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  sid TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL,
  uri TEXT NOT NULL DEFAULT '',
  query_hash TEXT NOT NULL DEFAULT '',
  query_text TEXT NOT NULL DEFAULT '',
  query_len INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT '',
  widened TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  candidates TEXT NOT NULL DEFAULT '[]',
  selected TEXT NOT NULL DEFAULT '[]',
  cand_total INTEGER NOT NULL DEFAULT 0,
  sel_total INTEGER NOT NULL DEFAULT 0,
  ms REAL NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  truncated INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_traces_sid_ts ON retrieval_traces(sid, ts DESC);
CREATE INDEX IF NOT EXISTS idx_traces_ws_ts ON retrieval_traces(workspace, ts DESC);
CREATE INDEX IF NOT EXISTS idx_traces_trigger_ts ON retrieval_traces(trigger, ts DESC);
`

export function ensureTraceSchema(db) {
  db.exec(TRACE_SCHEMA)
  return true
}

const SECRET_KV = /((?:password|passwd|pwd|token|api[_-]?key|secret)\s*[=:]\s*)([^\s,;]+)/gi

// Single redaction entry point. Idempotent: applying it twice is a no-op.
export function redactQuery(text) {
  let s = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
  s = s.replace(SECRET_KV, (_m, p) => p + '[REDACTED]')
  s = s.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^/\s:@]+):([^/\s@]+)@/gi,
    (_m, sch, user, pass) => `${sch}://<cred:${hash8(user + ':' + pass)}>@`)
  s = s.replace(/(?<![A-Za-z0-9+])(?:[A-Za-z]):[\\/][^\s"'<>|，。；、：）)\]}]*/g, (m) => `<path:${hash8(m)}>`)
  s = s.replace(/\\\\[^\s"'<>|，。；、：）)\]}]+/g, (m) => `<path:${hash8(m)}>`)
  s = s.replace(/(?<![\w:])\/(?:home|Users|var|tmp|opt|etc|root|usr|mnt|d)\/[^\s"'<>|，。；、：）)\]}]*/g,
    (m) => `<path:${hash8(m)}>`)
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => `<email:${hash8(m)}>`)
  s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => `<blob:${hash8(m)}>`)
  s = s.replace(SECRET_KV, (_m, p) => p + '[REDACTED]')
  return s.length > 240 ? s.slice(0, 239) + '…' : s
}

function sanitizeSid(sid) {
  const s = clean(sid, 120)
  if (!s || s === 'unknown') return ''
  return s
}
function normalizeWorkspace(w) {
  return clean(String(w ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(), 300)
}
function cleanStep(s) {
  if (!s || typeof s !== 'object') return null
  const out = { stage: clean(s.stage, 24), n: int(s.n), ms: Math.round(num(s.ms) * 1000) / 1000 }
  if (s.why) out.why = clean(s.why, 48)
  if (s.uri) out.uri = clean(s.uri, 200)
  return out.stage ? out : null
}
function cleanCandidate(c) {
  if (!c || typeof c !== 'object') return null
  const out = { uri: clean(c.uri, 200), kind: clean(c.kind, 24), rank: int(c.rank) }
  if (Number.isFinite(Number(c.score))) out.score = Math.round(Number(c.score) * 10000) / 10000
  if (c.src) out.src = clean(c.src, 16)
  if (c.why) out.why = clean(c.why, 48)
  return out.uri ? out : null
}
function cleanSelected(c) {
  if (!c || typeof c !== 'object') return null
  const out = { uri: clean(c.uri, 200), kind: clean(c.kind, 24), rank: int(c.rank) }
  if (c.why) out.why = clean(c.why, 48)
  return out.uri ? out : null
}
function jsonBytes(v) {
  try { return Buffer.byteLength(JSON.stringify(v)) } catch { return 0 }
}

// Build a DB-shaped row with all caps applied. Returns null for missing session
// or an unknown trigger; never throws on odd input.
export function buildTrace(raw = {}) {
  const sid = sanitizeSid(raw.sid)
  const trigger = clean(raw.trigger, 16)
  if (!sid || !TRACE_TRIGGERS.has(trigger)) return null
  const qRaw = String(raw.query ?? '')
  const queryText = process.env.DSH_MEMORY_TRACE_TEXT === '0' ? '' : redactQuery(qRaw)
  const ts = Number.isFinite(Number(raw.ts)) ? Math.max(0, int(raw.ts)) : Date.now()
  let truncated = 0

  let steps = (Array.isArray(raw.steps) ? raw.steps : []).map(cleanStep).filter(Boolean)
  if (steps.length > 16) { steps = steps.slice(0, 16); truncated |= 4 }
  while (steps.length && jsonBytes(steps) > 4096) { steps.pop(); truncated |= 4 }

  let candidates = (Array.isArray(raw.candidates) ? raw.candidates : []).map(cleanCandidate).filter(Boolean)
  const candTotal = Number.isFinite(Number(raw.candTotal)) ? int(raw.candTotal) : candidates.length
  if (candidates.length > 40) { candidates = candidates.slice(0, 40); truncated |= 1 }
  while (candidates.length && jsonBytes(candidates) > 8192) { candidates.pop(); truncated |= 1 }

  let selected = (Array.isArray(raw.selected) ? raw.selected : []).map(cleanSelected).filter(Boolean)
  const selTotal = Number.isFinite(Number(raw.selTotal)) ? int(raw.selTotal) : selected.length
  if (selected.length > 20) { selected = selected.slice(0, 20); truncated |= 2 }
  while (selected.length && jsonBytes(selected) > 4096) { selected.pop(); truncated |= 2 }

  const widened = (Array.isArray(raw.widened) ? raw.widened : []).map((x) => clean(x, 32)).filter(Boolean).slice(0, 16)
  const row = {
    ts,
    sid,
    workspace: normalizeWorkspace(raw.workspace),
    trigger,
    uri: clean(raw.uri, 300),
    query_hash: qRaw.trim() ? sha1(qRaw.trim()).slice(0, 16) : '',
    query_text: queryText,
    query_len: qRaw.length,
    mode: clean(raw.mode, 32),
    widened: JSON.stringify(widened),
    steps: JSON.stringify(steps),
    candidates: JSON.stringify(candidates),
    selected: JSON.stringify(selected),
    cand_total: candTotal,
    sel_total: selTotal,
    ms: Math.round(num(raw.ms) * 1000) / 1000,
    model: clean(raw.model, 64),
    error: clean(redactQuery(raw.error ?? ''), 200),
    truncated,
    bytes: 0,
  }
  // Whole-row cap: drop tails of the three JSON arrays; if still oversized,
  // clear them and mark bit 8 so the UI can say "详情已裁剪".
  const fit = () => jsonBytes({ ...row, bytes: 0 })
  while (fit() > 16384 && (candidates.length || selected.length || steps.length)) {
    if (candidates.length) { candidates.pop(); row.truncated |= 1 }
    else if (selected.length) { selected.pop(); row.truncated |= 2 }
    else { steps.pop(); row.truncated |= 4 }
    row.candidates = JSON.stringify(candidates)
    row.selected = JSON.stringify(selected)
    row.steps = JSON.stringify(steps)
  }
  if (fit() > 16384) {
    row.steps = '[]'; row.candidates = '[]'; row.selected = '[]'
    row.truncated |= 8
  }
  row.bytes = fit()
  return row
}

function traceEnabledFor(store) {
  const env = String(process.env.DSH_MEMORY_TRACE ?? '').trim()
  if (env === '0' || env.toLowerCase() === 'false') return false
  if (env === '1' || env.toLowerCase() === 'true') return true
  try {
    const c = JSON.parse(readFileSync(join(store.stateDir, 'control.json'), 'utf8')) ?? {}
    if (c.memoryTrace === false) return false
    if (c.memoryTrace === true) return true
  } catch { /* default on */ }
  return true
}

export function traceDbPath(store) {
  if (process.env.DSH_MEMORY_TRACE_DB) return process.env.DSH_MEMORY_TRACE_DB
  let loc = ''
  try { loc = String(store?.db?.location?.() ?? '') } catch { /* ignore */ }
  if (loc && loc !== ':memory:') return loc
  return join(store.stateDir || '.', 'memory', 'traces.sqlite')
}

const MAX_ROWS = () => Math.max(100, Number(process.env.DSH_MEMORY_TRACE_ROWS) || 5000)
const MAX_DAYS = () => Math.max(1, Number(process.env.DSH_MEMORY_TRACE_DAYS) || 30)

class TraceRecorder {
  constructor(dbFile, { sync = false, maxQueue = 256, batch = 32, intervalMs = 250 } = {}) {
    this.dbFile = dbFile
    this.sync = sync
    this.maxQueue = maxQueue
    this.batch = batch
    this.queue = []
    this.writing = false
    this.closed = false
    this.fail = 0
    this.dropped = 0
    this.written = 0
    this.lastError = ''
    this.lastRetain = Date.now()
    this.sinceRetain = 0
    this.db = new DatabaseSync(dbFile)
    this.db.exec('PRAGMA busy_timeout=50')
    try { this.db.exec('PRAGMA synchronous=NORMAL') } catch { /* connection-level */ }
    ensureTraceSchema(this.db)
    this.insert = this.db.prepare(`INSERT INTO retrieval_traces
      (ts, sid, workspace, trigger, uri, query_hash, query_text, query_len, mode, widened, steps,
       candidates, selected, cand_total, sel_total, ms, model, error, truncated, bytes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    this.timer = setInterval(() => { try { this.flush() } catch { /* fail-open */ } }, intervalMs)
    this.timer.unref?.()
    this.onExit = () => { try { this.flush() } catch { /* fail-open */ } }
    try { process.once('beforeExit', this.onExit) } catch { /* ignore */ }
  }

  record(row) {
    if (!row || this.closed) return false
    if (this.sync) {
      this.queue.push(row)
      return this.flush(1).ok
    }
    this.queue.push(row)
    if (this.queue.length > this.maxQueue) {
      this.queue.shift()
      this.dropped++
    }
    if (this.queue.length >= this.batch) this.flush()
    return true
  }

  flush(max = Infinity) {
    if (this.writing || this.closed || !this.queue.length) return { ok: true, written: 0 }
    this.writing = true
    const items = this.queue.splice(0, Math.min(this.queue.length, max))
    try {
      this.db.exec('BEGIN')
      for (const r of items) {
        this.insert.run(r.ts, r.sid, r.workspace, r.trigger, r.uri, r.query_hash, r.query_text,
          r.query_len, r.mode, r.widened, r.steps, r.candidates, r.selected, r.cand_total,
          r.sel_total, r.ms, r.model, r.error, r.truncated, r.bytes)
      }
      this.db.exec('COMMIT')
      this.written += items.length
      this.fail = 0
      this.sinceRetain += items.length
      if (this.sinceRetain >= 500 || Date.now() - this.lastRetain > 6 * 3600_000) this.retain()
      return { ok: true, written: items.length }
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      this.fail++
      this.lastError = String(err?.message ?? err).slice(0, 200)
      if (this.fail <= 3) this.queue.unshift(...items)
      else this.dropped += items.length
      while (this.queue.length > this.maxQueue) { this.queue.shift(); this.dropped++ }
      return { ok: false, error: this.lastError }
    } finally {
      this.writing = false
    }
  }

  retain() {
    const days = MAX_DAYS()
    const rows = MAX_ROWS()
    try {
      this.db.exec('BEGIN')
      try {
        this.db.prepare('DELETE FROM retrieval_traces WHERE id NOT IN (SELECT id FROM retrieval_traces ORDER BY id DESC LIMIT ?)').run(rows)
        this.db.prepare('DELETE FROM retrieval_traces WHERE ts < ?').run(Date.now() - days * 86400_000)
        this.db.exec('COMMIT')
      } catch (err) {
        try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
        throw err
      }
      this.sinceRetain = 0
      this.lastRetain = Date.now()
      return true
    } catch {
      return false
    }
  }

  close() {
    if (this.closed) return
    try { this.flush() } catch { /* ignore */ }
    this.closed = true
    try { clearInterval(this.timer) } catch { /* ignore */ }
    try { process.removeListener('beforeExit', this.onExit) } catch { /* ignore */ }
    try { this.db.close() } catch { /* ignore */ }
  }
}

const recorders = new Map()

export function traceRecorderFor(store, opts = {}) {
  if (!store) return null
  const dbFile = traceDbPath(store)
  const sync = opts.sync ?? String(process.env.DSH_MEMORY_TRACE_SYNC ?? '') === '1'
  const key = dbFile + '|' + (sync ? 's' : 'a')
  if (recorders.has(key)) return recorders.get(key)
  try {
    const dir = dirname(dbFile)
    if (dir && dir !== '.' && dir !== ':memory:') mkdirSync(dir, { recursive: true })
    const rec = new TraceRecorder(dbFile, { sync })
    recorders.set(key, rec)
    return rec
  } catch {
    recorders.set(key, null)
    return null
  }
}

export function recordTrace(store, raw) {
  try {
    if (!store || !traceEnabledFor(store)) return null
    const row = buildTrace(raw)
    if (!row) return null
    const rec = traceRecorderFor(store)
    if (!rec) return null
    rec.record(row)
    return row
  } catch {
    return null
  }
}

export function flushTraces(store) {
  try {
    const rec = store ? traceRecorderFor(store) : null
    return rec ? rec.flush() : { ok: true, written: 0 }
  } catch { return { ok: false, written: 0 } }
}

export function closeTraceRecorder(store) {
  try {
    if (!store) return
    const dbFile = traceDbPath(store)
    const sync = String(process.env.DSH_MEMORY_TRACE_SYNC ?? '') === '1'
    const key = dbFile + '|' + (sync ? 's' : 'a')
    const rec = recorders.get(key)
    rec?.close()
    recorders.delete(key)
  } catch { /* fail-open */ }
}

export function closeAllTraceRecorders() {
  for (const rec of recorders.values()) { try { rec?.close() } catch { /* ignore */ } }
  recorders.clear()
}

function mapRow(r) {
  if (!r) return null
  const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d } catch { return d } }
  return {
    id: Number(r.id), ts: Number(r.ts), sid: r.sid, workspace: r.workspace, trigger: r.trigger,
    uri: r.uri, queryHash: r.query_hash, preview: clip(r.query_text, 80), queryLen: Number(r.query_len),
    mode: r.mode, candTotal: Number(r.cand_total), selTotal: Number(r.sel_total),
    ms: Number(r.ms), error: r.error, truncated: Number(r.truncated),
  }
}

function openRead(dbFile) {
  if (!dbFile || !existsSync(dbFile)) return null
  try { return new DatabaseSync(dbFile, { readOnly: true }) } catch { return null }
}

export function listTraces(dbFile, { sid, since = 0, until = 0, limit = 50, cursor = null, trigger = '' } = {}) {
  const db = openRead(dbFile)
  if (!db) return { available: false, traces: [], nextCursor: null, hasMore: false }
  try {
    const exists = db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='retrieval_traces'").get()
    if (!exists) return { available: false, traces: [], nextCursor: null, hasMore: false }
    const lim = Math.max(1, Math.min(200, Number(limit) || 50))
    const where = ['sid=?']
    const args = [String(sid)]
    if (since > 0) { where.push('ts>=?'); args.push(Number(since)) }
    if (until > 0) { where.push('ts<=?'); args.push(Number(until)) }
    if (trigger && TRACE_TRIGGERS.has(trigger)) { where.push('trigger=?'); args.push(trigger) }
    if (cursor && Number.isFinite(cursor.ts) && Number.isFinite(cursor.id)) {
      where.push('(ts<? OR (ts=? AND id<?))')
      args.push(cursor.ts, cursor.ts, cursor.id)
    }
    const rows = db.prepare(`SELECT id, ts, sid, workspace, trigger, uri, query_hash, query_text, query_len,
      mode, cand_total, sel_total, ms, error, truncated
      FROM retrieval_traces WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...args, lim + 1)
    const hasMore = rows.length > lim
    const page = rows.slice(0, lim)
    const last = page[page.length - 1]
    return {
      available: true,
      traces: page.map(mapRow),
      nextCursor: hasMore && last ? `${last.ts}:${last.id}` : null,
      hasMore,
      limit: lim,
      retention: { maxRows: MAX_ROWS(), maxDays: MAX_DAYS() },
    }
  } catch {
    return { available: false, traces: [], nextCursor: null, hasMore: false }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

export function getTrace(dbFile, id) {
  const db = openRead(dbFile)
  if (!db) return { available: false, trace: null }
  try {
    const exists = db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='retrieval_traces'").get()
    if (!exists) return { available: false, trace: null }
    const r = db.prepare('SELECT * FROM retrieval_traces WHERE id=?').get(Number(id))
    if (!r) return { available: true, trace: null }
    const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d } catch { return d } }
    return {
      available: true,
      trace: {
        id: Number(r.id), ts: Number(r.ts), sid: r.sid, workspace: r.workspace, trigger: r.trigger,
        uri: r.uri,
        query: { hash: r.query_hash, text: r.query_text, len: Number(r.query_len) },
        mode: r.mode,
        widened: parse(r.widened, []),
        steps: parse(r.steps, []),
        candidates: parse(r.candidates, []),
        selected: parse(r.selected, []),
        candTotal: Number(r.cand_total), selTotal: Number(r.sel_total),
        ms: Number(r.ms), model: r.model, error: r.error,
        truncated: Number(r.truncated), bytes: Number(r.bytes),
        ref: `rcs-trace://${r.sid}/${r.id}`,
      },
    }
  } catch {
    return { available: false, trace: null }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function hashUri(uri) {
  const s = String(uri ?? '')
  const i = s.lastIndexOf('/')
  if (i < 0 || i === s.length - 1) return s
  return s.slice(0, i + 1) + '<key:' + hash8(s.slice(i + 1)) + '>'
}

export function exportTraces(dbFile, { sid, since = 0, until = 0, limit = 5000 } = {}) {
  const db = openRead(dbFile)
  if (!db) return { available: false, rows: [] }
  try {
    const exists = db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='retrieval_traces'").get()
    if (!exists) return { available: false, rows: [] }
    const lim = Math.max(1, Math.min(5000, Number(limit) || 5000))
    const where = ['sid=?']
    const args = [String(sid)]
    if (since > 0) { where.push('ts>=?'); args.push(Number(since)) }
    if (until > 0) { where.push('ts<=?'); args.push(Number(until)) }
    const rows = db.prepare(`SELECT * FROM retrieval_traces WHERE ${where.join(' AND ')} ORDER BY ts ASC, id ASC LIMIT ?`)
      .all(...args, lim)
    const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d } catch { return d } }
    const out = rows.map((r) => ({
      ts: Number(r.ts), sid: `<sid:${hash8(r.sid)}>`, workspace: `<ws:${hash8(r.workspace)}>`,
      trigger: r.trigger, uri: hashUri(r.uri), query: { hash: r.query_hash, text: redactQuery(r.query_text), len: Number(r.query_len) },
      mode: r.mode, widened: parse(r.widened, []),
      steps: parse(r.steps, []).map((s) => ({ ...s, uri: s.uri ? hashUri(s.uri) : undefined })),
      candidates: parse(r.candidates, []).map((c) => ({ ...c, uri: hashUri(c.uri) })),
      selected: parse(r.selected, []).map((c) => ({ ...c, uri: hashUri(c.uri) })),
      candTotal: Number(r.cand_total), selTotal: Number(r.sel_total), ms: Number(r.ms),
      model: r.model, error: r.error, truncated: Number(r.truncated),
    }))
    return { available: true, rows: out }
  } catch {
    return { available: false, rows: [] }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

export function clearTraces(dbFile, sid) {
  if (!dbFile || !existsSync(dbFile)) return { ok: true, deleted: 0 }
  let db = null
  try {
    db = new DatabaseSync(dbFile)
    db.exec('PRAGMA busy_timeout=5000')
    const exists = db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='retrieval_traces'").get()
    if (!exists) return { ok: true, deleted: 0 }
    const r = db.prepare('DELETE FROM retrieval_traces WHERE sid=?').run(String(sid))
    return { ok: true, deleted: Number(r.changes) || 0 }
  } catch {
    return { ok: false, deleted: 0 }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

export function traceStats(dbFile) {
  if (!dbFile || !existsSync(dbFile)) return { available: false, rows: 0, bytes: 0 }
  const db = openRead(dbFile)
  if (!db) return { available: false, rows: 0, bytes: 0 }
  let bytes = 0
  try { bytes = statSync(dbFile).size } catch { /* ignore */ }
  try {
    const exists = db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='retrieval_traces'").get()
    if (!exists) return { available: false, rows: 0, bytes }
    const rows = Number(db.prepare('SELECT COUNT(*) c FROM retrieval_traces').get()?.c ?? 0)
    return { available: true, rows, bytes, maxRows: MAX_ROWS(), maxDays: MAX_DAYS() }
  } catch {
    return { available: false, rows: 0, bytes }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

export function traceHealth() {
  const out = []
  for (const [key, rec] of recorders) {
    out.push({ key, queued: rec?.queue.length ?? 0, written: rec?.written ?? 0, dropped: rec?.dropped ?? 0, fail: rec?.fail ?? 0, lastError: rec?.lastError ?? '' })
  }
  return out
}
