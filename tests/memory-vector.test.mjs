// Phase 3：语义臂（默认关）—— 确定性、语义召回、失败开放、拒答与队列幂等。
// 运行：node tests/memory-vector.test.mjs
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'rcs-vec-'))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = root
process.env.DSH_MEMORY_VEC = ''
process.env.DSH_MEMORY_EMBED_MODEL = ''
process.env.DSH_MEMORY_EMBED_URL = ''

const { DatabaseSync } = await import('node:sqlite')
const mem = await import(pathToFileURL(join(HERE, '..', 'web', 'memory.mjs')).href)
const vec = await import(pathToFileURL(join(HERE, '..', 'web', 'memory-vec.mjs')).href)
const { MemoryStore } = mem

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const e = (i, dim = 8) => {
  const a = new Array(dim).fill(0)
  a[i] = 1
  return a
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const rowids = (r) => (r.results || []).map((x) => Number(x.rowid))

const WS = 'd:/proj/vector'
const store = new MemoryStore(new DatabaseSync(join(root, 'vec.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
let seq = 0
const put = (kind, key, value, scope = 'ws:' + WS) => store.ingest({
  sid: 's1', seq: ++seq, kind, key, value, scope, ts: 5000 + seq,
  source: { sid: 's1', seq }, ...(kind === 'insight' ? { fact_type: value?.type } : {}),
})
const rec = (kind, key, status = 'active') => store.get({ sid: 's1', scope: 'project', workspace: WS, kind, key, status })

const deploy = put('insight', 'deploy', { summary: '部署脚本统一放在 scripts 目录，必须使用绝对路径。', type: 'constraint' })
const database = put('insight', 'database', { summary: '数据库连接池上限为三十二，超过会排队。', type: 'state' })
const command = put('command', 'cmd:ls', { cmd: 'ls -la', action: 'shell' })
const stale = put('insight', 'stale', { summary: '旧的账本审计流程已经废弃。', type: 'state' })
const noise = put('insight', 'noise', { summary: '季度预算评审安排在周五下午。', type: 'state' })
for (const [i, k] of [['alpha', 'a'], ['beta', 'b'], ['gamma', 'c'], ['delta', 'd']]) {
  put('insight', 'port-' + k, { summary: `端口 8848 保持不变（${k}）。`, type: 'constraint' })
}
const id = (key, kind = 'insight') => Number(rec(kind, key)?.rowid)
const upsertVec = (key, arr, model = 'test-model', kind = 'insight') =>
  store.vecUpsert(id(key, kind), model, arr, { text: key, key })

upsertVec('deploy', e(0))
upsertVec('database', e(1))
upsertVec('cmd:ls', e(2), 'test-model', 'command')
upsertVec('stale', e(2))
upsertVec('noise', e(7))
upsertVec('port-a', e(3))
upsertVec('port-b', e(4))
upsertVec('port-c', e(5))
upsertVec('port-d', e(6))
const search = (opts) => store.search({ sid: 's1', workspace: WS, scope: 'project', ...opts })

/* A 确定性 ------------------------------------------------------------- */
{
  const runs = []
  for (let i = 0; i < 5; i++) runs.push(rowids(search({ query: '发布流程', embedding: e(0), vecModel: 'test-model', limit: 5 })))
  check('A 同输入 5 次排序完全一致', runs.every((x) => eq(x, runs[0])), JSON.stringify(runs[0]))
}

/* B 语义召回（词法零重叠） -------------------------------------------- */
{
  const lex = search({ query: '发布流程', limit: 5 })
  const hyb = search({ query: '发布流程', embedding: e(0), vecModel: 'test-model', limit: 5 })
  check('B 词法对此改写无命中', lex.results.length === 0, lex.mode)
  check('B 语义臂召回目标记录', hyb.results[0]?.key === 'deploy', JSON.stringify(rowids(hyb)))
  check('B 返回 vec 元数据且 mode 仍是词法层', hyb.vec?.arms?.includes('vec') && hyb.mode === lex.mode && hyb.vec.model === 'test-model', JSON.stringify(hyb.vec))
}

/* C 扩展/模型缺失、维度不符时逐位退回词法 ------------------------------ */
{
  const base = search({ query: '端口 8848', limit: 5 })
  const noEmb = search({ query: '端口 8848', limit: 5, embedding: undefined })
  const modelMissing = search({ query: '端口 8848', limit: 5, embedding: e(0), vecModel: '' })
  const dimMismatch = search({ query: '端口 8848', limit: 5, embedding: e(0, 4), vecModel: 'test-model' })
  check('C 无 embedding 与词法逐位相同', eq(rowids(base), rowids(noEmb)) && !('vec' in noEmb))
  check('C model-missing 逐位退回词法', eq(rowids(base), rowids(modelMissing)) && modelMissing.vec?.skipped === 'model-missing', JSON.stringify(modelMissing.vec))
  check('C dim-mismatch 不产生候选且逐位退回词法', eq(rowids(base), rowids(dimMismatch)) && (dimMismatch.vec?.k ?? 0) === 0, JSON.stringify(dimMismatch.vec))
}

/* D 无答案拒答 --------------------------------------------------------- */
{
  const q = new Array(9).fill(0)
  q[8] = 1 // 9 维与库内 8 维不匹配 ⇒ 语义臂无候选；查询本身也词法无命中
  const r2 = store.search({ sid: 's1', workspace: WS, scope: 'project', query: 'quantum banana', embedding: q, vecModel: 'test-model', limit: 5 })
  check('D 两臂均无候选 → 空结果且标注 no-answer', r2.results.length === 0 && r2.vec?.reason === 'no-answer', JSON.stringify(r2.vec))
}

/* E 混合不退化：词法 top-3 仍在混合 top-5 ------------------------------- */
{
  const lex = search({ query: '8848', limit: 5 })
  const hyb = search({ query: '8848', embedding: e(7), vecModel: 'test-model', limit: 5 })
  const top3 = rowids(lex).slice(0, 3)
  const top5 = rowids(hyb)
  check('E 词法有三条以上命中', top3.length === 3, `${top3.length}`)
  check('E 词法 top-3 全部保留在混合 top-5', top3.every((x) => top5.includes(x)), JSON.stringify({ top3, top5 }))
  check('E 融合只补充候选，不改写词法 mode', hyb.mode === lex.mode, `${lex.mode} -> ${hyb.mode}`)
}

/* F insight 先验（同分/同 cos 时 insight 在前） --------------------------- */
{
  const fused = vec.fuseRRF([], [
    { record_id: 2, cos: 0.9, rec: { rowid: 2, kind: 'command', updated_ts: 1 } },
    { record_id: 1, cos: 0.9, rec: { rowid: 1, kind: 'insight', updated_ts: 1 } },
  ], { limit: 2 })
  check('F 同分时 insight 排在 command 前', fused.items[0]?.rec?.kind === 'insight', JSON.stringify(fused.items.map((x) => x.rec.kind)))
}

/* G 模型/维度迁移：查询只读当前模型的向量，records 不变 ------------------ */
{
  put('insight', 'model-a', { summary: '原子加速器的冷却参数仍需复核。', type: 'state' })
  put('insight', 'model-b', { summary: '原子加速器的磁场标定记录。', type: 'state' })
  store.vecUpsert(id('model-a'), 'model-a', e(0), { text: 'model-a' })
  store.vecUpsert(id('model-b'), 'model-b', e(0), { text: 'model-b' })
  const before = Number(store.db.prepare('SELECT COUNT(*) c FROM records').get()?.c)
  const ra = search({ query: 'atom smasher', embedding: e(0), vecModel: 'model-a', limit: 5 })
  const rb = search({ query: 'atom smasher', embedding: e(0), vecModel: 'model-b', limit: 5 })
  const after = Number(store.db.prepare('SELECT COUNT(*) c FROM records').get()?.c)
  check('G model-a 只返回 A 的向量', ra.results.some((x) => x.key === 'model-a') && !ra.results.some((x) => x.key === 'model-b'), JSON.stringify(ra.results.map((x) => x.key)))
  check('G model-b 只返回 B 的向量', rb.results.some((x) => x.key === 'model-b') && !rb.results.some((x) => x.key === 'model-a'), JSON.stringify(rb.results.map((x) => x.key)))
  check('G 迁移不改 records 行数', before === after, `${before}/${after}`)
}

/* H 逻辑删除：active 不返回，status=all 仍返回；孤儿向量可回收 ---------- */
{
  const sid = id('stale')
  const qv = e(2)
  const before = search({ query: 'ledger audit', embedding: qv, vecModel: 'test-model', limit: 5 })
  store.setStatus(sid, 'superseded')
  const active = search({ query: 'ledger audit', embedding: qv, vecModel: 'test-model', limit: 5 })
  const all = search({ query: 'ledger audit', embedding: qv, vecModel: 'test-model', status: 'all', limit: 5 })
  check('H 失效前语义可召回', before.results.some((x) => x.rowid === sid), JSON.stringify(before.results.map((x) => x.key)))
  check('H superseded 后 active 不返回', !active.results.some((x) => x.rowid === sid), JSON.stringify(active.results.map((x) => x.key)))
  check('H status=all 仍返回历史证据', all.results.some((x) => x.rowid === sid), JSON.stringify(all.results.map((x) => x.key)))
  store.vecUpsert(999999, 'test-model', e(0), { text: 'orphan' })
  const gc = store.gcVectors()
  const left = Number(store.db.prepare('SELECT COUNT(*) c FROM record_vectors WHERE record_id=999999').get()?.c ?? -1)
  check('H 孤儿向量被 GC 清掉', gc >= 1 && left === 0, `gc=${gc} left=${left}`)
}

/* I 队列幂等 + drain（本地假 embedder，零外网） -------------------------- */
{
  let calls = 0
  let lastBody = null
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls++
      lastBody = body
      const { input } = JSON.parse(body || '{}')
      const texts = Array.isArray(input) ? input : [input]
      const embeddings = texts.map((t) => {
        if (String(t).includes('slow')) return e(0)
        return vec.vecNormalize(e(1))
      }).map((v) => Array.from(v))
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ embeddings }))
      }, String(texts[0] ?? '').includes('slow') ? 200 : 2)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  process.env.DSH_MEMORY_EMBED_URL = `http://127.0.0.1:${port}`
  store.setMetaRaw('vec:enabled', 'on')
  store.setMetaRaw('vec:model', 'queue-model')
  store.setMetaRaw('vec:state', 'ok')

  const recObj = {
    sid: 's1', seq: ++seq, kind: 'insight', key: 'queued', scope: 'ws:' + WS, ts: 6000 + seq,
    value: { summary: '队列幂等测试：只需要嵌入一次。', type: 'state' },
    source: { sid: 's1', seq }, fact_type: 'state',
  }
  store.ingest(recObj)
  const pending1 = Number(store.db.prepare('SELECT COUNT(*) c FROM vec_queue').get()?.c)
  const d1 = await store.drainVecQueue({ limit: 8 })
  const pending2 = Number(store.db.prepare('SELECT COUNT(*) c FROM vec_queue').get()?.c)
  check('I ingest 入队一次并 drain 一条', pending1 === 1 && d1.ok && d1.embedded === 1 && pending2 === 0 && calls === 1, JSON.stringify({ pending1, d1, pending2, calls }))
  check('I embedding 请求带上模型名', JSON.parse(lastBody).model === 'queue-model', lastBody)

  const again = store.ingest(recObj)
  const d2 = await store.drainVecQueue({ limit: 8 })
  check('I 同一事件重复 ingest 不重复入队', again === false && d2.embedded === 0 && calls === 1, JSON.stringify({ again, d2, calls }))

  const qrow = Number(store.db.prepare("SELECT rowid FROM records WHERE key='queued'").get()?.rowid)
  store._vecEnqueue(qrow, 'insight')
  const d3 = await store.drainVecQueue({ limit: 8 })
  check('I 同文本 hash 命中时跳过 embed 调用', d3.ok && d3.embedded === 0 && d3.skipped === 1 && calls === 1, JSON.stringify({ d3, calls }))

  // 超时 → degraded，队列保留，下一次可用（失败开放）
  store.ingest({
    sid: 's1', seq: ++seq, kind: 'insight', key: 'slow-one', scope: 'ws:' + WS, ts: 7000 + seq,
    value: { summary: 'slow embedding case', type: 'state' }, source: { sid: 's1', seq }, fact_type: 'state',
  })
  const d4 = await store.drainVecQueue({ limit: 1, timeoutMs: 30 })
  const stateAfter = store.getMetaRaw('vec:state')
  const pending4 = Number(store.db.prepare('SELECT COUNT(*) c FROM vec_queue').get()?.c)
  check('I 超时失败开放并保持 degraded', d4.ok === false && d4.error === 'timeout' && stateAfter === 'degraded' && pending4 === 1, JSON.stringify({ d4, stateAfter, pending4 }))
  store.setMetaRaw('vec:state', 'ok')

  const remote = await vec.embedBatch({ url: 'http://10.0.0.5:11434', model: 'x', texts: ['a'] })
  check('I 非本机地址默认拒绝（文本不出机器）', remote.ok === false && remote.error === 'remote-not-allowed', JSON.stringify(remote))

  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}
{
  let calls = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ embeddings: [Array.from(vec.vecNormalize(e(0)))] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.DSH_MEMORY_EMBED_URL = `http://127.0.0.1:${server.address().port}`
  store.setMetaRaw('vec:enabled', 'on')
  store.setMetaRaw('vec:model', 'test-model')
  store.setMetaRaw('vec:state', 'ok')
  const r = await store.searchAsync({ sid: 's1', workspace: WS, scope: 'project', query: '发布流程', limit: 3 })
  check('J searchAsync 自动 embedding 并融合', r.vec?.state === 'ok' && r.vec?.arms?.includes('vec') && r.results[0]?.key === 'deploy', JSON.stringify(r.vec))
  check('J 每次检索最多一次 embed 请求', calls === 1, `calls=${calls}`)
  store.setMetaRaw('vec:enabled', 'off')
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

store.close()
console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
process.exitCode = fails ? 1 : 0
