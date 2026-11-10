// [T] 行回放：旧版（只看传输层 + 全挂指针） vs v1.10.67（业务判定 + 体积门槛）
//
// 用一份**自造会话存证**（6 条工具结果，覆盖小/大 × 成功/业务失败/未落盘）回放两条路径，
// 把"旧版把业务失败全印成 OK"与"新版为每条小结果挂 8B 指针"的代价差异变成可核验的数字。
// 不读本机任何会话文件 —— 结论只依赖插件本身。
//
// 运行：node tests/transcript-row-replay.test.mjs
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(ROOT, 'web', 'contextinjector.mjs')).href)

let fails = 0
const check = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`) } catch (err) { fails += 1; console.log(`FAIL  ${label}: ${err.message}`) }
}

// —— 自造 6 条工具结果（seq / op / path / 正文 / 是否传输层报错）——
const FIXTURE = [
  { seq: 10, callId: 'c1', op: 'read', path: 'D:/proj/a.mjs', text: 'x'.repeat(4096), isError: false },
  { seq: 11, callId: 'c2', op: 'memory_remember', path: '-', text: '{"ok":true,"rowid":5513}', isError: false },
  { seq: 12, callId: 'c3', op: 'memory_correct', path: '-', text: '{"ok":false,"error":"need-explicit-user-intent"}', isError: false },
  { seq: 13, callId: 'c4', op: 'pwsh', path: '-', text: '{"ok":false,"error":"boom"} ' + 'y'.repeat(2000), isError: false },
  { seq: 14, callId: 'c5', op: 'transcript_expand', path: '-', text: '{"ok":false,"error":"seq-not-in-raw","pending":true}', isError: false },
  { seq: 15, callId: 'c6', op: 'grep', path: 'D:/proj', text: 'No matches found in 37 files', isError: false },
]

const calls = new Map(FIXTURE.map((f) => [f.callId, { op: f.op, path: f.path, args: {} }]))
const msgs = FIXTURE.map((f) => ({ role: 'tool', toolCallId: f.callId, isError: f.isError, seq: f.seq, content: [{ type: 'text', text: f.text }] }))
const seqOf = new Map(msgs.map((m, i) => [m, FIXTURE[i].seq]))

const rowsNew = mod.transcribeIncremental(msgs, { n: 0 }, { calls, seqOf, rawPtrMinBytes: 1024 })

// —— 忠实复现旧版一行式：只看 isError，正文一律不内联，指针一律挂 ——
const rowsOld = FIXTURE.map((f) => `[T] ${f.op} | ${f.path} | ${f.isError === true ? 'ERR' : 'OK'} | raw=${f.seq}`)

// —— 1) 三处行为差异 ——
const bizFail = (rs) => rs.filter((r) => r.includes('FAIL')).length
const pending = (rs) => rs.filter((r) => r.includes('PENDING')).length
const pointers = (rs) => rs.filter((r) => r.includes('raw=')).length

check('旧版把 2 条业务失败全印成 OK（这就是连错三回合的成因）', () => {
  assert.equal(bizFail(rowsOld), 0)
})
check('新版识别出这 2 条业务失败', () => {
  assert.equal(bizFail(rowsNew), 2, rowsNew.join(' / '))
})
check('未落盘的 seq 记 PENDING（不是 FAIL，也不是 OK）', () => {
  assert.equal(pending(rowsNew), 1, rowsNew.join(' / '))
})
check('指针只挂给 ≥1024B 的 2 条（旧版 6 条全挂）', () => {
  assert.equal(pointers(rowsOld), 6)
  assert.equal(pointers(rowsNew), 2, rowsNew.join(' / '))
})
check('小结果·业务失败：原因内联在同一行，不必回取', () => {
  const row = rowsNew.find((r) => r.includes('memory_correct'))
  assert.ok(row.includes('need-explicit-user-intent'), row)
  assert.ok(!row.includes('raw='), row)
})
check('小结果·成功：不挂指针、不内联正文', () => {
  const row = rowsNew.find((r) => r.includes('memory_remember'))
  assert.match(row, /\| OK$/, row)
  assert.ok(!row.includes('rowid') && !row.includes('raw='), row)
})

// —— 2) 行形态不退化：一条结果一行，op/path 逐字对齐旧版 ——
check('覆盖守卫：6 条结果 = 6 行 [T]，无新增行类', () => {
  assert.equal(rowsNew.filter((r) => r.startsWith('[T] ')).length, FIXTURE.length)
  assert.ok(!rowsNew.some((r) => r.startsWith('[V] ')), rowsNew.join(' / '))
})
check('每行的 op/path 与旧版逐字同形', () => {
  for (let i = 0; i < FIXTURE.length; i++) {
    const head = `[T] ${FIXTURE[i].op} | ${FIXTURE[i].path} | `
    assert.ok(rowsNew[i].startsWith(head), `第 ${i} 行: ${rowsNew[i]}`)
    assert.ok(rowsOld[i].startsWith(head), `旧版第 ${i} 行: ${rowsOld[i]}`)
  }
})

// —— 3) 代价可控：字节增量必须是一行量级，且远小于"6 次指针往返"的信息损失 ——
const bytes = (a) => a.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0)
const grew = bytes(rowsNew) - bytes(rowsOld)
console.log(`  旧版转录 ${bytes(rowsOld)}B（6 行，均 ${(bytes(rowsOld) / 6).toFixed(1)}B）`)
console.log(`  新版转录 ${bytes(rowsNew)}B（6 行，均 ${(bytes(rowsNew) / 6).toFixed(1)}B）`)
console.log(`  净增 ${grew}B —— 换来的是 2 条业务失败可见 + 4 次不必展开的往返`)
check('字节增量有界（< 600B / 6 行）', () => {
  assert.ok(grew < 600, '净增 ' + grew + 'B')
})
check('每行仍是单行（无裸 CR/LF 撑行）', () => {
  for (const r of rowsNew) assert.ok(!/[\r\n]/.test(r), JSON.stringify(r))
})

console.log('\n=== 新版行样例 ===')
console.log(rowsNew.map((r) => (r.length > 150 ? r.slice(0, 150) + '…' : r)).join('\n'))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
