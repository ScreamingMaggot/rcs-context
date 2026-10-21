// 折叠边界不变量回归测试：把论文 §3.2/§3.3 的 I2/I3 与汇报第 4 页"进行中的轮次一个节点都不碰"钉住。
//   被守住的主张：
//     · 折叠区间只覆盖"已结束"的内容；仍在飞的一轮绝不进区间（否则宿主把尾部当未回答的用户轮 ⇒ 同一条消息答两次，
//       真机 session-de4959d2 事故）
//     · call/result 配对不许被边界切分（切分 ⇒ surface 出现孤儿 tool 消息 ⇒ INVALID_REQUEST，
//       真机 session-7a5301d7 并行 subagent 场景崩溃）
//     · 已定死的悬空 call（其后有 turn/end）不算"未闭合"，可以跨越
//     · 多段转录合并后轮号取最大、seq 取末段（续传 seed 的次序依据）
//   运行：node tests/fold-boundary-invariants.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-fold-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
const M = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)
const { closedPrefixEnd, collectDeadCalls, pairSplitIds, mergeOwnSegments, parseSegHeader, segmentText, effectiveMaxTokens } = M

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const cb = (id) => ({ type: 'tool-call', id, name: 'pwsh' })
const rb = (id) => ({ type: 'tool-result', toolCallId: id, content: 'ok' })
const m = (...blocks) => ({ role: blocks[0]?.type ? 'assistant' : 'user', content: blocks })
const u = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] })

/* ──  closedPrefixEnd：只折已结束的内容 ─────────────────────────────── */
check('① 全闭合 ⇒ 可折到末端',
  closedPrefixEnd([u('a'), m(cb('c1')), m(rb('c1')), m(cb('c2')), m(rb('c2'))]) === 4)
check('① 末位是未闭合的 call ⇒ 钳到它之前（不吃掉在飞的一轮）',
  closedPrefixEnd([u('a'), m(cb('c1')), m(rb('c1')), m(cb('c2'))]) === 2,
  'end=' + closedPrefixEnd([u('a'), m(cb('c1')), m(rb('c1')), m(cb('c2'))]))
check('① 同一 call 被标为已定死（其后有 turn/end）⇒ 允许跨越到末端',
  closedPrefixEnd([u('a'), m(cb('c1')), m(rb('c1')), m(cb('c2'))], { deadCalls: new Set(['c2']) }) === 3)
check('① 空消息表 ⇒ -1（无内容可折）', closedPrefixEnd([]) === -1)
check('① 区间内只有孤儿 result（call 在外面）⇒ 返回 -1 交调用方延后',
  closedPrefixEnd([m(rb('z')), u('a'), m(rb('z2'))]) === -1,
  'end=' + closedPrefixEnd([m(rb('z')), u('a'), m(rb('z2'))]))
check('① 纯文本轮（无工具）⇒ 折到末端', closedPrefixEnd([u('a'), m({ type: 'text', text: 'x' }), u('b')]) === 2)

// 交错配对：A 的 result 永不回来（在飞），B 已闭合 ⇒ 端点必须收敛到 A 之前
check('① 交错的 call/result ⇒ 迭代收敛到最早被切分的 call 之前',
  closedPrefixEnd([u('q'), m(cb('A')), m(cb('B')), m(rb('B'))]) === 0,
  'end=' + closedPrefixEnd([u('q'), m(cb('A')), m(cb('B')), m(rb('B'))]))
check('① 交错但两侧都在区间内 ⇒ 不切分，可折到末端',
  closedPrefixEnd([u('q'), m(cb('A')), m(cb('B')), m(rb('B')), m(rb('A'))]) === 4,
  'end=' + closedPrefixEnd([u('q'), m(cb('A')), m(cb('B')), m(rb('B')), m(rb('A'))]))

/* ── ② collectDeadCalls：只有"确定不会有结果"的才算死 ─────────────────── */
const evs = (arr) => ({ ownEvents: () => arr })
const e1 = [{ seq: 5, msg: m(cb('c1')) }]
// 注：seq 是事件的**绝对下标**，turn/end 必须出现在 seq 之后的索引上才算死
check('② call 之后出现 turn/end ⇒ 判死',
  collectDeadCalls(e1, evs([{}, {}, {}, {}, {}, {}, { type: 'turn/end' }])).has('c1'))
check('② call 已有 result ⇒ 不判死',
  collectDeadCalls([{ seq: 5, msg: m(cb('c1')) }, { seq: 6, msg: m(rb('c1')) }], evs([{}, {}, {}])).size === 0)
check('② 无 call ⇒ 空集（不为不存在的事件建索引）', collectDeadCalls([], evs([])).size === 0)
check('② 事件不可得 ⇒ 空集（保守：宁可不折）', collectDeadCalls(e1, undefined).size === 0)
check('② seq 缺失 ⇒ 不判死（无法定位 turn/end）',
  collectDeadCalls([{ seq: undefined, msg: m(cb('c1')) }], evs([{}, { type: 'turn/end' }])).size === 0)
check('② turn/end 在 call 之前 ⇒ 不算死（那是上一轮的收尾）',
  collectDeadCalls([{ seq: 3, msg: m(cb('c1')) }], evs([{}, {}, { type: 'turn/end' }, {}, {}, {}])).size === 0)

/* ── ③ pairSplitIds：跨界配对必须被拒（提交前守卫） ────────────────────── */
check('③ call 在遮蔽集、result 在尾部 ⇒ 报出该 id',
  pairSplitIds([m(cb('x'))], [m(rb('x'))]).join() === 'x')
check('③ result 在遮蔽集、call 在尾部 ⇒ 报出该 id',
  pairSplitIds([m(rb('y'))], [m(cb('y'))]).join() === 'y')
check('③ 配对同侧 ⇒ 安全（空数组）',
  pairSplitIds([m(cb('z')), m(rb('z'))], [u('tail')]).length === 0)
check('③ 两侧都无配对 ⇒ 空', pairSplitIds([u('a')], [u('b')]).length === 0)

/* ── ④ 多段转录簿记：轮号取最大、seq 取末段、机器元数据不进上下文 ───────── */
const segA = segmentText(['[ROUND] 2', '[U] 旧指令', '[T] pwsh | - | OK'])
const segB = segmentText(['[ROUND] 7', '[A] 结论'])
const mg = mergeOwnSegments([{ text: segA, seq: 100 }, { text: segB, seq: 260 }])
check('④ 合并后轮号取最大', mg.round === 7, 'round=' + mg.round)
check('④ seq 取末段（续传按它排序）', mg.seq === 260)
check('④ 行数不丢：合并文本行数 = 两段行数之和',
  mg.text.split('\n').length === segA.split('\n').length + segB.split('\n').length)
check('④ 段内不含任何机器头（v1.10.16 契约：元数据不进模型上下文）',
  !/^# SC-SEG/m.test(mg.text))
check('④ 空输入 ⇒ 空结果不抛', mergeOwnSegments([]).segCount === 0 && mergeOwnSegments(null).text === '')
check('④ 空文本段被过滤（不占 segCount）',
  mergeOwnSegments([{ text: '', seq: 1 }, { text: '[ROUND] 1', seq: 2 }]).segCount === 1)
check('④ segmentText 对 null 安全', segmentText(null) === '')
const legacy = parseSegHeader('# SC-SEG 4 16 5383\n[ROUND] 3\n[U] x', 5383)
check('④ 老会话的段头仍可解析（历史不改写，只兼容读取）',
  legacy.segIndex === 4 && legacy.baseCumLines === 16 && legacy.prevSegSeq === 5383)
const fresh = parseSegHeader('[ROUND] 3\n[U] x', 77)
check('④ 新契约无段头 ⇒ 三字段记 null 且不抛',
  fresh.segIndex === null && fresh.baseCumLines === null && fresh.prevSegSeq === null && fresh.seq === 77)
check('④ parseSegHeader 对 null 安全', parseSegHeader(null).bytes === 0)

/* ──  压缩调用预算：先保底再封顶（顺序反了 control 显式调小会失效） ─────── */
check('⑤ 极短输入仍有 768 保底', effectiveMaxTokens(1, 4096) === 768)
check('⑤ 随正文长度线性增长（ceil/2）', effectiveMaxTokens(10000, 40960) === 5000)
check('⑤ 天花板生效', effectiveMaxTokens(100000, 900) === 900)
check('⑤ 天花板非法时回落默认且仍 ≥ 保底',
  Number.isFinite(effectiveMaxTokens(10, undefined)) && effectiveMaxTokens(10, undefined) >= 768)
check('⑤ 负数输入按 0 处理（不产生负预算）', effectiveMaxTokens(-99, 4096) === 768)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
