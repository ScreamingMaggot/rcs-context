// 折叠"压缩比"口径的回归测试：必须是**本折 ÷ 本折**（本次新增转录 ÷ 本次被转写的新原料）
//   病灶（2026-09-30）：旧值 = transcriptBytes(累计转录) / shadowedBytes(本折遮蔽)。首次折叠时二者
//   同源才显得正常，增量折叠上结构性 >1 —— 真机显示过 5914%、917%、3824 倍。
//   本测试用**真机历史读数**当断言（这些数来自对 last-fold 记录的重算），把口径钉住。
//   运行：node tests/fold-ratio.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-ratio-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
const { foldShrinkOf } = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

// —— 真机会话 5fe3512e 的五笔折叠（shadowed / appended / incrementalRaw）——
const real = [
  { n: 1, shadowed: 465068, appended: 57099, raw: 447486, x: 7.84 },
  { n: 2, shadowed: 648362, appended: 114123, raw: 648362, x: 5.68 },
  { n: 3, shadowed: 293978, appended: 80954, raw: 293978, x: 3.63 },
  { n: 4, shadowed: 197939, appended: 37186, raw: 197939, x: 5.32 },
  { n: 5, shadowed: 4946, appended: 3162, raw: 4946, x: 1.56 },
]
for (const c of real) {
  const r = foldShrinkOf({ appendedBytes: c.appended, incrementalRawBytes: c.raw, transcriptBytes: 0, shadowedBytes: c.shadowed })
  check(`第 ${c.n} 折 本折占比 ${r}（≈1/${c.x}）`, Math.abs(1 / r - c.x) < 0.05, 'ratio=' + r)
}

// —— 曾显示成天文数字的两笔：旧口径 917% / 3824 倍，新口径必须 <1 ——
const s5 = foldShrinkOf({ appendedBytes: 11486, incrementalRawBytes: 33158, transcriptBytes: 292524, shadowedBytes: 33158 })
check('5fe3512e 末笔：不再受累计转录污染（旧 9.1685 → <1）', s5 < 1, 'shrink=' + s5)
const ff = foldShrinkOf({ appendedBytes: 36, incrementalRawBytes: 40, transcriptBytes: 152960, shadowedBytes: 40 })
check('ffab17e9：旧 3824 倍 → 0.9', Math.abs(ff - 0.9) < 1e-9, 'shrink=' + ff)
const de = foldShrinkOf({ appendedBytes: 1165, incrementalRawBytes: 1870, transcriptBytes: 2323, shadowedBytes: 2323 })
check('de4959d2：旧 6.5863(659%) → 0.623', Math.abs(de - 0.623) < 1e-9, 'shrink=' + de)

// —— 分母为 0 或缺失 ⇒ 回退旧算式（老记录兼容），两者都没有 ⇒ null ——
check('缺增量原料 ⇒ 回退 transcript/shadowed',
  foldShrinkOf({ appendedBytes: 100, incrementalRawBytes: 0, transcriptBytes: 725, shadowedBytes: 8951 }) === Number((725 / 8951).toFixed(4)))
check('全缺 ⇒ null', foldShrinkOf({}) === null)
check('本折口径与"累计除本折"确实不同（防回归）',
  foldShrinkOf({ appendedBytes: 11486, incrementalRawBytes: 33158, transcriptBytes: 292524, shadowedBytes: 33158 })
  !== Number((292524 / 33158).toFixed(4)))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
