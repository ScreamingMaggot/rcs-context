// Phase 5.0：同步存储优化 —— ingest 事务、补课分片、状态聚合索引与连接 PRAGMA。
// 运行：node tests/memory-storage.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'rcs-storage-'))
const dbFile = join(root, 'storage.sqlite')
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = root
process.env.DSH_MEMORY_DB = dbFile
process.env.DSH_MEMORY_TRACE = '0'

const { DatabaseSync } = await import('node:sqlite')
const mem = await import(pathToFileURL(join(HERE, '..', 'web', 'memory.mjs')).href)
const webui = (await import(pathToFileURL(join(HERE, '..', 'contextinjector-webui', 'lib', 'index.mjs')).href)).default
const { MemoryStore, MemoryIngestor, allEvents } = mem

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const WS = 'D:/Proj/Storage'
const store = new MemoryStore(new DatabaseSync(dbFile), { stateDir: root, rawDir: join(root, 'raw') })
const counts = () => ({
  events: Number(store.db.prepare('SELECT COUNT(*) c FROM events').get()?.c),
  records: Number(store.db.prepare('SELECT COUNT(*) c FROM records').get()?.c),
  fts: Number(store.db.prepare('SELECT COUNT(*) c FROM records_fts').get()?.c),
})
let seq = 0
const put = (kind, key, value, extra = {}) => store.ingest({
  sid: 's1', seq: ++seq, kind, key, value, scope: 'ws:' + WS, ts: 1000 + seq,
  source: { sid: 's1', seq }, ...extra,
})
put('insight', 'a', { summary: '端口固定 8848。', type: 'constraint' }, { fact_type: 'constraint' })
put('insight', 'b', { summary: '部署目录是 scripts。', type: 'state' }, { fact_type: 'state' })
put('error', 'e1', { action: 'read', target: 'x', err: 'ENOENT' })
put('command', 'c1', { cmd: 'echo hi', action: 'shell' })
const resolved = put('error', 'e2', { action: 'read', target: 'y', err: 'EACCES' })
const rec = store.get({ sid: 's1', scope: 'project', workspace: WS, kind: 'error', key: 'e2' })
store.setStatus(rec.rowid, 'resolved')
const stale = store.get({ sid: 's1', scope: 'project', workspace: WS, kind: 'insight', key: 'b' })
store.setStatus(stale.rowid, 'superseded')

/* S1 连接 PRAGMA 与索引 ------------------------------------------------- */
{
  const pragma = (name) => store.db.prepare('PRAGMA ' + name).get()
  const sync = Number(pragma('synchronous')?.synchronous)
  const cache = Number(pragma('cache_size')?.cache_size)
  const busy = Number(pragma('busy_timeout')?.timeout ?? pragma('busy_timeout')?.busy_timeout)
  check('S1 synchronous=NORMAL 在每个连接上生效', sync === 1, sync)
  check('S1 cache_size=-65536（64MB）', cache === -65536, cache)
  check('S1 busy_timeout=5000', busy === 5000, busy)
  const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='records'").all().map((r) => r.name)
  check('S1 状态轮询索引已建', indexes.includes('idx_records_status_ts') && indexes.includes('idx_records_kind_status_ts'), indexes.join(','))
  check('S1 索引版本已记录', store.getMetaRaw('schemaIndexV') === '1', store.getMetaRaw('schemaIndexV'))
}

/* S2 ingest 自包事务：重复幂等 + 失败整条回滚 --------------------------- */
{
  const before = counts()
  const again = store.ingest({
    sid: 's1', seq: 1, kind: 'insight', key: 'a', scope: 'ws:' + WS, ts: 1001,
    value: { summary: '端口固定 8848。', type: 'constraint' }, source: { sid: 's1', seq: 1 }, fact_type: 'constraint',
  })
  check('S2 重复事件返回 false 且不新增行', again === false && JSON.stringify(counts()) === JSON.stringify(before), JSON.stringify({ again, counts: counts() }))
  check('S2 事务外 isTransaction=false', store.db.isTransaction === false)

  const beforeFail = counts()
  const orig = store.q.upsert
  store.q.upsert = { run() { throw new Error('injected-upsert-failure') } }
  let threw = false
  try {
    store.ingest({
      sid: 's1', seq: 999999, kind: 'insight', key: 'rollback', value: { summary: '这条不应留下', type: 'state' },
      scope: 'ws:' + WS, ts: 999999, source: { sid: 's1', seq: 999999 }, fact_type: 'state',
    })
  } catch { threw = true }
  store.q.upsert = orig
  const after = counts()
  const leaked = store.db.prepare("SELECT COUNT(*) c FROM events WHERE key='rollback'").get()
  check('S2 中途失败整条回滚（event 也不留）', threw && JSON.stringify(after) === JSON.stringify(beforeFail) && Number(leaked?.c) === 0, JSON.stringify({ threw, beforeFail, after, leaked }))
  check('S2 回滚后连接可继续写', store.db.isTransaction === false && put('insight', 'after-rollback', { summary: '回滚后仍可写。', type: 'state' }, { fact_type: 'state' }) === true)
}

/* S3 补课分片：同步 50/片、异步 25/片且让出事件循环 --------------------- */
{
  const events = Array.from({ length: 200 }, (_, i) => ({
    type: 'tool/call', seq: i + 1, t: 2000 + i, session: { id: 'catchup' },
    data: { callId: 'c' + i, name: 'read', arguments: { path: 'x' } },
  }))
  const session = { id: 'catchup', header: { cwd: 'D:/Proj/CatchUp' }, ownEvents: () => events }
  const ing = new MemoryIngestor(store)
  const t0 = performance.now()
  const r = ing.ingestSession(session, 'catchup', { chunkSize: 50 })
  const ms = performance.now() - t0
  const again = ing.ingestSession(session, 'catchup', { chunkSize: 50 })
  check('S3 200 事件分 4 片处理完', r.processed === 200 && r.chunks === 4 && r.cursor === 200, JSON.stringify(r))
  check('S3 分片事务不破坏幂等（重放 0 条）', again.processed === 0 && again.cursor === 200, JSON.stringify(again))
  check('S3 同步补课已明显低于旧 751ms', ms < 400, `${ms.toFixed(1)}ms`)

  const events2 = Array.from({ length: 2000 }, (_, i) => ({
    type: 'tool/call', seq: i + 1, t: 3000 + i, session: { id: 'catchup2' },
    data: { callId: 'd' + i, name: 'read', arguments: {} },
  }))
  const session2 = { id: 'catchup2', header: { cwd: 'D:/Proj/CatchUp2' }, ownEvents: () => events2 }
  const t1 = performance.now()
  const asyncResult = await ing.ingestSessionAsync(session2, 'catchup2', { chunkSize: 25 })
  const asyncMs = performance.now() - t1
  check('S3 异步补课 2000 事件完成且游标到顶', asyncResult.processed === 2000 && asyncResult.cursor === 2000 && asyncResult.chunks === 80, JSON.stringify({ ...asyncResult, ms: asyncMs.toFixed(1) }))
  check('S3 异步补课不长时间独占事件循环', asyncMs < 1500, `${asyncMs.toFixed(1)}ms`)
}

/* S4 WebUI 状态聚合：一次 GROUP BY 与逐条口径一致 ----------------------- */
{
  const routes = []
  webui.apply({ webServer: { register: (r) => { routes.push(r); return () => {} } }, effect: () => () => {} })
  const route = routes.find((r) => r.kind === 'exact' && r.path === '/api/memory/status')
  const res = await new Promise((resolve) => {
    const out = {
      code: null, body: '',
      writeHead(code) { this.code = code },
      end(b) { this.body = String(b ?? ''); resolve(this) },
    }
    route.handler({ method: 'GET', url: '/api/memory/status', headers: { host: '127.0.0.1:3000' } }, out)
  })
  const snap = JSON.parse(res.body)
  const direct = store.db.prepare("SELECT kind, status, COUNT(*) n FROM records GROUP BY kind, status").all()
  const expect = { active: 0, resolved: 0, insights: 0, errors: 0 }
  const kinds = new Map()
  for (const r of direct) {
    if (r.status === 'active') {
      expect.active += Number(r.n)
      if (r.kind === 'insight') expect.insights += Number(r.n)
      if (r.kind === 'error') expect.errors += Number(r.n)
      kinds.set(r.kind, Number(r.n))
    } else if (r.status === 'resolved') expect.resolved += Number(r.n)
  }
  const got = Object.fromEntries(snap.kinds.map((x) => [x.kind, x.n]))
  const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))))
  check('S4 totals 与直接 SQL 一致', res.code === 200 && snap.totals.active === expect.active && snap.totals.resolved === expect.resolved && snap.totals.insights === expect.insights && snap.totals.errors === expect.errors, JSON.stringify({ got: snap.totals, expect }))
  check('S4 kinds 与直接 SQL 一致', sorted(got) === sorted(Object.fromEntries(kinds)), JSON.stringify({ got, kinds: Object.fromEntries(kinds) }))
  const superseded = store.db.prepare("SELECT COUNT(*) c FROM records WHERE kind='insight' AND status='superseded'").get()
  check('S4 superseded insight 不计入 active（b 已失效）', Number(superseded?.c) === 1 && got.insight === expect.insights, JSON.stringify({ superseded, got: got.insight, expect: expect.insights }))
}

store.close()
console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
process.exitCode = fails ? 1 : 0
