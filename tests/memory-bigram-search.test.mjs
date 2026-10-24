// CJK 2-gram bm25 检索：自然问法要能压过“新但无关”的文档，摘要权重要高于正文。
// 运行：node tests/memory-bigram-search.test.mjs
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

const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'rcs-bi-'))
  return new MemoryStore(new DatabaseSync(join(root, 'bi.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
}
const ws = 'c:/proj/bi'
const ingest = (s, key, value, seq, ts) => s.ingest({
  sid: 's1', seq, kind: 'insight', key, scope: 'ws:' + ws,
  value, source: { sid: 's1', seq }, ...(ts ? { ts } : {}),
})

// ① 自然问法：三条大实话分散在句子里，整句短语匹配必然落空；旧排序会输给更新的短文档。
{
  const s = mk()
  ingest(s, 'three-gold', {
    summary: 'three.js 模型缩小后位置偏移：父组缩放不改变自身 position，模型会离桌子 30m，状态条却仍正常。',
    confidence: 0.95,
  }, 1, 1000)
  ingest(s, 'three-noise', { summary: 'three.js 场景加载与资源管理。', confidence: 0.95 }, 2, Date.now())
  const r = s.search({ sid: 's1', scope: 'project', workspace: ws, query: 'three.js 模型缩小后位置偏了，离桌子很远', limit: 5 })
  check('① 自然问法命中 gold 第 1', r.results[0]?.key === 'three-gold', r.results.map((x) => x.key).join(','))
  check('① 自然问法模式为 bigram', r.mode === 'bigram', r.mode)
}

// ② 摘要权重：正文把关键词重复很多遍的文档，不能压过摘要就是答案的文档。
{
  const s = mk()
  ingest(s, 'log-gold', { summary: '日志轮转阈值：512MB 就切分。', confidence: 0.9 }, 1, 1000)
  ingest(s, 'log-noise', {
    summary: '构建脚本的杂项说明。',
    body: '日志轮转阈值，日志轮转阈值，日志轮转阈值，日志轮转阈值，日志轮转阈值，日志轮转阈值。'.repeat(10),
    confidence: 0.9,
  }, 2, Date.now())
  const r = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '日志轮转阈值', limit: 5 })
  check('② 摘要命中排第 1', r.results[0]?.key === 'log-gold', r.results.map((x) => x.key).join(','))
  check('② 摘要权重在 bigram 通道生效', r.mode === 'bigram', r.mode)
}

// ③ 更新后 bigram 索引跟着刷新（旧值残留在索引里会继续命中）。
{
  const s = mk()
  ingest(s, 'canary', { summary: '灰度发布先放 5% 流量。', confidence: 0.8 }, 1)
  ingest(s, 'canary', { summary: '灰度发布先放 20% 流量。', confidence: 0.8 }, 2)
  const rOld = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '百分之五', limit: 5 })
  const rNew = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '灰度发布 20%', limit: 5 })
  check('③ 旧值不再命中', !rOld.results.some((x) => x.key === 'canary'), rOld.results.map((x) => x.key).join(','))
  check('③ 新值能搜到', rNew.results[0]?.key === 'canary', rNew.results.map((x) => x.key).join(','))
  let bi = null
  try { bi = s.db.prepare('SELECT COUNT(*) c FROM records_fts_bi').get() } catch { /* 表还没实现 */ }
  check('③ bigram 索引与记录数一致', Number(bi?.c) === 1, bi?.c)
}

// ④ ASCII 查询：bigram 索引不能把英文/数字查询弄丢。
{
  const s = mk()
  ingest(s, 'api-port', { summary: 'API port 8848 is fixed.', confidence: 0.9 }, 1)
  ingest(s, 'other', { summary: '无关的构建说明。', confidence: 0.9 }, 2)
  const r = s.search({ sid: 's1', scope: 'project', workspace: ws, query: 'port 8848', limit: 5 })
  check('④ ASCII 查询命中', r.results[0]?.key === 'api-port', r.results.map((x) => x.key).join(','))
}

// ⑤ 单字/极短查询不炸：仍应返回结果或空数组，而不是抛错。
{
  const s = mk()
  ingest(s, 'short', { summary: '端口固定为 8848。', confidence: 0.9 }, 1)
  let ok = true
  try {
    const r1 = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '端口', limit: 5 })
    const r2 = s.search({ sid: 's1', scope: 'project', workspace: ws, query: 'x', limit: 5 })
    ok = Array.isArray(r1.results) && Array.isArray(r2.results) && r1.results[0]?.key === 'short'
  } catch (e) {
    ok = false
    console.log('ERR', e?.message)
  }
  check('⑤ 短查询稳定', ok)
}

// ⑥ 英文虚词不该被当成“缺失标识符”把整个查询判空（只硬拦带数字/符号的代号）。
{
  const s = mk()
  ingest(s, 'en', { summary: 'API port 8848 is fixed.', confidence: 0.9 }, 1)
  const r = s.search({ sid: 's1', scope: 'project', workspace: ws, query: 'what is the port', limit: 5 })
  check('⑥ 英文虚词不误判空', r.results[0]?.key === 'en', r.mode + ':' + r.results.map((x) => x.key).join(','))
}

// ⑦ 只共享一个常见 bigram 的“不存在的问题”不硬凑结果。
{
  const s = mk()
  ingest(s, 'temp', { summary: '温度记录：25 度。', confidence: 0.9 }, 1)
  const r = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '冷藏库温度设定值', limit: 5 })
  check('⑦ 单个弱命中不硬凑', r.results.length === 0, r.mode + ':' + r.results.length)
}

// ⑧ 纯功能 bigram（能用/用来）不算证据。
{
  const s = mk()
  ingest(s, 'tool', { summary: '这个工具能用来压缩文件。', confidence: 0.9 }, 1)
  const r = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '量子纠缠能不能用来煮咖啡', limit: 5 })
  check('⑧ 功能 bigram 不硬凑', r.results.length === 0, r.mode + ':' + r.results.length)
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
