// 整理路由：手动可用独立强模型，自动永远不抢用它；未配置时按原顺序回退。
// 运行：node tests/memory-consolidate-route.test.mjs
import { routeForConsolidate } from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const last = { provider: 'deepseek-account', model: 'deepseek-chat' }
const compile = { memoryLlmProvider: 'ollama-local', memoryLlmModel: 'qwen3:4b' }
const manual = { ...compile, memoryConsolidateManualProvider: 'spark', memoryConsolidateManualModel: 'spark-x2.6' }

{
  const r = routeForConsolidate({ trigger: 'manual', lastRoute: last, ctrl: manual })
  check('① 手动优先用独立强模型', r?.provider === 'spark' && r?.model === 'spark-x2.6' && r?.via === 'manual', JSON.stringify(r))
}
{
  const r = routeForConsolidate({ trigger: 'auto', lastRoute: last, ctrl: manual })
  check('② 自动忽略手动强模型', r?.provider === 'deepseek-account' && r?.model === 'deepseek-chat' && r?.via === 'last', JSON.stringify(r))
}
{
  const r = routeForConsolidate({ trigger: 'manual', lastRoute: null, ctrl: manual })
  check('③ 手动无会话路由时仍可用强模型', r?.provider === 'spark' && r?.via === 'manual', JSON.stringify(r))
}
{
  const r = routeForConsolidate({ trigger: 'auto', lastRoute: null, ctrl: manual })
  check('④ 自动无会话路由时回退编译模型', r?.provider === 'ollama-local' && r?.model === 'qwen3:4b' && r?.via === 'control', JSON.stringify(r))
}
{
  const r = routeForConsolidate({ trigger: 'manual', lastRoute: last, ctrl: { memoryConsolidateManualProvider: 'spark' } })
  check('⑤ 手动路由必须成对，缺 model 时回退', r?.provider === 'deepseek-account' && r?.via === 'last', JSON.stringify(r))
}
{
  const r = routeForConsolidate({ trigger: 'manual', lastRoute: null, ctrl: { ...compile, memoryConsolidateManualProvider: 'spark', memoryConsolidateManualModel: '' } })
  check('⑥ 空 model 视为未配置，回退编译模型', r?.provider === 'ollama-local' && r?.via === 'control', JSON.stringify(r))
}
{
  const r = routeForConsolidate({ trigger: 'auto', lastRoute: null, ctrl: {} })
  check('⑦ 全空返回 null', r === null, JSON.stringify(r))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
