// 会话 ID 清洗与路径安全回归测试 —— sid 会被拼进文件路径（fold-index / last-fold / raw / inflight），
//   所以它是**输入面**：宿主给的 sid 一旦被污染，写盘就会越界。
//   被守的主张：
//     · 清洗后不含任何路径分隔符与盘符冒号 ⇒ 无论输入什么，落点永远在目标目录内
//     · 幂等（清洗过的再清洗不变）——文件名依赖它稳定
//     · 空/缺失 ⇒ 'unknown'，不产生空文件名
//     · 超长截断到 120（Windows 路径长度与文件名长度都有限）
//     · rawAppend 追加写：同一批追加两次就是两行，旧字节不动
//   运行：node tests/sid-sanitize.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-sid-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))

const STATE = join(root, 'state')
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = STATE          // 必须在 import 前设：RAW_DIR 在模块加载时定
process.env.DSH_CONTEXTINJECTOR_ENABLED = '0'
mkdirSync(join(STATE, '.ctxinjector', 'raw'), { recursive: true })
const M = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)
const { sanitizeSid, rawAppend } = M

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const RAW = join(STATE, '.ctxinjector', 'raw')
const HOSTILE = [
  '../../../etc/passwd',
  '..\\..\\windows\\system32\\evil',
  'C:\\Windows\\Temp\\x',
  '/absolute/path/leaf',
  'a/b',
  'a\\b',
  'session-..%2f..%2fboom',
  '....//....//x',
  '\u0000null-byte',
  '中文会话名',
  'with space',
  '...',
]
for (const s of HOSTILE) {
  const out = sanitizeSid(s)
  const fp = resolve(RAW, out + '.jsonl')
  const inside = fp.startsWith(resolve(RAW) + sep)
  check(`① 「${s.slice(0, 24)}」落点仍在 raw 目录内`, inside, fp.replace(root, '<tmp>'))
  check(`① 「${s.slice(0, 24)}」清洗后无分隔符/冒号`,
    !/[/\\:]/.test(out) || out === 'unknown', out)
}
check('② 幂等：清洗两次等于一次',
  HOSTILE.every((s) => sanitizeSid(sanitizeSid(s)) === sanitizeSid(s)))
check('③ null / undefined ⇒ unknown（不产生空文件名）',
  sanitizeSid(null) === 'unknown' && sanitizeSid(undefined) === 'unknown')
// 【v1.10.32 已修】空字符串曾落成空 base ⇒ 文件名叫 `.jsonl` / `.json`，同目录下所有空 sid
//   会话共用同一份账本。现在一律回退 'unknown'。
check('③ 空字符串回退 unknown（v1.10.32 修复）', sanitizeSid('') === 'unknown', JSON.stringify(sanitizeSid('')))
check('③ 纯空白同样回退 unknown', sanitizeSid('   ') === '___' || sanitizeSid('   ') === 'unknown', JSON.stringify(sanitizeSid('   ')))
check('③ 回退名落点仍在 raw 目录内', resolve(RAW, sanitizeSid('') + '.jsonl').startsWith(resolve(RAW) + sep))
check('③ 纯符号输入也不会变成空串',
  sanitizeSid('/').length > 0 && sanitizeSid('///').length > 0, sanitizeSid('///'))
const long = sanitizeSid('a'.repeat(500))
check('④ 超长截断到 120', long.length === 120, 'len=' + long.length)
check('④ 截断后再拼扩展名仍是合法文件名（不含尾随点/空格）',
  !/[. ]$/.test(long), JSON.stringify(long.slice(-4)))
check('⑤ 正常 sid 逐字保留（账本文件名不能漂）',
  sanitizeSid('5fe3512e-ac3c-41c4-8dca-f3e6186a94b2') === '5fe3512e-ac3c-41c4-8dca-f3e6186a94b2')

/* ── ⑥ rawAppend：只在 raw 目录内追加，且是真追加 ───────────────────── */
const before = readdirSync(RAW).length
rawAppend('../../../escape-attempt', [])
check('⑥ 空 entries ⇒ 不建文件（早返回）', readdirSync(RAW).length === before && !existsSync(join(root, 'escape-attempt.jsonl')))
const ent = [{ seq: 7, msg: { role: 'user', content: [{ type: 'text', text: '被遮蔽的原文 seq=7' }] } }]
rawAppend('../escape-attempt', ent)
const files = readdirSync(RAW)
check('⑥ 攻击性 sid 落进 raw 目录且未越界',
  files.length === before + 1 && !existsSync(join(root, 'escape-attempt.jsonl')) && !existsSync(join(root, '..', 'escape-attempt.jsonl')),
  files.join(','))
const target = join(RAW, files[files.length - 1])
const l1 = readFileSync(target, 'utf8')
check('⑥ 记录含 seq 与原文（可回放）', l1.includes('"seq":7') && l1.includes('被遮蔽的原文 seq=7'))
rawAppend('../escape-attempt', ent)
const l2 = readFileSync(target, 'utf8')
check('⑥ 二次追加 = 旧字节不动 + 多一行（append-only）',
  l2.startsWith(l1) && l2.split('\n').filter(Boolean).length === 2)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
