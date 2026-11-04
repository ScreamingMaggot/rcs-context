// 提示词体量与"转录在请求里到底有几份"的实测器（只读，零成本，不依赖 DSH 进程）
//
// 为什么存在（2026-09-14，付费跑批 A01/A0x 的分析事故）：
//   有人把**追加式日志里"历史事件体的总和"**当成了"请求里重复注入的份数"，
//   得出"转录被重复注入 ~29 次（2,020,741B / 70,269B = 28.8×）"的结论，并据此判定
//   "折叠没有产生收益"。这个推论有三处硬错，本工具把三处都变成可复算的数字：
//
//   ① 日志 ≠ 请求。单段转录每次折叠都**重写整份转录文本**（foldText + 新行），
//      日志（追加式）因此每次留下"当时全文"；一个 32 轮会话有 2 折/轮 = 63 次提交，
//      累加自然 ≈ 2MB —— 那是**历史**，不是**上下文**。请求里只有一份：
//      插件每次提交后把 `session.deriveMessages()` 的真实消息结构写进 injector.jsonl
//      的 `after` 字段（role/src/bytes/hash），本工具直接统计它。
//   ② 每折"第二份"只是同一份的**下一版**（增长 ~0.1%），不是并存的两份。
//   ③ 用量算术可以直接否掉它：A01-off-1 实测 93 步，输入 token 合计
//      uncached 80,655 + cacheRead 1,590,272 = 1,670,927 ≈ 1.67M。
//      若请求里真有 2.02MB（≈50 万 token）的转录，**单次请求**就已超过该总量，
//      93 步将需要 ~47M —— 实测值比"重复 29 份"的假设小 28 倍。
//
// 判据（`--check` 时任一不满足即 exit 1）：
//   I1 每次提交的请求里，**转录量级**（≥4KB）的 plugin 节点恰有 1 个（无累加、无丢失）
//   I2 请求总字节 ≤ 最大单节点 + 8KB（没有"看不见的大块"藏在别处）
//   I3 最后一份转录字节 == last-fold.full 字节（面板/索引/请求三者同源）
//
// 用法：
//   node measure-prompt-surface.mjs --run <runDir> [--run <runDir> ...]
//   node measure-prompt-surface.mjs --runs <父目录>          # 自动扫 run-* 子目录
//   node measure-prompt-surface.mjs --runs <父目录> --check  # 不变量闸（CI/回归用）
//   node measure-prompt-surface.mjs --runs <父目录> --json out.json
// 目录约定（付费跑批 harness 的落盘布局）：
//   <runDir>/out/injector.jsonl
//   <runDir>/out/state/.ctxinjector/raw/session-<sid>.jsonl      （折叠原料权威存证）
//   <runDir>/out/state/.ctxinjector/last-fold/<sid>.json
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

const argv = process.argv.slice(2)
const optAll = (name) => argv.reduce((acc, a, i) => (a === '--' + name && i + 1 < argv.length ? [...acc, argv[i + 1]] : acc), [])
const opt = (name, dflt = null) => (optAll(name)[0] ?? dflt)
const CHECK = argv.includes('--check')
const JSON_OUT = opt('json')

// ── 字节口径：必须与插件 messageBytes 逐字一致（否则本工具与 last-fold 对不上）──────
function blockTextOf(c) {
  if (c === null || c === undefined) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(blockTextOf).join('')
  if (typeof c === 'object') {
    if (typeof c.text === 'string') return c.text
    if (c.content !== undefined) return blockTextOf(c.content)
    try { return JSON.stringify(c) } catch { return '' }
  }
  return String(c)
}
function realBytes(m) {
  const blocks = Array.isArray(m?.content) ? m.content : []
  const parts = blocks.map((b) => {
    switch (b.type) {
      case 'text': return `text:${b.text ?? ''}`
      case 'tool-call': return `tc:${b.name ?? ''}:${b.arguments ?? ''}`
      case 'tool-result': return `tr:${b.name ?? b.toolCallId ?? ''}:${blockTextOf(b.content)}`
      default: return `${b.type}:${JSON.stringify(b).slice(0, 120)}`
    }
  })
  return `${m?.role ?? '?'}\u0001${parts.join('\u0001')}`.length
}
const readLines = (p) => {
  if (!existsSync(p)) return []
  try { return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] }
}
const findFile = (dir, name) => {
  if (!existsSync(dir)) return null
  const st = statSync(dir)
  if (st.isFile()) return name.startsWith('.') ? (dir.endsWith(name) ? dir : null) : (basename(dir) === name ? dir : null)
  const match = (f) => (name.startsWith('.') ? f.endsWith(name) : f === name)
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (match(f) && statSync(p).isFile()) return p
    try { if (statSync(p).isDirectory()) { const q = findFile(p, name); if (q) return q } } catch { /* ignore */ }
  }
  return null
}

const TRANSCRIPT_SCALE = 4096 // ≥4KB 的 plugin 节点 = "转录量级"

function measureRun(runDir) {
  const o = { run: basename(runDir), path: runDir, present: false, fails: [], warns: [], notes: [] }
  const inj = existsSync(join(runDir, 'out', 'injector.jsonl')) ? join(runDir, 'out', 'injector.jsonl')
    : (existsSync(join(runDir, 'injector.jsonl')) ? join(runDir, 'injector.jsonl') : null)
  if (!inj) { o.notes.push('没有 injector.jsonl ⇒ 该臂未装载插件（bare 臂正常如此）'); return o }
  o.present = true
  const recs = readLines(inj)
  const attempts = recs.filter((r) => r.tag === 'fold-attempt')
  const commits = recs.filter((r) => r.tag === 'fold-committed')
  o.attempts = attempts.length
  o.commits = commits.length
  if (commits.length === 0) { o.warns.push('没有任何 fold-committed 记录（该臂可能全程没折成）'); return o }

  // 每次提交后的"真实请求结构"：after（新）/ afterNodes（旧 last-fold 同名字段）
  const snaps = commits.map((c) => (Array.isArray(c.after) ? c.after : (Array.isArray(c.afterNodes) ? c.afterNodes : [])))
    .filter((a) => a.length > 0)
  o.snapshots = snaps.length
  const perCommit = snaps.map((nodes, i) => {
    const live = nodes.reduce((a, n) => a + (Number(n.bytes) || 0), 0)
    const plugins = nodes.filter((n) => n.src === 'plugin').map((n) => Number(n.bytes) || 0)
    const big = plugins.filter((b) => b >= TRANSCRIPT_SCALE)
    return { i, nodes: nodes.length, liveBytes: live, pluginCount: plugins.length, transBytes: plugins.length ? Math.max(...plugins) : 0, bigCount: big.length }
  })
  const last = perCommit[perCommit.length - 1]
  o.requests = perCommit.length
  o.finalNodes = last.nodes
  o.finalLiveBytes = last.liveBytes
  o.finalTranscriptBytes = last.transBytes
  o.maxLiveBytes = Math.max(...perCommit.map((c) => c.liveBytes))
  o.maxBigNodes = Math.max(...perCommit.map((c) => c.bigCount))

  // ① 不变量：请求里**不会出现两份**转录量级节点（这就是"没有重复注入"的机械证据）。
  //   注意早期折叠的转录还很小（<4KB）⇒ 只要求"至多 1 个"，不要求恒为 1；末态另判。
  for (const c of perCommit) {
    if (c.bigCount > 1) o.fails.push(`第 ${c.i + 1} 次提交的请求里有 ${c.bigCount} 个转录量级(≥4KB) plugin 节点（至多 1 个 ⇒ 出现累加/重复注入）`)
    if (c.liveBytes > c.transBytes + 8192) o.fails.push(`第 ${c.i + 1} 次提交：请求总字节 ${c.liveBytes} 超出最大单节点 ${c.transBytes} 达 ${c.liveBytes - c.transBytes}B（>8KB 余量，存在未计入的大块）`)
  }
  if (o.finalTranscriptBytes < TRANSCRIPT_SCALE) {
    o.warns.push(`末态转录仅 ${o.finalTranscriptBytes}B（该臂几乎没跑起来/没折成）⇒ 本跑次的收益数字不具代表性`)
  }

  // ② 幻觉量：把"日志里每次提交的转录全文"累加 —— 复现 28.8× 那个数字，并给出它到底是什么
  o.historySumBytes = perCommit.reduce((a, c) => a + c.transBytes, 0)
  o.historyRatio = o.finalTranscriptBytes > 0 ? Number((o.historySumBytes / o.finalTranscriptBytes).toFixed(2)) : null
  o.foldsPerTurn = o.commits

  // ③ 请求里的"真实收益"：末态请求 vs 不折叠时同一段对话的原文（raw 权威存证，按 msg.id 去重）
  const rawDir = findFile(join(runDir, 'out', 'state', '.ctxinjector'), 'raw') ?? join(runDir, 'out', 'state', '.ctxinjector', 'raw')
  const rawFile = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.endsWith('.jsonl')).map((f) => join(rawDir, f))[0] : null
  if (rawFile) {
    const rows = readLines(rawFile)
    const seen = new Map()
    let ownBytes = 0
    let ownRows = 0
    for (const r of rows) {
      const m = r?.msg
      if (!m) continue
      if (m?.source?.plugin === 'CONTEXTinjector') { ownRows++; ownBytes += realBytes(m); continue }
      const key = m.id ?? JSON.stringify(m).slice(0, 200)
      if (!seen.has(key)) seen.set(key, realBytes(m))
    }
    o.rawRows = rows.length
    o.rawUniqueMsgs = seen.size
    o.rawUniqueBytes = [...seen.values()].reduce((a, b) => a + b, 0)
    o.rawOwnRows = ownRows
    o.rawOwnBytes = ownBytes
    o.rawOverLive = o.finalLiveBytes > 0 ? Number((o.rawUniqueBytes / o.finalLiveBytes).toFixed(2)) : null
    o.rawOverTranscript = o.finalTranscriptBytes > 0 ? Number((o.rawUniqueBytes / o.finalTranscriptBytes).toFixed(2)) : null
  }

  // ③' 与 last-fold 对账（面板/索引/请求三者同源）
  const lfFile = findFile(join(runDir, 'out', 'state', '.ctxinjector', 'last-fold'), '.json')
  if (lfFile) {
    try {
      const lf = JSON.parse(readFileSync(lfFile, 'utf8'))
      o.lastFoldFullBytes = typeof lf.full === 'string' ? lf.full.length : null
      o.plugin = lf.plugin
      if (o.lastFoldFullBytes !== null && o.finalTranscriptBytes !== o.lastFoldFullBytes) {
        o.fails.push(`末态请求里的转录 ${o.finalTranscriptBytes}B ≠ last-fold.full ${o.lastFoldFullBytes}B（请求与面板不同源）`)
      }
      if (Array.isArray(lf.segments) && lf.segments.length > 1) o.notes.push(`segments=${lf.segments.length}（多段转录：每段各占一个节点，拼接才是全文）`)
    } catch (e) { o.warns.push('last-fold 解析失败: ' + e.message) }
  }

  // ④ 正确口径的折叠压缩比（v1.10.25 起才有的字段；老记录没有则跳过）
  const withRatio = attempts.filter((a) => Number.isFinite(a.foldRatio))
  if (withRatio.length > 0) {
    o.foldRatioMedian = Number(withRatio.map((a) => a.foldRatio).sort((x, y) => x - y)[Math.floor(withRatio.length / 2)].toFixed(4))
    o.foldRatioMin = Math.min(...withRatio.map((a) => a.foldRatio))
    o.foldRatioMax = Math.max(...withRatio.map((a) => a.foldRatio))
  } else {
    o.notes.push('没有 foldRatio 字段 ⇒ 该跑次用的是 v1.10.24 及更早（旧口径：shrink 结构上恒 ≈1，不含收益信息）')
  }
  const shrinks = attempts.map((a) => a.shrink).filter((x) => Number.isFinite(x))
  if (shrinks.length > 0) o.shrinkMedian = Number(shrinks.sort((a, b) => a - b)[Math.floor(shrinks.length / 2)].toFixed(4))
  return o
}

const runs = []
const isEntry = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))
if (isEntry) {
  for (const r of optAll('run')) runs.push(r)
  const parent = opt('runs')
  if (parent) {
    if (!existsSync(parent)) { console.error('找不到 ' + parent); process.exit(2) }
    for (const d of readdirSync(parent)) {
      const p = join(parent, d)
      try { if (statSync(p).isDirectory() && /^run-/.test(d)) runs.push(p) } catch { /* ignore */ }
    }
  }
  if (runs.length === 0) { console.error('用法: node measure-prompt-surface.mjs --run <runDir> | --runs <父目录> [--check] [--json out.json]'); process.exit(2) }

  const results = runs.map(measureRun)
  const kb = (n) => (Number.isFinite(n) ? (n / 1024).toFixed(1) + 'K' : '-')
  console.log('跑次'.padEnd(20) + '提交  请求节点  末态请求   末态转录  请求峰值  日志累加/末态   原料/末态   本折压缩比(中位)  shrink(中位)')
  for (const r of results) {
    if (!r.present) { console.log(String(r.run).padEnd(20) + '  —    （未装载插件）'); continue }
    console.log(
      String(r.run).padEnd(20) +
      String(r.commits).padEnd(6) +
      String(r.finalNodes ?? '-').padEnd(10) +
      kb(r.finalLiveBytes).padEnd(11) +
      kb(r.finalTranscriptBytes).padEnd(10) +
      kb(r.maxLiveBytes).padEnd(10) +
      String((r.historyRatio ?? '-') + 'x').padEnd(17) +
      String((r.rawOverLive ?? '-') + 'x').padEnd(12) +
      String(r.foldRatioMedian ?? '-').padEnd(17) +
      String(r.shrinkMedian ?? '-')
    )
  }
  for (const r of results) {
    if (r.present && Number.isFinite(r.rawUniqueBytes)) {
      console.log(`· ${r.run}: 不折叠时的同一段对话原文 = ${kb(r.rawUniqueBytes)}（${r.rawUniqueMsgs} 条，按 msg.id 去重；raw 存证 ${r.rawRows} 行含重复覆盖）` +
        ` ⇒ 末态请求 ${kb(r.finalLiveBytes)}，末态转录 ${kb(r.finalTranscriptBytes)}；折叠使"该显示的原料"降到 1/${r.rawOverLive ?? '-'}`)
    }
    for (const n of r.notes) console.log(`· ${r.run}: ${n}`)
    for (const w of r.warns) console.log(`! ${r.run}: ${w}`)
    for (const f of r.fails) console.log(`✗ ${r.run}: ${f}`)
  }
  const allFails = results.flatMap((r) => r.fails.map((f) => r.run + ': ' + f))
  console.log(`\n不变量：每次提交的请求里"转录量级节点至多 1 个" + "请求总字节 ≈ 最大单节点" ⇒ ${allFails.length === 0 ? 'PASS' : 'FAIL ' + allFails.length}`)
  console.log('说明：日志累加/末态 = 把每次提交的转录全文累加 ÷ 末态转录（= "重复注入 N 次"那种算法的产物，它不是请求体量）；')
  console.log('      原料/末态 = 同一段对话不折叠时的原文 ÷ 末态请求体量（折叠的真实收益，0.47% 级别的日志增量与它无关）。')
  if (JSON_OUT) {
    try { mkdirSync(dirname(JSON_OUT), { recursive: true }) } catch { /* ignore */ }
    writeFileSync(JSON_OUT, JSON.stringify(results, null, 2), 'utf8')
    console.log('JSON → ' + JSON_OUT)
  }
  process.exit(CHECK && allFails.length > 0 ? 1 : 0)
}

export { measureRun, realBytes, blockTextOf }
