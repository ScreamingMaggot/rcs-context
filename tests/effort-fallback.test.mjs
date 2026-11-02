// 推理档位不被支持时必须回退，而不是整条失败。
// 背景（用户实机）：control 里 condenseReasoningEffort 用 off，但 opencode-go/deepseek-v4.1-flash
// 没有 off 档 ⇒ 宿主 finish=error UNSUPPORTED_REASONING_EFFORT，整条 [A] 无损回退、压缩收益归零；
// 而记忆层把同样的失败静默成 null（用户："没看到类似错误"）。
// 运行：node tests/effort-fallback.test.mjs
import { mkdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-effort-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = join(root, 'state')
process.env.DSH_CONTEXTINJECTOR_ENABLED = '0'
const { applyCondense } = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)
const { MemoryStore, MemoryCompiler } = await import('../web/memory.mjs')

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const USAGE = { inputTokens: 120, cacheReadTokens: 800, outputTokens: 40 }
const okChunks = (text) => [
  { type: 'text-delta', text },
  { type: 'usage', usage: USAGE },
  { type: 'finish', reason: { kind: 'stop' } },
]
const errChunks = (code, message) => [
  { type: 'finish', reason: { kind: 'error', failure: { code, message } } },
]
const mkLlm = (handler) => {
  const box = { reqs: [] }
  box.stream = (req) => { box.reqs.push(req); return (async function* () { for (const c of handler(req)) yield c })() }
  box.llm = { stream: (req) => box.stream(req) }
  return box
}
const EFFORT_MSG = 'provider "opencode-go" model "deepseek-v4.1-flash" does not support reasoning effort "off"'

const mkIo = (llm) => ({
  route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  llm, minBytes: 20, maxTokens: 2048, budgetMs: 60_000,
  paybackHorizon: 0, payloadCheck: false, fb: {}, errs: [], kd: [],
  aux: { calls: 0, in: 0, cacheRead: 0, out: 0 },
})
const A = 'x'.repeat(60)
const rowsOf = (line) => ['[ROUND] 1', '[U] 用户指令', line, '[T] read | src/a.py | OK']

/* ── ① 折叠路径：off 被拒 ⇒ 不传该字段重一次,正文以思考模式参与 ─────── */
{
  const box = mkLlm((req) => (req.reasoningEffort
    ? errChunks('UNSUPPORTED_REASONING_EFFORT', EFFORT_MSG)
    : okChunks('结论：端口保持 8787。')))
  const io = mkIo(box.llm)
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', io)
  check('① 被拒后仍完成浓缩(不再整条回退)', out.rows[2] === '[A] 结论：端口保持 8787。', out.rows[2])
  check('① 统计 folded=1 / fallback=0', out.stat.folded === 1 && out.stat.fallback === 0, JSON.stringify({ f: out.stat.folded, b: out.stat.fallback }))
  check('① 恰好两次请求：第二次不带 reasoningEffort',
    box.reqs.length === 2 && box.reqs[0].reasoningEffort === 'off' && box.reqs[1].reasoningEffort === undefined,
    JSON.stringify(box.reqs.map((r) => r.reasoningEffort ?? '-')))
  check('① 回退被记录（不是静默）', io.errs.some((e) => /effort-unsupported/.test(String(e))), JSON.stringify(io.errs))
}

/* ── ② 非档位错误不得重试（否则等于给真故障加一次付费调用） ─────────── */
{
  const box = mkLlm(() => errChunks('RATE_LIMIT_EXCEEDED', 'slow down'))
  const io = mkIo(box.llm)
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', io)
  check('② 无关错误只请求一次', box.reqs.length === 1, box.reqs.length)
  check('② 无关错误仍按无损回退', out.stat.folded === 0 && out.stat.fallback === 1, JSON.stringify({ f: out.stat.folded, b: out.stat.fallback }))
}

/* ── ③ 抛异常形态的档位拒绝也要回退 ─────────────────────────────────── */
{
  const box = { reqs: [] }
  box.llm = {
    stream: (req) => {
      box.reqs.push(req)
      return (async function* () {
        if (req.reasoningEffort) throw new Error('UNSUPPORTED_REASONING_EFFORT:' + EFFORT_MSG)
        yield { type: 'text-delta', text: '结论：改走离线渲染。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', mkIo(box.llm))
  check('③ 抛错型档位拒绝也回退成功', out.rows[2] === '[A] 结论：改走离线渲染。' && box.reqs.length === 2, out.rows[2])
}

/* ── ④ 记忆编译路径：同样回退，且把原因记下来（此前是静默 null） ─────── */
const store = new MemoryStore(new DatabaseSync(join(root, 'mem.sqlite')), { stateDir: join(root, 'state'), rawDir: join(root, 'raw-mem') })
const sid = 'eff1'
const ws = 'c:/proj/effort'
const TEXT = '接口端口固定为 8848，测试脚本都放在 tests/'
store.ingest({ sid, seq: 1, kind: 'user_turn', key: 'u1', value: { text: TEXT }, source: { sid, seq: 1 } })
{
  const reqs = []
  const llm = {
    stream: (req) => {
      reqs.push(req)
      return (async function* () {
        if (req.reasoningEffort) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: EFFORT_MSG } } }
          return
        }
        yield { type: 'text-delta', text: '{"insights":[{"key":"port.rule","summary":"接口端口固定为 8848","confidence":0.9}]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const c = new MemoryCompiler(store, { foldGraceMs: 0, maxEvents: 40 })
  const r = await c.compileSession({ sid, workspace: ws, llm, route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })
  check('④ 档位被拒后编译仍产出 insight',
    r.ok === true && r.insights === 1 && r.effortFallback === 'off', JSON.stringify(r))
  check('④ 第二次调用不带 reasoningEffort',
    reqs.length === 2 && reqs[0].reasoningEffort === 'off' && reqs[1].reasoningEffort === undefined,
    JSON.stringify(reqs.map((q) => q.reasoningEffort ?? '-')))
  const stored = store.db.prepare("SELECT abstract FROM records WHERE kind='insight' AND key='port.rule'").get()
  check('④ 结论确实落库', String(stored?.abstract ?? '').includes('8848'), JSON.stringify(stored))
  const last = JSON.parse(store.getMetaRaw('llmLast:' + sid) ?? '{}')
  check('④ 回退写进状态面（可见，不再静默）', last.effortFallback === 'off', JSON.stringify(last))
}

/* ── ⑤ 记忆路径的无关失败必须带原因上报 ─────────────────────────────── */
{
  const sid2 = 'eff2'
  store.ingest({ sid: sid2, seq: 1, kind: 'user_turn', key: 'u1', value: { text: '导出统一走 encode_clip.py' }, source: { sid: sid2, seq: 1 } })
  let calls = 0
  const llm = {
    stream: () => {
      calls += 1
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: '400: invalid api key or insufficient balance' } } }
      })()
    },
  }
  const c = new MemoryCompiler(store, { foldGraceMs: 0, maxEvents: 40 })
  const r = await c.compileSession({ sid: sid2, workspace: ws, llm, route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })
  check('⑤ 非档位、非瞬时错误不重试', r.ok === false && r.reason === 'llm-failed' && calls === 1, JSON.stringify({ r, calls }))
  check('⑤ 失败原因被记录', String(r.err ?? '').includes('invalid api key'), JSON.stringify(r))
}

/* ── ⑤b 瞬时上游故障要退避重试（11-02 真机：Model is unavailable） ─────────── */
{
  const sid3 = 'eff3'
  store.ingest({ sid: sid3, seq: 1, kind: 'user_turn', key: 'u1', value: { text: '导出统一走 encode_clip.py' }, source: { sid: sid3, seq: 1 } })
  let calls = 0
  const llm = {
    stream: () => {
      calls += 1
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: '400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}' } } }
      })()
    },
  }
  const c = new MemoryCompiler(store, { foldGraceMs: 0, maxEvents: 40 })
  process.env.DSH_MEMORY_AUX_RETRY_MS = '0,0' // 退避读在调用时，测试里关掉真实等待
  const r = await c.compileSession({ sid: sid3, workspace: ws, llm, route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })
  delete process.env.DSH_MEMORY_AUX_RETRY_MS
  // 主路由 3 枪 + 两个本地回退路由各 3 枪：全部不可用时如实失败，不谎报成功。
  check('⑤b 所有路由都不可用 ⇒ 逐条重试后如实失败', r.ok === false && calls === 9, JSON.stringify({ ok: r.ok, calls }))
  check('⑤b 尝试过哪些模型可读', Array.isArray(r.tried) && r.tried.length === 3 && r.tried[0].includes('deepseek-v4.1-flash'), JSON.stringify(r.tried))
  check('⑤b 原因如实上报', String(r.err ?? '').includes('Model is unavailable'), JSON.stringify(r))
}

/* ── ⑥ 会话身份：provider 要求 x-opencode-session 时，辅助调用必须带 sessionId ── */
{
  // 复刻今天的真机链路：off 被拒 → 回退不传档位 → 若请求没有会话身份，上游 400 MissingSessionID
  const box = mkLlm((req) => {
    if (req.reasoningEffort) return errChunks('UNSUPPORTED_REASONING_EFFORT', EFFORT_MSG)
    if (!req.sessionId) return errChunks('INVALID_REQUEST', '400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}')
    return okChunks('结论：带会话身份才走通。')
  })
  const io = mkIo(box.llm)
  io.sessionId = 'session-abc123'
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', io)
  check('⑥ 折叠调用带 sessionId 后才成功', out.stat.folded === 1 && box.reqs.length === 2, JSON.stringify({ f: out.stat.folded, n: box.reqs.length }))
  check('⑥ 第二次请求确实携带会话身份（session- 前缀原样保留）',
    box.reqs[1].sessionId === 'session-abc123', JSON.stringify(box.reqs.map((r) => r.sessionId ?? '-')))
  // 缺身份时不得假装成功
  const box2 = mkLlm((req) => (req.sessionId ? okChunks('不该走到这里') : errChunks('INVALID_REQUEST', 'MissingSessionID')))
  const io2 = mkIo(box2.llm)
  const out2 = await applyCondense(rowsOf(`[A] ${A}`), 'single', io2)
  check('⑥ 没有会话身份 ⇒ 仍按无损回退（不谎报压缩成功）',
    out2.stat.folded === 0 && out2.stat.fallback === 1 && !out2.rows[2].includes('不该走到这里'), out2.rows[2])
}

/* ── ⑦ 记忆编译路径同样携带会话身份（裸 uuid 会被补成 session- 前缀） ── */
{
  const sid3 = 'eff7'
  const TEXT7 = '渲染出片一律用 30fps'
  store.ingest({ sid: sid3, seq: 1, kind: 'user_turn', key: 'u1', value: { text: TEXT7 }, source: { sid: sid3, seq: 1 } })
  const reqs = []
  const llm = {
    stream: (req) => {
      reqs.push(req)
      return (async function* () {
        if (!req.sessionId) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: '400 MissingSessionID' } } }
          return
        }
        yield { type: 'text-delta', text: '{"insights":[{"key":"fps.rule","summary":"渲染出片一律用 30fps","confidence":0.9}]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const c = new MemoryCompiler(store, { foldGraceMs: 0, maxEvents: 40 })
  const r = await c.compileSession({ sid: sid3, workspace: ws, llm, route: { provider: 'opencode-go', model: 'minimax-m3.1-flash-free' } })
  check('⑦ 编译一次成功(身份始终在场,不需要第二枪)',
    r.ok === true && r.insights === 1 && reqs.length === 1, JSON.stringify({ r: { ok: r.ok, i: r.insights }, n: reqs.length }))
  check('⑦ 会话身份为 session-<uuid> 形态（与宿主 agent.session.id 同形）',
    reqs.every((q) => q.sessionId === 'session-' + sid3), JSON.stringify(reqs.map((q) => q.sessionId)))
}

store.db.close()
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
