// 上次折叠的"错误回执"必须区分【失败】与【出过错但已恢复】。
// 真机事故：档位被拒 → 不传档位重试 → 输出撞 max-tokens → 抢救成功，folded=1/1 fallback=0，
// 面板却把三段历史文本按红字"调用错误"展示。这是跨工件契约：插件写字段、客户端读字段，
// 任何一边改名/漏读都会静默退回假报错，所以两侧一起钉住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const plugin = readFileSync(join(root, 'web', 'contextinjector.mjs'), 'utf8')
const client = readFileSync(join(root, 'contextinjector-webui', 'lib', 'client.js'), 'utf8')

test('① 插件由最终结果判定"已恢复"：有错但每段都折叠成功才算', () => {
  // 声明必须与 condenseErr 同级（写 last-fold 的代码在 if 块之外）；v1.10.61 把它写在块内，
  // 每次折叠写记录时抛 "condenseErrResolved is not defined"，整折被判失败。
  assert.doesNotMatch(plugin, /const condenseErrResolved/)
  const decl = plugin.indexOf('let condenseErrResolved = false')
  const assign = plugin.indexOf('condenseErrResolved = !!(condenseErr')
  assert.ok(decl > 0 && assign > decl, '两处必须存在且先声明后赋值')
  assert.match(plugin, /condenseErrResolved: condenseErrResolved \|\| undefined/)
})

test('② 面板读到该字段：已恢复降级为提示，未恢复才用 .ci-err', () => {
  assert.match(client, /lf\.condenseErrResolved/)
  assert.match(client, /ci-note/) // 已恢复的分支
  assert.match(client, /"ci-err"/) // 真失败的既有分支仍在
})

test('③ 提示样式存在且不是错误色', () => {
  assert.match(client, /\.ci-note\{[^}]*color:#9aa4b2/)
})
