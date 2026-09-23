// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// toolfold.mjs — 工具结果折叠：结构化短行 [T] 升级 + 值保真链 [V]（A档最小集，纯规则）
// 规格：docs/seminar/Draft of the tool result collapse rules.md (§1.1/1.2/1.3)
// 行格式（旧档前缀兼容）：
//   [T] tool|action|target|status|P<n>|k=v|k="verbatim"|bare...
//   [V] <seq>|tool|action|target|field|<verbatim 原文（单次转义）>
// status ∈ OK|FAIL|PARTIAL|CANCEL；P3 字段强制同时写 [V]；纯规则、无 LLM、正文不回流。
// 与 DSH 解耦、可离线单测：输入 (action, args, resultText, isError, {fs})。
import { createHash } from 'node:crypto'

const C = { HEAD: 200, TAIL: 200, TEE_BYTES: 2048, GREP_MATCHES: 10, GLOB_MATCHES: 20 }

// ---- 转义（只做一次；值内含裸 | \ " 换行时整体引号包裹并转义）----
function escVal(raw, forceQuote = false) {
  let s = String(raw == null ? '' : raw)
  const special = /[|\\"\n]/.test(s)
  if (!forceQuote && !special) return s
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\|/g, '\\|').replace(/\n/g, '\\n') + '"'
}
// 字段段：k=v（v 只在组装时转义一次）
const pair = (k, v, quote = false) => ({ k, v, quote })

// 【#2 修复（取自 RCS-0.1.0 返回包）】状态词表归一：结构化档用 OK|FAIL|PARTIAL|CANCEL，
// 注入器非结构化档用 OK|ERR（见 contextinjector `[T] op | path | ${isErr?'ERR':'OK'}`）。
// 不归一会导致"同一状态两套词"、下游匹配不上（反馈："[T] 行 ok 解析不匹配"）。
function normalizeStatus(s) {
  const v = String(s ?? '').trim().toUpperCase()
  if (v === 'ERR' || v === 'ERROR') return 'FAIL'
  if (v === 'OK' || v === 'FAIL' || v === 'PARTIAL' || v === 'CANCEL') return v
  return v || 'OK'
}

// 【#2 修复（取自 RCS-0.1.0 返回包）】兼容两种 [T] 行：
//   ① 结构化（本模块产出）：[T] tool|action|target|status|P<n>|k=v|…  （≥5 字段）
//   ② 非结构化（contextinjector 产出）：[T] op | path | OK/ERR        （3 字段）
// 旧实现要求 ≥5 字段 → 注入器的 [T] 行恒返回 null（"ok 解析不匹配"根因）。
export function parseRow(line) {
  const m = /^\[T\] (.*)$/.exec(String(line).trim())
  if (!m) return null
  const toks = tokenize(m[1])
  if (toks.length >= 5) {
    const [tool, action, target, status, grade] = toks.slice(0, 5)
    const fields = {}
    for (const t of toks.slice(5)) {
      const eq = t.indexOf('=')
      if (eq > 0) fields[t.slice(0, eq)] = t.slice(eq + 1)
      else fields[t] = t
    }
    return { tool, action, target, status: normalizeStatus(status), grade, fields, format: 'structured' }
  }
  if (toks.length === 3) {
    // 非结构化：[T] op | path | OK/ERR（注入器用 " | " 分隔 → token 需 trim）
    const [op, target, status] = toks.map((t) => t.trim())
    return { tool: op, action: op, target, status: normalizeStatus(status), grade: '', fields: {}, format: 'plain' }
  }
  return null
}
function tokenize(str) {
  const out = []; let cur = '', q = false, i = 0
  while (i < str.length) {
    const ch = str[i]
    if (q) {
      if (ch === '\\' && i + 1 < str.length) { cur += str[i + 1]; i += 2; continue }
      if (ch === '"') { q = false; i++; continue }
      cur += ch; i++; continue
    }
    if (ch === '"') { q = true; i++; continue }
    if (ch === '|') { if (cur !== '') out.push(cur); cur = ''; i++; continue }
    cur += ch; i++
  }
  if (cur !== '') out.push(cur)
  return out
}

// ---- 通用 ---------------------------------------------------------------
export function statusOf(isError, extra = {}) {
  if (isError) return 'FAIL'
  if (extra.cancelled) return 'CANCEL'
  if (extra.partial) return 'PARTIAL'
  return 'OK'
}
function firstLine(text) { return String(text ?? '').split('\n')[0] ?? '' }
function headTail(text, h = C.HEAD, t = C.TAIL) {
  const s = String(text == null ? '' : text)
  return { head: s.slice(0, h), tail: s.slice(-t), len: s.length }
}
function targetOf(action, args = {}) {
  for (const k of ['file_path', 'path', 'directory', 'pattern', 'query', 'url', 'job_id', 'goal_id', 'scope']) {
    if (typeof args[k] === 'string' && args[k]) return args[k]
  }
  if (action === 'ask_user_question' && typeof args.question === 'string') return args.question
  return '-'
}
function fsMeta(fs, path) {
  try {
    if (!fs || !path || path === '-') return null
    const buf = fs.readFileSync(path)
    return {
      size: buf.length,
      sha8: createHash('sha256').update(buf).digest('hex').slice(0, 8),
      lines: buf.toString('utf8').split('\n').length,
    }
  } catch { return null }
}

// ---- action 规则：返回 { status, grade, pairs:[{k,v,quote}], v:[{f,v}] } ----
const errPair = (pairs, v) => { pairs.push(pair('err', v, true)); return { f: 'err', v } }
function readRule({ args, text, isError, fs }) {
  const pairs = []; const v = []
  if (isError) { v.push(errPair(pairs, firstLine(text))); return { status: 'FAIL', grade: 'P1', pairs, v } }
  const path = targetOf('read', args)
  const meta = fsMeta(fs, path)
  if (meta) pairs.push(pair('size', meta.size), pair('lines', meta.lines), pair('sha8', meta.sha8))
  else pairs.push(pair('chars', String(text ?? '').length))
  return { status: 'OK', grade: 'P1', pairs, v }
}
function writeRule({ args, text, isError, fs }) {
  const pairs = []; const v = []
  if (isError) { v.push(errPair(pairs, firstLine(text))); return { status: 'FAIL', grade: 'P1', pairs, v } }
  const path = targetOf('write', args)
  const meta = fsMeta(fs, path)
  if (meta) pairs.push(pair('size', meta.size), pair('sha8', meta.sha8))
  else pairs.push(pair('ok', 1))
  return { status: 'OK', grade: 'P1', pairs, v }
}
function searchRule({ action, args, text, isError }) {
  const pairs = []; const v = []
  if (isError) { v.push(errPair(pairs, firstLine(text))); return { status: 'FAIL', grade: 'P2', pairs, v } }
  const pat = args.pattern || args.query || args.scope || '-'
  const lines = String(text ?? '').split('\n').filter((l) => l.trim())
  const K = action === 'grep' ? C.GREP_MATCHES : C.GLOB_MATCHES
  pairs.push(pair('pattern', pat), pair('count', lines.length))
  if (lines.length) pairs.push(pair('matches', lines.slice(0, K).join('\\n')))
  if (lines.length > K) pairs.push(pair('trunc', 'matches'))
  return { status: 'OK', grade: 'P2', pairs, v }
}
function shellRule({ args, text, isError }) {
  const pairs = []; const v = []
  const { head, tail, len } = headTail(text)
  pairs.push(pair('cmd', (args.cmd || args.command || args.arguments || '').slice(0, 80)),
    pair('exit', isError ? '!=0' : '0'), pair('out_n', len))
  if (len > 0) pairs.push(pair('head', head), pair('tail', tail))
  if (len > C.TEE_BYTES) pairs.push(pair('tee', 'REQUIRED'))
  if (isError) v.push(errPair(pairs, firstLine(text)))
  return { status: isError ? 'FAIL' : 'OK', grade: 'P2', pairs, v }
}
function askRule({ args, text, isError }) {
  const pairs = []; const v = []
  const val = String(text ?? '')
  v.push({ f: 'val', v: val })
  pairs.push(pair('q', args.question || '-', true))
  if (isError) v.push(errPair(pairs, firstLine(text)))
  return { status: isError ? 'FAIL' : 'OK', grade: 'P3', pairs, v }
}
function jobRule({ args, text, isError }) {
  const pairs = []; const v = []
  const id = args.job_id || firstLine(text).slice(0, 40) || '-'
  const { tail, len } = headTail(text)
  v.push({ f: 'job_id', v: id })
  pairs.push(pair('job_id', id, true), pair('state', isError ? 'fail' : 'done'))
  if (len) pairs.push(pair('out_n', len), pair('tail', tail))
  if (isError) v.push(errPair(pairs, firstLine(text)))
  return { status: isError ? 'FAIL' : 'OK', grade: 'P1', pairs, v }
}
function stateRule({ text, isError }) {
  const pairs = []; const v = []
  if (isError) v.push(errPair(pairs, firstLine(text)))
  return { status: isError ? 'FAIL' : 'OK', grade: 'P0', pairs, v }
}
function imageRule({ isError }) {
  const pairs = []; const v = []
  if (isError) { v.push(errPair(pairs, 'decode-error')); return { status: 'FAIL', grade: 'P1', pairs, v } }
  return { status: 'OK', grade: 'P1', pairs, v }
}
const RULES = {
  read: readRule, write: writeRule, edit: writeRule, str_replace: writeRule,
  glob: (x) => searchRule(Object.assign({}, x, { action: 'glob' })),
  grep: (x) => searchRule(Object.assign({}, x, { action: 'grep' })),
  pwsh: shellRule, bash: shellRule,
  ask_user_question: askRule, job_output: jobRule,
  create_goal: stateRule, get_goal: stateRule, update_goal: stateRule,
  job_list: stateRule, job_kill: stateRule, todo_write: stateRule, read_image: imageRule,
}
function fallbackRule({ text, isError }) {
  const pairs = []; const v = []
  if (isError) v.push(errPair(pairs, firstLine(text)))
  return { status: isError ? 'FAIL' : 'OK', grade: 'P1', pairs, v }
}

let VSEQ = 0
// 组装：为一条工具结果生成 [T] 行 + 需要的 [V] 行
export function foldOne({ action, args = {}, text = '', isError = false, fs = null, tool = 'tool' }) {
  const rule = RULES[action] || fallbackRule
  const r = rule({ action, args, text, isError, fs })
  const target = targetOf(action, args)
  // 先写 [V]（拿真实 seq），再在 [T] 里引用首条
  let firstSeq = 0
  const vs = []
  for (const it of r.v || []) {
    const seq = ++VSEQ
    if (!firstSeq) firstSeq = seq
    vs.push(`[V] ${seq}|${tool}|${action}|${target}|${it.f}|${escVal(it.v, true)}`)
  }
  const atom = [tool, action, target, r.status, r.grade].map((s) => escVal(s, false))
  const out = r.pairs.map((p) => p.k + '=' + escVal(p.v, p.quote))
  if (firstSeq) out.push('ref=V' + firstSeq)
  const t = '[T] ' + atom.concat(out).join('|')
  return { t, vs }
}
