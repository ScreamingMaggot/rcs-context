// toolfold 值保真契约回归测试 —— 钉住"关键数值逐字保留、错误载荷比丢失更糟"这条底线。
//   行格式：[T] tool|action|target|status|P<n>|k=v|k="verbatim"|… ；P3 字段强制同时写 [V]。
//   被守的主张（deck 第 4/6 页与论文 §5.3）：
//     · 命令/路径/模式等**输入值**原样出现在 [T] 里（可核对回原文）
//     · read/write 的 size/lines/sha8 来自**真实字节**（不是模型复述）
//     · 错误必须带 err=<首行原文>，且状态归一到 FAIL/OK 词表
//     · 长输出要被标记 tee=REQUIRED（防"看起来完整"）
//     · [V] 行的转义必须**可逆**（含 | " 反斜杠 CRLF 的值，反转义后与原文逐字相同）
//     · P3 字段（如 ask_user_question 的回答）必须进 [V]，只靠 [T] 会丢正文
//   运行：node tests/toolfold-value-retention.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-toolfold-'))
mkdirSync(join(root, 'toolfold'), { recursive: true })
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
const { foldOne, parseRow, statusOf } = await import(pathToFileURL(join(root, 'toolfold', 'toolfold.mjs')).href)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

/* 与实现同口径的单次反转义（用于证明 [V] 可逆） */
const unesc = (q) => {
  if (!q.startsWith('"')) return q
  const body = q.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      const n = body[i + 1]
      out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n
      i++
    } else out += body[i]
  }
  return out
}
const fields = (t) => t.replace(/^\[T\] /, '').split('|')

/* ── ① pwsh：输入值原样、退出码与输出规模来自真实读数 ─────────────────── */
const cmd = 'python -c "print(8787)" --port 8741'
const out = ['line1 ok', 'line2 detail', 'line3 tail'].join('\n')
const r1 = foldOne({ action: 'pwsh', args: { command: cmd }, text: out, tool: 'shell' })
const f1 = fields(r1.t)
check('① [T] 字段数 ≥5 且 status=OK', f1.length >= 5 && f1[3] === 'OK', r1.t)
check('① 命令逐字保留（含引号与端口号）', r1.t.includes('python -c "print(8787)" --port 8741') || f1.some((x) => unesc(x.replace(/^cmd=/, '')) === cmd),
  f1.find((x) => x.startsWith('cmd=')))
check('① exit=0 与 out_n = 正文字符数（实测 32，不是行数 3）',
  f1.includes('exit=0') && f1.includes('out_n=' + out.length), f1.filter((x) => x.startsWith('exit') || x.startsWith('out_n')).join(' '))
check('① head/tail 保留首尾行（中间可省）', r1.t.includes('line1 ok') && r1.t.includes('line3 tail'))
check('① tool 列写的是域（shell）且可解析', f1[0] === 'shell', f1[0])

const big = Array.from({ length: 400 }, (_, i) => `row ${i} ${'x'.repeat(20)}`).join('\n')
const r2 = foldOne({ action: 'bash', args: { cmd: 'ls -R' }, text: big })
check('① 超阈值输出 ⇒ tee=REQUIRED（不许看起来完整）', r2.t.includes('tee=REQUIRED'), 'len=' + big.length)
check('① statusOf 四态：OK / FAIL / CANCEL / PARTIAL',
  statusOf(false) === 'OK' && statusOf(true) === 'FAIL' &&
  statusOf(false, { cancelled: true }) === 'CANCEL' && statusOf(false, { partial: true }) === 'PARTIAL')
check('① 注入器词表 ERR 与结构化词表 FAIL 指的是同一件事（isError 两条路都归 FAIL）',
  foldOne({ action: 'pwsh', args: { cmd: 'x' }, text: 'boom', isError: true }).t.split('|')[3] === 'FAIL')

/* ── ② 错误：首行原文必须进 [T] 与 [V] ────────────────────────────────── */
const errText = 'Traceback (most recent call last):\n  File "a.py", line 12\nValueError: port 8741 taken'
const r3 = foldOne({ action: 'pwsh', args: { cmd: './run.sh' }, text: errText, isError: true })
check('② 错误 ⇒ status=FAIL', fields(r3.t)[3] === 'FAIL', r3.t)
check('② 错误首行原文逐字保留在 [T]', r3.t.includes('Traceback (most recent call last):'), r3.t.slice(0, 120))
check('② 错误同时写 [V]（P2 错误行强制留证）', r3.vs.length >= 1 && r3.vs[0].startsWith('[V] '), r3.vs[0] || '(none)')
check('② [T] 通过 ref=V<n> 指回首条 [V]', /ref=V\d+/.test(r3.t), (r3.t.match(/ref=V\d+/) || [''])[0])

/* ── ③ read/write：size/lines/sha8 取自真实字节 ─────────────────────── */
const content = 'a=1\nb=2\nc=3\n'
const realPath = join(root, 'sample.py')
const fsStub = { readFileSync: (p) => { if (p === realPath) return Buffer.from(content, 'utf8'); throw new Error('ENOENT') } }
const r4 = foldOne({ action: 'read', args: { path: realPath }, text: '（模型复述，不应被采信）', fs: fsStub })
const wantSha = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex').slice(0, 8)
check('③ read 路径原样出现（target 字段反转义后 == 真实路径）',
  unesc(fields(r4.t)[2]) === realPath, fields(r4.t)[2])
check('③ size/lines/sha8 与真实文件一致（不采信正文）',
  r4.t.includes(`size=${Buffer.byteLength(content)}`) && r4.t.includes('lines=4') && r4.t.includes(`sha8=${wantSha}`),
  fields(r4.t).filter((x) => /^(size|lines|sha8)=/.test(x)).join(' '))
const r5 = foldOne({ action: 'write', args: { path: realPath }, text: 'ok', fs: fsStub })
check('③ write 也带 size 与 sha8（写后可核）', /size=\d+/.test(r5.t) && /sha8=[0-9a-f]{8}/.test(r5.t), r5.t.slice(0, 110))
const rEdit = foldOne({ action: 'edit', args: { path: realPath, old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd\ne' }, text: 'ok', fs: fsStub })
check('③ edit 带精确行数增减（del/ins），不摘写正文',
  rEdit.t.includes('del=3') && rEdit.t.includes('ins=5') && !rEdit.t.includes('old_string'),
  rEdit.t)
const rWrite = foldOne({ action: 'write', args: { path: realPath, content: '1\n2\n3\n4' }, text: 'ok', fs: fsStub })
check('③ write 带写入行数（ins），不回流全文',
  rWrite.t.includes('ins=4') && !rWrite.t.includes('1\\n2\\n3\\n4'), rWrite.t)
const r6 = foldOne({ action: 'read', args: { path: realPath }, text: 'x'.repeat(321) })   // 无 fs ⇒ 退回 chars
check('③ 无 fs 时退回 chars=正文长度（不编 size）', r6.t.includes('chars=321'), r6.t)

/* ── ③b read 预览：8KB 源码不再只剩一行 chars ───────────────────────── */
const pyLines = []
for (let i = 0; i < 60; i++) {
  if (i === 0) pyLines.push('"""module docstring：这一行必须出现在 head"""')
  else if (i === 8) pyLines.push('class Analyzer:')
  else if (i === 10) pyLines.push('    def run(self, path):')
  else if (i === 40) pyLines.push('def main(argv):')
  else if (i === 45) pyLines.push('def later_one(x):')
  else if (i === 50) pyLines.push('class LaterTwo:')
  else pyLines.push(`# filler line ${i} ` + 'x'.repeat(90))
}
const bigPy = pyLines.join('\n')
const rBig = foldOne({ action: 'read', args: { path: 'src/analyzer.py' }, text: bigPy })
check('③b read 保留 head（开头正文可在折叠行里直接读）',
  rBig.t.includes('head=') && unesc(fields(rBig.t).find((x) => x.startsWith('head=')).replace(/^head=/, '')).includes('module docstring'), rBig.t.slice(0, 180))
check('③b read 保留 tail（结尾正文）',
  rBig.t.includes('tail=') && unesc(fields(rBig.t).find((x) => x.startsWith('tail=')).replace(/^tail=/, '')).includes('filler line 59'),
  fields(rBig.t).find((x) => x.startsWith('tail=')))
check('③b 代码文件带结构大纲（class/def）',
  rBig.t.includes('outline=') && /class Analyzer/.test(rBig.t) && /def main/.test(rBig.t),
  fields(rBig.t).find((x) => x.startsWith('outline=')))
check('③b 长正文标 trunc=mid（明示中间被折叠）', rBig.t.includes('trunc=mid'))
check('③b 预览有界：整行仍远小于原文', rBig.t.length < 2400, 'row=' + rBig.t.length + 'B raw=' + bigPy.length + 'B')
check('③b 预览行仍是单行（无裸 CR/LF）', !/[\r\n]/.test(rBig.t))
const rSmall = foldOne({ action: 'read', args: { path: 'src/tiny.py' }, text: 'a=1\nb=2' })
check('③b 小文件不标截断', !rSmall.t.includes('trunc=mid') && rSmall.t.includes('head='), rSmall.t)
const hostStyle = ['<path>/x/a.py</path>', '<content>', ...[...Array(40)].map((_, i) => `${i + 1}: ${i === 30 ? 'def run(x):' : i === 35 ? 'class A:' : '# line ' + i}`), '</content>'].join('\n')
const rHost = foldOne({ action: 'read', args: { path: '/x/a.py' }, text: hostStyle })
check('③b 宿主 `N: ` 行号前缀不阻断结构大纲',
  rHost.t.includes('outline=') && /def run/.test(rHost.t) && /class A/.test(rHost.t),
  fields(rHost.t).find((x) => x.startsWith('outline=')))

/* ── ③c 大纲质量：多行签名、箭头函数、类上下文、按语言分规则 ───────── */
const outlineOf = (row) => unesc(fields(row.t).find((x) => x.startsWith('outline='))?.replace(/^outline=/, '') ?? '')
const filler = (n, tag) => Array.from({ length: n }, (_, i) => `// ${tag} filler ${i} ` + 'y'.repeat(45))

const jsLines = filler(30, 'js')
jsLines.push('export function alpha(a, b) {', '  return a + b')
jsLines.push(...filler(8, 'mid'))
jsLines.push('const beta = (x) =>', '  x * 2')
jsLines.push(...filler(8, 'mid2'))
jsLines.push('const notFn = (/x/.exec(s) || []).length')
jsLines.push(...filler(4, 'mid3'))
jsLines.push('class Engine {')
jsLines.push('  run(task, opts) {', '  }', '  stop() {', '  }', '}')
const rJs = foldOne({ action: 'read', args: { path: 'src/a.mjs' }, text: jsLines.join('\n') })
const outJs = outlineOf(rJs)
check('③c 箭头函数进入大纲', /const beta = \(x\) =>/.test(outJs), outJs)
check('③c 括号表达式常量不误判为函数', !/notFn/.test(outJs), outJs)
check('③c 多行签名合并为一条', /export function alpha\(a, b\)/.test(outJs), outJs)
check('③c 类方法带类名前缀', /Engine\.run\(task, opts\)/.test(outJs) && /Engine\.stop\(\)/.test(outJs), outJs)

const pyFiller = (n, tag) => Array.from({ length: n }, (_, i) => `# ${tag} filler ${i} ` + 'y'.repeat(45))
const pyMultiLines = pyFiller(30, 'py')
pyMultiLines.push('class Holder:', '    def long_sig(', '        self,', '        a,', '        b,', '    ):')
pyMultiLines.push(...pyFiller(4, 'pymid'))
pyMultiLines.push('    def short(self):')
pyMultiLines.push(...pyFiller(4, 'pymid2'))
pyMultiLines.push('def top(x,', '        y):')
const rPyMulti = foldOne({ action: 'read', args: { path: 'src/a.py' }, text: pyMultiLines.join('\n') })
const outPy = outlineOf(rPyMulti)
check('③c Python 多行 def 合并并保留类前缀',
  /Holder\.long_sig\(self, a, b\)/.test(outPy) && /def top\(x, y\)/.test(outPy), outPy)
check('③c Python 类方法不重复写 def', !/def Holder\./.test(outPy) && /Holder\.short\(self\)/.test(outPy), outPy)

const advLines = filler(30, 'adv')
advLines.push('const NOT_A_FN = (() => { return 1 })()')
advLines.push('export function f(a, opts = {}) { return a }')
advLines.push('class Box {', '  ping() { return 1 }', '}')
const rAdv = foldOne({ action: 'read', args: { path: 'src/adv.mjs' }, text: advLines.join('\n') })
const outAdv = outlineOf(rAdv)
check('③c IIFE 不误判为命名函数', !/NOT_A_FN/.test(outAdv), outAdv)
check('③c 参数默认对象不被当函数体截断', /export function f\(a, opts = \{\}\)/.test(outAdv), outAdv)
check('③c 单行方法体也能识别并带类名前缀', /Box\.ping\(\)/.test(outAdv), outAdv)

const cLines = filler(30, 'c')
cLines.push('if (ready) {', '  go();', '}', 'int main(int argc, char** argv) {')
cLines.push(...filler(5, 'cmid'))
cLines.push('while (x) {', '}')
const rC = foldOne({ action: 'read', args: { path: 'src/a.c' }, text: cLines.join('\n') })
const outC = outlineOf(rC)
check('③c C 函数保留返回类型与参数', /int main\(int argc, char\*\* argv\)/.test(outC), outC)
check('③c C 控制语句不进大纲', !/if \(ready\)/.test(outC) && !/while \(x\)/.test(outC), outC)

const mdLines = filler(30, 'md')
mdLines.push('# Title', '## Section', '#### TooDeep')
const rMd = foldOne({ action: 'read', args: { path: 'docs/a.md' }, text: mdLines.join('\n') })
const outMd = outlineOf(rMd)
check('③c Markdown 只收 1–3 级标题', /# Title/.test(outMd) && /## Section/.test(outMd) && !/TooDeep/.test(outMd), outMd)

const budgetLines = filler(30, 'budget')
for (let i = 0; i < 30; i++) budgetLines.push(`export function veryLongFunctionName${i}(argumentOne, argumentTwo, argumentThree) {`)
const rBudget = foldOne({ action: 'read', args: { path: 'src/budget.mjs' }, text: budgetLines.join('\n') })
const outBudget = outlineOf(rBudget)
check('③c 大纲有界：≤320 字且不截断半个条目',
  outBudget.length <= 320 && !outBudget.endsWith(',') && !outBudget.endsWith(' '), 'len=' + outBudget.length + ' ' + outBudget.slice(-40))

/* ── ④ grep/glob：模式保留 + 命中计数 + 截断标记 ─────────────────────── */
const hits = Array.from({ length: 25 }, (_, i) => `src/f${i}.py:10:  PORT=87${i % 10}`).join('\n')
const r7 = foldOne({ action: 'grep', args: { pattern: 'PORT=\\d+' }, text: hits })
const patField = unesc(fields(r7.t).find((x) => x.startsWith('pattern=')).replace(/^pattern=/, ''))
check('④ 模式逐字保留（反转义后 == 原正则）', patField === 'PORT=\\d+', patField)
check('④ count=非空行数（25）', r7.t.includes('count=25'), fields(r7.t).find((x) => x.startsWith('count=')))
check('④ 超过 10 条 ⇒ trunc=matches（明示被截断）', r7.t.includes('trunc=matches'), r7.t.slice(-60))
const r8 = foldOne({ action: 'glob', args: { pattern: '**/*.mjs' }, text: Array.from({ length: 30 }, (_, i) => `f${i}.mjs`).join('\n') })
check('④ glob 上限 20 且同样标截断', r8.t.includes('count=30') && r8.t.includes('trunc=matches'))

/* ── ⑤ [V] 转义可逆：含 | " \ CRLF 的值必须原样还原 ─────────────────── */
const nasty = 'x|y "q" z\\w\r\nsecond line\nthird'
const r9 = foldOne({ action: 'ask_user_question', args: { question: '端口用哪个？' }, text: nasty })
const vsLine = r9.vs[0] || ''
const valField = vsLine.split('|').slice(5).join('|')     // [V] seq|tool|action|target|field|value
check('⑤ P3 字段强制进 [V]（只靠 [T] 会丢正文）', vsLine.includes('|val|'), vsLine.slice(0, 80))
check('⑤ [V] 值反转义后与原文逐字相同', unesc(valField) === nasty,
  unesc(valField) === nasty ? '' : JSON.stringify(unesc(valField)))
check('⑤ [V] 行本身仍是单行（不含裸 CR/LF）', !/[\r\n]/.test(vsLine))
check('⑤ 问题文本也被引号包裹保留', r9.t.includes('端口用哪个？'), r9.t.slice(0, 90))

/* ── ⑥ 纯状态类工具：不塞无意义字段，但仍归属正确档位 ───────────────── */
const r10 = foldOne({ action: 'todo_write', args: { todos: [] }, text: 'updated' })
check('⑥ 状态类 grade=P0 且 status=OK', fields(r10.t)[4] === 'P0' && fields(r10.t)[3] === 'OK', r10.t)
check('⑥ 未知工具回退：保留有界预览与总字节数，不回流全文',
  (() => { const body = 'raw-body-'.repeat(120)
           const r = foldOne({ action: 'brand_new_tool', args: { x: 1 }, text: body });
           return fields(r.t)[3] === 'OK' && /out_n=1080/.test(r.t) && /head=/.test(r.t) && /trunc=mid/.test(r.t) && !r.t.includes(body) })())
const rWeb = foldOne({ action: 'web_fetch', args: { url: 'https://example.com' }, text: 'line\n'.repeat(200), tool: 'web' })
check('⑥ web_fetch fallback：目标 URL + 有界预览', fields(rWeb.t)[2] === 'https://example.com' && /out_n=1000/.test(rWeb.t) && /head=/.test(rWeb.t) && /tail=/.test(rWeb.t), rWeb.t.slice(0, 120))
const rWd = foldOne({ action: 'working_directory', args: { cd: '玩' }, text: 'C:\\Users\\Administrator\\Desktop\\PLUGINTESTplace\\玩', tool: 'working_directory' })
const fWd = parseRow(rWd.t)
check('⑥ working_directory 记录 cd 与 cwd', !!fWd && fWd.target === '玩' && fWd.fields?.cd === '玩' && /玩/.test(fWd.fields?.cwd || ''), rWd.t)
const rWd2 = foldOne({ action: 'working_directory', args: {}, text: 'C:\\Users\\Administrator\\Desktop\\PLUGINTESTplace', tool: 'working_directory' })
check('⑥ 无参 working_directory 仍记录 cwd', parseRow(rWd2.t)?.fields?.cwd === 'C:\\Users\\Administrator\\Desktop\\PLUGINTESTplace', rWd2.t)

/* ── ⑦ 与下游解析器互通：parseRow 两种形态都能读 ─────────────────────── */
const p1 = parseRow(r1.t.replace(/^\[T\] /, '')) || parseRow(r1.t)
check('⑦ parseRow 认结构化行（≥5 字段）', p1 && (p1.status === 'OK' || p1.length >= 5), JSON.stringify(p1).slice(0, 80))
const legacy = parseRow('[T] read | src/a.py | OK')
check('⑦ parseRow 也认注入器的三字段稀疏行（旧实现恒 null 的病灶）',
  !!legacy && (legacy.status === 'OK' || legacy.op === 'read' || JSON.stringify(legacy).includes('OK')), JSON.stringify(legacy).slice(0, 80))
const plainRaw = parseRow('[T] read | src/a.py | OK | raw=42')
check('⑦ parseRow 容忍 plain raw 指针', !!plainRaw && plainRaw.fields?.raw === '42', JSON.stringify(plainRaw).slice(0, 80))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
