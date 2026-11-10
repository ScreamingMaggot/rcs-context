// 转录 [T] 行的可逆面契约（v1.10.67）
//
// 三修：
//   ① 业务层判定：回执 {"ok":false,"error":"x"} 是**业务失败**，不是"传输成功" ⇒ 行里写 FAIL(x)。
//      旧版只看 isError（传输层），于是连错三回合的拒绝行全印 OK，模型据此以为写成功了。
//   ② raw 指针体积门槛：正文 ≥ 1024B 才挂 raw=<seq>；小结果把有界预览内联在同一行——
//      回取要一次工具往返，为几百字节去换一次调用不划算。
//   ③ 工具用法：transcript_expand 必须带 description（进模型可见表的唯一说明书）。
//
// 纯函数级验证，不启动 DSH、不写会话日志。
// 运行：node tests/transcript-row-contract.test.mjs
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(ROOT, 'web', 'contextinjector.mjs')).href)

const out = []
const check = (name, fn) => {
  try { fn(); out.push(`PASS  ${name}`) } catch (err) { out.push(`FAIL  ${name}: ${err.message}`) }
}

// —— 1) 业务层判定 ——
check('业务失败提成 FAIL(错误码)', () => {
  assert.equal(mod.toolVerdictTag(false, '{"ok":false,"error":"need-explicit-user-intent"}'), 'FAIL(need-explicit-user-intent)')
})
check('业务失败无错误码时是 FAIL', () => {
  assert.equal(mod.toolVerdictTag(false, '{"ok":false}'), 'FAIL')
})
check('传输层 ERR 优先', () => {
  assert.equal(mod.toolVerdictTag(true, '{"ok":false,"error":"x"}'), 'ERR')
})
check('正常回执仍是 OK', () => {
  assert.equal(mod.toolVerdictTag(false, '{"ok":true,"rows":3}'), 'OK')
  assert.equal(mod.toolVerdictTag(false, 'line1\nline2'), 'OK')
  assert.equal(mod.toolVerdictTag(false, ''), 'OK')
})

// —— 2) 体积门槛 ——
check('缺省门槛 = 1024B', () => {
  assert.equal(mod.rawPtrMinBytesOf(null), 1024)
})
check('control.rawPtrMinBytes 热调', () => {
  assert.equal(mod.rawPtrMinBytesOf({ rawPtrMinBytes: 0 }), 0)
  assert.equal(mod.rawPtrMinBytesOf({ rawPtrMinBytes: 4096 }), 4096)
})

// —— 3) [T] 行形态 ——
const toolMsg = (callId, text, seq, isError = false) => ({ role: 'tool', toolCallId: callId, isError, seq, content: [{ type: 'text', text }] })
const calls = new Map([
  ['c-small', { op: 'memory_remember', path: '-', args: {} }],
  ['c-ok', { op: 'memory_remember', path: '-', args: {} }],
  ['c-big', { op: 'read', path: 'D:/x.txt', args: {} }],
])
const small = toolMsg('c-small', '{"ok":false,"error":"need-explicit-user-intent"}', 128)
const okSmall = toolMsg('c-ok', '{"ok":true,"rowid":5513}', 200)
const big = toolMsg('c-big', 'x'.repeat(4096), 167)

check('小结果·失败： FAIL(码)、不挂 raw=、同行内联预览', () => {
  const rows = mod.transcribeIncremental([small], { n: 0 }, { calls, rawPtrMinBytes: 1024 })
  const t = rows.find((r) => r.startsWith('[T] '))
  assert.ok(t, 'missing [T] row')
  assert.match(t, /FAIL\(need-explicit-user-intent\)/)
  assert.ok(!t.includes('raw='), '[T] must not carry raw= for small payload')
  assert.ok(t.includes('{"ok":false'), 'inline preview expected on the [T] row')
  assert.equal(rows.length, 1, 'exactly one row per tool result (no extra [V] row)')
})
check('小结果·成功： 不挂指针也不内联正文（保持转录精简）', () => {
  const rows = mod.transcribeIncremental([okSmall], { n: 0 }, { calls, rawPtrMinBytes: 1024 })
  const t = rows.find((r) => r.startsWith('[T] '))
  assert.match(t, /\| OK$/)
  assert.ok(!t.includes('raw=') && !t.includes('rowid'), 'no pointer, no inline body: ' + t)
})
check('大结果： 挂 raw=<seq>、无内联正文', () => {
  const rows = mod.transcribeIncremental([big], { n: 0 }, { calls, rawPtrMinBytes: 1024 })
  const t = rows.find((r) => r.startsWith('[T] '))
  assert.ok(t, 'missing [T] row')
  assert.match(t, /raw=167/)
  assert.equal(rows.length, 1)
  assert.ok(t.length < 80, 'large payload must not be inlined: ' + t.length)
})
check('大结果·失败： 仍只挂指针（正文够大，交给回取）', () => {
  const bigFail = toolMsg('c-big', '{"ok":false,"error":"boom"} ' + 'x'.repeat(2000), 300)
  const rows = mod.transcribeIncremental([bigFail], { n: 0 }, { calls, rawPtrMinBytes: 1024 })
  const t = rows.find((r) => r.startsWith('[T] '))
  assert.match(t, /FAIL\(boom\)/)
  assert.match(t, /raw=300/)
  assert.ok(!t.includes('xxxx'), 'no inline body when a pointer is attached')
})
check('门槛=0 退回旧行为（永远挂指针）', () => {
  const rows = mod.transcribeIncremental([small], { n: 0 }, { calls, rawPtrMinBytes: 0 })
  const t = rows.find((r) => r.startsWith('[T] '))
  assert.match(t, /raw=128/)
  assert.ok(!t.includes('{"ok":false'), 'no inline body when a pointer is attached: ' + t)
})
check('覆盖守卫口径不变：[T] 行数 = 工具结果数', () => {
  const rows = mod.transcribeIncremental([small, okSmall, big], { n: 0 }, { calls, rawPtrMinBytes: 1024 })
  assert.equal(rows.filter((r) => r.startsWith('[T] ')).length, 3)
  assert.ok(!rows.some((r) => r.startsWith('[V] ')), 'no new row classes introduced')
})

// —— 4) 工具注册表的用法描述 ——
check('transcript_expand 带 description 且是合法 JSON Schema', () => {
  const tool = mod.makeTranscriptExpandTool()
  assert.equal(tool.name, 'transcript_expand')
  assert.ok(typeof tool.description === 'string' && tool.description.length > 80, 'description too short/missing')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['seq'])
  assert.equal(tool.parameters.properties.seq.type, 'integer')
  assert.equal(typeof tool.output.render, 'function')
})

console.log(out.join('\n'))
const failed = out.some((l) => l.startsWith('FAIL'))
console.log('\n' + (failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS'))
process.exit(failed ? 1 : 0)
