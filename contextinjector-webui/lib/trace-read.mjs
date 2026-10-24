// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// trace-read.mjs — read-only access to Phase 4 retrieval traces for the WebUI host half.
// Kept inside the package so the WebUI can be loaded without reaching into ../../web.
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const sha1 = (s) => createHash('sha1').update(String(s ?? '')).digest('hex')
const hash8 = (s) => '#' + sha1(s).slice(0, 8)
const clip = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t
}
const TRIGGERS = new Set(['tool', 'ls', 'recall', 'inject', 'handover'])

function open(path) {
  if (!path || !existsSync(path)) return null
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    for (const p of ['busy_timeout=5000', 'cache_size=-65536']) {
      try { db.exec('PRAGMA ' + p) } catch { /* ignore */ }
    }
    return db
  } catch { return null }
}
function hasTable(db) {
  try { return !!db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='retrieval_traces'").get() } catch { return false }
}
const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d } catch { return d } }

function mapRow(r) {
  return {
    id: Number(r.id), ts: Number(r.ts), sid: r.sid, workspace: r.workspace, trigger: r.trigger,
    uri: r.uri, queryHash: r.query_hash, preview: clip(r.query_text, 80), queryLen: Number(r.query_len),
    mode: r.mode, candTotal: Number(r.cand_total), selTotal: Number(r.sel_total),
    ms: Number(r.ms), error: r.error, truncated: Number(r.truncated),
  }
}

export function listTraces(dbFile, { sid, since = 0, until = 0, limit = 50, cursor = null, trigger = '' } = {}) {
  const db = open(dbFile)
  if (!db) return { available: false, traces: [], nextCursor: null, hasMore: false }
  try {
    if (!hasTable(db)) return { available: false, traces: [], nextCursor: null, hasMore: false }
    const lim = Math.max(1, Math.min(200, Number(limit) || 50))
    const where = ['sid=?']
    const args = [String(sid)]
    if (since > 0) { where.push('ts>=?'); args.push(Number(since)) }
    if (until > 0) { where.push('ts<=?'); args.push(Number(until)) }
    if (trigger && TRIGGERS.has(trigger)) { where.push('trigger=?'); args.push(trigger) }
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
      available: true, traces: page.map(mapRow),
      nextCursor: hasMore && last ? `${last.ts}:${last.id}` : null, hasMore, limit: lim,
    }
  } catch {
    return { available: false, traces: [], nextCursor: null, hasMore: false }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

export function getTrace(dbFile, id) {
  const db = open(dbFile)
  if (!db) return { available: false, trace: null }
  try {
    if (!hasTable(db)) return { available: false, trace: null }
    const r = db.prepare('SELECT * FROM retrieval_traces WHERE id=?').get(Number(id))
    if (!r) return { available: true, trace: null }
    return {
      available: true,
      trace: {
        id: Number(r.id), ts: Number(r.ts), sid: r.sid, workspace: r.workspace, trigger: r.trigger, uri: r.uri,
        query: { hash: r.query_hash, text: r.query_text, len: Number(r.query_len) },
        mode: r.mode, widened: parse(r.widened, []), steps: parse(r.steps, []),
        candidates: parse(r.candidates, []), selected: parse(r.selected, []),
        candTotal: Number(r.cand_total), selTotal: Number(r.sel_total), ms: Number(r.ms),
        model: r.model, error: r.error, truncated: Number(r.truncated), bytes: Number(r.bytes),
        ref: `rcs-trace://${r.sid}/${r.id}`,
      },
    }
  } catch {
    return { available: false, trace: null }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function redactExport(text) {
  let s = String(text ?? '')
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
  s = s.replace(/((?:password|passwd|pwd|token|api[_-]?key|secret)\s*[=:]\s*)([^\s,;]+)/gi, (_m, p) => p + '[REDACTED]')
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => `<email:${hash8(m)}>`)
  return s
}
function hashUri(uri) {
  const s = String(uri ?? '')
  const i = s.lastIndexOf('/')
  if (i < 0 || i === s.length - 1) return s
  return s.slice(0, i + 1) + '<key:' + hash8(s.slice(i + 1)) + '>'
}

export function exportTraces(dbFile, { sid, since = 0, until = 0, limit = 5000 } = {}) {
  const db = open(dbFile)
  if (!db) return { available: false, rows: [] }
  try {
    if (!hasTable(db)) return { available: false, rows: [] }
    const lim = Math.max(1, Math.min(5000, Number(limit) || 5000))
    const where = ['sid=?']
    const args = [String(sid)]
    if (since > 0) { where.push('ts>=?'); args.push(Number(since)) }
    if (until > 0) { where.push('ts<=?'); args.push(Number(until)) }
    const rows = db.prepare(`SELECT * FROM retrieval_traces WHERE ${where.join(' AND ')} ORDER BY ts ASC, id ASC LIMIT ?`)
      .all(...args, lim)
    return {
      available: true,
      rows: rows.map((r) => ({
        ts: Number(r.ts), sid: `<sid:${hash8(r.sid)}>`, workspace: `<ws:${hash8(r.workspace)}>`,
        trigger: r.trigger, uri: hashUri(r.uri),
        query: { hash: r.query_hash, text: redactExport(r.query_text), len: Number(r.query_len) },
        mode: r.mode, widened: parse(r.widened, []),
        steps: parse(r.steps, []).map((s) => ({ ...s, uri: s.uri ? hashUri(s.uri) : undefined })),
        candidates: parse(r.candidates, []).map((c) => ({ ...c, uri: hashUri(c.uri) })),
        selected: parse(r.selected, []).map((c) => ({ ...c, uri: hashUri(c.uri) })),
        candTotal: Number(r.cand_total), selTotal: Number(r.sel_total), ms: Number(r.ms),
        model: r.model, error: r.error, truncated: Number(r.truncated),
      })),
    }
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
    try { db.exec('PRAGMA cache_size=-65536') } catch { /* ignore */ }
    if (!hasTable(db)) return { ok: true, deleted: 0 }
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
  let bytes = 0
  try { bytes = statSync(dbFile).size } catch { /* ignore */ }
  const db = open(dbFile)
  if (!db) return { available: false, rows: 0, bytes }
  try {
    if (!hasTable(db)) return { available: false, rows: 0, bytes }
    return { available: true, rows: Number(db.prepare('SELECT COUNT(*) c FROM retrieval_traces').get()?.c ?? 0), bytes }
  } catch {
    return { available: false, rows: 0, bytes }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

export const TRACE_TRIGGERS = TRIGGERS
