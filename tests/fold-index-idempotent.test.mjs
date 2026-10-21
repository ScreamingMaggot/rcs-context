// 折叠账本幂等与 monotonic 实算回归测试 —— 修 0.2 真机发现的两个账本问题。
//   病灶（2026-10-09，0.2.0-rc.2 真机两次复现）：
//     · **同一笔折叠被写两行**：turn-stopping 与 turn/end 兜底是两个独立触发点，同一区间各提交一次，
//       fold-index 里出现两行（除 t 外逐字相同，间隔 1.7–1.9s）。任何按行求和的总账翻倍。
//     · `monotonic: true` 是**硬编码常量**，不是测量值 —— 自证字段会被下游当成"已验过"。
//   本测试直接对 writeFoldIndex 打，钉住：同一 foldSeq 只记一次；不同 foldSeq 正常追加；
//   monotonic 由 cumLines 与遮蔽 seq 实算得出。
//   运行：node tests/fold-index-idempotent.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-fidx-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
const STATE = join(root, 'state')
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = STATE
process.env.DSH_CONTEXTINJECTOR_ENABLED = '0'
const { writeFoldIndex } = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const SID = 'session-idem-0001'
const file = join(STATE, '.ctxinjector', 'fold-index', 'idem-0001.jsonl')
const rows = () => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const rec = (foldSeq, shadowedSeqs, cumBefore, cumAfter) => ({
  sid: SID, trigger: 'turn-end', foldSeq, shadowedSeqs,
  cumBefore, cumAfter, shadowedBytes: 1000, transcriptBytes: 300,
  liveBytes: 800, incrementalRawBytes: 1000, appendedBytes: 300,
})

/* ── ① 同一笔折叠只记一次账（幂等） ─────────────────────────────────── */
writeFoldIndex(rec(17, [44, 46, 50], 0, 6))
writeFoldIndex(rec(17, [44, 46, 50], 0, 6))     // 第二触发点重复提交
check('① 同一 foldSeq 重复提交 ⇒ 仍只有 1 行', rows().length === 1, '行数=' + rows().length)
writeFoldIndex(rec(36, [52, 54], 6, 13))
check('① 换一笔（新 foldSeq）⇒ 正常追加', rows().length === 2, '行数=' + rows().length)
check('① 追加不覆盖旧行（append-only）', rows()[0].foldSeq === 17 && rows()[1].foldSeq === 36)
writeFoldIndex(rec(36, [52, 54], 6, 13))
check('① 第二笔的重复提交同样被吞掉', rows().length === 2, '行数=' + rows().length)

/* ── ② 总账不再翻倍：按行求和 == 按 foldSeq 去重求和 ─────────────────── */
const sum = (key, pick) => rows().reduce((n, r) => n + pick(r[key]), 0)
const dedup = new Map(rows().map((r) => [r.foldSeq, r]))
const sumD = (key, pick) => [...dedup.values()].reduce((n, r) => n + pick(r[key]), 0)
check('② raw/appended 的全行求和 == 去重求和（重复行已不再产生）',
  sum('raw', (v) => v) === sumD('raw', (v) => v) && sum('appended', (v) => v) === sumD('appended', (v) => v),
  `raw ${sum('raw', (v) => v)} vs ${sumD('raw', (v) => v)}`)
check('② 本折倍数口径仍成立（appended / raw 在 0..1）',
  rows().every((r) => r.appended / r.raw > 0 && r.appended / r.raw <= 1),
  rows().map((r) => (r.appended / r.raw).toFixed(2)).join(','))

/* ── ③ monotonic 是实算，不是硬编码 ────────────────────────────────── */
check('③ 正常递增 ⇒ monotonic=true', rows().every((r) => r.monotonic === true))
writeFoldIndex(rec(60, [60, 55], 13, 19))
check('③ 遮蔽 seq 回退（60 > 55）⇒ monotonic=false',
  rows().find((r) => r.foldSeq === 60).monotonic === false,
  String(rows().find((r) => r.foldSeq === 60).monotonic))
writeFoldIndex(rec(80, [70, 72], 19, 12))
check('③ 累计行号回退（19 → 12）⇒ monotonic=false',
  rows().find((r) => r.foldSeq === 80).monotonic === false)
writeFoldIndex(rec(90, [74, 76], 12, 20))
check('③ 恢复递增后 monotonic 回到 true（不是一次性开关）',
  rows().find((r) => r.foldSeq === 90).monotonic === true)
check('③ 缺 cumLines 时不误报（保守取 true，只按 seq 判）',
  (() => { writeFoldIndex({ sid: SID, trigger: 'x', foldSeq: 95, shadowedSeqs: [80, 82] }); return rows().find((r) => r.foldSeq === 95).monotonic === true })())

/* ── ④ 不同 sid 互不干扰（幂等只看本会话的账本） ─────────────────────── */
writeFoldIndex({ ...rec(17, [1, 2], 0, 2), sid: 'session-other-sid' })
const other = join(STATE, '.ctxinjector', 'fold-index', 'other-sid.jsonl')
check('④ 另一个 sid 的同一 foldSeq 正常落账',
  readFileSync(other, 'utf8').trim().split('\n').filter(Boolean).length === 1)
check('④ 本会话账本行数不受影响（17/36/60/80/90/95 共 6 笔）', rows().length === 6, '行数=' + rows().length)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
