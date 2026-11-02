// 模型级不可用（11-02 真机：opencode-go/deepseek-v4.1-flash 连续 5 小时 Model is unavailable）：
// 重试救不了死路由，只有换路由才有产出。记忆编译在后台跑，本地模型慢一点也比整轮不学强。
// 本测试钉三件事：回退清单的解析优先级、路由死亡判定、以及 compileSession 真的会在主路由
// 失败后由本地模型服务并把 serving 模型如实写进记录。
import { mkdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-route-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = join(root, 'state')
process.env.DSH_CONTEXTINJECTOR_ENABLED = '0'
process.env.DSH_MEMORY_AUX_RETRY_MS = '0,0'
delete process.env.DSH_AUX_FALLBACK_MODELS

const { MemoryStore, MemoryCompiler, parseRouteSpec, auxFallbackRoutes, isRouteDead } = await import('../web/memory.mjs')

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

/* ── ① 清单解析 ──────────────────────────────────────────────── */
check('① provider/model 解析', JSON.stringify(parseRouteSpec('ollama-local/qwen3.5:4b')) === JSON.stringify({ provider: 'ollama-local', model: 'qwen3.5:4b' }))
check('① 非法值返回 null', parseRouteSpec('') === null && parseRouteSpec('noslash') === null && parseRouteSpec('/model') === null && parseRouteSpec('prov/') === null)
{
  const fb = auxFallbackRoutes({}, {})
  check('① 无配置时回退到本机两个模型', fb.length === 2 && fb[0].provider === 'ollama-local', JSON.stringify(fb))
}
{
  const fb = auxFallbackRoutes({ auxFallbackRoutes: ['a/x', 'b/y'] }, {})
  check('① control 清单优先且不再叠加默认值', fb.length === 2 && fb[0].model === 'x' && fb[1].model === 'y', JSON.stringify(fb))
}
{
  const fb = auxFallbackRoutes({}, { DSH_AUX_FALLBACK_MODELS: 'p/1, q/2 ,p/1' })
  check('① 环境变量可覆盖并去重', fb.length === 2 && fb[1].provider === 'q', JSON.stringify(fb))
}
{
  // 真机：记忆钉在 minimax（上游下线），而压缩用的 deepseek 是通的 ⇒ 压缩路由必须是首选回退。
  const fb = auxFallbackRoutes({ condenseProvider: 'opencode-go', condenseModel: 'deepseek-v4.1-flash' }, {})
  check('① 压缩路由排在回退首位', fb[0].provider === 'opencode-go' && fb[0].model === 'deepseek-v4.1-flash', JSON.stringify(fb[0]))
}

/* ── ② 路由死亡判定 ──────────────────────────────────────────── */
check('② 上游不可用判死', isRouteDead({ text: null, error: 'INVALID_REQUEST:400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}' }) === true)
check('② 档位拒绝不算路由死亡（交给阶梯）', isRouteDead({ text: null, error: 'UNSUPPORTED_REASONING_EFFORT', effortRejected: true }) === false)
check('② 空输出不算路由死亡', isRouteDead({ text: null, error: 'empty output' }) === false)

/* ── ③ 端到端：主路由死掉，本地模型接住 ─────────────────────── */
{
  const db = join(root, 'mem.sqlite')
  const store = new MemoryStore(new DatabaseSync(db), { stateDir: join(root, 'state'), rawDir: join(root, 'raw-mem') })
  const sid = 'rt1'
  store.ingest({ sid, seq: 1, kind: 'user_turn', key: 'u1', value: { text: '数据库统一使用 SQLite，接口端口固定为 8848' }, source: { sid, seq: 1 } })
  const seen = []
  const llm = {
    stream: (req) => {
      seen.push(req.provider + '/' + req.model)
      const chunks = req.provider === 'opencode-go'
        ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: '400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}' } } }]
        : [{ type: 'text-delta', text: '{"insights":[{"key":"db.engine","summary":"数据库统一使用 SQLite","type":"constraint","confidence":0.9}]}' }, { type: 'finish', reason: { kind: 'stop' } }]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const c = new MemoryCompiler(store, { foldGraceMs: 0, maxEvents: 40 })
  const r = await c.compileSession({ sid, workspace: { id: 'ws1', root: root }, llm, route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })
  check('③ 主路由不可用时编译仍成功', r.ok === true && r.insights >= 1, JSON.stringify(r))
  check('③ 记录如实写出服务的模型', r.model === 'qwen3.5:4b' && r.fallbackRoute === 'ollama-local/qwen3.5:4b', JSON.stringify({ m: r.model, f: r.fallbackRoute }))
  check('③ 先试主路由、再试本地（且本地只调一次）', seen[0] === 'opencode-go/deepseek-v4.1-flash' && seen.filter((x) => x === 'ollama-local/qwen3.5:4b').length === 1, JSON.stringify(seen))
  const ins = new DatabaseSync(db).prepare("SELECT value FROM events WHERE sid=? AND kind='insight'").all(sid)
  const saved = ins.map((x) => { try { return JSON.parse(x.value) } catch { return {} } })
  check('③ 落库的 insight 带真实模型', saved.length >= 1 && String(saved[0].model ?? '').includes('ollama-local/qwen3.5:4b'), JSON.stringify(saved.map((x) => x.model)))
}

/* ── ④ 真实控制面：control.json 里的压缩路由被当作首选回退 ───────── */
{
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(root, 'state', 'control.json'), JSON.stringify({ condenseProvider: 'opencode-go', condenseModel: 'deepseek-v4.1-flash' }))
  const sid = 'rt2'
  const store = new MemoryStore(new DatabaseSync(join(root, 'mem2.sqlite')), { stateDir: join(root, 'state'), rawDir: join(root, 'raw-mem') })
  store.ingest({ sid, seq: 1, kind: 'user_turn', key: 'u1', value: { text: '接口端口固定为 8848' }, source: { sid, seq: 1 } })
  const seen = []
  const llm = {
    stream: (req) => {
      seen.push(req.provider + '/' + req.model)
      const ok = req.model === 'deepseek-v4.1-flash'
      const chunks = ok
        ? [{ type: 'text-delta', text: '{"insights":[{"key":"api.port","summary":"接口端口固定为 8848","type":"constraint","confidence":0.9}]}' }, { type: 'finish', reason: { kind: 'stop' } }]
        : [{ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: '400: Model is unavailable' } } }]
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const c = new MemoryCompiler(store, { foldGraceMs: 0, maxEvents: 40 })
  const r = await c.compileSession({ sid, workspace: { id: 'ws2', root }, llm, route: { provider: 'opencode-go', model: 'minimax-m3.1-flash-free' } })
  check('④ 主路由(minimax)死亡 ⇒ 改用压缩路由(deepseek)', r.ok === true && r.fallbackRoute === 'opencode-go/deepseek-v4.1-flash', JSON.stringify({ ok: r.ok, f: r.fallbackRoute, seen }))
  check('④ 没有去碰本机模型', seen.every((x) => !x.startsWith('ollama-local')), JSON.stringify(seen))
  check('④ tried 依次记下主路由与回退路由', JSON.stringify(r.tried) === JSON.stringify(['opencode-go/minimax-m3.1-flash-free', 'opencode-go/deepseek-v4.1-flash']), JSON.stringify(r.tried))
}

if (fails === 0) console.log('ALL PASS')
else console.log(fails + ' FAILED')
process.exit(fails === 0 ? 0 : 1)