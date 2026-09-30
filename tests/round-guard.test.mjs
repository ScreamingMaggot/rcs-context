// 折叠的"当前轮保护"回归测试
//   病灶（2026-09-30 真机 session-de4959d2）：pre-step 折发生在"本轮第 2 步"时，closedPrefixEnd 因
//   "所有 call 都已闭合"返回表面末端 ⇒ 本轮的 user 消息与刚产出的助手回复被一起折进转录 ⇒
//   表面尾部成了 **user 角色**的转录 ⇒ 宿主当它是"未回答的用户轮"再跑一步 ⇒ 同一条被答两次。
//   运行：node tests/round-guard.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-round-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
const { openRoundClampEnd } = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

// 造一个"本轮仍在飞"的表面：seq 10 真人 user → 11 助手(带 tool-call) → 12 工具结果 → 13 助手回复
const userOpen = { seq: 10, msg: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] } }
const asstCall = { seq: 11, msg: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } }
const toolRes = { seq: 12, msg: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } }
const asstAns = { seq: 13, msg: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } }
const entries = [userOpen, asstCall, toolRes, asstAns]
const end = 3   // closedPrefixEnd 在"全部闭合"时会给出末端

// A. 该轮之后**没有** turn/end ⇒ 仍在飞 ⇒ 钳到本轮起点之前
// 事件数组按 **seq 索引**（宿主 ownEvents() 的形态）——不是按位置堆放
const sparse = (pairs) => { const a = []; for (const [i, e] of pairs) a[i] = { type: e }; return a }
const sessOpen = { ownEvents: () => sparse([[11, 'step/start'], [12, 'tool/result']]) }
check('A 本轮仍在飞 ⇒ 遮蔽终点钳到轮起点之前', openRoundClampEnd(entries, sessOpen, end) === -1,
  'clamped=' + openRoundClampEnd(entries, sessOpen, end))

// B. 该轮之后**有** turn/end ⇒ 已结束 ⇒ 允许折叠（轮末折主路径不受影响）
const sessEnded = { ownEvents: () => sparse([[11, 'step/start'], [14, 'turn/end']]) }
check('B 本轮已结束 ⇒ 不钳制（轮末折不受影响）', openRoundClampEnd(entries, sessEnded, end) === end,
  'end=' + openRoundClampEnd(entries, sessEnded, end))

// C. 表面里没有真人轮起点（异常形态）⇒ 不钳制
const noOpen = [asstCall, toolRes, asstAns]
check('C 无真人轮起点 ⇒ 不钳制', openRoundClampEnd(noOpen, sessOpen, 2) === 2)

// D. 自己的转录节点（plugin:CONTEXTinjector）不算轮起点
const ownNode = { seq: 9, msg: { role: 'user', source: { kind: 'plugin:CONTEXTinjector' }, content: [{ type: 'text', text: '[ROUND] 1 …' }] } }
// 自身节点在 0、轮起点在 1 ⇒ 钳到 0：自身节点仍可折，当前轮被排除在外
check('D 自身转录节点不被误认作轮起点（钳到它之后、轮起点之前）', openRoundClampEnd([ownNode, ...entries], sessOpen, 4) === 0,
  'clamped=' + openRoundClampEnd([ownNode, ...entries], sessOpen, 4))

// E. 轮起点就在 0 ⇒ 钳成 -1（调用方据此"本轮不折"）
const onlyRound = [userOpen, asstAns]
check('E 轮起点在 0 ⇒ 钳成 -1 交给调用方延后', openRoundClampEnd(onlyRound, sessOpen, 1) === -1)

// F. 事件查不到（allEvents 抛错）⇒ 不钳制，退回旧行为（避免折叠永久停摆）
const sessThrow = { ownEvents: () => { throw new Error('boom') } }
check('F 事件不可得 ⇒ 不钳制（保守回退）', openRoundClampEnd(entries, sessThrow, end) === end)

// G. end<0 原样返回
check('G end<0 原样返回', openRoundClampEnd(entries, sessOpen, -1) === -1)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
