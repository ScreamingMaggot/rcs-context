// 原生压缩后不复活旧转录（v1.10.74 回归）
//   实测根因（2026-11-11，session-64963da1 / spark 131072 窗口，12 轮 11 次原生压缩）：
//   DSH 原生压缩把插件的折叠检查点一起总结掉之后，`st.foldText` 仍是压缩前的非空旧值
//   （`seedFoldState` 只在 `foldText === ''` 时才跑），下一次折叠因此把**整份压缩前的转录**
//   又拼进新检查点 ⇒ 上下文立刻回到压缩前大小 ⇒ 下一轮再次越线、再次原生压缩。
//   本测试钉住两条契约：
//   ① 缺省：非自身 compaction/end 之后清空折叠基线，下一折从**压缩后的表面**重建，旧转录不回流；
//   ② 开关：control.resetAfterNativeCompaction=false ⇒ 保持旧行为（可 A/B，且证明 ① 的差异真实存在）。
// 运行：node tests/native-compaction-reset.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const k of ['DSH_CONTEXTINJECTOR_ENABLED', 'DSH_CONTEXTINJECTOR_TEST_ROUND', 'DSH_CONTEXTINJECTOR_TRACE',
  'DSH_CONTEXTINJECTOR_FOLD_AT_TURN_END', 'DSH_CONTEXTINJECTOR_FOLD_JOIN_MS', 'DSH_CONTEXTINJECTOR_NATIVE_RESET']) {
  delete process.env[k]
}
const root = mkdtempSync(join(tmpdir(), 'rcs-native-reset-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, 'code', d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'code', 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'code', 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'code', 'toolfold', 'toolfold.mjs'))
const stateDir = join(root, 'state')
mkdirSync(stateDir, { recursive: true })
const CONTROL = join(stateDir, 'control.json')
const writeControl = (obj) => writeFileSync(CONTROL, JSON.stringify(obj), 'utf8')
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = stateDir

const mod = await import(pathToFileURL(join(root, 'code', 'web', 'contextinjector.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, timeout = 3000, step = 20) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = fn()
    if (v) return v
    await sleep(step)
  }
  return fn()
}

// —— 假宿主：surface 真正应用 replace 投影；额外支持直接派发任意 session/event ——
function makeHost(sid) {
  const events = []
  const appended = []
  const nodes = []
  const handlers = {}
  const llm = {
    listProviders: () => [],
    listModels: async () => [],
    async *stream() {
      yield { type: 'text-delta', text: '浓缩后的摘要。' }
      yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    on(name, h) { (handlers[name] ??= []).push(h) },
    inject() { /* tools 延迟挂载，测试用不到 */ },
    get(name) { return name === 'llm' ? llm : null },
  }
  mod.default.apply(ctx)
  const session = {
    id: sid,
    surface: { nodes },
    ownEvents: () => events,
    eventAt: (seq) => events[seq],
    deriveEventMessage: (ev) => {
      if (!ev) return null
      if (ev.__msg) return ev.__msg
      return ev.type === 'user/message' && ev.data?.role ? ev.data : null
    },
    deriveMessages: () => nodes.map((s) => session.deriveEventMessage(events[s])).filter(Boolean),
    requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
    append(type, data, meta) {
      const ev = { seq: 1000 + appended.length, type, data, meta }
      appended.push(ev)
      events[ev.seq] = ev
      const op = meta?.surfaceOp
      if (op?.op === 'replace') {
        const i = nodes.findIndex((s) => s >= op.startSeq && s <= op.endSeq)
        if (i >= 0) {
          let n = 0
          while (i + n < nodes.length && nodes[i + n] >= op.startSeq && nodes[i + n] <= op.endSeq) n += 1
          nodes.splice(i, n, ev.seq)
        } else {
          nodes.push(ev.seq)
        }
      } else if (String(type).includes('message')) {
        nodes.push(ev.seq)
      }
      return { seq: ev.seq, type, data }
    },
  }
  const fire = (ev) => { for (const h of handlers['session/event'] ?? []) h(session, ev) }
  const fireTurnEnd = (turn) => fire({ type: 'turn/end', data: { turn } })
  // 只认插件自己的检查点（宿主原生压缩写的那条 source 里没有 plugin 标识）
  const checkpoints = () => appended.filter((e) => e.type === 'user/message' && e.data?.source?.plugin === 'CONTEXTinjector')
  return { session, events, appended, nodes, fire, fireTurnEnd, checkpoints }
}
const addUser = (host, seq, text) => {
  host.events[seq] = { seq, type: 'user/message', data: {}, __msg: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
  host.nodes.push(seq)
}
const addAssistant = (host, seq, text) => {
  host.events[seq] = { seq, type: 'assistant/message', data: {}, __msg: { role: 'assistant', content: [{ type: 'text', text }] } }
  host.nodes.push(seq)
}
const endTurn = (host, seq, turn) => { host.events[seq] = { seq, type: 'turn/end', data: { turn } } }
const textOf = (cp) => (cp.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')

const MARK_OLD = 'ZQ-OLD-TRANSCRIPT-MARKER'
const MARK_NEW = 'ZQ-NEW-ROUND-MARKER'

// 原生压缩：宿主把自己的检查点消息替换掉旧节点（含插件检查点），再发 compaction/start|end
async function runScenario({ sid, reset }) {
  writeControl({ enabled: true, sessions: [sid], sessionModes: { [sid]: 'off' }, foldMinShadowBytes: 0, resetAfterNativeCompaction: reset })
  const host = makeHost(sid)

  // 第 1 轮 → 插件折叠出 CP1（转录里带 MARK_OLD）
  addUser(host, 1, MARK_OLD + ' 第一轮的问题')
  addAssistant(host, 2, '第一轮的回答')
  endTurn(host, 3, 1)
  host.fireTurnEnd(1)
  const cp1 = await waitFor(() => host.checkpoints()[0], 3000)
  if (!cp1) throw new Error('scenario: first fold did not commit')

  // 宿主原生压缩：CP1 与第 1 轮一起被一条 summary 替换
  const summary = host.session.append('user/message', {
    role: 'user',
    source: { kind: 'compact-checkpoint' },
    content: [{ type: 'text', text: '<compacted-summary>宿主总结：第一轮已完成。</compacted-summary>' }],
  }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: cp1.seq } })
  host.fire({ type: 'compaction/start', data: { compactionId: 'native-test-1', turn: null } })
  host.fire({ type: 'compaction/end', data: { compactionId: 'native-test-1', turn: null } })

  // 第 2 轮 → 插件再折一次
  addUser(host, 4, MARK_NEW + ' 第二轮的问题')
  addAssistant(host, 5, '第二轮的回答')
  endTurn(host, 6, 2)
  host.fireTurnEnd(2)
  const cp2 = await waitFor(() => host.checkpoints()[1], 3000)
  return { host, cp1, cp2, summarySeq: summary.seq, cp1Text: textOf(cp1) }
}

/* ① 缺省：重置基线 ⇒ 旧转录不回流 */
{
  const { host, cp2, cp1Text, summarySeq } = await runScenario({ sid: 'session-aaaa1111-1111-4111-8111-aaaaaaaaaaaa', reset: true })
  check('① 原生压缩后仍能继续折叠（CP2 已提交）', !!cp2)
  if (cp2) {
    const t = textOf(cp2)
    check('① CP1 的转录确实含旧标记（前提成立）', cp1Text.includes(MARK_OLD), cp1Text.slice(0, 60))
    check('① CP2 不再包含压缩前的旧转录（不复活）', !t.includes(MARK_OLD), t.slice(0, 80))
    check('① CP2 含压缩后新一轮的内容', t.includes(MARK_NEW), t.slice(0, 80))
    const op = cp2.meta?.surfaceOp ?? {}
    check('① 宿主检查点仍留在表面（折叠从它之后开始，不吞掉 summary）',
      host.nodes.includes(summarySeq) && op.startSeq !== summarySeq, JSON.stringify({ op, nodes: host.nodes }))
  }
}

/* ② 开关关闭：保持旧行为（旧转录被整份写回）——证明 ① 的差异真实存在 */
{
  const { cp2 } = await runScenario({ sid: 'session-bbbb2222-2222-4222-8222-bbbbbbbbbbbb', reset: false })
  check('② 关闭开关后仍能折叠（CP2 已提交）', !!cp2)
  if (cp2) {
    const t = textOf(cp2)
    check('② 关闭开关 ⇒ 旧转录被写回（旧行为可复现）', t.includes(MARK_OLD), t.slice(0, 80))
  }
}

/* ③ 开关语义：env 硬覆盖 > control */
{
  check('③ control 缺省 ⇒ 开', mod.nativeCompactionResetOn({}) === true)
  check('③ control=false ⇒ 关', mod.nativeCompactionResetOn({ resetAfterNativeCompaction: false }) === false)
  check('③ env=0 硬覆盖 control=true', mod.nativeCompactionResetOn({ resetAfterNativeCompaction: true }, '0') === false)
  check('③ env=1 硬覆盖 control=false', mod.nativeCompactionResetOn({ resetAfterNativeCompaction: false }, '1') === true)
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
