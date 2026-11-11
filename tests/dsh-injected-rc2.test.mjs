// DSH 0.2.2-rc.2 兼容回归：runtime-context 快照的形态变了。
//   rc.1: user 消息正文直接是 "Current runtime context: ..."（裸文本）
//   rc.2: <system-reminder>\nThe following information describes your current session:\n\n...\n</system-reminder>
// 注入判定若只认旧前缀，尾部快照就不再被判为注入 ⇒ 被折叠遮蔽 ⇒ DSH 逐轮补发。
// 现在的判定：source.kind 优先（与文本形态无关），前缀匹配前剥 reminder 包裹。
// Run: node tests/dsh-injected-rc2.test.mjs
import { isDshInjected, isInjectedUser } from '../web/contextinjector.mjs'

let fails = 0
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!condition) fails++
}

const userMessage = (text, source) => ({
  role: 'user',
  source,
  content: [{ type: 'text', text }],
})

// ① rc.2 形态：包裹 + 新开场句，kind 仍是 runtime-context
const rc2Text = '<system-reminder>\nThe following information describes your current session:\n\n'
  + 'Current working directory: "C:\\work"\n</system-reminder>'
const rc2 = userMessage(rc2Text, { kind: 'runtime-context', form: 'snapshot', sections: [] })
check('rc2 runtime-context (wrapped) counts as injected', isDshInjected(rc2) === true)
check('rc2 runtime-context is injected under the legacy keepInject=false semantics too',
  isInjectedUser(rc2) === true)

// ② rc.1 形态仍然要认（同一份代码跑两个宿主）
const rc1 = userMessage('Current runtime context: cwd="C:\\work"', { kind: 'runtime-context' })
check('rc1 runtime-context (bare text) still counts as injected', isDshInjected(rc1) === true)

// ③ 少了 source 时只能靠文本：包裹必须剥掉才匹配得上新开场句
const noSource = userMessage(rc2Text, undefined)
check('a wrapped runtime-context without source still matches by text', isDshInjected(noSource) === true)

// ④ 真人输入不得被误判
const human = userMessage('帮我看下这个口径问题', { kind: 'user' })
check('a human message is not injected', isDshInjected(human) === false && isInjectedUser(human) === false)

// ⑤ 既有 kind 判定不受影响
check('skill-catalog still counts as injected',
  isDshInjected(userMessage('<system-reminder>skills</system-reminder>', { kind: 'skill-catalog' })) === true)

// ⑥ 自身转录消息在 keepInject 语义下仍可被折叠（不能钉在 surface 上）
const own = userMessage('[FOLD v1] ...', { kind: 'plugin:CONTEXTinjector' })
check('own folded transcript is not treated as a DSH injection', isDshInjected(own) === false)

// ⑦ EXTREASON 简报是易失量，两个判定里都必须可折叠
const extreason = userMessage('[R] 简报', { kind: 'plugin:EXTREASON' })
check('extreason brief stays foldable in both semantics',
  isDshInjected(extreason) === false && isInjectedUser(extreason) === false)

if (fails) {
  console.error(`\n${fails} 条断言失败`)
  process.exit(1)
}
console.log('\nall assertions passed')
