// 分型与预算纯函数回归测试（condense/chunk.mjs）——钉住"跨转录器单一口径"与预算算术。
//   被守的主张：
//     · 消息来源分型是**唯一来源**：注入器与 LOGcompiler 共用它决定 [U]/[ROUND]/[C]/[S]/[N]/[R]，
//       两处各写一套前缀就会让轮号分叉（历史事故）
//     · 只用 kind==='user' 判真人轮，不做"非 user 即插件"的二分（实测有 skill-catalog /
//       subagent-settled / subagent-report 等 merge-extensible 取值）
//     · 退役形态 kind:'plugin' 与 v4 形态 kind:'plugin:X' 都要认（同一文件双宿主通吃）
//     · 压缩失败必须归一到 enum（否则"大量静默回退"无从排查）
//     · 单块 token 预算：先保底再封顶，且上下文窗口要留 20% 余量
//   运行：node tests/condense-classification.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-chunk-'))
mkdirSync(join(root, 'condense'), { recursive: true })
copyFileSync(join(SRC, 'condense', 'chunk.mjs'), join(root, 'condense', 'chunk.mjs'))
const M = await import(pathToFileURL(join(root, 'condense', 'chunk.mjs')).href)
const { classifyMessageSource, classifyUserMessage, pluginIdOf, classifyCondenseError,
        detectMilestone, inferBlockType, chunkForCompressor, resolveMaxTokenBudget,
        subagentIdOf, snapshotSummary, MAX_TOKEN_FLOOR, CONDENSE_BUDGET } = M

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

/* ── ① 来源分型：七类 + 双形态 plugin id ─────────────────────────────── */
const cls = (src) => classifyMessageSource(src).cls
check('① 真人轮只认 kind==="user"', cls({ kind: 'user' }) === 'user')
check('① 本插件注入（v4 形态 plugin:CONTEXTinjector）判 self',
  cls({ kind: 'plugin:CONTEXTinjector' }) === 'self')
check('① 退役形态 {kind:"plugin", plugin:"CONTEXTinjector"} 同样判 self',
  cls({ kind: 'plugin', plugin: 'CONTEXTinjector' }) === 'self')
check('① EXTREASON 简报单独一类（不能落 opaque，否则两边都不转录=静默丢内容）',
  cls({ kind: 'plugin:EXTREASON' }) === 'extreason')
check('① subagent 报告 → relay（内容保留但不计 ROUND）',
  cls({ kind: 'subagent-report' }) === 'relay' && cls({ kind: 'x', form: 'relay' }) === 'relay')
check('① subagent 结束 → notice/subagent', (() => { const r = classifyMessageSource({ kind: 'subagent-settled' }); return r.cls === 'notice' && r.sub === 'subagent' })())
check('① 无 form 的审批插件 → notice/approval', (() => { const r = classifyMessageSource({ kind: 'plugin:user-approval' }); return r.cls === 'notice' && r.sub === 'approval' })())
check('① runtime 快照 → snapshot（只存 sections 摘要）', cls({ form: 'snapshot' }) === 'snapshot')
check('① skill 目录两种形态 → catalog',
  cls({ form: 'catalog' }) === 'catalog' && cls({ kind: 'skill-catalog' }) === 'catalog')
check('① 未知 kind → opaque 且把 kind 回传（保守跳过，不猜）',
  (() => { const r = classifyMessageSource({ kind: 'brand-new-kind' }); return r.cls === 'opaque' && r.kind === 'brand-new-kind' })())
check('① 无 source → opaque（不许当真人轮）', cls(undefined) === 'opaque' && cls(null) === 'opaque')
check('① pluginIdOf 认双形态、认不出返回 null',
  pluginIdOf({ kind: 'plugin:X' }) === 'X' && pluginIdOf({ kind: 'plugin', plugin: 'Y' }) === 'Y' && pluginIdOf({ kind: 'user' }) === null)
check('① classifyUserMessage 读 data.source（不是 data.message.source —— 旧 bug 就在这）',
  classifyUserMessage({ data: { source: { kind: 'user' } } }).cls === 'user' &&
  classifyUserMessage({ data: { message: { source: { kind: 'user' } } } }).cls === 'opaque')

/* ── ② 失败分型：自由文本 → enum ──────────────────────────────────── */
const cases = [
  ['llm service unavailable', 'llm-unavailable'],
  ['no condense route (llm service absent)', 'route-missing'],
  ['stream error while reading', 'stream-error'],
  ['finish=max-tokens', 'finish-max'],   // 【注意】\w+ 不含 '-'，故枚举值是 finish-max 而非 finish-max-tokens
  ['parse 失败：行协议不合规', 'parse-error'],
  ['载荷未过值保真闸', 'fidelity-blocked'],
  ['request timeout', 'timeout'],
  ['ollama: connection refused', 'ollama-error'],
  ['返回空', 'empty-output'],
  ['未缩短', 'not-shortened'],
  ['完全没见过的原因', 'other'],
]
for (const [reason, want] of cases) {
  const got = classifyCondenseError(reason)
  check(`② 「${reason.slice(0, 28)}」→ ${want}`, got === want, got === want ? '' : 'got=' + got)
}
check('② null/undefined → other（不抛）', classifyCondenseError(null) === 'other' && classifyCondenseError() === 'other')

/* ── ③ 里程碑检测：三个门槛缺一不可 ──────────────────────────────── */
check('③ 短于 512B ⇒ 不算（绝对下限）', detectMilestone('已完成本轮全部工作', { meanBlockBytes: 10 }) === false)
const long = '已完成阶段性总结：' + 'x'.repeat(2000)
check('③ 够长且有描述词、且超过 3× 均块 ⇒ 算', detectMilestone(long, { meanBlockBytes: 100 }) === true)
check('③ 够长但无描述词（普通工具输出）⇒ 不算',
  detectMilestone('x'.repeat(2000), { meanBlockBytes: 100 }) === false)
check('③ 未超过 k× 均块 ⇒ 不算（严格大于）',
  detectMilestone('已完成' + 'x'.repeat(400), { meanBlockBytes: 200 }) === false)
check('③ 均块缺失时以 minBytes 当均值（保守）',
  detectMilestone('已完成' + 'x'.repeat(2000), {}) === true && detectMilestone('已完成' + 'x'.repeat(400), {}) === false)
check('③ inferBlockType：错误优先于里程碑',
  inferBlockType('已完成总结', { nearToolError: true, milestone: true }) === 'tool_error' &&
  inferBlockType('已完成总结', { milestone: true }) === 'ai_summary' &&
  inferBlockType('随便一段') === 'exploration')

/* ── ④ 分块：不丢字符是第一位，其次才是块宽 ───────────────────────── */
const samples = [
  ['短文本', 'hello world'],
  ['多段落', 'aaa\n\nbbb\n\nccc'],
  ['长行无断点', 'x'.repeat(5000)],
  ['CRLF', Array.from({ length: 200 }, (_, i) => `line ${i}\r`).join('\n')],
  ['中文句末', Array.from({ length: 300 }, (_, i) => `第 ${i} 句。`).join('')],
]
for (const [name, src] of samples) {
  const chunks = chunkForCompressor(src, 1000)
  check(`④ ${name}：拼接后与原文逐字相同（零丢失）`, chunks.join('') === src,
    chunks.join('') === src ? '' : `len ${chunks.join('').length} vs ${src.length}`)
  check(`④ ${name}：硬切模式下每块不超过上限`, chunks.every((c) => c.length <= 1000),
    'max=' + Math.max(...chunks.map((c) => c.length)))
  check(`④ ${name}：不返回空块`, chunks.every((c) => c.length > 0), 'n=' + chunks.length)
}
const soft = chunkForCompressor('y'.repeat(3000), 1000, { allowHardCut: false })
check('④ 禁硬切时仍不丢字符（不可断的长行整段交上层）', soft.join('') === 'y'.repeat(3000),
  'chunks=' + soft.map((c) => c.length).join(','))
check('④ 空串 ⇒ 空数组（无死循环）', chunkForCompressor('', 100).length === 0)
const big = chunkForCompressor('z'.repeat(200000), 4096)
check('④ 20 万字符能收敛且块数合理', big.join('') === 'z'.repeat(200000) && big.length > 1 && big.length < 200, 'n=' + big.length)

/* ── ⑤ 单块预算：先保底、再封顶、留 20% 余量 ─────────────────────── */
check('⑤ 硬覆盖优先且不低于 256 保底',
  resolveMaxTokenBudget({ hardOverride: 100 }) === MAX_TOKEN_FLOOR &&
  resolveMaxTokenBudget({ hardOverride: 5000 }) === 5000)
check('⑤ 窗口 + 模型上限：取 min(上限, 窗口×0.8 − 已用)',
  resolveMaxTokenBudget({ ctxWindow: 10000, defaultMaxTokens: 3000, inputBudget: 1000 }) === 3000 &&
  resolveMaxTokenBudget({ ctxWindow: 10000, defaultMaxTokens: 3000, inputBudget: 6500 }) === 1500)
check('⑤ 只有模型上限 ⇒ 用它（受保底约束）',
  resolveMaxTokenBudget({ defaultMaxTokens: 1500 }) === 1500 &&
  resolveMaxTokenBudget({ defaultMaxTokens: 100 }) === MAX_TOKEN_FLOOR)
check('⑤ 只有窗口 ⇒ 窗口×0.8 − 已用',
  resolveMaxTokenBudget({ ctxWindow: 10000, inputBudget: 1000 }) === 7000)
check('⑤ 全缺 ⇒ 回退值（不是 0）', resolveMaxTokenBudget({}) === 700)
check('⑤ 已用超窗口 ⇒ 仍回保底（不产生 0/负数）',
  resolveMaxTokenBudget({ ctxWindow: 1000, defaultMaxTokens: 3000, inputBudget: 99999 }) === MAX_TOKEN_FLOOR)

/* ── ⑥ 两个小工具 ────────────────────────────────────────────────── */
check('⑥ subagentIdOf 从正文抓 8 位以上 hex 段', subagentIdOf('报告来自 subagent 5fe3512e-ac3c 的正文') === '5fe3512e-ac3c')
check('⑥ subagentIdOf 抓不到 ⇒ null', subagentIdOf('没有 id 的正文') === null)
check('⑥ snapshotSummary 只留 section 名（防每 step 重注入膨胀）',
  snapshotSummary([{ name: 'file-policy' }, { name: 'approval' }]) === 'runtime snapshot: file-policy, approval' &&
  snapshotSummary([]) === 'runtime snapshot' && snapshotSummary(null) === 'runtime snapshot')
check('⑥ 压缩预算表存在且每项都在 [0,1]', typeof CONDENSE_BUDGET === 'object' &&
  Object.values(CONDENSE_BUDGET).every((v) => typeof v === 'number' && v >= 0 && v <= 1),
  JSON.stringify(CONDENSE_BUDGET))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
