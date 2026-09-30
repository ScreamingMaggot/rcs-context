// toolfold 的行式契约：foldOne 的输出必须**单行**（[T]/[V] 各一行，不含裸 CR/LF）
//   动机：Windows 工具正文普遍是 \r\n。escVal 过去只转 \n、漏了 \r，裸 CR 写进行式日志后
//   会被当成换行 ⇒ 一行撑成多行，面板与任何按行解析的下游读到垃圾续行。
//   运行：node tests/toolfold-single-line.test.mjs
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
// 装配成安装布局（profiles/web + profiles/condense + profiles/toolfold）再 import，顺带验证交付结构
const root = mkdtempSync(join(tmpdir(), 'rcs-tf-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
const { foldOne } = await import(pathToFileURL(join(root, 'toolfold', 'toolfold.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + String(detail).slice(0, 90) : ''}`)
  if (!cond) fails++
}

const CRLF_TEXT = '=== PWD ===\r\n\r\nPath\r\n----\r\nC:\\temp\\ws\r\n=== python ===\r\nPython 3.14.0\r\n'
const cases = [
  { action: 'pwsh', args: { command: 'Write-Output "a"\r\nWrite-Output "b"' }, text: CRLF_TEXT, isError: false, tool: 'shell' },
  { action: 'read', args: { file_path: 'src/x.py' }, text: 'l1\r\nl2\r\nl3', isError: false, tool: 'fs' },
  { action: 'edit', args: { path: 'docs/A.md' }, text: 'ok', isError: true, tool: 'fs' },
  { action: 'grep', args: { pattern: 'foo' }, text: 'a\r\nb\r\nc', isError: false, tool: 'fs-search' },
  { action: 'unknown_tool', args: {}, text: 'x\r\ny', isError: false, tool: 'unknown_tool' },
]

for (const c of cases) {
  const { t, vs } = foldOne({ ...c, fs: { readFileSync } })
  const all = [t, ...vs]
  check(`[${c.action}] 输出全为单行（无裸 CR/LF）`, all.every((l) => !/[\r\n]/.test(l)), all.find((l) => /[\r\n]/.test(l)))
  check(`[${c.action}] 行首标记正确`, t.startsWith('[T] ') && vs.every((v) => v.startsWith('[V] ')))
  check(`[${c.action}] 竖线不破坏字段数`, t.split('|').length >= 5)
}

// 反证：把 \r 当普通字符塞进去，转义后应变成可见的 \r 两字符
const { t } = foldOne({ action: 'pwsh', args: { command: 'a\r\nb' }, text: 'x\ry', isError: false, tool: 'shell', fs: null })
check('CR 被转成可见的 \\r 字面量', t.includes('\\r') && !t.includes('\r'), t)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
