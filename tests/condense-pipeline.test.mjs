// 浓缩流水线端到端回归测试（applyCondense + condenseText，桩掉 llm 服务）——把"值保真 + 回退分型
//   + 计费记账"这三件对外承诺一次测到位。
//   为什么必须测这一层：单元测纯函数只证明"算得对"，而**折叠提交路径**才是真机出过事的地方
//   （今晚的重复记账、以及此前 6.9% 命中率/付费却不压缩，都住在这条链上）。
//   桩法：io.llm = { stream(req) ⇒ async 迭代器 }，按 llmText 的契约吐 text-delta / usage / finish。
//   运行：node tests/condense-pipeline.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-pipe-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = join(root, 'state')
process.env.DSH_CONTEXTINJECTOR_ENABLED = '0'
const { applyCondense } = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const USAGE = { inputTokens: 120, cacheReadTokens: 800, outputTokens: 40 }
const okChunks = (text, kind = 'stop') => [
  { type: 'text-delta', text },
  { type: 'usage', usage: USAGE },
  { type: 'finish', reason: { kind } },
]
/** 桩：handler(req) 返回 chunk 数组；可抛错模拟流异常 */
const mkLlm = (handler) => ({ stream: (req) => (async function* () { for (const c of handler(req)) yield c })() })
const mkIo = (llm, extra = {}) => ({
  route: { provider: 'stub', model: 'stub-1' },
  llm,
  minBytes: 20,
  maxTokens: 2048,
  budgetMs: 60_000,
  paybackHorizon: 0,              // 关掉回本闸（否则会被 skip），回本闸单列一例
  payloadCheck: false,            // 默认档（与线上默认一致）
  fb: {}, errs: [], kd: [],
  aux: { calls: 0, in: 0, cacheRead: 0, out: 0 },
  ...extra,
})
const A = 'x'.repeat(60)
const rowsOf = (line) => ['[ROUND] 1', '[U] 用户指令', line, '[T] read | src/a.py | OK']

/* ── ① off 档：一行不动、一分钱不花 ─────────────────────────────────── */
{
  const io = mkIo(mkLlm(() => okChunks('不该被调用')))
  const r = await applyCondense(rowsOf(`[A] ${A}`), 'off', io)
  check('① off 档：行原样返回', r.rows.join('\n') === rowsOf(`[A] ${A}`).join('\n'))
  check('① off 档：零调用零费用', r.stat.calls === 0 && io.aux.calls === 0)
}

/* ── ② 正常浓缩：只换 [A]，其余行绝不动 ─────────────────────────────── */
{
  const io = mkIo(mkLlm(() => okChunks('结论：端口保持 8787。')))
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', io)
  check('② [A] 被换成浓缩结果', out.rows[2] === '[A] 结论：端口保持 8787。', out.rows[2])
  check('② [U]/[T]/[ROUND] 一字不动',
    out.rows[0] === '[ROUND] 1' && out.rows[1] === '[U] 用户指令' && out.rows[3] === '[T] read | src/a.py | OK')
  check('② 统计：a=1 / folded=1 / fallback=0 / calls=1',
    out.stat.a === 1 && out.stat.folded === 1 && out.stat.fallback === 0 && out.stat.calls === 1, JSON.stringify(out.stat))
  check('② 真实用量记账（auxCalls + 账单口径）',
    out.stat.auxCalls === 1 && out.stat.auxBilled === Math.round(120 + 800 * 0.25 + 40), String(out.stat.auxBilled))
  check('② 实测回本回合落盘（预估 vs 实付并列）',
    Number.isFinite(out.stat.paybackEst) && out.stat.paybackEst > 1, 'est=' + out.stat.paybackEst)
}

/* ── ③ 值保真第一道防线：模型**看不到**原值，回填逐字还原 ───────────── */
{
  const uuid = '5fe3512e-ac3c-41c4-8dca-f3e6186a94b2'
  const win = 'D:\\DSH\\web\\contextinjector.mjs'
  const src = `[A] 已核对会话 ${uuid} 与文件 ${win}，两者一致，结论是端口无需改动。` + ' 补充说明'.repeat(12)
  let seen = ''
  const io = mkIo(mkLlm((req) => { seen = JSON.stringify(req.messages); return okChunks('结论：一致，无需改动。') }))
  const out = await applyCondense([src], 'single', io)
  check('③ 模型收到的文本里**没有原值**（只有占位符）',
    seen.includes('⟦') && !seen.includes(uuid) && !seen.includes('DSH'), seen.slice(0, 120))
  check('③ 占位符数量与值数量一致', (seen.match(/⟦[A-Z]+\d+⟧/g) || []).length >= 2)
  check('③ 提交的 [A] 行是浓缩结果（更短）', out.rows[0].startsWith('[A] ') && out.rows[0].length < src.length, out.rows[0].slice(0, 40))

  // 模型把占位符原样带出 ⇒ 必须回填成**原值**（这是"值不可能被改坏"的机制证据）
  let echoed = ''
  const io2 = mkIo(mkLlm((req) => {
    const m = JSON.stringify(req.messages).match(/⟦[A-Z]+\d+⟧(?:[^\\\\"]*⟦[A-Z]+\d+⟧)?/)
    echoed = m ? m[0].replace(/\\\\n/g, ' ') : ''
    return okChunks('结论：' + echoed)
  }))
  const out2 = await applyCondense([src], 'single', io2)
  check('③ 模型回吐占位符 ⇒ 回填成原值（uuid 与路径逐字回来）',
    out2.rows[0].includes(uuid) && out2.rows[0].includes(win), out2.rows[0].slice(0, 90))
  check('③ 回填后不留 ⟦…⟧ 残骸', !/⟦/.test(out2.rows[0]), out2.rows[0].slice(0, 90))
}

/* ── ④ 回退分型：每一种都回落到原文，且标注原因 ─────────────────────── */
const cases = [
  ['noShrink', () => okChunks('这一句比原文还长'.repeat(40)), (io) => io.fb.noShrink === 1],
  ['empty', () => okChunks('   '), (io) => io.fb.empty === 1],
  ['llmErr', () => [], (io) => io.fb.llmErr === 1],
]
for (const [name, handler, assert] of cases) {
  const io = mkIo(mkLlm(handler))
  const before = rowsOf(`[A] ${A}`)
  const out = await applyCondense(before, 'single', io)
  check(`④ ${name} ⇒ 回退无损（该行保持原文）`, out.rows.join('\n') === before.join('\n'), out.rows[0].slice(0, 40))
  check(`④ ${name} ⇒ 原因被分型记下（不堆成一句 llmErr）`, assert(io), JSON.stringify(io.fb))
  check(`④ ${name} ⇒ 计入 fallback 而非 folded`, out.stat.fallback === 1 && out.stat.folded === 0)
}
{
  const io = mkIo({ stream: () => (async function* () { throw new Error('socket hang up') })() })
  const before = rowsOf(`[A] ${A}`)
  const out = await applyCondense(before, 'single', io)
  check('④ 流异常 ⇒ 不炸、回退无损', out.rows.join('\n') === before.join('\n') && io.fb.llmErr === 1, JSON.stringify(io.fb))
}
/* 截断走的是 P2「抢救」而不是回退：两道闸（缩短达标 + 无半截占位符）都过才算成功 */
{
  const io = mkIo(mkLlm(() => okChunks('草稿：端口一致。', 'max-tokens')))
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', io)
  check('④ 被截断但抢救闸通过 ⇒ 记为 salvaged（成功，不算回退）',
    out.stat.salvaged === 1 && out.stat.fallback === 0 && out.rows[2] === '[A] 草稿：端口一致。', JSON.stringify(out.stat))
  const io2 = mkIo(mkLlm(() => okChunks('草稿 ⟦ID', 'max-tokens')))
  const before2 = rowsOf(`[A] ${A}`)
  const out2 = await applyCondense(before2, 'single', io2)
  check('④ 截断且留半截占位符 ⇒ 抢救闸拦住、回退原文',
    out2.rows.join('\n') === before2.join('\n') && out2.stat.fallback === 1, JSON.stringify(io2.fb))
}

/* ── ⑤ 两道前置闸：短行与回本，都是"花钱之前"拦住 ───────────────────── */
{
  const io = mkIo(mkLlm(() => okChunks('不该被调用')))
  const short = ['[A] 太短']
  const out = await applyCondense(short, 'single', io)
  check('⑤ 短于 minBytes ⇒ 一次请求都不发（aux=0）', io.aux.calls === 0 && io.fb.tooShort === 1, JSON.stringify(io.fb))
  check('⑤ calls = 真实发起数（0），预算预约数另记在 callsReserved',
    out.stat.calls === 0 && out.stat.callsReserved === 1, JSON.stringify({ calls: out.stat.calls, res: out.stat.callsReserved }))
  check('⑤ 短行同样无损', out.rows[0] === '[A] 太短')
}
{
  const io = mkIo(mkLlm(() => okChunks('不该被调用')), { paybackHorizon: 1 })
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', io)
  check('⑤ 预计回本超出视界 ⇒ 不发调用、记 payback',
    io.aux.calls === 0 && io.fb.payback === 1 && out.stat.paybackSkipped === 1, JSON.stringify(io.fb))
  check('⑤ 回本闸跳过同样不算"发起了调用"', out.stat.calls === 0, String(out.stat.calls))
}
{
  const io = mkIo(mkLlm(() => okChunks('结论：一致。')))
  const out = await applyCondense(rowsOf(`[A] ${A}`), 'single', io)
  check('⑤ 预算充裕 ⇒ 正常完成且 budgetHit 不误报',
    out.stat.budgetHit === false && out.stat.calls === 1, JSON.stringify({ hit: out.stat.budgetHit, calls: out.stat.calls }))
  check('⑤ budgetHit 是布尔字段（接口存在，供慢调用时的记账）', typeof out.stat.budgetHit === 'boolean')
}

/* ── ⑥ 值保真第二道闸（payloadCheck）：默认关、显式开则拦住改值 ─────── */
{
  const src = `[A] 读 conf_17.yaml 得到 PORT=8787，写进 deploy.py。` + ' 说明'.repeat(30)
  const stub = mkLlm(() => okChunks('读 conf_9.yaml 得到 PORT=9031，写进 deploy.py。'))   // 值被改坏
  const ioOff = mkIo(stub)                                  // 默认：闸关
  const outOff = await applyCondense([src], 'single', ioOff)
  check('⑥ 默认档（payloadCheck=false）：值被改坏也会被接受（记录在案的口径）',
    outOff.rows[0].includes('9031'), outOff.rows[0].slice(0, 50))
  const ioOn = mkIo(stub, { payloadCheck: true })            // 显式开闸
  const outOn = await applyCondense([src], 'single', ioOn)
  check('⑥ 开闸后：改值被拦，整条 [A] 回退原文',
    outOn.rows[0] === src && ioOn.fb.payloadGate === 1, JSON.stringify(ioOn.fb))
}

/* ── ⑦ double 档 K 通道：只收"整词出现在原文"的关键值，幻觉值被剔 ───── */
{
  const src = `[A] 端口取 8787，配置文件 conf_17.yaml，提交号 e7b40c73。` + ' 细节'.repeat(30)
  let call = 0
  // 双档下 K 通道与浓缩通道**并发**发出（顺序不保证）⇒ 按请求文本分派，别靠调用先后
  const io = mkIo(mkLlm((req) => {
    call += 1
    const u = JSON.stringify(req.messages)
    if (u.includes('载荷清单')) return okChunks('conf_17.yaml\n8787\ndeadbeef\n杂乱说明请忽略')   // K 清单（含幻觉值）
    return okChunks('端口与配置文件已核对一致。')                                                 // 浓缩
  }))
  const out = await applyCondense([src], 'double', io)
  const line = out.rows[0]
  check('⑦ 真值被并入 [关键值]（整词命中原文）',
    line.includes('[关键值]') && line.includes('8787') && line.includes('conf_17.yaml'), line.slice(0, 80))
  check('⑦ 幻觉值 deadbeef 被剔除', !line.includes('deadbeef'))
  check('⑦ K 通道与浓缩各记一次调用', out.stat.calls === 2 && io.aux.calls === 2, JSON.stringify(out.stat))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
