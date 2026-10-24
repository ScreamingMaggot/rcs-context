// 整理结果打分器自检：合成用例必须同时能判对、判漏、判噪声、判解析失败。
// 运行：node tests/memory-consolidation-eval.test.mjs
import { scoreConsolidation } from './lib-consolidation-eval.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const activeOf = (obj) => Object.entries(obj).map(([key, summary]) => ({ key, summary, factType: 'state' }))

{
  const r = scoreConsolidation({
    active: activeOf({ a: 'A2', b: 'B', c: 'C' }),
    required: { a: ['A2'], c: ['C'] },
    unchanged: { b: 'B' },
    changedKeys: ['a', 'c'],
    appliedOps: [{ op: 'new', target: 'a' }, { op: 'supersede', target: 'a' }, { op: 'new', target: 'c' }],
    result: { ok: true },
  })
  check('① 完美结果：召回/精度/安全全满', r.recall === 1 && r.precision === 1 && r.extra.length === 0 && r.unexpectedApplied.length === 0 && r.safety === true, JSON.stringify(r))
}

{
  const r = scoreConsolidation({
    active: activeOf({ a: 'A', b: 'B', c: 'C' }),
    required: { a: ['A2'], c: ['C'] },
    unchanged: { b: 'B' },
    changedKeys: ['a', 'c'],
    appliedOps: [{ op: 'new', target: 'c' }],
    result: { ok: true },
  })
  check('② 漏掉变更：召回下降，安全仍真', r.recall === 0.5 && r.precision === 1 && r.safety === true, JSON.stringify(r))
}

{
  const r = scoreConsolidation({
    active: activeOf({ a: 'A2', b: 'B2', c: 'C' }),
    required: { a: ['A2'], c: ['C'] },
    unchanged: { b: 'B' },
    changedKeys: ['a', 'c'],
    appliedOps: [{ op: 'new', target: 'a' }, { op: 'new', target: 'b' }],
    result: { ok: true },
  })
  check('③ 误改未变事实：精度下降且记为非预期操作', r.precision === 0 && r.unexpectedApplied.includes('new:b') && r.safety === false, JSON.stringify(r))
}

{
  const r = scoreConsolidation({
    active: activeOf({ a: 'A2', b: 'B', c: 'C', d: 'D' }),
    required: { a: ['A2'], c: ['C'] },
    unchanged: { b: 'B' },
    changedKeys: ['a', 'c'],
    appliedOps: [{ op: 'new', target: 'a' }, { op: 'new', target: 'c' }, { op: 'new', target: 'd' }],
    result: { ok: true },
  })
  check('④ 多出状态事实：记噪声且安全失败', r.extra.includes('d') && r.unexpectedApplied.includes('new:d') && r.safety === false, JSON.stringify(r))
}

{
  const r = scoreConsolidation({
    active: activeOf({ a: 'A', b: 'B' }),
    required: { a: ['A2'] },
    unchanged: { b: 'B' },
    changedKeys: ['a'],
    appliedOps: [],
    result: { ok: false, reason: 'parse-failed' },
  })
  check('⑤ 解析失败：未完成但未改坏数据', r.completed === false && r.safety === true && r.recall === 0 && r.precision === 1, JSON.stringify(r))
}

{
  const r = scoreConsolidation({
    active: activeOf({ a: 'A', x: 'COMP' }),
    required: { a: ['A'] },
    unchanged: {},
    changedKeys: [],
    absent: ['x'],
    appliedOps: [],
    result: { ok: true },
  })
  check('⑦ 已失效事实复活：安全失败', r.absentActive.includes('x') && r.safety === false, JSON.stringify(r))
}

{
  const r = scoreConsolidation({
    active: [
      { key: 'a', summary: 'A2', factType: 'state' },
      { key: 'b', summary: 'B', factType: 'state' },
      { key: 'c', summary: 'C', factType: 'state' },
      { key: 't', summary: 'new task', factType: 'task' },
    ],
    required: { a: ['A2'], c: ['C'] },
    unchanged: { b: 'B' },
    changedKeys: ['a', 'c'],
    appliedOps: [
      { op: 'new', target: 'a', type: 'state' },
      { op: 'new', target: 'c', type: 'state' },
      { op: 'new', target: 't', type: 'task' },
    ],
    result: { ok: true },
  })
  check('⑥ task/history 变更不计入状态安全失败', r.safety === true && r.extra.length === 0 && r.unexpectedApplied.length === 0, JSON.stringify(r))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
