// 未落盘的 seq 不得冒充业务失败（v1.10.72）
//
// 背景：raw append 是异步的，[T] 行渲染时该 seq 可能还没 flush；transcript_expand 此时回
// {"ok":false,"error":"seq-not-in-raw"}。v1.10.67 把一切 {"ok":false,...} 提成 FAIL(错误码)，
// 于是"还没落盘"被写成"FAIL(seq-not-in-raw)"——真机上一条 probe 的正文带该回执，[T] 行就
// 标成 FAIL，而同一个 seq 稍后展开实得 6662B，模型据此判"工具坏了"。
//
// v1.10.72：RETRYABLE_CODES 里的码记中性状态 PENDING（行仍只挂 raw=<seq>），不与业务 FAIL
// 同权重；真正的业务失败仍必须写成 FAIL(错误码)。
//
// 运行：node tests/transcript-pending-row.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(ROOT, 'web', 'contextinjector.mjs')).href)

let fails = 0
const check = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`) } catch (err) { fails += 1; console.log(`FAIL  ${label}: ${err.message}`) }
}

// —— 1) 判定表 ——
const cases = [
  ['传输层成功', false, '{"ok":true}', 'OK'],
  ['业务失败保留错误码', false, '{"ok":false,"error":"need-explicit-user-intent"}', 'FAIL(need-explicit-user-intent)'],
  ['业务失败无错误码', false, '{"ok":false}', 'FAIL'],
  ['未落盘的中性状态', false, '{"ok":false,"error":"seq-not-in-raw","pending":true}', 'PENDING'],
  ['传输层报错', true, 'boom', 'ERR'],
]
for (const [label, isErr, text, want] of cases) {
  check(label, () => {
    const got = mod.toolVerdictTag(isErr, text)
    assert.equal(got, want, `期望 ${want}，实得 ${got}`)
  })
}

// —— 2) 行形态：PENDING 行不出现 FAIL，指针照旧 ——
const msgs = [
  { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'x'.repeat(2000) }] },
  { role: 'tool', toolCallId: 'c2', isError: false, content: [{ type: 'text', text: '{"ok":false,"error":"seq-not-in-raw","pending":true}' }] },
]
const calls = new Map([
  ['c1', { op: 'pwsh', path: '-', args: {} }],
  ['c2', { op: 'transcript_expand', path: '-', args: {} }],
])
const seqOf = new Map([[msgs[0], 11], [msgs[1], 12]])
const rows = mod.transcribeIncremental(msgs, { n: 0 }, { calls, seqOf, rawPtrMinBytes: 1024 })

check('大结果行只挂指针、不标 FAIL', () => {
  assert.ok(rows.some((r) => r.includes('raw=11') && !r.includes('FAIL')), rows.join(' / '))
})
check('seq-not-in-raw 记 PENDING，不写成 FAIL', () => {
  const row = rows.find((r) => r.includes('transcript_expand'))
  assert.ok(row, '应产出 transcript_expand 行')
  assert.ok(!row.includes('FAIL'), row)
  assert.ok(row.includes('PENDING'), row)
})

// —— 3) 工具自身回执：带 pending 标记与「稍后重试」提示 ——
const rawDir = mkdtempSync(join(tmpdir(), 'rcs-raw-'))
mkdirSync(rawDir, { recursive: true })
const SID = '11111111-2222-4333-8444-555555555555'
writeFileSync(
  join(rawDir, `session-${SID}.jsonl`),
  JSON.stringify({ t: Date.now(), seq: 42, msg: { role: 'tool', content: [{ type: 'text', text: 'raw body for seq 42' }] } }) + '\n',
  'utf8',
)

check('已落盘的 seq 能取回原文', () => {
  const hit = mod.readRawEntry(rawDir, SID, 42)
  assert.equal(hit.ok, true, JSON.stringify(hit))
  assert.match(hit.text, /raw body for seq 42/)
  assert.equal(hit.seq, 42)
})
check('未落盘的 seq 是 pending 而非裸错误', () => {
  const miss = mod.readRawEntry(rawDir, SID, 7)
  assert.equal(miss.ok, false)
  assert.equal(miss.error, 'seq-not-in-raw')
  assert.equal(miss.pending, true)
  assert.ok(miss.hint && miss.hint.length > 0, '应给出「稍后重试」的提示')
})

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
