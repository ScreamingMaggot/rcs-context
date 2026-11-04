// 提示词体量的不变量测试（移植自 0.1.20 / v1.10.25 的 prompt-economy.test.mjs）
//
// 为什么把它放回仓库：v1.10.66 的 web/contextinjector.mjs L2401 注释里仍写着
//   "本字段与 tools/measure-prompt-surface.mjs 的不变量判据互为交叉校验"
// 但那个工具与它的测试在 0.1.20 → rcs-context 的搬迁中丢了 ⇒ **交叉校验实际上不存在**，
// 只有一句引用在。这类"引用仍在、校验已无"的残留比没有更危险：它让读代码的人以为有闸门。
//
// 本测试钉三件事：
//   ① messageBytes 必须计入嵌套工具正文（[object Object] 回归）
//   ② 请求面不变量：转录量级节点至多 1 个 + 请求总字节 ≈ 最大单节点 + 末态==last-fold.full
//   ③ **负向对照**：人为重复注入必须被判 FAIL —— 没有这条，"闸门"就是安慰剂
// 运行：node tests/prompt-surface-invariant.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-surface-'))
for (const d of ['web', 'condense', 'toolfold', 'tools']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
copyFileSync(join(SRC, 'tools', 'measure-prompt-surface.mjs'), join(root, 'tools', 'measure-prompt-surface.mjs'))

// 注入器顶层会 mkdirSync(<DSH_HOME>/state-compiler)：先隔离到临时目录再 import
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = join(process.env.DSH_HOME, 'state-compiler')

const { messageBytes, blockTextOf, transcribeIncremental, sanitizeSid, rawAppend } =
  await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)
const { measureRun } = await import(pathToFileURL(join(root, 'tools', 'measure-prompt-surface.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

// ── ① 计量：嵌套工具正文必须计入 ───────────────────────────────────────────────
const toolResultMsg = (text) => ({
  role: 'user', id: 'm-tr-' + text.length, source: { kind: 'tool', callId: 'call_1' },
  content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text }], isError: false }],
})
const bigBody = 'X'.repeat(40000)
const bytes40k = messageBytes(toolResultMsg(bigBody)).length
check('messageBytes 计入嵌套工具正文（40KB 必须 ≥40000B）', bytes40k >= 40000, 'bytes=' + bytes40k)
check('不得再出现 [object Object]', !messageBytes(toolResultMsg(bigBody)).includes('[object Object]'))
check('字符串形态的 tool-result 同样计入',
  messageBytes({ role: 'user', content: [{ type: 'tool-result', name: 'read', content: 'Y'.repeat(5000) }] }).length >= 5000)
check('blockTextOf 覆盖 块数组/嵌套 content',
  blockTextOf([{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }]) === 'abcd' &&
  blockTextOf({ content: [{ type: 'text', text: 'x' }] }) === 'x')

// 计量修复必须让"折叠收益"可见：40KB 工具正文经转写后压到 1/10 以下
const msgs = [{ role: 'assistant', content: [{ type: 'text', text: 'done' }], id: 'a1' }, toolResultMsg('Z'.repeat(40000))]
const rows = transcribeIncremental(msgs, { n: 1 }, { structured: false })
const rawB = msgs.reduce((a, m) => a + messageBytes(m).length, 0)
const rowB = rows.join('\n').length
check('40KB 工具正文被转写压到 1/10 以下', rawB >= 40000 && rowB < rawB / 10, `raw=${rawB} rows=${rowB}`)

// ── ② raw 存证只存原料（派生转录不得回灌）──────────────────────────────────────
{
  const sid = 'unit-raw-' + Date.now()
  const own = { role: 'user', id: 'own-1', source: { kind: 'plugin', plugin: 'CONTEXTinjector' }, content: [{ type: 'text', text: 'Q'.repeat(30000) }] }
  const raw = { role: 'user', id: 'raw-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
  rawAppend(sid, [{ seq: 1, msg: own }, { seq: 2, msg: raw }])
  const fp = join(process.env.DSH_CONTEXTINJECTOR_STATE_DIR, '.ctxinjector', 'raw', sanitizeSid(sid) + '.jsonl')
  const body = existsSync(fp) ? readFileSync(fp, 'utf8') : ''
  check('rawAppend 不把自己的转录写成"被遮蔽原文"', body.includes('hello') && !body.includes('Q'.repeat(30000)))
}

// ── ③ 请求面不变量 + 负向对照 ─────────────────────────────────────────────────
function fakeRun({ duplicate = false, nCommits = 4, transcriptKB = 40 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rcs-surf-run-'))
  const out = join(dir, 'out')
  const state = join(out, 'state', '.ctxinjector')
  mkdirSync(join(state, 'raw'), { recursive: true })
  mkdirSync(join(state, 'last-fold'), { recursive: true })
  const lines = []
  for (let i = 0; i < nCommits; i++) {
    const tb = Math.max(1024, Math.round(transcriptKB * 1024 * ((i + 1) / nCommits)))
    const after = [
      { role: 'user', src: 'user', bytes: 80 + i, hash: 'h1' },
      { role: 'user', src: 'plugin', bytes: 400, hash: 'h2' },
      { role: 'user', src: 'plugin', bytes: tb, hash: 'h3' },
    ]
    if (duplicate) after.push({ role: 'user', src: 'plugin', bytes: tb, hash: 'h3dup' })
    lines.push(JSON.stringify({ t: 1 + i, tag: 'fold-attempt', trigger: 'turn/end', shrink: 0.998, transcriptBytes: tb, foldRatio: 0.4 }))
    lines.push(JSON.stringify({ t: 1 + i, tag: 'fold-committed', trigger: 'turn/end', after, liveBytes: after.reduce((a, x) => a + x.bytes, 0) }))
  }
  writeFileSync(join(out, 'injector.jsonl'), lines.join('\n') + '\n', 'utf8')
  writeFileSync(join(state, 'last-fold', 'sid.json'), JSON.stringify({ plugin: 'test', full: 'x'.repeat(transcriptKB * 1024) }), 'utf8')
  return dir
}

const healthy = fakeRun({ duplicate: false })
try {
  const r = measureRun(healthy)
  check('健康跑次：请求里只有一份转录（PASS）', r.present && r.fails.length === 0, JSON.stringify(r.fails).slice(0, 200))
  check('健康跑次：请求总字节 ≈ 最大单节点', r.finalLiveBytes - r.finalTranscriptBytes <= 8192,
    `live=${r.finalLiveBytes} trans=${r.finalTranscriptBytes}`)
  check('健康跑次：日志累加口径必然 >1（"重复注入"假象的来源）', r.historyRatio > 1.5, 'historyRatio=' + r.historyRatio)
} finally { rmSync(healthy, { recursive: true, force: true }) }

const dup = fakeRun({ duplicate: true })
try {
  const r = measureRun(dup)
  check('负向对照：人为重复注入必须判 FAIL', r.fails.length > 0, JSON.stringify(r.fails).slice(0, 200))
  check('负向对照：失败原因指认"转录量级节点 ≥2"', r.fails.some((f) => /转录量级/.test(f)))
} finally { rmSync(dup, { recursive: true, force: true }) }

rmSync(root, { recursive: true, force: true })
console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAIL'}`)
process.exit(fails === 0 ? 0 : 1)
