// 经济性算术回归测试（回本闸 + 准入闸）——钉住"折叠是否值得做"这条判据。
//   背景（v1.10.23 引入）：折一条 [A] 要花**一次付费调用**，省下的却在后续回合按**缓存读价**计——
//   今天按 1.0 全额付、换明天每回合 0.25 的折扣，于是必须算回本回合数 m*(S)，否则"折叠"可能是亏的。
//   被守的主张：
//     · 回本回合数 = 一次性成本 ÷ 每回合收益，且随正文变大而**下降**（大块更划算）
//     · 收益为 0（正文不比输出长）⇒ turns = Infinity，调用方据此不折（不是 NaN）
//     · 实测回本（用真实 usage 反算）在无 aux 时必须返回 null，不许编数
//     · 逐项自洽：cost / benefitPerTurn 必须等于 turns
//   运行：node tests/payback-and-budget.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-payback-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
const M = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)
const { paybackOf, paybackMeasured, minBytesOf, effectiveMaxTokens } = M

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b))

/* ── ① 预估回本：自洽 + 单调 + 大块更快回本 ─────────────────────────── */
const p1k = paybackOf(1000)
check('① 逐项自洽：cost / benefitPerTurn == turns',
  near(p1k.cost / p1k.benefitPerTurn, p1k.turns), JSON.stringify(p1k))
check('① 输出 token 按正文的固定比例估（<正文，才可能有收益）',
  p1k.outTok < p1k.bodyTok && near(p1k.outTok / p1k.bodyTok, 0.6, 0.01), p1k.outTok + '/' + p1k.bodyTok)
check('① 折扣可反推且为 0.25 量级（缓存读价）',
  near(p1k.benefitPerTurn / (p1k.bodyTok - p1k.outTok), 0.25, 0.02),
  String(p1k.benefitPerTurn / (p1k.bodyTok - p1k.outTok)))
const sizes = [200, 500, 1000, 2000, 5000, 20000, 100000]
const turns = sizes.map((n) => paybackOf(n).turns)
check('① 正文越大回本越快（严格递减）',
  turns.every((t, i) => i === 0 || t < turns[i - 1]),
  sizes.map((n, i) => `${n}:${turns[i].toFixed(1)}`).join('  '))
check('① 回本回合数有下界（≥1：至少要把这次调用赚回来）', turns.every((t) => t >= 1),
  'min=' + Math.min(...turns).toFixed(2))
check('① 零长度不产生 NaN/负数（bodyTok 强制 ≥1）',
  Number.isFinite(paybackOf(0).bodyTok) && paybackOf(0).bodyTok >= 1 && paybackOf(0).turns > 0)
check('① 负输入按 0 处理（不炸）', Number.isFinite(paybackOf(-999).turns))
const huge = paybackOf(10 ** 9)
check('① 超大正文收敛到有限值（不会 0/0）',
  Number.isFinite(huge.turns) && huge.turns > 0, String(huge.turns))

/* ── ② 实测回本：没有 usage 就 return null，绝不编数 ────────────────── */
check('② 无 aux ⇒ null', paybackMeasured(null, 4000, 1000) === null)
check('② aux.calls=0 ⇒ null', paybackMeasured({ calls: 0 }, 4000, 1000) === null)
const aux = { calls: 1, in: 100, cacheRead: 200, out: 50 }
const m1 = paybackMeasured(aux, 4000, 1000)
check('② 成本按账单口径：in + cacheRead×0.25 + out',
  m1 && near(m1.cost, 100 + 200 * 0.25 + 50), m1 && String(m1.cost))
check('② 收益 = 省下 token × 0.25 折扣，且自洽',
  m1 && near(m1.cost / m1.benefitPerTurn, m1.turns), m1 && JSON.stringify(m1))
const m2 = paybackMeasured(aux, 1000, 4000)
check('② 正文比输出还短 ⇒ 收益为 0 ⇒ turns = Infinity（调用方据此拒折）',
  m2 && m2.benefitPerTurn === 0 && m2.turns === Infinity, m2 && JSON.stringify(m2))

/* ── ③ 准入闸参数：0 是合法值（表示不设门槛），非法值回退默认 ─────────── */
check('③ minBytes=0 ⇒ 0（显式关闭准入闸，不是回退默认）', minBytesOf({ minBytes: 0 }) === 0)
check('③ 缺省 ⇒ 内置默认（240）', minBytesOf({}) === 240 && minBytesOf(null) === 240)
check('③ 非数字/负数 ⇒ 回退默认（不产生负门槛）',
  minBytesOf({ minBytes: '200' }) === 240 && minBytesOf({ minBytes: -5 }) === 240)
check('③ 合法正数原样生效', minBytesOf({ minBytes: 1024 }) === 1024)

/* ── ④ 会话维度联动：正文越长，单块预算越大（但受上限约束） ───────────── */
const b1 = effectiveMaxTokens(1000, 2048)
const b2 = effectiveMaxTokens(8000, 2048)
const b3 = effectiveMaxTokens(8000, 800)
check('④ 正文变长 ⇒ 预算上升', b2 > b1, `${b1} -> ${b2}`)
check('④ 但绝不越过上限', b2 <= 2048 && b3 <= 800, `${b2}/${b3}`)
check('④ 回本判据与预算不冲突：大块（回本快）也拿到更大预算',
  paybackOf(20000).turns < paybackOf(500).turns && b2 > b1)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
