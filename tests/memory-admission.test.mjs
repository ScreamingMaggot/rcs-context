// 单一准入点 + 凭据显式拒写。
// 背景（实测）：注入 SQL 只放 state/constraint，而 handover 自己取数不过滤 ⇒ ft=task 的偏好被注入；
// 而拦住"密码改成<明文>"那条提案的其实是 quote-boundary（句子边界），安全与效率旋钮偶然耦合。
// 运行：node tests/memory-admission.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  MemoryStore, MemoryCompiler, buildHandover, handoverMarkdown, makeMemoryTools,
  isInjectableFactType, looksLikeCredential, redactSecrets, INJECTABLE_FACT_TYPES,
} from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const root = mkdtempSync(join(tmpdir(), 'rcs-admit-'))
const ws = 'c:/proj/admission'
const store = new MemoryStore(new DatabaseSync(join(root, 'admit.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
const put = (rec) => store.ingest({ scope: 'ws:' + ws, ...rec })

// ① 准入谓词就是那一把门，两个口径一致
check('① state/constraint 可见，task/history 不可见',
  isInjectableFactType('state') && isInjectableFactType('constraint') &&
  !isInjectableFactType('task') && !isInjectableFactType('history') && !isInjectableFactType(''),
  JSON.stringify(INJECTABLE_FACT_TYPES))

put({ sid: 'a', seq: 10, kind: 'user_turn', key: 'turn:10', scope: 'sess:a', value: { text: '基础设计要包含卡点装置' }, source: { sid: 'a', seq: 10 } })
put({ sid: 'a', seq: 11, kind: 'insight', key: 'pref-beat', fact_type: 'task', value: { summary: '用户强调基础设计应包含卡点装置和生物工程属性', confidence: 0.95 }, source: { sid: 'a', seq: 11 } })
put({ sid: 'a', seq: 12, kind: 'insight', key: 'port', fact_type: 'constraint', value: { summary: '接口端口固定为 8848', confidence: 0.9 }, source: { sid: 'a', seq: 12 } })
put({ sid: 'a', seq: 13, kind: 'insight', key: 'miss', fact_type: 'history', value: { summary: 'AGENTS.md 文件未找到，搜索无结果', confidence: 0.8 }, source: { sid: 'a', seq: 13 } })

// ② handover 与注入 SQL 走同一把门
const h = buildHandover(store, { sid: 'a', workspace: ws })
const keys = h.insights.map((x) => x.key)
check('② 交接卡不再收录 task/history 事实', keys.includes('port') && !keys.includes('pref-beat') && !keys.includes('miss'), JSON.stringify(keys))
const md = handoverMarkdown(h)
const factsBlock = ((md.split('## Known facts')[1] ?? '').split(/^## /m)[0])
check('② markdown 的 Known facts 段只剩可见事实',
  factsBlock.includes('8848') && !factsBlock.includes('卡点装置') && !factsBlock.includes('AGENTS.md'), factsBlock)
check('② 注入面（insightsSince）与卡片口径一致',
  store.insightsSince('ws:' + ws, 0, 10).every((x) => isInjectableFactType(x.type ?? x.factType ?? store.get({ sid: 'a', scope: 'project', workspace: ws, kind: 'insight', key: x.key })?.factType)),
  JSON.stringify(store.insightsSince('ws:' + ws, 0, 10).map((x) => x.key)))

// ③ 凭据识别：命中真实凭据，不误杀正常约束
const denyCases = [
  '密码改成SCrea2M0i0n6gQu',
  'password=hunter2',
  '把 API key 设成 sk-abcdefgh12345678',
  'Bearer abcdefgh12345678',
  '口令为 A1b2C3d4',
]
const keepCases = [
  '密钥管理规则需要写进文档',
  '密码忘了，改用指纹登录',
  '接口端口固定为 8848',
  '所有测试统一使用 node:test',
]
check('③ 凭据形态全部命中', denyCases.every((t) => looksLikeCredential(t)),
  JSON.stringify(denyCases.filter((t) => !looksLikeCredential(t))))
check('③ 正常约束不被误杀', keepCases.every((t) => !looksLikeCredential(t)),
  JSON.stringify(keepCases.filter((t) => looksLikeCredential(t))))
check('③ 渲染侧同样遮蔽中文赋值式凭据',
  !redactSecrets('密码改成SCrea2M0i0n6gQu').includes('SCrea2M0i0n6gQu'), redactSecrets('密码改成SCrea2M0i0n6gQu'))

// ④ 写入工具拒收凭据
const tools = Object.fromEntries(makeMemoryTools(store).map((t) => [t.name, t]))
let seq = 0
const events = []
const pushUser = (text) => { seq += 1; events.push({ type: 'user/message', seq, data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text }] } } }); return seq }
const exec = { agent: { session: { id: 'session-a', header: { cwd: 'C:\\Proj\\Admission' }, ownEvents: () => events } } }
pushUser('请记住：密码改成SCrea2M0i0n6gQu')
const rem = await tools.memory_remember.execute({ text: '密码改成SCrea2M0i0n6gQu' }, exec)
check('④ memory_remember 拒写凭据（不是脱敏后照存）',
  rem.ok === false && rem.error === 'credential-not-storable', JSON.stringify(rem))
check('④ 库里没有这条凭据',
  !store.db.prepare("SELECT 1 FROM records WHERE abstract LIKE '%SCrea2M0i0n6gQu%' OR value LIKE '%SCrea2M0i0n6gQu%'").get())
pushUser('请记住：接口端口固定为 8848')
const remOk = await tools.memory_remember.execute({ text: '接口端口固定为 8848' }, exec)
check('④ 正常事实仍可写入（闸门不是钝刀）', remOk.ok === true, JSON.stringify(remOk))

// ⑤ 编译层同样拒绝，并留下可观测计数
const sid2 = 'b'
put({ sid: sid2, seq: 1, kind: 'user_turn', key: 'u1', value: { text: '密码改成SCrea2M0i0n6gQu，以后每次部署都要轮换' }, source: { sid: sid2, seq: 1 } })
const fakeLlm = {
  stream: async function* () {
    yield { type: 'text-delta', text: '{"insights":[{"key":"cred.rule","summary":"密码改成SCrea2M0i0n6gQu","confidence":0.9}]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const compiler = new MemoryCompiler(store, { foldGraceMs: 0, maxEvents: 40 })
const r = await compiler.compileSession({ sid: sid2, workspace: ws, llm: fakeLlm, route: { provider: 'ollama-local', model: 'qwen3:4b' } })
check('⑤ 编译不落凭据，且计数可见',
  r.ok === true && r.insights === 0 && r.secretRejected === 1, JSON.stringify(r))
const leaked = store.db.prepare("SELECT 1 FROM records WHERE kind='insight' AND (value LIKE '%SCrea2M0i0n6gQu%' OR abstract LIKE '%SCrea2M0i0n6gQu%')").get()
check('⑤ 口令没有变成长期事实（事件流仍按原样留痕，属另一条待办）', !leaked, JSON.stringify(leaked))
check('⑤ 即便原话留痕，渲染面也必须遮蔽',
  !handoverMarkdown(buildHandover(store, { sid: sid2, workspace: ws })).includes('SCrea2M0i0n6gQu'))

store.db.close()
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
