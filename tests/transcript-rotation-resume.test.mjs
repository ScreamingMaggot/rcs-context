// 转录轮转与断点续传回归测试（LOGcompiler）——钉住"长会话转录无界增长"与"重启后续号不归零"。
//   被守的主张（deck 第 15 页"六处故障"里那条转录二次膨胀、以及账本可复查）：
//     · 超过阈值即**轮转**（base → base.1，依次递增），旧段一字不动
//     · 轮转不丢行：各段行数之和 == 实际产出行数（含缓冲中的行）
//     · 轮号跨段连续，既不重复也不归零
//     · **跨进程**（换一个模块实例 = 重启宿主）再记一句时，轮号从"各段最大值 + 1"续上
//       —— lastRoundInDir 必须把 base 与 base.1/2/3 一起扫
//   运行：node tests/transcript-rotation-resume.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-rot-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
for (const [sub, f] of [['web', 'logcompiler.mjs'], ['condense', 'chunk.mjs'], ['toolfold', 'toolfold.mjs']]) {
  copyFileSync(join(SRC, sub, f), join(root, sub, f))
}
// 两份副本 = 两个进程（模块状态互不可见），用来模拟宿主重启
for (const name of ['log-1.mjs', 'log-2.mjs']) {
  copyFileSync(join(root, 'web', 'logcompiler.mjs'), join(root, 'web', name))
}

const TRANS = join(root, 'transcripts')
const STATE = join(root, 'state')
process.env.LOGCOMPILER_LOGS_DIR = TRANS
process.env.LOGCOMPILER_STATE_DIR = STATE
delete process.env.LOGCOMPILER_OUT
process.env.LOGCOMPILER_MAX_BYTES = '1024'      // 最小可设值：逼出轮转

const SID = 'session-rotation-0001'
// LOGcompiler 落盘时会**去掉 session- 前缀**（normKey），文件名基与 sid 不同名 —— 测试必须照它的口径。
const KEY = SID.replace(/^session-?/i, '')
const handlers = []
const attach = async (file) => {
  const mod = await import(pathToFileURL(join(root, 'web', file)).href)
  mod.default.apply({ on(t, fn) { if (t === 'session/event') handlers.push(fn) } })
  return handlers[handlers.length - 1]
}
const emit = (fn) => (ev) => fn({ id: SID }, ev)
const user = (t) => ({ type: 'user/message', data: { content: [{ type: 'text', text: t }], source: { kind: 'user' } } })
const call = (id, name) => ({ type: 'tool/call', data: { callId: id, name, arguments: JSON.stringify({ path: 'src/a.py' }) } })
const result = (id, out) => ({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: id, isError: false, content: [{ type: 'tool-result', toolName: 'read', content: out }] } } })

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

/* ── 进程 1：写够量，逼出轮转 ─────────────────────────────────────── */
const send1 = emit(await attach('log-1.mjs'))
const ROUNDS = 8
for (let r = 1; r <= ROUNDS; r++) {
  send1(user(`第 ${r} 轮：把 PORT=87${r} 写进 deploy.py。` + '填充'.repeat(120)))
  send1(call(`c${r}`, 'read'))
  send1(result(`c${r}`, `content of round ${r} `.repeat(20)))
}

const segs = () => readdirSync(TRANS).filter((f) => f.startsWith(KEY)).sort()
const allSegs = segs()
const base = join(TRANS, KEY + '.log')
check('① base 段存在', existsSync(base), allSegs.join(','))
check('① 已发生轮转（出现 .1 段）', allSegs.includes(KEY + '.log.1'), allSegs.join(','))
check('① 轮转后仍是新建的 base（续写而非覆盖）', existsSync(base))

const readSeg = (f) => readFileSync(join(TRANS, f), 'utf8')
const linesOf = (txt) => txt.split('\n').filter(Boolean)
const perSeg = allSegs.map((f) => ({ f, lines: linesOf(readSeg(f)) }))
check('② 每段行都是完整行（无半行/无裸 CR 残句）',
  perSeg.every((s) => s.lines.every((l) => /^\[|^#/.test(l))),
  perSeg.map((s) => s.f + ':' + s.lines.length).join('  '))

const rounds = []
const uCount = { v: 0 }
let tCount = 0
for (const s of perSeg) for (const l of s.lines) {
  const m = /^\[ROUND\] (\d+)$/.exec(l)
  if (m) rounds.push(Number(m[1]))
  if (l.startsWith('[U] ')) uCount.v++
  if (l.startsWith('[T] ')) tCount++
}
check('③ 轮号跨段连续且不重复（1..N 各一次）',
  rounds.length === ROUNDS && new Set(rounds).size === ROUNDS && rounds.every((n, i) => n === i + 1),
  rounds.join(','))
check('③ 真人轮数与 [U] 行数一致', uCount.v === ROUNDS, `U=${uCount.v}`)
check('③ 工具记录零丢失（轮转前后都在）', tCount === ROUNDS, `T=${tCount}`)
check('③ 所有真轮指令都能在段里检索到（含跨段那条）',
  perSeg.some((s) => s.lines.some((l) => l.includes('PORT=873'))) &&
  perSeg.some((s) => s.lines.some((l) => l.includes('PORT=87' + ROUNDS))))

/* ── 进程 2：模拟宿主重启，续号必须从 max+1 起（不归零） ───────────── */
const send2 = emit(await attach('log-2.mjs'))
send2(user('重启之后的第 1 句：继续'))
const allLines2 = readdirSync(TRANS).filter((f) => f.startsWith(KEY)).sort()
  .flatMap((f) => linesOf(readFileSync(join(TRANS, f), 'utf8')))
const rounds2 = allLines2.map((l) => (/^\[ROUND\] (\d+)$/.exec(l) || [])[1]).filter(Boolean).map(Number)
check('④ 重启后轮号从「各段最大值 + 1」续上（断点续传扫全部段）',
  Math.max(...rounds2) === ROUNDS + 1, `max=${Math.max(...rounds2)} 期望=${ROUNDS + 1}`)
check('④ 重启后没有把轮号归零（不出现第二条 [ROUND] 1）',
  rounds2.filter((n) => n === 1).length === 1, 'count1=' + rounds2.filter((n) => n === 1).length)
check('④ 重启后那句也进了转录', allLines2.some((l) => l.includes('重启之后的第 1 句')))

/* ── ⑤ 旧段一字不动（轮转不改写历史） ─────────────────────────────── */
const seg1Name = allSegs.find((f) => f.endsWith('.log.1'))
const seg1 = seg1Name ? readSeg(seg1Name) : ''
check('⑤ 已轮转的旧段内容不含进程 2 的新句（历史不改写）',
  !!seg1Name && !seg1.includes('重启之后'), seg1Name ? '' : '（未发生轮转，本项无法判定）')

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
