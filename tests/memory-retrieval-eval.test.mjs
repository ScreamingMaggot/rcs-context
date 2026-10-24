// 零模型检索评测：200 份文档 + 30 条跨会话 insight + 更新/无关问题。
// 目的不是“跑通”，而是回答“检索在规模下还取不取得回”。固定种子、无 LLM、可进 CI。
// 运行：node tests/memory-retrieval-eval.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const root = mkdtempSync(join(tmpdir(), 'rcs-eval-'))
const ws = 'c:/proj/eval'
const s = new MemoryStore(new DatabaseSync(join(root, 'eval.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })

// 200 份文档：都含“配置项”这个热门词，只有各自的模块号唯一。
for (let i = 0; i < 200; i++) {
  const sid = 's' + (i % 20)
  s.ingest({
    sid, seq: 100 + i, kind: 'file_state', key: 'file:doc' + i, scope: 'ws:' + ws,
    value: { path: 'docs/module-' + i + '.md', action: 'read', size: 100 + i, excerpt: '模块' + i + ' 的配置项是 ' + (1000 + i) + '。' },
    source: { sid, seq: 100 + i },
  })
}
// 30 条跨会话事实：每条一个唯一代号。
for (let j = 0; j < 30; j++) {
  const sid = 's' + (j % 20)
  s.ingest({
    sid, seq: 400 + j, kind: 'insight', key: 'fact:' + j, scope: 'ws:' + ws,
    value: { summary: '代号朱雀' + j + ' 的接口端口是 ' + (9000 + j) + '，归属模块' + (j * 3) + '。', confidence: 0.9 },
    source: { sid, seq: 400 + j },
  })
}
// 同 key 更新：旧值 8848 应被 9999 覆盖。
for (const [seq, port] of [[500, 8848], [501, 9999]]) {
  s.ingest({
    sid: 's1', seq, kind: 'insight', key: 'api-port', scope: 'ws:' + ws,
    value: { summary: '接口端口固定为 ' + port + '。', confidence: 0.95 }, source: { sid: 's1', seq },
  })
}

const q = (query, limit = 10) => s.search({ sid: 's1', scope: 'project', workspace: ws, query, limit })

// 1) 唯一代号：检验“答案没被 200 份文档淹没”。
const tokenHits = []
for (let j = 0; j < 10; j++) {
  const r = q('朱雀' + j, 5)
  tokenHits.push(r.results.findIndex((x) => x.key === 'fact:' + j))
}
const at1 = tokenHits.filter((i) => i === 0).length
const at5 = tokenHits.filter((i) => i >= 0).length
check('① 唯一代号 recall@1 = 10/10', at1 === 10, tokenHits.join(','))
check('① 唯一代号 recall@5 = 10/10', at5 === 10, tokenHits.join(','))

// 2) 跨会话关联：模块号 + 热门词。
const crossHits = []
for (let i = 0; i < 10; i++) {
  const n = i * 17
  const r = q('模块' + n + ' 配置项', 5)
  crossHits.push(r.results.findIndex((x) => x.key === 'file:doc' + n))
}
check('② 跨会话文档 recall@1 = 10/10', crossHits.filter((i) => i === 0).length === 10, crossHits.join(','))
check('② 跨会话文档 recall@5 = 10/10', crossHits.every((i) => i >= 0), crossHits.join(','))

// 3) MRR（唯一代号 + 跨会话，共 20 题）。
const rr = [...tokenHits, ...crossHits].map((i) => (i >= 0 ? 1 / (i + 1) : 0))
const mrr = rr.reduce((a, b) => a + b, 0) / rr.length
check('③ MRR ≥ 0.80', mrr >= 0.80, mrr.toFixed(3))

// 4) 更新语义：新值命中、旧值不再命中。
const fresh = q('9999', 5)
const stale = q('8848', 5)
check('④ 更新后的新值命中 api-port', fresh.results.some((x) => x.key === 'api-port'), fresh.mode + ':' + fresh.results.length)
check('④ 被覆盖的旧值不再命中', !stale.results.some((x) => x.key === 'api-port'), stale.mode + ':' + stale.results.length)

// 5) 无关问题：不硬凑结果。
let noAns = 0
for (let j = 0; j < 5; j++) if (q('不存在的代号ZXQ' + j, 5).results.length === 0) noAns++
check('⑤ 无关问题 5/5 返回空', noAns === 5, String(noAns))

// 5b) 自然问法（不是记忆里的原词）：整句短语匹配必落空，靠停用词剥离/2-gram 兜底。
const natural = ['上次那个端口', '端口是多少', '记忆里的端口', '那个端口']
const natHit = natural.filter((x) => q(x, 5).results.some((r) => r.key === 'api-port'))
check('⑤b 自然问法 recall@5 = 4/4', natHit.length === 4, natural.map((x) => x + ':' + q(x, 5).results.length).join(' | '))
const nat = q('上次那个端口', 5)
check('⑤b 兜底结果不冒充精确命中',
  nat.mode !== 'fts-exact' && (nat.mode !== 'relaxed' || /端口/.test(nat.relaxedQuery ?? '')), nat.mode)

// 6) 延迟（本机、临时库；只作回归线，不作跨机器承诺）。
const times = []
for (let i = 0; i < 50; i++) {
  const t0 = performance.now()
  q(i % 2 ? '朱雀' + (i % 10) : '模块' + ((i % 10) * 17) + ' 配置项', 10)
  times.push(performance.now() - t0)
}
times.sort((a, b) => a - b)
const p50 = times[Math.floor(times.length * 0.5)]
const p95 = times[Math.floor(times.length * 0.95)]
check('⑥ p95 < 50ms（200 文档夹具）', p95 < 50, `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`)

s.close()
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
