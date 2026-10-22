// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// toolfold.mjs — 工具结果折叠：结构化短行 [T] 升级 + 值保真链 [V]（A档最小集，纯规则）
// 规格：docs/seminar/Draft of the tool result collapse rules.md (§1.1/1.2/1.3)
// 行格式（旧档前缀兼容）：
//   [T] tool|action|target|status|P<n>|k=v|k="verbatim"|bare...
//   [V] <seq>|tool|action|target|field|<verbatim 原文（单次转义）>
// status ∈ OK|FAIL|PARTIAL|CANCEL；P3 字段强制同时写 [V]；纯规则、无 LLM、正文不回流。
// 与 DSH 解耦、可离线单测：输入 (action, args, resultText, isError, {fs})。
import { createHash } from 'node:crypto'

const C = { HEAD: 200, TAIL: 200, TEE_BYTES: 2048, GREP_MATCHES: 10, GLOB_MATCHES: 20,
  READ_HEAD_LINES: 24, READ_HEAD_CHARS: 800, READ_TAIL_LINES: 8, READ_TAIL_CHARS: 280, READ_OUTLINE_CHARS: 320 }

// read 预览：确定性抽取，不做摘要。目的不是替代原文，而是让模型在折叠后仍知道
// “这个文件是什么、开头/结尾长什么样、有哪些结构符号”，避免把 8KB 源码压成一行
// `chars=8365` 后被迫重读。正文仍可经 [T] 的 raw=<seq> 精确展开。
const CODE_EXT = /\.(?:py|pyw|js|mjs|cjs|ts|tsx|jsx|java|go|rs|c|h|cc|cpp|hpp|cs|rb|php|sh|ps1|tex|md|ya?ml|toml)$/i
function clipHead(s, n) {
  const t = String(s ?? '')
  if (t.length <= n) return { text: t, cut: false }
  return { text: t.slice(0, n), cut: true }
}
// 大纲不是 AST：按语言做行级词法匹配，但补齐了正则方案最容易错的三件事——
// 多行签名拼接、`const x = (...) =>` 与普通括号表达式的区分、类/impl 上下文前缀。
const JS_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'])
const CONTROL_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'new', 'await', 'yield', 'super', 'this', 'do', 'else', 'try', 'finally', 'foreach', 'using', 'lock', 'fixed'])
const OUTLINE_RULES = {
  js: [
    { kind: 'class', ctx: true, re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', re: /^(?:export\s+)?(?:default\s+)?(?:interface|enum)\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: 'function', re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/ },
    // 箭头函数必须出现 `=>`；参数表不嵌套括号，避免把 `const x = (() => ...)` 这类 IIFE 当函数。
    { kind: 'function', re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/ },
    { kind: 'method', method: true, re: /^(?:(?:static|async|get|set|override|public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?$/ },
  ],
  py: [
    { kind: 'class', re: /^class\s+([A-Za-z_]\w*)/ },
    { kind: 'def', re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  go: [
    { kind: 'type', re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/ },
    { kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/ },
  ],
  rs: [
    { kind: 'class', ctx: true, re: /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/ },
    { kind: 'class', ctx: true, re: /^(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/ },
    { kind: 'mod', ctx: true, re: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/ },
  ],
  jvm: [
    { kind: 'class', ctx: true, re: /^(?:(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp|partial)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'method', method: true, re: /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp|virtual|override|async|sealed|internal|extern|unsafe)\s+)+(?:[\w$<>\[\],.?\s]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?$/ },
  ],
  c: [
    { kind: 'class', ctx: true, re: /^(?:typedef\s+)?(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*$/ },
    { kind: 'function', re: /^(?!\s*(?:if|for|while|switch|catch|return|sizeof|else|do|case|goto)\b)(?:[A-Za-z_][\w \t*&:<>,]*?)\b([A-Za-z_]\w*)\s*\([^;]*\)$/ },
  ],
  rb: [
    { kind: 'class', re: /^(?:class|module)\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/ },
  ],
  php: [
    { kind: 'class', ctx: true, re: /^(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/ },
    { kind: 'method', method: true, re: /^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::\s*[^{]+)?$/ },
    { kind: 'function', re: /^function\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  sh: [
    { kind: 'function', re: /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*$/ },
    { kind: 'function', re: /^function\s+([A-Za-z_]\w*)\s*$/ },
  ],
  ps1: [
    { kind: 'function', re: /^function\s+([A-Za-z_][\w-]*)/ },
  ],
  tex: [
    { kind: 'section', re: /^\\(?:part|chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/ },
  ],
  md: [
    { kind: 'heading', nameGroup: 2, re: /^(#{1,3})\s+(.+)$/ },
  ],
}
function rulesFor(ext) {
  if (JS_EXT.has(ext)) return OUTLINE_RULES.js
  if (ext === 'py' || ext === 'pyw') return OUTLINE_RULES.py
  if (ext === 'go') return OUTLINE_RULES.go
  if (ext === 'rs') return OUTLINE_RULES.rs
  if (ext === 'java' || ext === 'cs') return OUTLINE_RULES.jvm
  if (ext === 'c' || ext === 'h' || ext === 'cc' || ext === 'cpp' || ext === 'hpp') return OUTLINE_RULES.c
  if (ext === 'rb') return OUTLINE_RULES.rb
  if (ext === 'php') return OUTLINE_RULES.php
  if (ext === 'sh') return OUTLINE_RULES.sh
  if (ext === 'ps1') return OUTLINE_RULES.ps1
  if (ext === 'tex') return OUTLINE_RULES.tex
  if (ext === 'md') return OUTLINE_RULES.md
  return []
}
// 宿主 read 结果带 `N: ` 行号前缀（以及 <content> 包装），结构行必须先剥掉它。
function outlineLine(raw) {
  return String(raw ?? '').replace(/^\s*\d+:\s?/, '').trim()
}
function outlineIndent(raw) {
  const s = String(raw ?? '').replace(/^\s*\d+:\s?/, '')
  return /^[ \t]*/.exec(s)[0].replace(/\t/g, '    ').length
}
function tidySignature(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*\)/g, ')')
    .replace(/\s*[:{]\s*$/, '')
    .trim()
}
function needsMoreSignature(s) {
  const t = String(s).replace(/\s*\{\s*$/, '')
  let p = 0, b = 0, c = 0
  for (const ch of t) {
    if (ch === '(') p++
    else if (ch === ')') p--
    else if (ch === '[') b++
    else if (ch === ']') b--
    else if (ch === '{') c++
    else if (ch === '}') c--
  }
  return p > 0 || b > 0 || c > 0 || /\\$/.test(t)
}
function signatureAt(lines, i) {
  let text = outlineLine(lines[i])
  for (let j = i + 1; j < Math.min(lines.length, i + 6) && needsMoreSignature(text); j++) {
    const next = outlineLine(lines[j])
    if (!next) break
    text += ' ' + next
  }
  return tidySignature(text)
}
// 去掉函数/类的块体，但保留参数里的默认值对象（`opts = {}` 的花括号在括号内，不能切）。
function cutBody(s) {
  let p = 0, b = 0, c = 0, last = -1
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') p++
    else if (ch === ')') p--
    else if (ch === '[') b++
    else if (ch === ']') b--
    else if (ch === '{') {
      if (p === 0 && b === 0 && c === 0) last = i
      c++
    } else if (ch === '}') c--
  }
  return last > 0 ? s.slice(0, last).trimEnd() : s
}
function braceDelta(line) {
  const s = String(line).replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/\/\/.*$/, '')
  let d = 0
  for (const ch of s) {
    if (ch === '{') d++
    else if (ch === '}') d--
  }
  return d
}
function matchRule(line, rules, { inClass, indent }) {
  for (const rule of rules) {
    if (rule.method && (!inClass || indent <= 0)) continue
    const m = rule.re.exec(line)
    if (!m) continue
    const name = m[rule.nameGroup ?? 1] ?? ''
    if (rule.method && CONTROL_NAMES.has(name)) continue
    return { kind: rule.kind, name, rule }
  }
  return null
}
export function codeOutline(lines, ext = '', limit = 8) {
  const rules = rulesFor(ext)
  if (!rules.length) return []
  const found = []
  const add = (decl, sig, ctx, isMethod, groupOrder = null, cat = 0) => {
    let clean = tidySignature(sig)
    if (!clean) return
    // 单行函数体不能进大纲：箭头函数截到 `=>`，其余截到配平后的块体 `{`。
    const arrow = /^(?:export\s+)?(?:const|let|var)\b/.test(clean) ? clean.indexOf('=>') : -1
    if (arrow >= 0) clean = clean.slice(0, arrow + 2)
    else if (decl.kind === 'type') clean = clean.replace(/\s*=.*$/, '')
    else if (decl.kind !== 'section' && decl.kind !== 'heading') clean = cutBody(clean)
    const at = decl.name ? clean.indexOf(decl.name) : -1
    const tail = at >= 0 ? clean.slice(at) : clean
    const label = clipHead(isMethod ? (ctx ? ctx + '.' : '') + tail : clean, 100).text
    const order = found.length
    found.push({ label, cat, group: groupOrder ?? order, order })
  }
  if (ext === 'py' || ext === 'pyw') {
    const stack = []
    for (let i = 0; i < lines.length; i++) {
      const line = outlineLine(lines[i])
      // 注释/包装行不是语句，不能让它们参与缩进 dedent，否则类下面的方法会丢上下文。
      if (!line || line.startsWith('#') || line.startsWith('<')) continue
      const indent = outlineIndent(lines[i])
      while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop()
      const decl = matchRule(cutBody(tidySignature(line)), rules, { inClass: stack.some((x) => x.kind === 'class'), indent })
      if (!decl) continue
      const classStack = stack.filter((x) => x.kind === 'class')
      const classes = classStack.map((x) => x.name)
      const isMethod = decl.kind === 'def' && classes.length > 0
      const owner = isMethod ? classStack[classStack.length - 1] : null
      const cat = isMethod ? Math.max(1, owner?.cat ?? 0) : stack.length === 0 ? 0 : 2
      const order = found.length
      add(decl, signatureAt(lines, i), classes.join('.'), isMethod, owner?.order ?? null, cat)
      stack.push({ name: decl.name, indent, kind: decl.kind === 'class' ? 'class' : 'def', order, cat })
    }
  } else {
    const stack = []
    let depth = 0
    let pending = null
    for (let i = 0; i < lines.length; i++) {
      const line = outlineLine(lines[i])
      if (!line) continue
      while (stack.length && depth < stack[stack.length - 1].depth) stack.pop()
      const inClass = stack.length > 0 && depth === stack[stack.length - 1].depth
      const decl = matchRule(cutBody(tidySignature(line)), rules, { inClass, indent: outlineIndent(lines[i]) })
      if (decl) {
        const isMethod = !!decl.rule.method || (inClass && decl.kind === 'function')
        const ctx = stack.map((x) => x.name).join('.')
        const order = found.length
        const owner = stack.length ? stack[stack.length - 1] : null
        const cat = isMethod ? Math.max(1, owner?.cat ?? 0) : depth <= 0 ? 0 : 2
        add(decl, signatureAt(lines, i), ctx, isMethod, isMethod && owner ? owner.order : null, cat)
        if (decl.rule.ctx) {
          if (line.includes('{')) stack.push({ name: decl.name || tidySignature(line), order, cat, depth: depth + 1 })
          else pending = { name: decl.name || tidySignature(line), order, cat }
        }
      } else if (pending && line.includes('{')) {
        stack.push({ name: pending.name, order: pending.order, cat: pending.cat, depth: depth + 1 })
        pending = null
      }
      depth += braceDelta(line)
    }
  }
  // 顶层 → 成员 → 深层嵌套；同类按文件顺序，方法跟随其所属类，类永远排在自己的方法前。
  found.sort((a, b) => a.cat - b.cat || a.group - b.group || a.order - b.order)
  const out = []
  for (const item of found) {
    if (out.includes(item.label)) continue
    out.push(item.label)
    if (out.length >= limit) break
  }
  return out
}
export function readPreview(text, path) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!s) return { head: '', tail: '', outline: '', truncated: false }
  const lines = s.split('\n')
  const headRaw = lines.slice(0, C.READ_HEAD_LINES).join('\n')
  const head = clipHead(headRaw, C.READ_HEAD_CHARS)
  const coveredByHead = headRaw.length
  const wantTail = lines.length > C.READ_HEAD_LINES + C.READ_TAIL_LINES || head.cut
  const tailRaw = wantTail && s.length > coveredByHead ? lines.slice(-C.READ_TAIL_LINES).join('\n') : ''
  const tail = tailRaw.length > C.READ_TAIL_CHARS
    ? { text: tailRaw.slice(-C.READ_TAIL_CHARS), cut: true }
    : { text: tailRaw, cut: false }
  let outline = ''
  const ext = (/\.([a-z0-9]+)$/i.exec(String(path ?? ''))?.[1] ?? '').toLowerCase()
  if (CODE_EXT.test(String(path ?? '')) && lines.length > C.READ_HEAD_LINES) {
    const items = codeOutline(lines, ext).filter((x) => !head.text.includes(x))
    const picked = []
    let used = 0
    for (const item of items) {
      const need = (picked.length ? 2 : 0) + item.length
      if (used + need > C.READ_OUTLINE_CHARS) break
      picked.push(item)
      used += need
    }
    if (picked.length >= 1) outline = picked.join('; ')
  }
  return { head: head.text, tail: tail.text, outline, truncated: head.cut || tail.cut || lines.length > C.READ_HEAD_LINES }
}


// ---- 转义（只做一次；值内含裸 | \ " 换行时整体引号包裹并转义）----
function escVal(raw, forceQuote = false) {
  let s = String(raw == null ? '' : raw)
  // ⚠ 必须连 \r 一起转义：本模块的输出是**行式**格式（一行一条 [T]/[V]），而 Windows 工具
  //   正文普遍是 \r\n。只转 \n 会留下裸 CR，写进只增日志后 CR 自身被当换行 ⇒ 一行撑成多行，
  //   面板 parseTranscript 与任何按行解析的下游都会读到垃圾续行（2026-09-29 重建事故日志时暴露）。
  const special = /[|\\"\n\r]/.test(s)
  if (!forceQuote && !special) return s
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\|/g, '\\|').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"'
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
  if (toks.length >= 3) {
    // 非结构化：[T] op | path | OK/ERR（注入器用 " | " 分隔 → token 需 trim）；
    // 新转录还会追加 raw=/call= 指针，解析器容忍并收进 fields。
    const [op, target, status] = toks.slice(0, 3).map((t) => t.trim())
    const fields = {}
    for (const rawTok of toks.slice(3)) {
      const t = rawTok.trim()
      const eq = t.indexOf('=')
      if (eq > 0) fields[t.slice(0, eq)] = t.slice(eq + 1)
    }
    return { tool: op, action: op, target, status: normalizeStatus(status), grade: '', fields, format: 'plain' }
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
  for (const k of ['file_path', 'path', 'directory', 'pattern', 'query', 'url', 'job_id', 'goal_id', 'scope', 'cd', 'name']) {
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
  // 有界、确定性的正文预览：head/tail + 代码结构大纲；完整原文仍由 raw 指针承载。
  const pv = readPreview(text, path)
  if (pv.head) pairs.push(pair('head', pv.head, true))
  if (pv.outline) pairs.push(pair('outline', pv.outline, true))
  if (pv.tail) pairs.push(pair('tail', pv.tail, true))
  if (pv.truncated) pairs.push(pair('trunc', 'mid'))
  return { status: 'OK', grade: 'P1', pairs, v }
}
function writeRule({ args, text, isError, fs }) {
  const pairs = []; const v = []
  if (isError) { v.push(errPair(pairs, firstLine(text))); return { status: 'FAIL', grade: 'P1', pairs, v } }
  const path = targetOf('write', args)
  const meta = fsMeta(fs, path)
  if (meta) pairs.push(pair('size', meta.size), pair('sha8', meta.sha8))
  else pairs.push(pair('ok', 1))
  // 精确 patch 统计：不摘写正文，只给行数增减；完整参数仍由 call=<seq> 承载。
  const oc = args.old_string ?? args.old_str ?? args.oldText ?? null
  const nc = args.new_string ?? args.new_str ?? args.newText ?? args.content ?? null
  if (typeof oc === 'string' && oc !== '') pairs.push(pair('del', oc.split('\n').length))
  if (typeof nc === 'string' && nc !== '') pairs.push(pair('ins', nc.split('\n').length))
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
// 宿主 working_directory：无参调用会把 cwd 设为工作区根，返回当前路径。
// 显式记录 cd 与 cwd，避免转录只看到"路径变了"却看不出是谁改的。
function workingDirRule({ args, text, isError }) {
  const pairs = []; const v = []
  const cd = typeof args?.cd === 'string' ? args.cd : (typeof args?.path === 'string' ? args.path : '')
  if (cd) pairs.push(pair('cd', cd))
  const cwd = firstLine(text).slice(0, 240)
  if (isError) v.push(errPair(pairs, cwd))
  else if (cwd) pairs.push(pair('cwd', cwd, true))
  return { status: isError ? 'FAIL' : 'OK', grade: 'P1', pairs, v }
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
  working_directory: workingDirRule,
  ask_user_question: askRule, job_output: jobRule,
  create_goal: stateRule, get_goal: stateRule, update_goal: stateRule,
  job_list: stateRule, job_kill: stateRule, todo_write: stateRule, read_image: imageRule,
}
function fallbackRule({ text, isError }) {
  const pairs = []; const v = []
  // 未命中专用规则的工具（web_fetch/web_search/skill/present…）不能再只留 status：
  // 保留有界头尾与总字节数，全文靠 [T] 的 raw 指针回取，避免"静默丢正文"。
  const { head, tail, len } = headTail(text)
  pairs.push(pair('out_n', len))
  if (len > 0) pairs.push(pair('head', head))
  if (len > C.HEAD) pairs.push(pair('tail', tail), pair('trunc', 'mid'))
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
