// 折叠触发时机回归（v1.10.38）：
//   实测（2026-10-22 session-3655c2fe）：3/3 折叠全是 pre-step 同步触发，轮末 0 次有效折叠；
//   最坏一例用户发消息后先等 60.1s（condense 折上一轮的 748B）才开始回答。
//   根因：pre-step 在 next() 之后同步 await foldAttempt；轮末触发（turn-stopping/turn-end）被
//   protectLatestRound 钳成结构性死触发（每轮只折"最近一轮之前"，而那里已经折过）⇒ 0 次有效折叠。
//   本测试钉住 v1.10.37 的减法契约（触发点 3 → 2）：
//   ① pre-step 生产路径只 join、绝不同步折，next() 恰好一次；
//   ② turn/end 后台折叠**刚结束的轮**（不再保护最近一轮）；
//   ③ 第二折是增量：替换区间从旧转录节点起到本轮末，transcript 单调累加 [ROUND] 1/2；
//   ④ 慢浓缩（模拟 60s 级）只让下一轮最多等 foldJoinTimeoutMs，请求照常放行；
//   ⑤ agent/turn-stopping 不再注册（同一时刻最多一个后台折叠）；
//   ⑥ control.foldAtTurnEnd=false ⇒ 完全不折（应急闸）；
//   ⑦ 微折门槛：缺省 2048B 以下不折、累积过门槛再折；摘要只显示本折/累计两个比值，
//      同一会话复用同一个 compactionId（聊天区只维护一行「上下文已压缩」标记）。
// 运行：node tests/fold-trigger-timing.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

// 隔离 STATE_DIR：必须在 import 前设好（模块以 const 读 env）
delete process.env.DSH_CONTEXTINJECTOR_ENABLED
delete process.env.DSH_CONTEXTINJECTOR_TEST_ROUND
delete process.env.DSH_CONTEXTINJECTOR_TRACE
delete process.env.DSH_CONTEXTINJECTOR_FOLD_AT_TURN_END
delete process.env.DSH_CONTEXTINJECTOR_FOLD_JOIN_MS
const root = mkdtempSync(join(tmpdir(), 'rcs-trig-'))
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
const { foldInflightFile } = mod

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 条件轮询，替代固定 sleep：折叠是 400ms debounce + 异步提交，固定等待既慢又会偶发
const waitFor = async (fn, timeout = 3000, step = 20) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = fn()
    if (v) return v
    await sleep(step)
  }
  return fn()
}

// —— 假宿主：surface 会真正应用 replace 投影（与真实宿主同语义），否则增量折叠测不出来 ——
function makeHost(sid, { llmDelayMs = 0 } = {}) {
  const events = []           // 按 seq 稀疏索引（ownEvents 形态）
  const appended = []         // 本插件 append 的事件（含 compaction 生命周期）
  const nodes = []            // surface.nodes：只放消息节点，replace 后替换为检查点节点
  const handlers = {}
  const llm = {
    listProviders: () => [],
    listModels: async () => [],
    async *stream() {
      if (llmDelayMs > 0) await sleep(llmDelayMs)
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
    requestHeader: () => ({ config: { provider: 'fake', model: 'slow' } }),
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
  const fireTurnEnd = (turn) => {
    for (const h of handlers['session/event'] ?? []) h(session, { type: 'turn/end', data: { turn } })
  }
  const preStep = async () => {
    let calls = 0
    const next = async () => { calls++; return 'decision' }
    const decision = await (handlers['agent/pre-step'] ?? [])[0]({ agent: { session }, messages: ['u'], turn: 1, step: 1 }, next)
    return { decision, nextCalls: calls }
  }
  const hasHandler = (name) => (handlers[name]?.length ?? 0) > 0
  return { session, events, appended, nodes, fireTurnEnd, preStep, hasHandler }
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
const compactionEvents = (host) => host.appended.filter((e) => String(e.type).startsWith('compaction/'))
const checkpoints = (host) => host.appended.filter((e) => e.type === 'user/message')

const U = (n) => '第一轮的问题内容'.repeat(n)   // 每条 8 字 × 3B = 24B/次
const A = (n) => '第一轮的回答内容较长'.repeat(n)

/* ── 场景 1+2：pre-step 只 join；turn/end 折刚结束的轮；第二折增量累加 ──────────── */
{
  const sid = 'session-11111111-1111-4111-8111-111111111111'
  writeControl({ enabled: true, sessions: [sid], sessionModes: { [sid]: 'off' }, foldMinShadowBytes: 0 })
  const host = makeHost(sid)
  check('⑤ 不再注册 agent/turn-stopping（触发点 3 → 2）', !host.hasHandler('agent/turn-stopping'))

  addUser(host, 1, U(10))
  addAssistant(host, 2, A(20))
  endTurn(host, 3, 1)

  const before = host.appended.length
  const first = await host.preStep()
  check('① pre-step next() 恰好一次', first.nextCalls === 1, `nextCalls=${first.nextCalls}`)
  check('① pre-step 返回决策', first.decision === 'decision')
  check('① pre-step 生产路径不产生任何折叠事件', host.appended.length === before,
    `appended=${host.appended.length - before}`)

  host.fireTurnEnd(1)
  const cp1 = await waitFor(() => checkpoints(host)[0], 3000)
  check('② turn/end 后台折掉刚结束的轮（检查点已提交）', !!cp1,
    `checkpoints=${checkpoints(host).length}`)
  check('② 生命周期走宿主 compaction 协议', compactionEvents(host).length === 3,
    `events=${compactionEvents(host).map((e) => e.type).join(',')}`)
  if (cp1) {
    const op = cp1.meta?.surfaceOp ?? {}
    check('② 替换区间覆盖刚结束轮的全部节点（seq 1..2）',
      op.op === 'replace' && op.startSeq === 1 && op.endSeq === 2, JSON.stringify(op))
    const text = cp1.data?.content?.[0]?.text ?? ''
    check('② 转录含刚结束轮的 [U] 与 [A]', text.includes('[U]') && text.includes('[A]'), text.slice(0, 60))
    const sum1 = host.appended.find((e) => e.type === 'compaction/summary')
    check('⑦ 摘要只显示两个压缩比（本折/累计）',
      /^本折 [\d.—]+ · 累计 [\d.—]+$/.test(sum1?.data?.summary?.[0]?.text ?? ''),
      sum1?.data?.summary?.[0]?.text)
    check('⑦ 宿主折叠行依赖的统计字段仍在',
      Array.isArray(sum1?.data?.shadowedSeqs) && sum1.data.shadowedSeqs.length === 2 && sum1.data.shadowedTokenCount > 0,
      JSON.stringify({ seqs: sum1?.data?.shadowedSeqs, tok: sum1?.data?.shadowedTokenCount }))
  }

  // 第二轮：pre-step 仍然只 join；轮末把新轮与旧转录节点一起增量折掉
  addUser(host, 4, U(15))
  addAssistant(host, 5, A(20))
  endTurn(host, 6, 2)
  const second = await host.preStep()
  check('① 第二轮 pre-step 仍不折（next 一次）',
    second.nextCalls === 1 && checkpoints(host).length === 1,
    `nextCalls=${second.nextCalls} checkpoints=${checkpoints(host).length}`)

  host.fireTurnEnd(2)
  const both = await waitFor(() => (checkpoints(host).length === 2 ? checkpoints(host) : null), 3000)
  check('② 第二轮 turn/end 也折掉刚结束的轮', !!both, `checkpoints=${checkpoints(host).length}`)
  if (both) {
    const cp2 = both[1]
    const op = cp2.meta?.surfaceOp ?? {}
    check('③ 替换区间从旧转录节点起到本轮末（增量、不重折旧 seq）',
      op.op === 'replace' && op.startSeq === cp1.seq && op.endSeq === 5, JSON.stringify(op))
    const text = cp2.data?.content?.[0]?.text ?? ''
    check('③ 转录单调累加两轮（[ROUND] 1 与 2）',
      text.includes('[ROUND] 1') && text.includes('[ROUND] 2'), text.slice(0, 80))
    check('③ 转录含两轮的 [U] 与 [A]',
      (text.match(/\[U\]/g) ?? []).length === 2 && (text.match(/\[A\]/g) ?? []).length === 2,
      `U=${(text.match(/\[U\]/g) ?? []).length} A=${(text.match(/\[A\]/g) ?? []).length}`)
    check('⑦ 两次折叠复用同一 compactionId（聊天区只更新一行标记）',
      cp2.data?.source?.compactionId === cp1.data?.source?.compactionId,
      `${cp1.data?.source?.compactionId} vs ${cp2.data?.source?.compactionId}`)
  }
}

/* ── 场景 3：慢浓缩只让下一轮等到 foldJoinTimeoutMs，绝不等到折叠结束 ───────────── */
{
  const sid = 'session-33333333-3333-4333-8333-333333333333'
  writeControl({ enabled: true, sessions: [sid], sessionModes: { [sid]: 'single' }, foldJoinTimeoutMs: 200, foldMinShadowBytes: 0 })
  const host = makeHost(sid, { llmDelayMs: 1200 })
  addUser(host, 1, U(5))
  addAssistant(host, 2, A(40)) // 960 字 > condenseMinBytes，确保真的发起慢调用
  endTurn(host, 3, 1)

  host.fireTurnEnd(1)
  const started = await waitFor(() => existsSync(foldInflightFile(sid)), 2000)
  check('④ 轮末折叠已进入在飞状态', started)

  const t0 = Date.now()
  const pre = await host.preStep()
  const elapsed = Date.now() - t0
  // 【v1.10.53 · 非阻塞 join】pre-step 不再等待折叠完成，直接放行请求。
  // 旧行为：elapsed >= 150（等 foldJoinTimeoutMs）；新行为：elapsed < 50（几乎不等待）。
  check('④ pre-step 非阻塞 join（不被慢折叠拖住）',
    pre.nextCalls === 1 && elapsed < 50, `elapsed=${elapsed}ms`)
  check(' join 后请求照常放行（决策已返回）', pre.decision === 'decision')
  check('④ join 时折叠仍在飞（检查点尚未提交）', checkpoints(host).length === 0,
    `checkpoints=${checkpoints(host).length}`)

  const cp = await waitFor(() => checkpoints(host)[0], 5000)
  check('④ 后台折叠最终落地（超时不取消任务）', !!cp)
}

/* ── 场景 3b：缺省微折门槛 2048B —— 微轮不折，累积过门槛再折 ──────────────────── */
{
  const sid = 'session-55555555-5555-4555-8555-555555555555'
  writeControl({ enabled: true, sessions: [sid], sessionModes: { [sid]: 'off' } }) // 不设 foldMinShadowBytes ⇒ 缺省 2048
  const host = makeHost(sid)
  addUser(host, 1, U(10))       // 文本 ≈80 字符
  addAssistant(host, 2, A(10))  // 文本 ≈100 字符，合计 < 2048（messageBytes 口径）
  endTurn(host, 3, 1)
  host.fireTurnEnd(1)
  await sleep(700)
  check('⑦ 微轮低于缺省门槛：轮末不折（聊天区不新增标记）', checkpoints(host).length === 0,
    `checkpoints=${checkpoints(host).length}`)

  addUser(host, 4, U(150))      // 文本 ≈1200 字符
  addAssistant(host, 5, A(150)) // 文本 ≈1500 字符 ⇒ 两轮累积过 2048（messageBytes 口径）
  endTurn(host, 6, 2)
  host.fireTurnEnd(2)
  const cp = await waitFor(() => checkpoints(host)[0], 3000)
  check('⑦ 累积过门槛后轮末折叠', !!cp, `checkpoints=${checkpoints(host).length}`)
  if (cp) {
    const op = cp.meta?.surfaceOp ?? {}
    check('⑦ 折叠覆盖两轮累积（seq 1..5）',
      op.op === 'replace' && op.startSeq === 1 && op.endSeq === 5, JSON.stringify(op))
    const text = cp.data?.content?.[0]?.text ?? ''
    check('⑦ 转录含两轮（[ROUND] 1 与 2）',
      text.includes('[ROUND] 1') && text.includes('[ROUND] 2'), text.slice(0, 60))
  }
}

/* ── 场景 4：control.foldAtTurnEnd=false ⇒ 完全不折（turn/end 是唯一触发点）─────── */
{
  const sid = 'session-44444444-4444-4444-8444-444444444444'
  writeControl({ enabled: true, sessions: [sid], sessionModes: { [sid]: 'off' }, foldAtTurnEnd: false })
  const host = makeHost(sid)
  addUser(host, 1, U(10))
  addAssistant(host, 2, A(10))
  endTurn(host, 3, 1)
  const pre = await host.preStep()
  host.fireTurnEnd(1)
  await sleep(700) // 覆盖 400ms debounce + 提交余量
  check('⑥ 关闭 turn-end 折后完全不折（pre-step 也不再兜底）',
    pre.nextCalls === 1 && checkpoints(host).length === 0,
    `checkpoints=${checkpoints(host).length}`)
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
