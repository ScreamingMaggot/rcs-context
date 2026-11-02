// 折叠侧的路由降级：模型被上游摘掉（Model is unavailable）或宿主没配这个 id（UNKNOWN_MODEL）
// 时，重试同一条毫无意义——必须换路由，且本机 ollama 明明在跑就该接住。
// 真机事故（11-02 18:39）：把压缩模型选成 deepseek-v4.1-flash-free，宿主直接 UNKNOWN_MODEL，
// 整折无损回退，而本地 ollama 全程在线、折叠侧没有任何降级。
import { mkdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-foldfb-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = join(root, 'state')
process.env.DSH_CONTEXTINJECTOR_ENABLED = '0'
const { applyCondense } = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)
const { auxFallbackRoutes, isRouteDead } = await import(pathToFileURL(join(root, 'condense', 'chunk.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const okChunks = (text) => [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } }]
const errChunks = (code, message) => [{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }]
const mkLlm = (handler) => {
  const box = { reqs: [] }
  box.stream = (req) => { box.reqs.push(req); return (async function* () { for (const c of handler(req)) yield c })() }
  box.llm = { stream: box.stream }
  return box
}
const rowsOf = (line) => ['[ROUND] 1', '[U] 用户指令', line, '[T] read | src/a.py | OK']
const A = 'x'.repeat(60)
const mkIo = (llm, fallbackRoutes) => ({
  route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash-free' },
  llm, minBytes: 20, maxTokens: 2048, budgetMs: 60_000,
  paybackHorizon: 0, payloadCheck: false, fb: {}, errs: [], kd: [],
  aux: { calls: 0, in: 0, cacheRead: 0, out: 0 },
  fallbackRoutes,
})

/* ⓪ 判定面 */
check('⓪ UNKNOWN_MODEL 判为路由死亡', isRouteDead('UNKNOWN_MODEL: pi-ai provider "opencode-go" has no configured model "deepseek-v4.1-flash-free"'))
check('⓪ 鉴权错不算路由死亡', isRouteDead('INVALID_REQUEST:401: invalid api key') === false)
{
  const fb = auxFallbackRoutes({ condenseProvider: 'opencode-go', condenseModel: 'deepseek-v4.1-flash-free' }, {})
  check('⓪ 回退表含本机 ollama', fb.some((r) => r.provider === 'ollama-local'), JSON.stringify(fb))
}

/* ① 主路由被宿主拒 ⇒ 本机接住并真的折了 */
{
  const box = mkLlm((req) => (req.provider === 'opencode-go'
    ? errChunks('UNKNOWN_MODEL', 'pi-ai provider "opencode-go" has no configured model "deepseek-v4.1-flash-free"')
    : okChunks('结论：端口保持 8787。')))
  const io = mkIo(box.llm, auxFallbackRoutes({ condenseProvider: 'opencode-go', condenseModel: 'deepseek-v4.1-flash-free' }, {}))
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', io)
  check('① 主路由不可用 ⇒ 本机兜底完成折叠', out.stat.folded === 1 && out.stat.fallback === 0, JSON.stringify({ f: out.stat.folded, b: out.stat.fallback }))
  check('① 记录指向实际服务的路由', io.fallbackRoute && io.fallbackRoute.model === 'qwen3.5:4b', JSON.stringify(io.fallbackRoute))
  check('① 先试主路由再试本机', box.reqs[0].provider === 'opencode-go' && box.reqs.some((r) => r.provider === 'ollama-local'), JSON.stringify(box.reqs.map((r) => r.provider + '/' + r.model)))
}

/* ② 鉴权/参数类错误不触发换路由（换一条只会白花钱） */
{
  const box = mkLlm(() => errChunks('INVALID_REQUEST', '401: invalid api key'))
  const io = mkIo(box.llm, auxFallbackRoutes({}, {}))
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', io)
  check('② 非路由级错误不换路由（无损回退）', out.stat.folded === 0 && out.stat.fallback === 1 && !io.fallbackRoute, JSON.stringify({ f: out.stat.folded, b: out.stat.fallback, fb: io.fallbackRoute }))
}

if (fails === 0) console.log('ALL PASS')
else console.log(fails + ' FAILED')
process.exit(fails === 0 ? 0 : 1)
