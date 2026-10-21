// 一键跑全部回归测试：node tests/run-all.mjs
//   逐个 spawn tests/*.test.mjs，汇总断言数与失败项；任一失败 ⇒ 退出码非 0（可挂 CI）。
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)))
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort()
let bad = 0, pass = 0, total = 0
const t0 = Date.now()
for (const f of files) {
  const r = spawnSync(process.execPath, [join(here, f)], { encoding: 'utf8', timeout: 120000 })
  const out = (r.stdout || '') + (r.stderr || '')
  const p = (out.match(/^PASS/gm) || []).length
  const fl = (out.match(/^FAIL/gm) || []).length
  total += p + fl; pass += p
  if (r.status !== 0) {
    bad++
    console.log(`✗ ${f}  (${p} pass / ${fl} FAIL)`)
    console.log(out.split('\n').filter((l) => l.startsWith('FAIL') || l.includes('Error')).slice(0, 12).map((l) => '    ' + l).join('\n'))
  } else {
    console.log(`✓ ${f}  (${p} 条断言)`)
  }
}
console.log(`\n${files.length - bad}/${files.length} 套通过　·　断言 ${pass}/${total}　·　${((Date.now() - t0) / 1000).toFixed(1)}s`)
process.exit(bad ? 1 : 0)
