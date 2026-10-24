// 编译/折叠串行：折叠在飞时编译等待或放弃，不得抢同一个本地模型队列。
// 运行：node tests/memory-compile-schedule.test.mjs
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = mkdtempSync(join(tmpdir(), 'rcs-sched-'))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = root
const { MemoryStore, MemoryCompiler, foldInflightAgeMs } = await import('../web/memory.mjs')

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const sid = 'session-sched1'
const bare = 'sched1'
const foldDir = join(root, '.ctxinjector', 'fold-inflight')
const foldFile = join(foldDir, bare + '.json')
mkdirSync(foldDir, { recursive: true })

const store = new MemoryStore(new DatabaseSync(join(root, 'sched.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
store.ingest({ sid, seq: 1, kind: 'user_turn', key: 'u1', value: { text: '项目端口是 8848' }, source: { sid, seq: 1 } })

const mkLlm = () => {
  const box = { calls: 0 }
  box.llm = {
    stream: async function* () {
      box.calls++
      yield { type: 'text-delta', text: '{"insights":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return box
}
const route = { provider: 'ollama-local', model: 'qwen3:4b' }
const opts = { foldGraceMs: 0, foldPollMs: 20, foldWaitMs: 400, foldStaleMs: 60_000 }

// ① 折叠持续在飞 ⇒ 等满 foldWaitMs 后放弃，不调模型、不推进 llmThrough。
{
  writeFileSync(foldFile, JSON.stringify({ sessionId: sid, startedAt: Date.now() }) + '\n', 'utf8')
  check('① 标记可见', foldInflightAgeMs(sid) >= 0, foldInflightAgeMs(sid))
  const box = mkLlm()
  const c = new MemoryCompiler(store, { ...opts, foldWaitMs: 120 })
  const t0 = Date.now()
  const r = await c.compileSession({ sid, llm: box.llm, route })
  const dt = Date.now() - t0
  check('① 折叠在飞 ⇒ reason=fold-inflight', r.ok === false && r.reason === 'fold-inflight', JSON.stringify(r))
  check('① 确实等过（≥100ms）', dt >= 100, dt + 'ms')
  check('① 未调用编译模型', box.calls === 0, 'calls=' + box.calls)
  check('① 未推进 llmThrough', store.getMetaRaw('llmThrough:' + bare) === null)
  check('① 放弃原因写入 llmLast', String(store.getMetaRaw('llmLast:' + bare)).includes('fold-inflight'))
}

// ② 等待期间折叠落定 ⇒ 编译继续。
{
  const box = mkLlm()
  const c = new MemoryCompiler(store, { ...opts, foldWaitMs: 800 })
  const p = c.compileSession({ sid, llm: box.llm, route })
  setTimeout(() => { try { rmSync(foldFile, { force: true }) } catch { /* ignore */ } }, 60)
  const r = await p
  check('② 折叠落定后编译继续', r.ok === true && box.calls === 1, JSON.stringify(r))
  check('② 推进 llmThrough', Number(store.getMetaRaw('llmThrough:' + bare)) === 1, store.getMetaRaw('llmThrough:' + bare))
}

// ③ 陈旧标记（进程崩过）不挡路。
{
  store.ingest({ sid, seq: 2, kind: 'user_turn', key: 'u2', value: { text: '构建命令是 pwsh build.ps1' }, source: { sid, seq: 2 } })
  writeFileSync(foldFile, JSON.stringify({ sessionId: sid, startedAt: 0 }) + '\n', 'utf8')
  const old = new Date(Date.now() - 5000)
  utimesSync(foldFile, old, old)
  const box = mkLlm()
  const c = new MemoryCompiler(store, { ...opts, foldStaleMs: 1000 })
  const r = await c.compileSession({ sid, llm: box.llm, route })
  check('③ 陈旧标记被忽略，编译继续', r.ok === true && box.calls === 1, JSON.stringify(r))
  check('③ 陈旧标记不做清理（折叠侧自有 finally）', foldInflightAgeMs(sid) > 1000)
}

// ④ 无标记 ⇒ 直接编译（不额外等待）。
{
  store.ingest({ sid, seq: 3, kind: 'user_turn', key: 'u3', value: { text: '测试脚本都放在 tests/' }, source: { sid, seq: 3 } })
  rmSync(foldFile, { force: true })
  const box = mkLlm()
  const c = new MemoryCompiler(store, { ...opts, foldGraceMs: 0 })
  const t0 = Date.now()
  const r = await c.compileSession({ sid, llm: box.llm, route })
  check('④ 无折叠标记直接编译', r.ok === true && box.calls === 1 && Date.now() - t0 < 300, JSON.stringify(r))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
