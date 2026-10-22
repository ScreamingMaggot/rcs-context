// 记忆编译模型路由回归：control 覆盖成对才生效，否则回退会话当前模型。
// 运行：node tests/memory-route-config.test.mjs
import { routeForCompile, groundedInsight } from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const session = (provider, model) => ({
  requestHeader: () => ({ config: { provider, model } }),
})

const ctrl = routeForCompile(session('deepseek-account', 'deepseek-v4-flash'), {
  memoryLlmProvider: 'ollama-local',
  memoryLlmModel: 'qwen3:4b-instruct-2507-q4_K_M',
})
check('① 成对覆盖优先于会话模型',
  ctrl?.provider === 'ollama-local' && ctrl?.model === 'qwen3:4b-instruct-2507-q4_K_M' && ctrl?.via === 'control',
  JSON.stringify(ctrl))

const half = routeForCompile(session('deepseek-account', 'deepseek-v4-flash'), {
  memoryLlmProvider: 'ollama-local',
})
check('② 只配 provider（半对）⇒ 忽略覆盖，回退会话',
  half?.provider === 'deepseek-account' && half?.via === 'session', JSON.stringify(half))

const empty = routeForCompile(session('deepseek-account', 'deepseek-v4-flash'), {
  memoryLlmProvider: '',
  memoryLlmModel: '',
})
check('③ 空串 = 清除覆盖 ⇒ 回退会话',
  empty?.provider === 'deepseek-account' && empty?.via === 'session', JSON.stringify(empty))

const none = routeForCompile({ requestHeader: () => ({}) }, {})
check('④ 两者都无 ⇒ null（调用方记 no-route）', none === null, String(none))

const broken = routeForCompile({ requestHeader: () => { throw new Error('boom') } }, {})
check('⑤ requestHeader 抛错 ⇒ null（失败开放，不打断事件循环）', broken === null, String(broken))

/* ── ⑥ 小模型标识符逐字闸（4B 实测会抄错模型名） ─────────────────── */
const SRC = '使用 qwen3:4b-instruct-2507-q4_K_M，端口 8848，会话 session-3655c2fe-a38a-4834-ac0a-de610474e06f，版本 v1.10.39'
check('⑥ 标识符逐字正确 ⇒ 放行',
  groundedInsight({ summary: '模型 qwen3:4b-instruct-2507-q4_K_M，端口 8848' }, SRC) === true)
check('⑥ 模型名抄错（4-4b）⇒ 拒绝',
  groundedInsight({ summary: '模型 qwen3:4-4b-instruct-2507-q4_K_M，端口 8848' }, SRC) === false)
check('⑥ 会话 id 抄错一位 ⇒ 拒绝',
  groundedInsight({ summary: '会话 session-3655c2ff-a38a-4834' }, SRC) === false)
check('⑥ 普通短句（无字母数字混合长 token）⇒ 放行',
  groundedInsight({ summary: '使用 8848 端口' }, SRC) === true)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
