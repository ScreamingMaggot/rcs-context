// 漂移 #11 回归测试：0.1.7 把 tool-call 从"助手消息内容块"改为独立 tool/call 事件
//   ⇒ transcribeIncremental 的 pending 永不登记 ⇒ [T] 的工具名/目标整列退化为 `?`。
//   本测试锁定修复后的三条契约：①事件索引可恢复名字；②无索引时确实复现事故（防"假修复"）；
//   ③老宿主（块内自带 name）行为逐字不变。
//   运行：node tests/drift11-toolcall-event-index.test.mjs
// ⚠ 插件源码里的 import 是**安装后布局**（profiles/web/contextinjector.mjs → ../condense/、../toolfold/），
//   而仓库是平铺的。故本测试先把交付文件装配成安装布局再 import——顺带验证交付包结构本身可加载。
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-layout-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))

const { transcribeIncremental, callIndexFromEvents, isToolResultMsg, toolResultCallId } = await import(
  new URL('file:///' + join(root, 'web', 'contextinjector.mjs').replace(/\\/g, '/')))

let fails = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`)
  if (!cond) fails++
}

// —— 夹具：0.1.7 形态的事件层（name/arguments 只在事件里，arguments 为 JSON 字符串）——
const EVENTS = [
  { type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'python --version' }) } },
  { type: 'tool/call', data: { callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'src/airfoil_ai/ml.py' }) } },
  { type: 'tool/call', data: { callId: 'c3', name: 'edit', arguments: JSON.stringify({ path: 'docs/ASSUMPTIONS.md' }) } },
  { type: 'tool/call', data: { callId: 'c4', name: 'web_search', arguments: JSON.stringify({ query: 'NACA 5 digit camber table' }) } },
  // 噪声：非 tool/call 事件不得进入索引
  { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1' } } },
]
const session = { ownEvents: () => EVENTS }
const calls = callIndexFromEvents(session)

check('① 事件索引：只收 tool/call，4 条齐全', calls.size === 4, [...calls.keys()].join(','))
check('① 索引携带工具名', [...calls.values()].map((v) => v.op).join(',') === 'pwsh,read,edit,web_search')
check('① 文件类工具解析出目标路径', calls.get('c2').path === 'src/airfoil_ai/ml.py' && calls.get('c3').path === 'docs/ASSUMPTIONS.md')
check('① 无路径语义的工具回落为 -', calls.get('c1').path === '-' && calls.get('c4').path === '-')

// —— 派生消息：助手消息**没有** tool-call 块，工具结果自带 tool-result 块 ——
const asst = { role: 'assistant', content: [{ type: 'text', text: 'probing environment' }] }
const results = ['c1', 'c2', 'c3', 'c4'].map((id) => ({
  role: 'tool',
  toolCallId: id,
  source: { kind: 'tool', callId: id },
  content: [{ type: 'tool-result', toolCallId: id, isError: false, content: [{ type: 'text', text: 'ok' }] }],
}))
const rowsOf = (opts) => transcribeIncremental([asst, ...results], { n: 1 }, opts).filter((r) => r.startsWith('[T]'))

const fixed = rowsOf({ structured: false, calls })
check('② 修复后：四条 [T] 全部带出工具名', fixed.length === 4 && fixed.every((r) => /\[T\] \w/ && !r.startsWith('[T] ?')), fixed.join(' ;; '))
check('② 修复后：目标路径进入转录行', /\[T\] read \| src\/airfoil_ai\/ml\.py \| OK/.test(fixed.join('\n')))

const broken = rowsOf({ structured: false })
check('③ 反证：去掉索引则工具名整列退化为 ?（复现事故）', broken.length === 4 && broken.every((r) => r.startsWith('[T] ?')), broken.join(' ;; '))

const structuredBroken = rowsOf({ structured: true })
check('③ 反证：structured 档退化为 `?|?|-`（真机 118/118 的形态）', structuredBroken.every((r) => r.startsWith('[T] ?|?|-')), structuredBroken[0])
const structuredFixed = rowsOf({ structured: true, calls })
check('② structured 档修复后带出工具域与名字', structuredFixed.every((r) => /\[T\] [a-z-]+\|(pwsh|read|edit|web_search)\|/.test(r)), structuredFixed[0])

// —— 老宿主形态：tool-call 块在助手消息内、自带 name ⇒ 不依赖索引，行为逐字不变 ——
const legacy = [
  ...['c1', 'c2', 'c3', 'c4'].map((id) => ({
    role: 'assistant',
    content: [{ type: 'tool-call', id, name: calls.get(id).op, arguments: JSON.stringify({ x: id }) }],
  })),
  ...results,
]
const legacyRows = transcribeIncremental(legacy, { n: 1 }, { structured: false }).filter((r) => r.startsWith('[T]'))
check('④ 老宿主（块内自带 name）无需索引即正确，行为不变', legacyRows.length === 4 && legacyRows.every((r) => /\[T\] \w/ && !r.startsWith('[T] ?')), legacyRows.join(' ;; '))

const legacyWithIdx = transcribeIncremental(legacy, { n: 1 }, { structured: false, calls }).filter((r) => r.startsWith('[T]'))
check('④ 老宿主 + 索引在场 ⇒ 与不带索引逐字相同（块内 name 优先）', legacyWithIdx.join('\n') === legacyRows.join('\n'))

// —— ⑤ 漂移 #11 主症状：0.1.7 的**消息级**工具结果（content 只有 text，无 tool-result 块）——
//    旧实现只在块级分支产 [T] ⇒ 这类结果被整类静默跳过（真机：205 节点折叠后 [T] 行数 = 0）。
const msgLevel = [
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'ls' }) }] },
  { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, isError: false,
    content: [{ type: 'text', text: 'a.py  b.py' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'src/x.py' }) }] },
  { role: 'tool', toolCallId: 'c2', source: { kind: 'tool', callId: 'c2' }, isError: true,
    content: [{ type: 'text', text: 'file not found' }] },
]
const rows5 = transcribeIncremental(msgLevel, { n: 1 }, { structured: false })
const T5 = rows5.filter((r) => r.startsWith('[T]'))
check('⑤ 0.1.7 消息级结果 ⇒ 每条都产 [T]（旧实现为 0 条）', T5.length === 2, T5.join(' ;; '))
check('⑤ 工具名与目标来自 pending 登记', /\[T\] pwsh \| - \| OK/.test(T5[0] || '') && /\[T\] read \| src\/x\.py \| ERR/.test(T5[1] || ''), T5.join(' ;; '))
check('⑤ isError 从消息层生效', /\| ERR$/.test(T5[1] || ''), T5[1])

// —— ⑥ 覆盖守卫的判据：工具结果消息数 == [T] 行数（少一行即拒绝折叠）——
const wantTool = msgLevel.filter((m) => isToolResultMsg(m)).length
const gotTool = rows5.filter((r) => /^\[T\] /.test(r)).length
check('⑥ 覆盖 parity：want == got', wantTool === 2 && gotTool === 2, `want=${wantTool} got=${gotTool}`)

// —— ⑦ 双形态判定：块级与消息级都认，普通消息不误认 ——
check('⑦ isToolResultMsg 认消息级', isToolResultMsg({ role: 'tool', content: [{ type: 'text', text: 'x' }] }))
check('⑦ isToolResultMsg 认块级', isToolResultMsg({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c9' }] }))
check('⑦ isToolResultMsg 不认普通 user/assistant', !isToolResultMsg(asst) && !isToolResultMsg({ role: 'user', content: [{ type: 'text', text: 'hi' }] }))
check('⑦ callId 提取双形态', toolResultCallId({ toolCallId: 'a1' }) === 'a1' && toolResultCallId({}, { toolCallId: 'a2' }) === 'a2'
  && toolResultCallId({ source: { kind: 'tool', callId: 'a3' } }) === 'a3')

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
