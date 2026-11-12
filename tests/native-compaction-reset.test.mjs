// 原生压缩 ⇒ 卷封存 + 轮次继承 + 边界缀增（v1.10.75 回归；含 v1.10.74 的两条旧契约）
//   背景（2026-11-11，session-64963da1 / spark 131072 窗口，12 轮 11 次原生压缩）：
//   宿主原生压缩只压**前缀**（selectCompactableRange 从尾部保留 retainTokens），插件注入的转录在尾部，
//   原生碰不到它；而插件又把自己的整份转录随轮次单调追加 ⇒ 每轮都越线、每轮都原生压缩。
//   v1.10.74 只止住了"压缩后旧转录被整份拼回去"，没有回答"旧卷该怎么处置"。
//   v1.10.75（用户定的最小改法）：
//     ① 封存：原生 compaction/end（非自身、非错误）⇒ 当前卷原文落 sealed/<sid>/v<N>.json，索引记
//        baseRound / resumeAfterSeq / volumes[]；封存卷不再被追加、不再进上下文。
//     ② 继承轮次：新卷 [ROUND] 从封存时的 foldRound 续号。
//     ③ 边界缀增：新卷只缀增原生摘要覆盖范围之后的节点（摘要给出单调边界；只有检查点时按位置切）。
//   本测试钉住：①旧转录不回流 ②开关能回到旧行为 ③开关语义 ④封存产物+轮次继承+单调边界
//             ⑤旧卷仍留在表面时原地冻结 ⑥进程重启后 seed 不把封存卷灌回来。
// 运行：node tests/native-compaction-reset.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
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
//   seq 统一单调分配（与真宿主一致：后 append 的节点 seq 更大）。"重启后的 host" 复用同一份 events/nodes。
let SEQ = 1000
function makeHost(sid, adopt = null) {
  const events = adopt?.events ?? []
  const nodes = adopt?.nodes ?? []
  const appended = []
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
      const ev = { seq: SEQ++, type, data, meta }
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
const addUser = (host, text) => {
  const seq = SEQ++
  host.events[seq] = { seq, type: 'user/message', data: {}, __msg: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
  host.nodes.push(seq)
  return seq
}
const addAssistant = (host, text) => {
  const seq = SEQ++
  host.events[seq] = { seq, type: 'assistant/message', data: {}, __msg: { role: 'assistant', content: [{ type: 'text', text }] } }
  host.nodes.push(seq)
  return seq
}
const endTurn = (host, turn) => { const seq = SEQ++; host.events[seq] = { seq, type: 'turn/end', data: { turn } }; return seq }
const textOf = (cp) => (cp.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
const roundOf = (text) => { const m = /^\[ROUND\]\s*(\d+)/m.exec(String(text ?? '')); return m ? Number(m[1]) : null }
// 最后一行 [ROUND]：重启后 seed 会把**当前卷**（CP2）接回基线，所以首行仍是 CP2 的 ROUND 2，
// 续号要看尾部（新增的那一轮）。
const lastRoundOf = (text) => {
  const ns = [...String(text ?? '').matchAll(/^\[ROUND\]\s*(\d+)/gm)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n))
  return ns.length ? Math.max(...ns) : null
}

const MARK_OLD = 'ZQ-OLD-TRANSCRIPT-MARKER'
const MARK_NEW = 'ZQ-NEW-ROUND-MARKER'

// 原生压缩：宿主用自己的一条 summary 替换 [start..end]，再发 compaction/start|end。
//   nativeMode='replace-all'    → 连插件 CP1 一起总结掉（真机 64963da1 的常见形态）
//   nativeMode='replace-prefix' → 只总结 CP1 之前的前缀，CP1 仍留在 surface（宿主保留窗口落在旧卷之后）
//   withSummary=true            → 额外写 compaction/summary（带 shadowedSeqs）给出**单调**摘要边界
async function runScenario({ sid, reset, nativeMode = 'replace-all', withSummary = false }) {
  writeControl({ enabled: true, sessions: [sid], sessionModes: { [sid]: 'off' }, foldMinShadowBytes: 0, resetAfterNativeCompaction: reset })
  const host = makeHost(sid)

  // 第 1 轮 → 插件折叠出 CP1（转录里带 MARK_OLD）
  const u1 = addUser(host, MARK_OLD + ' 第一轮的问题')
  const a1 = addAssistant(host, '第一轮的回答')
  endTurn(host, 1)
  host.fireTurnEnd(1)
  const cp1 = await waitFor(() => host.checkpoints()[0], 3000)
  if (!cp1) throw new Error('scenario: first fold did not commit')
  await sleep(120) // 等后台折叠把 st.foldText 写回（封存读的是它）

  const endSeq = nativeMode === 'replace-prefix' ? a1 : cp1.seq
  const summary = host.session.append('user/message', {
    role: 'user',
    source: { kind: 'compact-checkpoint' },
    content: [{ type: 'text', text: '<compacted-summary>宿主总结：第一轮已完成。</compacted-summary>' }],
  }, { surfaceOp: { op: 'replace', startSeq: u1, endSeq } })
  if (withSummary) {
    host.session.append('compaction/summary', {
      compactionId: 'native-test-1',
      summary: [{ type: 'text', text: '宿主总结：第一轮已完成。' }],
      shadowedSeqs: [u1, a1],
      shadowedRange: { start: u1, end: a1 },
    })
  }
  host.fire({ type: 'compaction/start', data: { compactionId: 'native-test-1', turn: null } })
  host.fire({ type: 'compaction/end', data: { compactionId: 'native-test-1', turn: null } })

  // 第 2 轮 → 插件再折一次
  addUser(host, MARK_NEW + ' 第二轮的问题')
  addAssistant(host, '第二轮的回答')
  endTurn(host, 2)
  host.fireTurnEnd(2)
  const cp2 = await waitFor(() => host.checkpoints()[1], 3000)
  return { host, cp1, cp2, summarySeq: summary.seq, cp1Text: textOf(cp1), u1, a1 }
}

const sealIndex = (sid) => mod.readSealIndex(sid)
const sealFile = (sid, v = 1) => join(stateDir, '.ctxinjector', 'sealed', sid.replace(/^session-?/i, ''), 'v' + v + '.json')

/* ① 缺省：封存旧卷 ⇒ 旧转录不回流、轮次续号、宿主总结留在表面 */
{
  const { host, cp2, cp1Text, summarySeq } = await runScenario({ sid: 'session-aaaa1111-1111-4111-8111-aaaaaaaaaaaa', reset: true })
  check('① 原生压缩后仍能继续折叠（CP2 已提交）', !!cp2)
  if (cp2) {
    const t = textOf(cp2)
    check('① CP1 的转录确实含旧标记（前提成立）', cp1Text.includes(MARK_OLD), cp1Text.slice(0, 60))
    check('① CP2 不再包含压缩前的旧转录（不复活）', !t.includes(MARK_OLD), t.slice(0, 80))
    check('① CP2 含压缩后新一轮的内容', t.includes(MARK_NEW), t.slice(0, 80))
    check('① CP2 轮次续号（ROUND 2，不回到 1）', roundOf(t) === 2, t.split('\n')[0])
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

/* ④ 封存产物：原文落盘、索引记轮次与单调边界、新卷只缀增边界之后 */
{
  const sid = 'session-cccc3333-3333-4333-8333-cccccccccccc'
  const { host, cp1, cp2, a1 } = await runScenario({ sid, reset: true, withSummary: true })
  check('④ CP2 已提交（封存后仍能继续折叠）', !!cp2)
  if (cp2) {
    const idx = sealIndex(sid)
    check('④ 封存索引已落盘', !!idx, JSON.stringify(idx?.volumes?.[0]?.bytes ?? null))
    check('④ 索引记了 baseRound（继承轮次的下限）', idx?.baseRound === 1, idx?.baseRound)
    check('④ 索引记了摘要边界（summary 来源、单调）', idx?.resumeAfterSeq === a1 && idx?.boundaryFrom === 'summary', JSON.stringify({ r: idx?.resumeAfterSeq, want: a1, f: idx?.boundaryFrom }))
    const vol = existsSync(sealFile(sid, 1)) ? JSON.parse(readFileSync(sealFile(sid, 1), 'utf8')) : null
    check('④ 封存卷原文在盘上（含旧转录）', !!vol && String(vol.text).includes(MARK_OLD), vol ? vol.bytes : null)
    check('④ 封存卷元数据完整（轮次/seq/sha256）', !!vol && Array.isArray(vol.rounds) && vol.rounds[1] === 1 && Array.isArray(vol.seq) && /^[0-9a-f]{64}$/.test(vol.sha256 || ''))
    check('④ 新卷轮次继承：CP2 首行 = ROUND 2', roundOf(textOf(cp2)) === 2, textOf(cp2).split('\n')[0])
    check('④ 新卷不复述旧卷', !textOf(cp2).includes(MARK_OLD), textOf(cp2).slice(0, 60))
    check('④ 新卷只遮蔽摘要边界之后的节点', Number(cp2.meta?.surfaceOp?.startSeq) > a1, JSON.stringify({ op: cp2.meta?.surfaceOp, a1 }))
    check('④ 封存卷不再被追加（新 CP 的遮蔽集不含 CP1）', !(cp2.meta?.surfaceOp && cp1.seq >= cp2.meta.surfaceOp.startSeq && cp1.seq <= cp2.meta.surfaceOp.endSeq), JSON.stringify(cp2.meta?.surfaceOp))
  }
}

/* ⑤ 旧卷仍留在表面（宿主保留窗口落在它之后）：原地冻结，不遮蔽、不重转录 —— "封存这之前的 LOG 表" */
{
  const sid = 'session-eeee5555-5555-4555-8555-eeeeeeeeeeee'
  const { host, cp1, cp2 } = await runScenario({ sid, reset: true, nativeMode: 'replace-prefix', withSummary: true })
  check('⑤ 旧卷仍能折叠（CP2 已提交）', !!cp2)
  if (cp2) {
    const idx = sealIndex(sid)
    check('⑤ 旧卷已被封存（按内容 hash 认领，而非 seq）', (idx?.volumes ?? []).some((v) => v.sha256), JSON.stringify((idx?.volumes ?? []).map((v) => v.v)))
    check('⑤ 旧卷没被重转录进新卷', !textOf(cp2).includes(MARK_OLD), textOf(cp2).slice(0, 60))
    check('⑤ 旧卷原地留在表面（没被新卷的 replace 吃掉）', host.nodes.includes(cp1.seq), JSON.stringify(host.nodes))
    const iCp1 = host.nodes.indexOf(cp1.seq)
    const iCp2 = host.nodes.indexOf(cp2.seq)
    check('⑤ 新卷落在旧卷之后（surface 位置）', iCp1 >= 0 && iCp2 > iCp1, JSON.stringify({ iCp1, iCp2, nodes: host.nodes }))
    check('⑤ 轮次仍续号', roundOf(textOf(cp2)) === 2, textOf(cp2).split('\n')[0])
  }
}

/* ⑥ 进程重启：surface 上还留着已封存的旧卷 —— seed 必须跳过它，绝不把旧转录灌回来 */
{
  const sid = 'session-ffff6666-6666-4666-8666-ffffffffffff'
  const { host, cp1, cp2 } = await runScenario({ sid, reset: true, nativeMode: 'replace-prefix', withSummary: true })
  check('⑥ 第一段（同进程）已封存并折出 CP2', !!cp1 && !!cp2)
  if (cp2) {
    // 模拟重启：同一份 events/nodes，新的 apply（新的会话状态），只保留持久化的封存索引
    const host2 = makeHost(sid, { events: host.events, nodes: host.nodes })
    addUser(host2, '第三轮的问题')
    addAssistant(host2, '第三轮的回答')
    endTurn(host2, 3)
    host2.fireTurnEnd(3)
    const cp3 = await waitFor(() => host2.checkpoints()[0], 3000)
    check('⑥ 重启后仍能折叠（CP3 已提交）', !!cp3)
    if (cp3) {
      const t = textOf(cp3)
      check('⑥ 重启后封存卷没有被 seed 回来', !t.includes(MARK_OLD), t.slice(0, 80))
      check('⑥ 重启后轮次继续（尾行 = ROUND 3，不重头）', lastRoundOf(t) === 3, t.split('\n').filter((l) => l.startsWith('[ROUND]')).join(' '))
      check('⑥ 重启后旧卷仍在表面（冻结）', host2.nodes.includes(cp1.seq), JSON.stringify(host2.nodes))
      check('⑥ 新卷仍落在旧卷之后', host2.nodes.indexOf(cp3.seq) > host2.nodes.indexOf(cp2.seq), JSON.stringify(host2.nodes))
    }
  }
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
