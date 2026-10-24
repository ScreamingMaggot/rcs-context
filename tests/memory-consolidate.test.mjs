// 记忆整理：操作解析、约束保护、证据校验、应用结果。
// 运行：node tests/memory-consolidate.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = mkdtempSync(join(tmpdir(), 'rcs-consol-state-'))
const mem = await import(pathToFileURL(join(HERE, '..', 'web', 'memory.mjs')).href)
const { MemoryStore, MemoryConsolidator, parseConsolidateOps } = mem

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

// ① 操作解析与拒绝
{
  const ev = ['11', '12']
  const keys = ['old-state', 'port-constraint', 'keep-me', 'merge-me']
  const ok = parseConsolidateOps(JSON.stringify({ ops: [
    { op: 'mark_stale', target: 'old-state', reason: '目录已删', evidence: ['11'] },
    { op: 'merge', target: 'merge-me', keep: 'keep-me', reason: 'duplicate', evidence: ['12'] },
    { op: 'new', key: 'new-fact', summary: '新增测试目录', confidence: 0.8, type: 'state', evidence: ['12'] },
  ] }), { keys, evidence: ev })
  check('① 合法操作解析', ok.ops.length === 3, JSON.stringify(ok.ops.map((x) => x.op)))
  const dup = parseConsolidateOps(JSON.stringify({ ops: [
    { op: 'mark_stale', target: 'old-state', reason: 'a', evidence: ['11'] },
    { op: 'supersede', target: 'old-state', reason: 'b', evidence: ['12'] },
  ] }), { keys, evidence: ev })
  check('① 同一 target 第二次被拒', dup.rejected.some((x) => x.reason === 'duplicate-target'), JSON.stringify(dup.rejected))
  const bad = parseConsolidateOps(JSON.stringify({ ops: [
    { op: 'mark_stale', target: 'old-state', reason: 'x', evidence: ['99'] },
    { op: 'mark_stale', target: 'missing', reason: 'x', evidence: ['11'] },
    { op: 'delete', target: 'old-state', reason: 'x', evidence: ['11'] },
    { op: 'mark_stale', target: 'old-state', reason: 'x', evidence: [] },
  ] }), { keys, evidence: ev })
  check('① 未提供的证据被拒', bad.rejected.some((x) => x.reason === 'evidence-not-provided'))
  check('① 非活动 target 被拒', bad.rejected.some((x) => x.reason === 'target-not-active'))
  check('① 未知操作被拒', bad.rejected.some((x) => x.reason === 'unknown-op'))
  check('① 无证据被拒', bad.rejected.some((x) => x.reason === 'no-evidence'))
  const extra = parseConsolidateOps('{"ops":[{"op":"mark_stale","target":"old-state","reason":"x","evidence":["11"]}]}}', { keys, evidence: ev })
  check('① 尾部多一个 } 仍可解析', extra.ops.length === 1, JSON.stringify(extra))
  const trailing = parseConsolidateOps('{"ops":[{"op":"mark_stale","target":"old-state","reason":"x","evidence":["11"]}]}\nDone.', { keys, evidence: ev })
  check('① 尾随说明文字不影响解析', trailing.ops.length === 1, JSON.stringify(trailing))
  const unpaired = parseConsolidateOps(JSON.stringify({ ops: [
    { op: 'supersede', target: 'old-state', reason: '只是又被确认了一次', evidence: ['11'] },
  ] }), { keys, evidence: ev })
  check('① 无同 key 新值的 supersede 在解析期被拒', unpaired.ops.length === 0 && unpaired.rejected.some((x) => x.reason === 'supersede-without-new'), JSON.stringify(unpaired))
  const paired = parseConsolidateOps(JSON.stringify({ ops: [
    { op: 'supersede', target: 'old-state', reason: '目录已改', evidence: ['12'] },
    { op: 'new', key: 'old-state', summary: '目录已改为新位置。', confidence: 0.8, type: 'state', evidence: ['12'] },
  ] }), { keys, evidence: ev })
  check('① 同 key 取代成对时通过', paired.ops.length === 2, JSON.stringify(paired))
}

// ② 应用：state 可失效、constraint 受保护、new 落库
{
  const root = mkdtempSync(join(tmpdir(), 'rcs-consol-db-'))
  const WS = 'c:/proj/consol'
  const store = new MemoryStore(new DatabaseSync(join(root, 'm.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
  store.ingest({
    sid: 's1', seq: 1, kind: 'insight', key: 'old-state', scope: 'ws:' + WS,
    value: { summary: '工作区包含 COMP 目录。', confidence: 0.9 }, source: { sid: 's1', seq: 1 }, extractor: 'seed', ts: Date.now() - 5000,
  })
  store.ingest({
    sid: 's1', seq: 2, kind: 'insight', key: 'port-constraint', scope: 'ws:' + WS,
    value: { summary: '接口端口固定为 8848。', confidence: 0.9 }, source: { sid: 's1', seq: 2 }, extractor: 'seed', ts: Date.now() - 5000,
  })
  store.ingest({
    sid: 's1', seq: 3, kind: 'user_turn', key: 'turn:3', scope: 'ws:' + WS,
    value: { text: '工作区已经改成新的测试目录了。' }, source: { sid: 's1', seq: 3 }, extractor: 'rule', ts: Date.now() - 1000,
  })
  const evId = store.db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').get().id
  const reply = JSON.stringify({ ops: [
    // 故意把 new 放在 supersede 之前：应用阶段必须最后写新值，不能被墓碑盖掉。
    { op: 'new', key: 'old-state', summary: '工作区已改为新的测试目录。', confidence: 0.8, type: 'state', evidence: [String(evId)] },
    { op: 'supersede', target: 'old-state', reason: '目录已改为新位置', evidence: [String(evId)] },
    { op: 'mark_stale', target: 'port-constraint', reason: '尝试误删约束', evidence: [String(evId)] },
  ] })
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const con = new MemoryConsolidator(store)
  const r = await con.consolidate({ sid: 's1', workspace: WS, llm, route: { provider: 'fake', model: 'fake-1' }, trigger: 'manual' })
  check('② 整理成功', r.ok === true, JSON.stringify(r))
  const oldRow = store.db.prepare("SELECT status, value, fact_type FROM records WHERE key='old-state'").get()
  check('② 新值最后写入，不被墓碑盖掉', oldRow?.status === 'active' && JSON.parse(oldRow.value).summary === '工作区已改为新的测试目录。', JSON.stringify(oldRow))
  check('② 新值类型正确', oldRow?.fact_type === 'state', oldRow?.fact_type)
  check('② constraint 没被误删', store.db.prepare("SELECT status FROM records WHERE key='port-constraint'").get()?.status === 'active')
  check('② 取代计数', r.superseded === 1, JSON.stringify(r))
  check('② 约束保护计数', r.protected === 1, r.protected)
  const auditRows = store.db.prepare("SELECT value FROM records WHERE kind='audit'").all()
  check('② 审计记录了取代', auditRows.some((x) => /"op":"supersede"/.test(String(x.value))), JSON.stringify(auditRows))
  check('② 审计已写', auditRows.length >= 2, auditRows.length)
  check('② 游标推进', Number(store.getMetaRaw('consolidateEventId:' + WS)) >= evId)
  const allMax = Number(store.db.prepare('SELECT MAX(id) m FROM events WHERE scope=?').get('ws:' + WS)?.m ?? 0)
  check('② 自写事件不计入下次整理', store.maxRealEventId(WS) === Number(store.getMetaRaw('consolidateEventId:' + WS)), JSON.stringify({ real: store.maxRealEventId(WS), cursor: store.getMetaRaw('consolidateEventId:' + WS) }))
  check('② 自写事件确实存在但不计入', allMax > store.maxRealEventId(WS), JSON.stringify({ allMax, real: store.maxRealEventId(WS) }))

  const again = await con.consolidate({ sid: 's1', workspace: WS, llm, route: { provider: 'fake', model: 'fake-1' }, trigger: 'auto' })
  check('② 无新事件时跳过模型', again.ok === true && again.reason === 'no-new', JSON.stringify(again))
  store.close()
}

// ④ 重置前后证据闸门：旧事件不得复活事实；约束类型不得降级
{
  const root = mkdtempSync(join(tmpdir(), 'rcs-consol-reset-'))
  const WS = 'c:/proj/reset'
  const store = new MemoryStore(new DatabaseSync(join(root, 'm.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
  const t0 = Date.now() - 10_000
  store.ingest({ sid: 's1', seq: 1, kind: 'insight', key: 'old-state', scope: 'ws:' + WS, value: { summary: '旧目录仍在 COMP。' }, source: { sid: 's1', seq: 1 }, extractor: 'seed', ts: t0 })
  store.ingest({ sid: 's1', seq: 2, kind: 'insight', key: 'port-constraint', scope: 'ws:' + WS, value: { summary: '端口固定为 8848。' }, source: { sid: 's1', seq: 2 }, extractor: 'seed', ts: t0 })
  store.ingest({ sid: 's1', seq: 3, kind: 'user_turn', key: 'turn:pre', scope: 'ws:' + WS, value: { text: '旧目录里有脚本。' }, source: { sid: 's1', seq: 3 }, extractor: 'rule', ts: t0 + 1000 })
  const resetAt = t0 + 2000
  store.addReset({ workspace: WS, at: resetAt, seq: 77, cmd: "Remove-Item 'COMP' -Recurse" })
  store.sweep({ workspace: WS })
  store.ingest({ sid: 's1', seq: 4, kind: 'user_turn', key: 'turn:post', scope: 'ws:' + WS, value: { text: '新目录是 WORK，端口固定为 8848。' }, source: { sid: 's1', seq: 4 }, extractor: 'rule', ts: resetAt + 1000 })
  store.ingest({ sid: 's1', seq: 5, kind: 'insight', key: 'new-state', scope: 'ws:' + WS, value: { summary: '当前目录是 WORK。' }, source: { sid: 's1', seq: 5 }, extractor: 'seed', ts: resetAt + 1000 })
  store.ingest({ sid: 's1', seq: 6, kind: 'user_turn', key: 'turn:later', scope: 'ws:' + WS, value: { text: 'WORK 也改名了。' }, source: { sid: 's1', seq: 6 }, extractor: 'rule', ts: resetAt + 5000 })
  const idOf = (key) => store.db.prepare("SELECT id FROM events WHERE key=?").get(key)?.id
  const preId = String(idOf('turn:pre'))
  const postId = String(idOf('turn:post'))
  const laterId = String(idOf('turn:later'))
  const con = new MemoryConsolidator(store)
  const g = con.gather(WS)
  check('④ 重置前事件不进入模型窗口', g.events.length > 0 && g.events.every((e) => Number(e.ts) > resetAt), JSON.stringify(g.events.map((e) => [e.id, e.ts])))
  check('④ 游标仍覆盖重置前事件', Number(g.cursor) >= Number(preId), JSON.stringify({ cursor: g.cursor, preId }))
  const counts = con.apply(WS, 's1', [
    { op: 'new', key: 'old-state', summary: '旧目录仍在 COMP。', confidence: 0.9, type: 'state', evidence: [preId] },
    { op: 'new', key: 'new-dir', summary: '当前目录是 WORK。', confidence: 0.9, type: 'state', evidence: [postId] },
    { op: 'new', key: 'port-constraint', summary: '端口固定为 8848。', confidence: 0.9, type: 'state', evidence: [postId] },
    { op: 'mark_stale', target: 'new-state', reason: '旧证据', evidence: [preId] },
    { op: 'mark_stale', target: 'new-state', reason: '只靠重置', evidence: ['r:77'] },
    { op: 'mark_stale', target: 'new-state', reason: '后续改名', evidence: [laterId] },
    { op: 'new', key: 'new-state', summary: 'WORK 已改名。', confidence: 0.9, type: 'state', evidence: [laterId] },
    { op: 'supersede', target: 'new-state', reason: '后续改名', evidence: [laterId] },
    // 没有同 key 替代值的 supersede 只会在“确认”时把仍然成立的事实藏起来，必须跳过。
    { op: 'supersede', target: 'new-dir', reason: '没有替代值', evidence: [laterId] },
  ], g)
  check('④ 重置前证据不能复活旧状态', store.db.prepare("SELECT status FROM records WHERE key='old-state'").get()?.status === 'historical')
  const newDir = store.db.prepare("SELECT status, value FROM records WHERE key='new-dir'").get()
  check('④ 重置后证据可新增事实且无替代值的取代被拒', newDir?.status === 'active' && JSON.parse(newDir.value).summary === '当前目录是 WORK。', JSON.stringify(newDir))
  check('④ 约束 key 的新事实类型不降级', store.db.prepare("SELECT fact_type FROM records WHERE key='port-constraint'").get()?.fact_type === 'constraint')
  const ns = store.db.prepare("SELECT status, value FROM records WHERE key='new-state'").get()
  check('④ 后置新事件可取代并保留新值', ns?.status === 'active' && JSON.parse(ns.value).summary === 'WORK 已改名。', JSON.stringify(ns))
  const audit4 = store.db.prepare("SELECT value FROM records WHERE kind='audit'").all()
  check('④ 取代写入审计', audit4.some((x) => /"op":"supersede"/.test(String(x.value))), JSON.stringify(audit4))
  check('④ 闸门跳过计数', counts.skipped === 5, JSON.stringify(counts))
  check('④ 取代计数', counts.superseded === 1 && counts.invalidated === 0, JSON.stringify(counts))
  store.setMetaRaw('consolidateEventId:' + WS, '0')
  const g2 = new MemoryConsolidator(store, { maxEvents: 3 }).gather(WS)
  const got = g2.events.map((e) => Number(e.id))
  const raw = store.db.prepare("SELECT id FROM events WHERE scope=? AND extractor!='consolidate' AND kind!='audit' ORDER BY id DESC LIMIT 3").all('ws:' + WS).map((r) => Number(r.id)).reverse()
  check('④ 只取最近 N 条候选事件（正序）', JSON.stringify(raw) === JSON.stringify([4, 5, 6]) && JSON.stringify(got) === JSON.stringify([4, 6]), JSON.stringify({ got, raw }))
  check('④ 同 key 旧确认事件不进入模型窗口', !got.includes(5) && g2.cursor >= 6, JSON.stringify({ got, cursor: g2.cursor }))
  store.close()
}

// ③ LLM 失败进入冷却，不破坏数据
{
  const root = mkdtempSync(join(tmpdir(), 'rcs-consol-fail-'))
  const WS = 'c:/proj/fail'
  const store = new MemoryStore(new DatabaseSync(join(root, 'm.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
  store.ingest({ sid: 's1', seq: 1, kind: 'user_turn', key: 'turn:1', scope: 'ws:' + WS, value: { text: 'x' }, source: { sid: 's1', seq: 1 }, extractor: 'rule' })
  const llm = { async *stream() { throw new Error('boom') } }
  const con = new MemoryConsolidator(store)
  const r = await con.consolidate({ sid: 's1', workspace: WS, llm, route: { provider: 'fake', model: 'f' }, trigger: 'auto' })
  check('③ 失败可观测', r.ok === false && r.reason === 'llm-failed', JSON.stringify(r))
  const r2 = await con.consolidate({ sid: 's1', workspace: WS, llm, route: { provider: 'fake', model: 'f' }, trigger: 'auto' })
  check('③ 自动触发进入冷却', r2.ok === false && r2.reason === 'cooldown', JSON.stringify(r2))
  const r3 = await con.consolidate({ sid: 's1', workspace: WS, llm, route: { provider: 'fake', model: 'f' }, trigger: 'manual' })
  check('③ 手动触发不被冷却挡住', r3.reason === 'llm-failed', JSON.stringify(r3))
  store.close()
}

// ⑤ 全部操作被拒时只修复一次；仍失败则记为 parse-failed 且不推进游标
{
  const root = mkdtempSync(join(tmpdir(), 'rcs-consol-repair-'))
  const WS = 'c:/proj/repair'
  const store = new MemoryStore(new DatabaseSync(join(root, 'm.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
  store.ingest({ sid: 's1', seq: 1, kind: 'user_turn', key: 'turn:1', scope: 'ws:' + WS, value: { text: '工作区端口改为 9000。' }, source: { sid: 's1', seq: 1 }, extractor: 'rule' })
  const evId = String(store.db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').get().id)
  const bad = JSON.stringify({ ops: [{ op: 'mark_stale', target: 'ghost', reason: 'x', evidence: [evId] }] })
  const good = JSON.stringify({ ops: [{ op: 'new', key: 'port-new', summary: '工作区端口改为 9000。', confidence: 0.9, type: 'constraint', evidence: [evId] }] })
  let calls = 0
  const llm = {
    async *stream() {
      calls++
      yield { type: 'text-delta', text: calls === 1 ? bad : good }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const con = new MemoryConsolidator(store)
  const r = await con.consolidate({ sid: 's1', workspace: WS, llm, route: { provider: 'fake', model: 'f' }, trigger: 'manual' })
  check('⑤ 全拒后修复一次并成功', r.ok === true && r.repaired === true && r.added === 1, JSON.stringify(r))
  check('⑤ 修复只多一次模型调用', calls === 2, calls)
  store.close()

  const root2 = mkdtempSync(join(tmpdir(), 'rcs-consol-repair-fail-'))
  const WS2 = 'c:/proj/repair-fail'
  const store2 = new MemoryStore(new DatabaseSync(join(root2, 'm.sqlite')), { stateDir: root2, rawDir: join(root2, 'raw') })
  store2.ingest({ sid: 's1', seq: 1, kind: 'user_turn', key: 'turn:1', scope: 'ws:' + WS2, value: { text: 'x' }, source: { sid: 's1', seq: 1 }, extractor: 'rule' })
  const id2 = String(store2.db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').get().id)
  const alwaysBad = JSON.stringify({ ops: [{ op: 'mark_stale', target: 'ghost', reason: 'x', evidence: [id2] }] })
  const llm2 = { async *stream() { yield { type: 'text-delta', text: alwaysBad }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const con2 = new MemoryConsolidator(store2)
  const r2 = await con2.consolidate({ sid: 's1', workspace: WS2, llm: llm2, route: { provider: 'fake', model: 'f' }, trigger: 'manual' })
  check('⑤ 修复仍失败记为 parse-failed', r2.ok === false && r2.reason === 'parse-failed', JSON.stringify(r2))
  check('⑤ 解析失败不推进游标', store2.getMetaRaw('consolidateEventId:' + WS2) == null)
  const r3 = await con2.consolidate({ sid: 's1', workspace: WS2, llm: llm2, route: { provider: 'fake', model: 'f' }, trigger: 'auto' })
  check('⑤ 解析失败进入自动冷却', r3.ok === false && r3.reason === 'cooldown', JSON.stringify(r3))
  store2.close()
}

// ⑥ 同 key 的 new 是替换值：证据早于事实更新时间时不得覆盖
{
  const root = mkdtempSync(join(tmpdir(), 'rcs-consol-stale-new-'))
  const WS = 'c:/proj/stale-new'
  const store = new MemoryStore(new DatabaseSync(join(root, 'm.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
  store.ingest({
    sid: 's1', seq: 1, kind: 'user_turn', key: 'turn:old', scope: 'ws:' + WS,
    value: { text: '目录旧名称是 OLD。' }, source: { sid: 's1', seq: 1 }, extractor: 'rule', ts: Date.now() - 6000,
  })
  store.ingest({
    sid: 's1', seq: 2, kind: 'insight', key: 'kept-state', scope: 'ws:' + WS,
    value: { summary: '目录当前名称是 NEW。' }, source: { sid: 's1', seq: 2 }, extractor: 'seed', ts: Date.now() - 1000,
  })
  store.ingest({
    sid: 's1', seq: 3, kind: 'command', key: 'kept-state', scope: 'ws:' + WS,
    value: { action: 'pwsh', status: 'OK', cmd: 'Get-ChildItem', out: '目录当前名称是 NEWER。' },
    source: { sid: 's1', seq: 3 }, extractor: 'rule', ts: Date.now() + 1000,
  })
  const oldEv = String(store.db.prepare("SELECT id FROM events WHERE key='turn:old'").get().id)
  const newEv = String(store.db.prepare("SELECT id FROM events WHERE seq=3 AND kind='command'").get().id)
  const con = new MemoryConsolidator(store)
  const g = con.gather(WS)
  check('⑥ 同 key 的更新事件仍进入模型窗口', g.events.some((e) => String(e.id) === newEv), JSON.stringify(g.events.map((e) => e.id)))
  const counts = con.apply(WS, 's1', [
    { op: 'new', key: 'kept-state', summary: '目录旧名称是 OLD。', confidence: 0.9, type: 'state', evidence: [oldEv] },
  ], g)
  const row = store.db.prepare("SELECT status, value FROM records WHERE key='kept-state'").get()
  check('⑥ 旧证据不能覆盖同 key 现有事实', JSON.parse(row.value).summary === '目录当前名称是 NEW。' && row.status === 'active', JSON.stringify(row))
  check('⑥ 旧证据覆盖被跳过', counts.added === 0 && counts.skipped === 1, JSON.stringify(counts))
  const counts2 = con.apply(WS, 's1', [
    { op: 'new', key: 'kept-state', summary: '目录当前名称是 NEWER。', confidence: 0.9, type: 'state', evidence: [newEv] },
  ], con.gather(WS))
  const row2 = store.db.prepare("SELECT status, value FROM records WHERE key='kept-state'").get()
  check('⑥ 更新证据可替换同 key 事实', counts2.added === 1 && JSON.parse(row2.value).summary === '目录当前名称是 NEWER。', JSON.stringify({ counts2, row2 }))
  store.close()
}

// ⑦ new 的 grounding 只看被引用证据，不能被当前事实文本自我证明
{
  const root = mkdtempSync(join(tmpdir(), 'rcs-consol-cited-'))
  const WS = 'c:/proj/cited'
  const store = new MemoryStore(new DatabaseSync(join(root, 'm.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
  store.ingest({
    sid: 's1', seq: 1, kind: 'insight', key: 'port-state', scope: 'ws:' + WS,
    value: { summary: '接口端口固定为 8848。' }, source: { sid: 's1', seq: 1 }, extractor: 'seed', ts: Date.now() - 1000,
  })
  store.ingest({
    sid: 's1', seq: 1, kind: 'insight', key: 'name-state', scope: 'ws:' + WS,
    value: { summary: '目录当前名称是 NEW。' }, source: { sid: 's1', seq: 1 }, extractor: 'seed', ts: Date.now() - 2000,
  })
  store.ingest({
    sid: 's1', seq: 2, kind: 'user_turn', key: 'turn:rain', scope: 'ws:' + WS,
    value: { text: '今天下雨。' }, source: { sid: 's1', seq: 2 }, extractor: 'rule', ts: Date.now(),
  })
  const rainEv = String(store.db.prepare("SELECT id FROM events WHERE key='turn:rain'").get().id)
  const con = new MemoryConsolidator(store)
  const bad = con.apply(WS, 's1', [
    { op: 'new', key: 'port-state', summary: '接口端口固定为 8848。', confidence: 0.99, type: 'state', evidence: [rainEv] },
  ], con.gather(WS))
  const row = store.db.prepare("SELECT value FROM records WHERE key='port-state'").get()
  check('⑦ 无引用证据支撑的摘要不能自我证明', bad.added === 0 && bad.skipped === 1, JSON.stringify(bad))
  check('⑦ 事实未被无关事件改写', JSON.parse(row.value).confidence == null && JSON.parse(row.value).summary === '接口端口固定为 8848。', JSON.stringify(row))

  const proseBad = con.apply(WS, 's1', [
    { op: 'new', key: 'name-state', summary: '目录当前名称是 NEW。', confidence: 0.99, type: 'state', evidence: [rainEv] },
  ], con.gather(WS))
  const proseRow = store.db.prepare("SELECT value FROM records WHERE key='name-state'").get()
  check('⑦ 纯文本摘要也不能靠无关事件自我复制', proseBad.added === 0 && proseBad.skipped === 1, JSON.stringify(proseBad))
  check('⑦ 纯文本事实保持原值', JSON.parse(proseRow.value).confidence == null && JSON.parse(proseRow.value).summary === '目录当前名称是 NEW。', JSON.stringify(proseRow))

  store.ingest({
    sid: 's1', seq: 3, kind: 'user_turn', key: 'turn:port', scope: 'ws:' + WS,
    value: { text: '已确认接口端口固定为 8848。' }, source: { sid: 's1', seq: 3 }, extractor: 'rule', ts: Date.now() + 1000,
  })
  const portEv = String(store.db.prepare("SELECT id FROM events WHERE key='turn:port'").get().id)
  const portTs = Number(store.db.prepare('SELECT ts FROM events WHERE id=?').get(portEv).ts)
  const good = con.apply(WS, 's1', [
    { op: 'new', key: 'port-state', summary: '接口端口固定为 8848。', confidence: 0.99, type: 'state', evidence: [portEv] },
  ], con.gather(WS))
  const row2 = JSON.parse(store.db.prepare("SELECT value FROM records WHERE key='port-state'").get().value)
  check('⑦ 引用证据含摘要数字时可写入', good.added === 1 && good.skipped === 0, JSON.stringify(good))
  check('⑦ 写入带 citations 与 validFrom', JSON.stringify(row2.citations) === JSON.stringify([portEv]) && row2.validFrom === portTs, JSON.stringify(row2))

  store.ingest({
    sid: 's1', seq: 4, kind: 'user_turn', key: 'turn:name', scope: 'ws:' + WS,
    value: { text: '已确认目录当前名称是 NEWER。' }, source: { sid: 's1', seq: 4 }, extractor: 'rule', ts: Date.now() + 2000,
  })
  const nameEv = String(store.db.prepare("SELECT id FROM events WHERE key='turn:name'").get().id)
  const proseGood = con.apply(WS, 's1', [
    { op: 'new', key: 'name-state', summary: '目录当前名称是 NEWER。', confidence: 0.9, type: 'state', evidence: [nameEv] },
  ], con.gather(WS))
  const proseRow2 = JSON.parse(store.db.prepare("SELECT value FROM records WHERE key='name-state'").get().value)
  check('⑦ 有文本支持时可替换纯文本事实', proseGood.added === 1 && proseRow2.summary === '目录当前名称是 NEWER。', JSON.stringify({ proseGood, proseRow2 }))

  const downgrade = con.apply(WS, 's1', [
    { op: 'new', key: 'name-state', summary: '目录当前名称是 NEWER。', confidence: 0.9, type: 'history', evidence: [nameEv] },
  ], con.gather(WS))
  const row3 = store.db.prepare("SELECT fact_type, status FROM records WHERE key='name-state'").get()
  check('⑦ 同 key 新值不能把 state 降级为 history', downgrade.added === 1 && row3?.fact_type === 'state' && row3?.status === 'active', JSON.stringify({ downgrade, row3 }))
  store.close()
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
