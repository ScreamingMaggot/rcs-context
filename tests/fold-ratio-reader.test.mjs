// 读时校正：历史 last-fold 的首折读数（head 计入分子）不能在面板继续显示 101%。
// 运行：node tests/fold-ratio-reader.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = mkdtempSync(join(tmpdir(), 'rcs-reader-'))
const { normalizeLastFold } = await import(pathToFileURL(join(HERE, '..', 'contextinjector-webui', 'lib', 'index.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const base = () => ({
  appendedBytes: 2150, incrementalRawBytes: 2132, headBytes: 1756,
  transcriptBytes: 2150, shadowedBytes: 4675, foldRatio: 1.0084, shrink: 1.0084,
  segments: [{ kind: 'head', bytes: 1756 }, { kind: 'new', bytes: 393 }],
})

{
  const x = normalizeLastFold(base())
  check('① 带 head 段的旧记录按同口径重算（101% → 18.48%）', Math.abs(x.foldRatio - 0.1848) < 1e-4, x.foldRatio)
  check('① shrink 同步到新口径', Math.abs(x.shrink - 0.1848) < 1e-4, x.shrink)
}

{
  const r = base()
  r.segments = [{ kind: 'new', bytes: 393 }]
  const x = normalizeLastFold(r)
  check('② 无 head 段不改（增量折保持原值）', x.foldRatio === 1.0084, x.foldRatio)
}

{
  const r = base()
  delete r.incrementalRawBytes
  const x = normalizeLastFold(r)
  check('③ 缺原始计数不改（无法复算就保持原样）', x.foldRatio === 1.0084, x.foldRatio)
}

{
  const r = base()
  r.foldRatio = 0.1848
  r.shrink = 0.1848
  const x = normalizeLastFold(r)
  check('④ 新记录重算结果一致（幂等）', Math.abs(x.foldRatio - 0.1848) < 1e-9, x.foldRatio)
}

check('⑤ null 原样返回', normalizeLastFold(null) === null)
{
  const r = base()
  r.segments = [{ kind: 'new', bytes: 393 }]
  check('⑥ 不相关记录原样返回（同一引用，不复制）', normalizeLastFold(r) === r)
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
