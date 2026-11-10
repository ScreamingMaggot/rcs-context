#!/usr/bin/env node
// session-econ.mjs — 从本机 DSH 会话档案重算 README「实测」表。
//
//   node tools/session-econ.mjs --dsh-home "$DSH_HOME" [--mode single] [--top 8] [--window 1048576]
//
// 口径（与 README 一致）：
//   累计工具输出+回复 = 会话事件流里 tool/result + assistant/message + user/message 的原始字节
//   折叠后驻留        = .ctxinjector/last-fold/<sid>.json 的 transcriptBytes
//   上下文占用        = 每个 assistant/message 的 usage.inputTokens + usage.cacheReadTokens
//
// 会话档案是「多个 zstd 帧首尾相接」的 jsonl（每次追加一帧），Node 的
// zstdDecompressSync 只解第一帧，所以这里按帧魔数切片逐个解。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const HOME = arg('--dsh-home', process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'))
const ONLY = arg('--mode', '')          // 只看某个档位：single / double / off
const TOP = Number(arg('--top', '8'))
const WINDOW = Number(arg('--window', '1048576'))
const BYTES_PER_TOKEN = Number(arg('--bpt', '3.5'))

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeArchive(file) {
  const buf = readFileSync(file)
  const offs = []
  for (let i = 0; (i = buf.indexOf(MAGIC, i)) !== -1; i += 4) offs.push(i)
  let out = ''
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { out += zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { /* 半帧，跳过 */ }
  }
  return out
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/^session.*\.jsonl\.zstd$/.test(e.name)) out.push(p)
  }
  return out
}

const med = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0)

// 档位（插件自己的记账）与折叠结果
const modes = {}
const ctlPath = join(HOME, 'state-compiler', 'control.json')
if (existsSync(ctlPath)) Object.assign(modes, JSON.parse(readFileSync(ctlPath, 'utf8')).sessionModes || {})

const foldDir = join(HOME, 'state-compiler', '.ctxinjector', 'last-fold')
const folds = {}
if (existsSync(foldDir)) {
  for (const f of readdirSync(foldDir)) {
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(foldDir, f), 'utf8'))
      folds[j.sessionId] = j
    } catch { /* 坏记录忽略 */ }
  }
}

const rows = []
for (const file of walk(join(HOME, 'sessions'))) {
  let text
  try { text = decodeArchive(file) } catch { continue }
  let sid = null, steps = 0, comp = 0, surface = 0
  const ctxs = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'session') { sid = e.id; continue }
    if (e.type === 'step/start') steps++
    else if (e.type === 'compaction/start') comp++
    else if (e.type === 'tool/result' || e.type === 'assistant/message' || e.type === 'user/message') {
      surface += JSON.stringify(e.data || {}).length
      if (e.type === 'assistant/message' && e.data && e.data.usage) {
        const u = e.data.usage
        ctxs.push((u.inputTokens || 0) + (u.cacheReadTokens || 0))
      }
    }
  }
  if (!sid) continue
  const mode = modes[sid] || null
  if (ONLY && mode !== ONLY) continue
  const fold = folds[sid] || null
  rows.push({
    sid, mode, steps, comp, surface,
    folded: fold ? fold.transcriptBytes : null,
    ctxMed: med(ctxs.filter((c) => c < 200000)),
    ctxP90: pct(ctxs.filter((c) => c < 200000), 0.9),
    ctxMax: ctxs.length ? Math.max(...ctxs) : 0,
  })
}

rows.sort((a, b) => b.surface - a.surface)
const withFold = rows.filter((r) => r.folded)
const sum = (a) => a.reduce((x, y) => x + y, 0)
const MB = (n) => (n / 1048576).toFixed(2)
const p = (n) => ((100 * n) / WINDOW).toFixed(1) + '%'

console.log(`DSH_HOME = ${HOME}`)
console.log(`会话 ${rows.length} 个（有折叠记录 ${withFold.length} 个）${ONLY ? `，只看档位 ${ONLY}` : ''}\n`)
console.log('| 会话 | 档位 | 步数 | 累计工具输出+回复 | 折叠后驻留 | 压缩比 | 上下文占用 中位 / P90 | 峰值 | 原生压缩 |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const r of withFold.slice(0, TOP)) {
  console.log(`| \`${r.sid.replace('session-', '').slice(0, 8)}\` | ${r.mode || '-'} | ${r.steps} | ${MB(r.surface)} MB | ${MB(r.folded)} MB | **${(r.surface / r.folded).toFixed(0)}×** | ${p(r.ctxMed)} / ${p(r.ctxP90)} | ${p(r.ctxMax)} | ${r.comp} 次 |`)
}

if (withFold.length) {
  const surface = sum(withFold.map((r) => r.surface))
  const folded = sum(withFold.map((r) => r.folded))
  console.log(`\n合计 ${withFold.length} 个会话、${sum(withFold.map((r) => r.steps))} 步：`)
  console.log(`  累计 ${MB(surface)} MB → 驻留 ${MB(folded)} MB（${(surface / folded).toFixed(0)}×）`)
  console.log(`  按 ${BYTES_PER_TOKEN} B/token 折算：≈ ${(surface / BYTES_PER_TOKEN / 1e6).toFixed(1)}M token = ${(surface / BYTES_PER_TOKEN / WINDOW).toFixed(1)} 个窗口 → ${(folded / BYTES_PER_TOKEN / WINDOW).toFixed(2)} 个窗口`)
  console.log(`  中位上下文占用：${p(med(withFold.map((r) => r.ctxMed)))}；P90 中位：${p(med(withFold.map((r) => r.ctxP90)))}`)
}
