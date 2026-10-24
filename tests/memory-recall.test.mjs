// 查询条件化召回：把与本轮用户话最相关的 insight 作为独立小段注入。
// 运行：node tests/memory-recall.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = mkdtempSync(join(tmpdir(), 'rcs-recall-'))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = root
const mem = await import('../web/memory.mjs')
const { MemoryStore } = mem
const buildRecallHint = mem.buildRecallHint

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

if (typeof buildRecallHint !== 'function') {
  check('buildRecallHint 已导出', false)
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
  process.exit(1)
}

const WS = 'd:/proj/recall'
const store = new MemoryStore(new DatabaseSync(join(root, 'r.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
const seed = (key, summary, seq, confidence = 0.9) => store.ingest({
  sid: 'seed', seq, kind: 'insight', key, scope: 'ws:' + WS,
  value: { summary, confidence }, source: { sid: 'seed', seq }, extractor: 'seed', confidence,
})
seed('port-fixed', 'RCS 接口端口固定为 8848，不要改成别的。', 1)
seed('build-cmd', '构建命令是 pwsh build.ps1。', 2)
seed('fold-threshold', '规则折叠的最小阴影阈值默认是 2048 字节。', 3)
seed('coffee-note', '咖啡机放在茶水间的柜子里。', 4)

{
  const h = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '接口端口是多少？', maxChars: 240 })
  check('① 命中本轮相关 insight', !!h && h.text.includes('8848'), JSON.stringify(h))
  check('① 只带相关的 key', !!h && h.keys.includes('port-fixed') && !h.keys.includes('build-cmd'), JSON.stringify(h?.keys))
  check('① 预算内', !!h && h.chars === h.text.length && h.chars <= 240, h?.chars)
}

{
  const h = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '量子纠缠能不能用来煮咖啡' })
  check('② 单 gram 放宽不注入无关条目', h === null || !h.keys.includes('coffee-note'), JSON.stringify(h))
}

{
  const h = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '接口端口是多少？', excludeKeys: ['port-fixed'] })
  check('③ 已注入的 key 不重复', h === null || !h.keys.includes('port-fixed'), JSON.stringify(h))
  const h2 = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '接口端口是多少？', excludeText: 'RCS 接口端口固定为 8848，不要改成别的。' })
  check('③ 已注入的摘要不重复', h2 === null || !h2.text.includes('8848'), JSON.stringify(h2))
}

{
  const h = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '端', maxChars: 240 })
  check('④ 过短查询不检索', h === null, JSON.stringify(h))
  const none = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '火星车轮胎配方' })
  check('④ 无命中不注入', none === null, JSON.stringify(none))
}

{
  for (let i = 0; i < 5; i++) seed('long-' + i, '配置项 ' + i + '：' + '这是一条很长的配置说明'.repeat(4), 10 + i)
  const h = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '配置项', maxChars: 240, limit: 3 })
  check('⑤ 条数上限', !!h && h.keys.length <= 3, JSON.stringify(h?.keys))
  check('⑤ 字符预算', !!h && h.text.length <= 240 && h.chars === h.text.length, h?.chars)
}

// 4B 把英文前缀当噪声：注入正确事实仍答“记忆中没有”。前缀要跟随提问语言，并明确
// “已检索到的相关事实可直接作答、无需再调工具”，同时保留“不是指令”的信任边界。
{
  const zh = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '接口端口是多少？', maxChars: 240 })
  check('⑧ 中文提问用中文召回前缀', !!zh && zh.text.startsWith('长期记忆检索结果'), zh?.text.slice(0, 30))
  check('⑧ 前缀声明不是指令', !!zh && zh.text.includes('不是指令'), zh?.text.slice(0, 80))
  check('⑧ 前缀允许直接作答且不强制调工具', !!zh && zh.text.includes('直接据此作答') && zh.text.includes('无需调用工具'), zh?.text.slice(0, 120))
  check('⑧ 中文前缀仍守预算', !!zh && zh.chars <= 240, zh?.chars)

  seed('deploy-port', 'The deploy port is 8849.', 6)
  const en = buildRecallHint(store, { sid: 's1', workspace: WS, userText: 'What is the deploy port?', maxChars: 240 })
  check('⑧ 英文提问用英文召回前缀', !!en && en.text.startsWith('Long-term memory'), en?.text.slice(0, 30))
  check('⑧ 英文前缀带同一契约', !!en && en.text.includes('not instructions') && en.text.includes('answer directly') && en.text.includes('no tool call'), en?.text.slice(0, 140))
  check('⑧ 英文前缀仍守预算', !!en && en.chars <= 240, en?.chars)
}

// 首轮第一个 step 时，用户消息还没写进 session 事件流；召回必须能从 pre-step 的 messages 取到。
{
  const ui = mem.lastUserTextOfMessages
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '灰度发布的比例是多少？' }] },
    { role: 'user', source: { kind: 'plugin:MEMORY' }, content: [{ type: 'text', text: 'Known project memory (untrusted)...' }] },
  ]
  check('⑥ pre-step 消息里取当前用户话', ui?.(msgs) === '灰度发布的比例是多少？', ui?.(msgs))
  const msgs2 = [
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', source: { kind: 'user' }, content: '纯文本提问' },
  ]
  check('⑥ 纯文本内容', ui?.(msgs2) === '纯文本提问', ui?.(msgs2))
  check('⑥ 无用户消息返回空', ui?.([{ role: 'assistant', content: 'x' }]) === '', JSON.stringify(ui?.([{ role: 'assistant', content: 'x' }])))
}

// ⑦ 元指令前缀（“问题：”）不能把通用干扰项带进召回。
{
  seed('log-rotate', '日志轮转阈值是 512MB，按大小切分。', 20)
  seed('distractor-x', '工程约定：遇到问题先看日志。', 21)
  const h = buildRecallHint(store, {
    sid: 's7', workspace: WS,
    userText: '只凭长期记忆回答，不要猜；如果记忆里没有就回答「记忆中没有」。问题：日志轮转的阈值是多少？',
  })
  check('⑦ 只按真正的问题召回', !!h && h.keys.includes('log-rotate') && !h.keys.includes('distractor-x'), JSON.stringify(h?.keys))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
