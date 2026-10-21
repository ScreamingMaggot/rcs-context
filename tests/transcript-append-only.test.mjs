// LOGcompiler 的「不可变追加日志」不变量回归测试 —— 把论文/汇报里口头承诺的 I1 钉成机器可检。
//   被守住的主张（三处引用）：
//     · 汇报第 2 页「前缀逐字节不变」/ 第 4 页五道校验之一
//     · 论文 §3.1 Invariant I1（no rewrite）与 §3.4 前缀缓存经济性
//     · 关键数字页「工具记录 627 行 / 0 丢失」
//   病灶（历史上真出过）：0.1.7 漂移 #11 让 tool/result 的 callId 恒 undefined ⇒
//   [T] 整列退化为 `?|?`（内容没丢但审计价值归零）；更早出过整类丢行事故。
//   本测试不依赖模型、不依赖宿主：用 LOGCOMPILER_OUT 单文件模式把转录器灌进临时目录，
//   按 DSH 的事件形态喂合成事件，然后逐条断言。
//   运行：node tests/transcript-append-only.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-append-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
for (const [sub, f] of [['web', 'logcompiler.mjs'], ['condense', 'chunk.mjs'], ['toolfold', 'toolfold.mjs']]) {
  copyFileSync(join(SRC, sub, f), join(root, sub, f))
}
const OUT = join(root, 'transcripts', 'global.log')
process.env.LOGCOMPILER_OUT = OUT
process.env.LOGCOMPILER_STATE_DIR = join(root, 'state')
process.env.LOGCOMPILER_MAX_BYTES = String(8 << 20) // 测试内不触发轮转

const mod = await import(pathToFileURL(join(root, 'web', 'logcompiler.mjs')).href)
let emit = null
mod.default.apply({ on(type, fn) { if (type === 'session/event') emit = fn } })
if (!emit) { console.log('FAIL  插件未注册 session/event 钩子'); process.exit(1) }

const SID = 'session-testappendonly'
const txt = (t) => [{ type: 'text', text: t }]
const user = (t, source = { kind: 'user' }) => ({ type: 'user/message', data: { content: txt(t), source } })
const assist = (t) => ({ type: 'assistant/message', data: { content: txt(t) } })
const call = (id, name, args = {}) => ({ type: 'tool/call', data: { callId: id, name, arguments: JSON.stringify(args) } })
const result = (id, name, out, isError = false) => ({
  type: 'tool/result',
  data: { message: { role: 'tool', toolCallId: id, isError, content: [{ type: 'tool-result', toolName: name, content: out }] } },
})
const send = (ev) => emit({ id: SID }, ev)
const read = () => readFileSync(OUT, 'utf8')
const lines = () => read().split('\n').filter(Boolean)
const countOf = (p) => lines().filter((l) => l.startsWith(p)).length

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

/* ──  追加即前缀扩展：已写下的字节永不被改写（I1 / 前缀缓存的地基） ───────── */
let prev = ''
let prefixOk = true, prefixAt = -1
const snapshot = (i) => {
  const now = read()
  if (!now.startsWith(prev)) { prefixOk = false; if (prefixAt < 0) prefixAt = i }
  prev = now
}

const N = 40 // 合成 40 个真人轮，每轮 3 次工具往返
for (let r = 1; r <= N; r++) {
  send(user(`第 ${r} 轮指令：把 PORT=87${r} 写进 deploy.py`))
  snapshot(0)
  for (let k = 0; k < 3; k++) {
    const id = `c-${r}-${k}`
    send(call(id, 'pwsh', { command: `python step.py ${r}-${k}` }))
    send(result(id, 'pwsh', `ok ${r}-${k}\nline2 with\rCR`))
    send(assist(`第 ${r} 轮第 ${k} 段发言`))
  }
  snapshot(1)
}

check('① 全程 120 次工具往返 ⇒ [T] 行数恰好等于调用数（627/0 口径的推广）',
  countOf('[T] ') === N * 3, `got=${countOf('[T] ')} want=${N * 3}`)
check('① 每轮真人指令都开出 [ROUND]，且轮号连续无重复',
  countOf('[ROUND] ') === N && lines()[0].startsWith('[ROUND] 1'), `rounds=${countOf('[ROUND] ')}`)
check('① [U] 行数 = 真人轮数', countOf('[U] ') === N, `u=${countOf('[U] ')}`)
check('① 已写内容从未被改写（每次 flush 后都是上一次的字节前缀扩展）',
  prefixOk, prefixAt < 0 ? 'checked across ' + (N * 2) + ' flushes' : 'first break at snapshot ' + prefixAt)
check('① 末轮的关键值逐字可检索（值保真，供折叠侧校验）',
  lines().some((l) => l.includes('PORT=87' + N)), 'PORT=87' + N)

/* ── ② 单行性：任何转录行都不含裸 CR/LF ⇒ 可逐行审计、可数 ─────────────── */
const raw = read()
const badLines = raw.split('\n').filter((l) => /\r/.test(l))
check('② 无裸 CR 残留在行内', badLines.length === 0, badLines.length ? badLines[0].slice(0, 60) : '')
check('② 行数 = 文件换行数（无未落盘缓冲、无半行）',
  lines().length === raw.replace(/\n$/, '').split('\n').length)

/* ── ③ 注入类消息一律不计 ROUND、不冒充 [U]（否则轮号与审计分叉） ───────── */
const before = { rounds: countOf('[ROUND] '), u: countOf('[U] ') }
send(user('Current runtime context …', { kind: 'plugin', form: 'snapshot', sections: [{ name: 'file-policy' }] }))
send(user('技能目录……', { kind: 'skill-catalog' }))
send(user('job finished', { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' }))
send(user('subagent settled', { kind: 'subagent-settled' }))
send(user('subagent abcdef01-2345-6789 报告正文', { kind: 'subagent-report', form: 'relay' }))
send(user('本插件自己的折叠注入', { kind: 'plugin', plugin: 'CONTEXTinjector' }))
send(user('未知来源', { kind: 'brand-new-kind' }))
snapshot(9)
check('③ 七类注入都不增加 ROUND', countOf('[ROUND] ') === before.rounds,
  `before=${before.rounds} after=${countOf('[ROUND] ')}`)
check('③ 快照/目录/通知/未知来源不落 [U]', countOf('[U] ') === before.u, `u=${countOf('[U] ')}`)
check('③ 快照走 [S]、目录走 [C]、通知走 [N]、subagent 报告走 [V]',
  countOf('[S] ') === 1 && countOf('[C] ') === 1 && countOf('[N] ') === 2 && countOf('[V] ') === 1,
  `S=${countOf('[S] ')} C=${countOf('[C] ')} N=${countOf('[N] ')} V=${countOf('[V] ')}`)
check('③ 本插件注入(self)完全不转录', !lines().some((l) => l.includes('本插件自己的折叠注入')))

/* ── ④ EXTREASON 简报：逐行原样保留、不计 ROUND（它是日志的一部分，不是易失注入） */
const b4 = { rounds: countOf('[ROUND] '), r: countOf('[R] ') }
send(user('[R] 已核实：conf_17.yaml 的 9031 是过期值\n[R] 生效端口应为 9077\n前言噪声行',
  { kind: 'plugin', plugin: 'EXTREASON' }))
snapshot(8)
check('④ 简报两条 [R] 逐行保留', countOf('[R] ') === b4.r + 2, `r=${countOf('[R] ')}`)
check('④ 简报不计 ROUND', countOf('[ROUND] ') === b4.rounds)
check('④ 非 [R] 前言噪声不被塞进转录', !lines().some((l) => l.startsWith('[U] 前言噪声行')))

/* ── ⑤ 漂移形态反证：结果先于调用 / 缺 callId ⇒ 事件不丢，仍产一条 [T] ───── */
const t5 = countOf('[T] ')
send(result('orphan-1', 'read', 'no call event seen'))          // 孤儿结果（0.1.7 形态）
send(call('c-60-0', 'edit', { path: 'src/a.py' }))
send({ type: 'tool/result', data: { message: { role: 'tool', content: txt('text-only result'), toolCallId: 'c-60-0', isError: true } } }) // 无 tool-result 块
send({ type: 'tool/result', data: { callId: 'c-60-0' } })        // 已消费的 callId 再来一次
snapshot(7)
check('⑤ 孤儿结果与纯 text 结果都产出 [T]（不静默丢事件）', countOf('[T] ') - t5 === 3,
  `delta=${countOf('[T] ') - t5}`)
check('⑤ isError 在消息层也生效（出现 ERR 行）', lines().some((l) => /^\[T\] .*\| ERR$/.test(l)))
check('⑤ 孤儿结果退化为 ? 但仍计数（可被"整列变 ?"的守卫发现）',
  lines().some((l) => l.startsWith('[T] ? | ')))

/* ── ⑥ 追加后再来一轮，旧字节仍逐字不变（前缀可缓存的直接证据） ─────────── */
const frozen = read()
send(user('第 41 轮：继续'))
send(call('c-41-0', 'read', { path: 'x' }))
send(result('c-41-0', 'read', 'content'))
snapshot(6)
check('⑥ 新轮写入后，旧文件内容仍是新内容的严格前缀', read().startsWith(frozen))
check('⑥ 旧行数未被改写（只增不减）', lines().length > frozen.split('\n').filter(Boolean).length)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
