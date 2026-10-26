// 折叠可见性回归：replace 副本必须走宿主 compaction 协议，否则 UI 只认 append 来源，
// 用户眼前的助手正文会被模型专用的替换副本遮掉（真机 session-91ed1967）。
// 运行：node tests/fold-checkpoint-visible.test.mjs
import { appendFoldCheckpoint, openRoundClampEnd, stripSnapshotRows, isSelfCompactionId, openTurnOf } from '../web/contextinjector.mjs'
import { pluginIdOf, classifyMessageSource } from '../condense/chunk.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const appended = []
const session = {
  append(type, data, meta) {
    const seq = appended.length
    appended.push({ seq, type, data, meta })
    return { seq, type, data }
  },
}
const result = appendFoldCheckpoint(session, {
  transcript: '[ROUND] 1\n[U] hi\n[A] hello',
  shadowedSeqs: [3, 4, 5],
  turn: 2,
  shadowedBytes: 400,
})

check('① 生命周期顺序 start→summary→replace→end',
  appended.map((e) => e.type).join(',') === 'compaction/start,compaction/summary,user/message,compaction/end',
  appended.map((e) => e.type).join(','))
check('① compactionId 贯穿四个事件',
  [appended[0].data.compactionId, appended[1].data.compactionId, appended[2].data.source.compactionId, appended[3].data.compactionId]
    .every((x) => x === result.compactionId), result.compactionId)
check('① start/end 携带同一 turn（pre-step 内是开轮）',
  appended[0].data.turn === 2 && appended[3].data.turn === 2)
check('① summary 记录被遮蔽 seq 与 range',
  JSON.stringify(appended[1].data.shadowedSeqs) === '[3,4,5]' &&
  appended[1].data.shadowedRange.start === 3 && appended[1].data.shadowedRange.end === 5)
check('① summary 带 provider/model（宿主 schema 必填）',
  typeof appended[1].data.provider === 'string' && appended[1].data.provider.length > 0 &&
  typeof appended[1].data.model === 'string' && appended[1].data.model.length > 0)
check('① summary 统计条数与 token 估算',
  appended[1].data.shadowedSeqs.length === 3 && appended[1].data.shadowedTokenCount === 100,
  'tokens=' + appended[1].data.shadowedTokenCount)
check('① 替换副本是 compact-checkpoint（UI 才认）',
  appended[2].data.source.kind === 'compact-checkpoint')
check('① 替换副本带自身 plugin 标记（RCS 防自转录）',
  appended[2].data.source.plugin === 'CONTEXTinjector' &&
  pluginIdOf(appended[2].data.source) === 'CONTEXTinjector')
check('① 本插件检查点分类为 self，不会是 [U]/外部注入',
  classifyMessageSource(appended[2].data.source).cls === 'self',
  JSON.stringify(classifyMessageSource(appended[2].data.source)))
check('① 替换区间与 sourceEventSeqs 覆盖全部被遮蔽节点',
  appended[2].meta.surfaceOp.op === 'replace' &&
  appended[2].meta.surfaceOp.startSeq === 3 && appended[2].meta.surfaceOp.endSeq === 5 &&
  [0, 1, 3, 4, 5].every((s) => appended[2].meta.sourceEventSeqs.includes(s)),
  JSON.stringify(appended[2].meta))
check('① 模型侧内容仍是完整规则转录',
  appended[2].data.content[0].text === '[ROUND] 1\n[U] hi\n[A] hello')
check('① 人类侧摘要保持短行（原文由原始 append 事件承载）',
  appended[1].data.summary[0].text.length < 120, appended[1].data.summary[0].text)

// 宿主原生 compaction 的 source 不带 plugin ⇒ 不能被误认成自身转录
check('① 宿主原生检查点不归类为 self',
  pluginIdOf({ kind: 'compact-checkpoint', compactionId: 'x' }) === null &&
  classifyMessageSource({ kind: 'compact-checkpoint', compactionId: 'x' }).cls === 'opaque')
check('② 自身生命周期 ID 提交后从让路集合移除',
  isSelfCompactionId(result.compactionId) === false)

/* ── compaction turn 归属：异步 turn-end fold 落到下一轮时不得写 turn:null（真机 session-64963da1）── */
check('②a openTurnOf: 最后 turn/start 未闭合 ⇒ 该 turn',
  openTurnOf({ ownEvents: () => [{ seq: 0, type: 'turn/start', data: { turn: 10 } }, { seq: 1, type: 'step/start', data: { turn: 10, step: 1 } }] }) === 10)
check('②a openTurnOf: turn/end 后 ⇒ null',
  openTurnOf({ ownEvents: () => [{ seq: 0, type: 'turn/start', data: { turn: 10 } }, { seq: 1, type: 'turn/end', data: { turn: 10 } }] }) === null)
check('②a openTurnOf: snapshotEvents 回退',
  openTurnOf({ snapshotEvents: () => [{ seq: 0, type: 'turn/start', data: { turn: 7 } }] }) === 7)
check('②a openTurnOf: 事件异常/缺失 ⇒ null',
  openTurnOf({ ownEvents() { throw new Error('boom') } }) === null && openTurnOf(null) === null)

const makeCommitSession = (ownEvents) => {
  const events = []
  return {
    events,
    ownEvents: () => ownEvents,
    append(type, data, meta) {
      const seq = events.length
      events.push({ seq, type, data, meta })
      return { seq, type, data }
    },
  }
}
const openCommit = makeCommitSession([{ seq: 0, type: 'turn/start', data: { turn: 10 } }])
const openResult = appendFoldCheckpoint(openCommit, {
  transcript: '[ROUND] 1\n[U] q\n[A] a', shadowedSeqs: [3, 4], turn: null, shadowedBytes: 100,
})
check('②a 异步 fold 落到打开中的 turn 10 ⇒ start/end owner=10',
  openCommit.events[0].data.turn === 10 && openCommit.events[3].data.turn === 10 && openResult.turn === 10,
  JSON.stringify({ start: openCommit.events[0].data.turn, end: openCommit.events[3].data.turn, result: openResult.turn }))

const closedCommit = makeCommitSession([{ seq: 0, type: 'turn/start', data: { turn: 10 } }, { seq: 1, type: 'turn/end', data: { turn: 10 } }])
const closedResult = appendFoldCheckpoint(closedCommit, {
  transcript: '[ROUND] 1\n[U] q\n[A] a', shadowedSeqs: [3, 4], turn: null, shadowedBytes: 100,
})
check('②a 无打开 turn ⇒ start/end owner=null（手动 compaction 语义）',
  closedCommit.events[0].data.turn === null && closedCommit.events[3].data.turn === null && closedResult.turn === null)

/* ── 当前轮保护：仍在飞的那一轮不得折；已结束的轮必须可折（turn/end 是折叠主路径）── */
const entries = [
  { seq: 0, msg: { role: 'user', content: [{ type: 'text', text: 'q1' }], source: { kind: 'user' } } },
  { seq: 1, msg: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } },
  { seq: 2, msg: { role: 'user', content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } } },
  { seq: 3, msg: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] } },
]
const sessionEnded = { ownEvents: () => [{ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4, type: 'turn/end' }] }
const sessionOpen = { ownEvents: () => [{ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }] }
check('③ 该轮已结束（turn/end 已落日志）⇒ 可折到末端（end→3）',
  openRoundClampEnd(entries, sessionEnded, 3) === 3,
  'end=' + openRoundClampEnd(entries, sessionEnded, 3))
check('③ 该轮仍在飞（无 turn/end）⇒ 钳到该轮起点之前（end→1）',
  openRoundClampEnd(entries, sessionOpen, 3) === 1,
  'end=' + openRoundClampEnd(entries, sessionOpen, 3))
check('③ 只有一轮且仍在飞 ⇒ 不折（end→-1）',
  openRoundClampEnd(entries.slice(0, 2), sessionOpen, 1) === -1)
check('③ 事件查询异常 ⇒ 不钳制（保守回退旧行为）',
  openRoundClampEnd(entries, { ownEvents() { throw new Error('boom') } }, 3) === 3)

/* ── 旧转录里的 [S] 残留必须清掉（否则新折继续把它注入模型） ── */
const oldText = '[ROUND] 1\n[S] runtime snapshot: working-directory:current\n[U] q\n[A] a\n[S] runtime snapshot: working-directory:current'
check('④ stripSnapshotRows 删除全部 [S] 行',
  stripSnapshotRows(oldText) === '[ROUND] 1\n[U] q\n[A] a',
  JSON.stringify(stripSnapshotRows(oldText)))
check('④ 不含 [S] 时原样返回（引用级不变）',
  (() => { const t = '[ROUND] 1\n[U] q'; return stripSnapshotRows(t) === t })())
check('④ [A] 正文里的 [S] 不被误删',
  stripSnapshotRows('[A] 说明 [S] 是快照行前缀') === '[A] 说明 [S] 是快照行前缀')

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAIL`)
process.exit(fails === 0 ? 0 : 1)
