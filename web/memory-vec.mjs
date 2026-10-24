// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// memory-vec.mjs — Phase 3 semantic arm (pure math + local embedder + RRF).
//
// The vector layer is a ranking signal, never a fact source: vectors are derived
// from records, stored in a plain table, and any failure returns the lexical
// result unchanged. Default is off; callers must supply an embedding or enable
// DSH_MEMORY_VEC explicitly.

import { createHash } from 'node:crypto'

export const VEC_DEFAULTS = Object.freeze({
  k: 60,
  wLex: 1.0,
  wVec: 0.8,
  insightBoost: 1.15,
  cosFloor: 0.35,
  noAnswerCos: 0.45,
  maxK: 64,
  embedTimeoutMs: 300,
  batch: 16,
})

export const VEC_KINDS = new Set(['insight', 'file_state', 'command', 'search', 'error', 'user_answer'])

const KIND_RANK = {
  insight: 0, file_state: 1, command: 2, search: 3, user_answer: 4, error: 5,
  job: 6, task: 6, user_turn: 8, tool_unknown: 9,
}
const kindRank = (k) => KIND_RANK[k] ?? 7

export function vecNormalize(input) {
  if (!input || typeof input.length !== 'number' || !input.length) return null
  const out = new Float32Array(input.length)
  let sum = 0
  for (let i = 0; i < input.length; i++) {
    const x = Number(input[i])
    if (!Number.isFinite(x)) return null
    out[i] = x
    sum += x * x
  }
  if (!(sum > 0)) return null
  const inv = 1 / Math.sqrt(sum)
  for (let i = 0; i < out.length; i++) out[i] *= inv
  return out
}

export function vecToBlob(v) {
  if (!v || !v.length) return null
  const buf = Buffer.allocUnsafe(v.length * 4)
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(Number(v[i]), i * 4)
  return buf
}

export function vecFromBlob(blob, dim = 0) {
  if (!blob) return null
  const bytes = blob instanceof Uint8Array ? blob : (ArrayBuffer.isView(blob) ? new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength) : null)
  if (!bytes) return null
  const n = dim > 0 ? Number(dim) : Math.floor(bytes.byteLength / 4)
  if (!Number.isFinite(n) || n <= 0 || bytes.byteLength < n * 4) return null
  const ab = new ArrayBuffer(n * 4)
  new Uint8Array(ab).set(bytes.subarray(0, n * 4))
  return new Float32Array(ab)
}

export function vecDot(a, b) {
  if (!a || !b || a.length !== b.length) return null
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export function vecCosine(a, b) {
  const dot = vecDot(a, b)
  if (dot === null) return null
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) { na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!(na > 0) || !(nb > 0)) return null
  return dot / Math.sqrt(na * nb)
}

// rows: [{ record_id, vec: Uint8Array|Float32Array, ... }]
export function vecTopK(rows, query, { k = 20, floor = VEC_DEFAULTS.cosFloor, dim = 0 } = {}) {
  const q = query instanceof Float32Array ? query : vecNormalize(query)
  if (!q || !Array.isArray(rows)) return []
  const out = []
  for (const row of rows) {
    const v = row.vec instanceof Float32Array ? row.vec : vecFromBlob(row.vec, dim || q.length)
    if (!v || v.length !== q.length) continue
    const cos = vecCosine(q, v)
    if (cos === null || !Number.isFinite(cos) || cos < floor) continue
    out.push({ ...row, cos })
  }
  out.sort((a, b) => b.cos - a.cos || Number(a.record_id) - Number(b.record_id))
  return out.slice(0, Math.max(1, Number(k) || 20))
}

// Weighted reciprocal-rank fusion. Inputs are already ordered best-first;
// `lex` items are the lexical arm, `vec` items carry `cos` and full records.
export function fuseRRF(lex = [], vec = [], opts = {}) {
  const K = Number(opts.k ?? VEC_DEFAULTS.k) || VEC_DEFAULTS.k
  const wLex = Number.isFinite(Number(opts.wLex)) ? Number(opts.wLex) : VEC_DEFAULTS.wLex
  const wVec = Number.isFinite(Number(opts.wVec)) ? Number(opts.wVec) : VEC_DEFAULTS.wVec
  const boost = Number.isFinite(Number(opts.insightBoost)) ? Number(opts.insightBoost) : VEC_DEFAULTS.insightBoost
  const limit = Math.max(1, Number(opts.limit) || 10)
  const rankLex = new Map()
  const rankVec = new Map()
  const rows = new Map()
  lex.forEach((r, i) => {
    if (!r || r.rowid === undefined) return
    const id = Number(r.rowid)
    if (!Number.isFinite(id)) return
    rankLex.set(id, i + 1)
    rows.set(id, { rowid: id, rec: r, cos: null })
  })
  vec.forEach((r, i) => {
    if (!r || r.record_id === undefined) return
    const id = Number(r.record_id)
    if (!Number.isFinite(id)) return
    rankVec.set(id, i + 1)
    const prev = rows.get(id)
    if (prev) prev.cos = r.cos
    else rows.set(id, { rowid: id, rec: r.rec ?? r, cos: r.cos })
  })
  const scored = []
  for (const item of rows.values()) {
    const rl = rankLex.get(item.rowid)
    const rv = rankVec.get(item.rowid)
    let s = 0
    if (rl) s += wLex / (K + rl)
    if (rv) s += wVec / (K + rv)
    if (item.rec?.kind === 'insight') s *= boost
    scored.push({ ...item, score: s, lexRank: rl ?? null, vecRank: rv ?? null })
  }
  scored.sort((a, b) => b.score - a.score
    || kindRank(a.rec?.kind) - kindRank(b.rec?.kind)
    || Number(b.rec?.updated_ts ?? 0) - Number(a.rec?.updated_ts ?? 0)
    || a.rowid - b.rowid)
  const maxCos = vec.reduce((m, r) => (Number.isFinite(r?.cos) ? Math.max(m, r.cos) : m), 0)
  return { items: scored.slice(0, limit), total: scored.length, maxCos }
}

export function vecQueryEligible(query) {
  const s = String(query ?? '').trim()
  if (!s) return false
  if (/[\u3400-\u9fff]/.test(s)) return s.replace(/\s+/g, '').length >= 2
  return /[A-Za-z][A-Za-z0-9_./#-]{2,}/.test(s)
}

export function vecSrcHash(model, key, text) {
  return createHash('sha1').update(String(model ?? '') + '\n' + String(key ?? '') + '\n' + String(text ?? '')).digest('hex')
}

export function vecLocalUrl(raw) {
  try {
    const u = new URL(String(raw || ''))
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

function parseVectors(data) {
  const list = Array.isArray(data?.embeddings) ? data.embeddings
    : (Array.isArray(data?.data) ? data.data.map((d) => d?.embedding) : null)
  if (!Array.isArray(list)) return null
  const out = []
  for (const item of list) {
    const v = vecNormalize(item)
    if (!v) return null
    out.push(v)
  }
  return out
}

// One batch call. The default budget is 300 ms and only loopback endpoints are
// allowed (the text never leaves the machine unless explicitly overridden).
export async function embedBatch({
  url = 'http://127.0.0.1:11434', model = '', texts = [], timeoutMs = VEC_DEFAULTS.embedTimeoutMs,
  allowRemote = false, fetchImpl = globalThis.fetch,
} = {}) {
  const list = Array.isArray(texts) ? texts.map((t) => String(t ?? '')).filter(Boolean) : []
  if (!list.length) return { ok: true, vectors: [], dim: 0, ms: 0 }
  if (!model) return { ok: false, error: 'model-missing' }
  if (!allowRemote && !vecLocalUrl(url)) return { ok: false, error: 'remote-not-allowed' }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch-unavailable' }
  const base = String(url).replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => { try { ctrl.abort() } catch { /* ignore */ } }, Math.max(10, Number(timeoutMs) || VEC_DEFAULTS.embedTimeoutMs))
  timer.unref?.()
  const t0 = performance.now()
  try {
    const res = await fetchImpl(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: list }),
      signal: ctrl.signal,
    })
    if (!res || !res.ok) return { ok: false, error: 'http-' + (res?.status ?? 'error'), ms: Number((performance.now() - t0).toFixed(3)) }
    const data = await res.json()
    const vectors = parseVectors(data)
    if (!vectors || vectors.length !== list.length) return { ok: false, error: 'bad-response', ms: Number((performance.now() - t0).toFixed(3)) }
    const dim = vectors[0]?.length ?? 0
    if (!dim || vectors.some((v) => v.length !== dim)) return { ok: false, error: 'dim-mismatch', ms: Number((performance.now() - t0).toFixed(3)) }
    return { ok: true, vectors, dim, model, ms: Number((performance.now() - t0).toFixed(3)) }
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message ?? ''))
    return { ok: false, error: aborted ? 'timeout' : 'request-failed', ms: Number((performance.now() - t0).toFixed(3)) }
  } finally {
    clearTimeout(timer)
  }
}

// Probe /api/tags for the first embedding-capable model (Ollama reports
// capabilities; do not trust error text such as 501 during startup).
export async function probeEmbedder({
  url = 'http://127.0.0.1:11434', timeoutMs = 500, allowRemote = false, fetchImpl = globalThis.fetch,
} = {}) {
  if (!allowRemote && !vecLocalUrl(url)) return { ok: false, error: 'remote-not-allowed' }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch-unavailable' }
  const base = String(url).replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => { try { ctrl.abort() } catch { /* ignore */ } }, Math.max(10, Number(timeoutMs) || 500))
  timer.unref?.()
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: ctrl.signal })
    if (!res || !res.ok) return { ok: false, error: 'http-' + (res?.status ?? 'error') }
    const data = await res.json()
    const models = Array.isArray(data?.models) ? data.models : []
    const hit = models.find((m) => Array.isArray(m?.capabilities) && m.capabilities.includes('embedding'))
      ?? models.find((m) => /embed/i.test(String(m?.name ?? '')))
    if (!hit) return { ok: false, error: 'model-missing', models: models.length }
    return { ok: true, model: String(hit.name ?? hit.model ?? ''), models: models.length }
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message ?? ''))
    return { ok: false, error: aborted ? 'timeout' : 'request-failed' }
  } finally {
    clearTimeout(timer)
  }
}
