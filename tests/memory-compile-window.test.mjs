// 编译窗口的活性：游标之后的固定 40 条头部窗口够不到下一句用户话时，
// 谓词不得把"窗口里没有"当成"后面没有"——否则游标永不推进（实测 14/15 个有积压的会话锁死）。
// 运行：node tests/memory-compile-window.test.mjs
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = mkdtempSync(join(tmpdir(), 'rcs-window-'))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = root
const { MemoryStore, MemoryCompiler } = await import('../web/memory.mjs')

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const sid = 'session-window1'
const bare = 'window1'
const workspace = 'd:/window/proj'
const store = new MemoryStore(new DatabaseSync(join(root, 'window.sqlite')), {
  stateDir: root, rawDir: join(root, 'raw'),
})

const U1 = '项目端口是 8848，测试脚本都放在 tests/ 下面'
const U2 = '所有导出统一走 encode_clip.py，命名一律 clip_序号.mp4'
store.ingest({ sid, seq: 1, kind: 'user_turn', key: 'u1', value: { text: U1 }, source: { sid, seq: 1 } })
// 118 条纯工具事件把 u2 推到游标 +40 之外，正是真实高强度轮的形状。
for (let seq = 2; seq <= 119; seq++) {
  const kind = seq % 3 === 0 ? 'file_state' : seq % 3 === 1 ? 'command' : 'job'
  store.ingest({ sid, seq, kind, key: `${kind}-${seq}`, value: { target: `f/${seq}.py`, status: 'OK' }, source: { sid, seq } })
}
store.ingest({ sid, seq: 120, kind: 'user_turn', key: 'u2', value: { text: U2 }, source: { sid, seq: 120 } })

const mkLlm = (summary) => {
  const box = { calls: 0, seen: [] }
  box.llm = {
    stream: async function* (req) {
      box.calls++
      box.seen.push(JSON.stringify(req ?? {}))
      yield { type: 'text-delta', text: `{"insights":[{"key":"export.rule","summary":${JSON.stringify(summary)},"confidence":0.9}]}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return box
}
const route = { provider: 'ollama-local', model: 'qwen3:4b' }
const opts = { foldGraceMs: 0, foldPollMs: 20, foldWaitMs: 200, foldStaleMs: 60_000 }

// ① 头部窗口含 user_turn 时维持原行为：读到窗口末尾、游标推进到窗口内最大 seq。
{
  const box = mkLlm(U1)
  const c = new MemoryCompiler(store, { ...opts, maxEvents: 40 })
  const r = await c.compileSession({ sid, llm: box.llm, route })
  check('① 头部窗口有话时正常编译', r.ok === true && box.calls === 1, JSON.stringify(r))
  check('① 游标推进到窗口末尾 seq 40',
    Number(store.getMetaRaw('llmThrough:' + bare)) === 40, store.getMetaRaw('llmThrough:' + bare))
}

// ② 锁死形态：下一句用户话在游标 +40 之外。旧实现返回 no-user-turn 且游标不动。
{
  const box = mkLlm('所有导出统一走 encode_clip.py')
  const c = new MemoryCompiler(store, { ...opts, maxEvents: 40 })
  const r = await c.compileSession({ sid, llm: box.llm, route })
  check('② 窗口够不到下一句话时仍须编译（不得判 no-user-turn）',
    r.ok === true && r.reason === undefined, JSON.stringify(r))
  check('② 只调一次模型', box.calls === 1, box.calls)
  check('② 送给模型的文本包含那句用户话', box.seen[0]?.includes('encode_clip.py') === true)
  check('② 游标推进到该句 seq 120',
    Number(store.getMetaRaw('llmThrough:' + bare)) === 120, store.getMetaRaw('llmThrough:' + bare))
  const last = JSON.parse(store.getMetaRaw('llmLast:' + bare) ?? '{}')
  check('② llmLast 记录锚定句与被跳过的工具事件数（可观测）',
    Number(last.skipped) > 0 && Number(last.anchorSeq) === 120, JSON.stringify(last))
  const stored = store.db.prepare("SELECT scope, abstract FROM records WHERE kind='insight'").all()
  check('② 该句结论落库',
    stored.some((x) => String(x.abstract).includes('encode_clip.py')),
    JSON.stringify(stored.map((x) => x.scope + '|' + String(x.abstract).slice(0, 40))))
}

// ③ 游标之后只剩工具事件（无用户话）时，no-user-turn 仍然是正确结论。
for (let seq = 121; seq <= 200; seq++) {
  store.ingest({ sid, seq, kind: 'command', key: `c-${seq}`, value: { cmd: 'x', status: 'OK' }, source: { sid, seq } })
}
{
  const box = mkLlm('不该被调用')
  const c = new MemoryCompiler(store, { ...opts, maxEvents: 40 })
  const r = await c.compileSession({ sid, llm: box.llm, route })
  check('③ 游标后只剩工具事件 ⇒ 仍然拒绝', r.ok === false && r.reason === 'no-user-turn', JSON.stringify(r))
  check('③ 拒绝时不调用模型', box.calls === 0, box.calls)
  check('③ 拒绝时游标不动（停在 120）', Number(store.getMetaRaw('llmThrough:' + bare)) === 120)
}

// ④ 多次轮末重复触发不得原地踏步：每次至少消费一句用户话。
{
  const U3 = '渲染出片一律用 30fps，别改帧率'
  store.ingest({ sid, seq: 201, kind: 'user_turn', key: 'u3', value: { text: U3 }, source: { sid, seq: 201 } })
  const c = new MemoryCompiler(store, { ...opts, maxEvents: 40 })
  let advanced = 0
  for (let i = 0; i < 3; i++) {
    store.setMetaRaw('llmFailAt:' + bare, 0)
    const box = mkLlm('渲染出片一律用 30fps')
    const r = await c.compileSession({ sid, llm: box.llm, route })
    if (r.ok) advanced = Number(store.getMetaRaw('llmThrough:' + bare))
  }
  check('④ 三次轮末内追上第三句', advanced === 201, advanced)
}

store.db.close()
rmSync(root, { recursive: true, force: true })
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
