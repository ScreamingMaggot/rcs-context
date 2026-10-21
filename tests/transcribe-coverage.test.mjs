// 转录覆盖与形状漂移回归测试 —— 守"工具记录 627 行 / 0 丢失"这条对外主张的生成侧。
//   病灶（真机两次）：
//     · 漂移 #11（0.1.7）：tool-call 变成独立事件 ⇒ 块里没有 name ⇒ [T] 的工具名/目标整列退化为 ?
//       （真机 118/118）；工具结果消息不再有 tool-result 块 ⇒ 旧块级分支整类跳过
//       （真机 205 个节点折叠后 [T] 行数 = 0，模型看不到任何工具痕迹）。
//     · 更早：某一类节点被整类跳过，转录"看起来完整、其实缺整段"。
//   覆盖守卫的判据是 want(增量里的工具结果数) == got(产出的 [T] 行数)，
//   本测试直接喂两种宿主形态 + 混合形态，断言这个等式与"不退化为 ?"。
//   运行：node tests/transcribe-coverage.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-cov-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
for (const [sub, f] of [['web', 'contextinjector.mjs'], ['condense', 'chunk.mjs'], ['condense', 'ivr.mjs'], ['toolfold', 'toolfold.mjs']]) {
  copyFileSync(join(SRC, sub, f), join(root, sub, f))
}
// transcribeIncremental 等已在源文件末尾集中导出 ⇒ 直接导入临时副本（不改仓库源文件）
const M = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)
const { transcribeIncremental, isToolResultMsg, toolResultCallId } = M

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const T = (rows) => rows.filter((r) => /^\[T\] /.test(r))
const uMsg = (t, source) => ({ role: 'user', content: [{ type: 'text', text: t }], ...(source ? { source } : {}) })
const aText = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] })
// 老宿主形态：call 与 result 都在助手消息的内容块里，块自带 name
const legacyCall = (id, name, args) => ({ role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] })
const legacyResult = (id, out) => ({ role: 'user', content: [{ type: 'tool-result', toolCallId: id, content: out }] })
// 0.1.7 形态：独立 tool/call 事件派生的结果消息，content 只有 text，callId/isError 在消息层
const msgResult = (id, out, isError = false) => ({ role: 'tool', toolCallId: id, isError, content: [{ type: 'text', text: out }] })

/* ── ① 两种宿主形态都产出 [T]，且逐字同形 ─────────────────────────────── */
const st1 = { n: 0 }
const r1 = transcribeIncremental([uMsg('开工'), legacyCall('c1', 'read', { path: 'src/a.py' }), legacyResult('c1', 'body')], st1)
check('① 块级形态 ⇒ 一条 [T] 带出 op 与目标', T(r1).length === 1 && /\[T\] read \| src\/a\.py \| OK/.test(T(r1)[0]), T(r1).join(' ;; '))
const st2 = { n: 0 }
const r2 = transcribeIncremental([uMsg('开工'), msgResult('c1', 'body')], st2, { calls: new Map([['c1', { op: 'read', path: 'src/a.py', args: {} }]]) })
check('② 消息级形态（0.1.7）⇒ 同样产出一条 [T]', T(r2).length === 1, T(r2).join(' ;; '))
check('①② 两形态输出逐字同形（下游审计不需分叉）', T(r1).join() === T(r2).join())

/* ── ② 覆盖守卫的输入：want(工具结果数) == got([T] 行数) ───────────────── */
const mixed = []
let want = 0
for (let i = 0; i < 25; i++) {
  if (i % 2 === 0) { mixed.push(legacyCall(`k${i}`, 'pwsh', { command: `pytest t${i}` })); mixed.push(legacyResult(`k${i}`, 'ok')); want += 1 }
  else { mixed.push(msgResult(`m${i}`, 'ok', i % 4 === 3)); want += 1 }
}
const idx = new Map()
for (let i = 1; i < 25; i += 2) idx.set(`m${i}`, { op: 'edit', path: `src/f${i}.py`, args: {} })
const st3 = { n: 0 }
const r3 = transcribeIncremental(mixed, st3, { calls: idx })
const got = T(r3).length
check('② 混合形态 25 次工具往返 ⇒ [T] 行数与工具结果数相等（守卫不触发）',
  got === want, `want=${want} got=${got}`)
check('② isToolResultMsg 对两形态都认得（want 的算法与守卫同源）',
  mixed.filter(isToolResultMsg).length === want, `counted=${mixed.filter(isToolResultMsg).length}`)
check('② 错误结果标 ERR 且仍计数（6 条消息级 isError）', r3.filter((l) => /\| ERR$/.test(l)).length === 6,
  r3.filter((l) => /\| ERR$/.test(l)).length)

/* ──  反证：拿不到事件索引时才会退化为 ?（证明索引确实在起作用） ───────── */
const st4 = { n: 0 }
const noIdx = transcribeIncremental([uMsg('x'), msgResult('z1', 'ok')], st4)
check('③ 无索引的消息级结果 ⇒ 退化为 ?（这正是真机 118/118 的形态）',
  /\[T\] \| |\[T\] \? \|/.test(noIdx.filter((l) => /^\[T\] /.test(l))[0] || ''), noIdx.filter((l) => /^\[T\] /.test(l)).join(' ;; '))
check('③ 但行数仍为 1（退化只丢字段，不丢事件）', T(noIdx).length === 1)
const st5 = { n: 0 }
const withIdx = transcribeIncremental([uMsg('x'), msgResult('z1', 'ok')], st5, { calls: new Map([['z1', { op: 'grep', path: 'src/', args: {} }]]) })
check('③ 补上索引 ⇒ 工具名与目标回来了', /\[T\] grep \| src\/ \| OK/.test(withIdx.join('\n')), T(withIdx).join(' ;; '))

/* ── ④ 防自转录：本插件注入的折叠消息不得变成 [U]（否则主模型复述"伪历史"） */
const st6 = { n: 3 }
const selfMsgs = [
  { role: 'user', content: [{ type: 'text', text: '[ROUND] 1\n[U] 旧指令\n[T] pwsh | - | OK' }], source: { kind: 'plugin:CONTEXTinjector' } },
  uMsg('Current runtime context …', { kind: 'plugin:dsh-system-prompt', form: 'snapshot', sections: [{ name: 'file-policy' }] }),
  uMsg('[ROUND] 9 老形态无前缀'),
]
const r6 = transcribeIncremental(selfMsgs, st6)
check('④ 本插件注入（plugin:CONTEXTinjector）完全不转录',
  !r6.some((l) => l.includes('旧指令')), r6.join(' ;; ').slice(0, 80))
check('④ 注入不递增 ROUND（roundState 保持 3）', st6.n === 3, 'n=' + st6.n)
check('④ 快照走 [S] 摘要而非全文', r6.filter((l) => /^\[S\] /.test(l)).length === 1, r6.filter((l) => /^\[S\]/.test(l)).join())

/* ── ⑤ 五类行纪律：不出现未知行类 ─────────────────────────────────── */
const ALLOWED = ['[ROUND]', '[U]', '[A]', '[T]', '[M]', '[R]', '[C]', '[S]', '[N]', '[V]']
const all = [...r1, ...r2, ...r3, ...noIdx, ...withIdx, ...r6]
const bad = all.filter((l) => !ALLOWED.some((p) => l.startsWith(p)))
check('⑤ 输出行类全部落在允许集合内', bad.length === 0, bad.slice(0, 2).join(' ;; '))
check('⑤ 每行都是单行（无裸 CR/LF，可逐行数）',
  all.every((l) => !/[\r\n]/.test(l)))
const st7 = { n: 0 }
const rs = transcribeIncremental([
  uMsg('指令'),
  { role: 'assistant', content: [{ type: 'reasoning', text: '隐藏思维链不该进转录' }, { type: 'text', text: '可见发言' }] },
], st7)
check('⑤ reasoning 块被剥离（content-only 纪律）', !rs.some((l) => l.includes('隐藏思维链')), rs.join(' ;; '))
check('⑤ 同一条消息里的可见正文照常转录', rs.some((l) => l === '[A] 可见发言'))

/* ── ⑥ 轮号口径：与 LOGcompiler 一致，仅真人轮递增 ──────────────────── */
const st8 = { n: 0 }
transcribeIncremental([
  uMsg('真人一', { kind: 'user' }),
  uMsg('注入', { kind: 'plugin', form: 'notice' }),
  uMsg('真人二', { kind: 'user' }),
  { role: 'user', content: [{ type: 'text', text: 'subagent 回传', },], source: { kind: 'subagent-report', form: 'relay' } },
], st8)
check('⑥ 两轮真人 ⇒ ROUND 递增到 2', st8.n === 2, 'n=' + st8.n)
check('⑥ 退役形态 kind=plugin 与 v4 形态 kind=plugin:X 都不冒充真人轮',
  (() => { const st = { n: 0 }; transcribeIncremental([uMsg('a', { kind: 'plugin', plugin: 'CONTEXTinjector' }), uMsg('b', { kind: 'plugin:CONTEXTinjector' })], st); return st.n === 0 })())

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
