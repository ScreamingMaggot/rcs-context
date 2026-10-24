// Phase 4：检索轨迹 —— 脱敏/上限、写入不产生事实、工具采集、只读 API 契约。
// 运行：node tests/memory-trace.test.mjs
import { mkdtempSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'rcs-trace-'))
const dbFile = join(root, 'trace.sqlite')
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = root
process.env.DSH_MEMORY_DB = dbFile
process.env.DSH_MEMORY_TRACE_DB = ''
process.env.DSH_MEMORY_TRACE = '1'
process.env.DSH_MEMORY_TRACE_SYNC = '1'

const { DatabaseSync } = await import('node:sqlite')
const mem = await import(pathToFileURL(join(HERE, '..', 'web', 'memory.mjs')).href)
const trace = await import(pathToFileURL(join(HERE, '..', 'web', 'memory-trace.mjs')).href)
const webui = (await import(pathToFileURL(join(HERE, '..', 'contextinjector-webui', 'lib', 'index.mjs')).href)).default
const read = await import(pathToFileURL(join(HERE, '..', 'contextinjector-webui', 'lib', 'trace-read.mjs')).href)
const { MemoryStore, makeMemoryTools } = mem

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const WS = 'D:/Proj/Trace'
const store = new MemoryStore(new DatabaseSync(dbFile), { stateDir: root, rawDir: join(root, 'raw') })
let seq = 0
for (let i = 0; i < 6; i++) {
  store.ingest({
    sid: 's1', seq: ++seq, kind: 'insight', key: 'port-' + i,
    value: { summary: `端口 8848 固定，配置项 ${i}。`, type: 'constraint' },
    scope: 'ws:' + WS, ts: 1000 + seq, source: { sid: 's1', seq }, fact_type: 'constraint',
  })
}
store.setMetaRaw('recallKeys:s1', '[]')

/* B1 脱敏与文本入口 ----------------------------------------------------- */
{
  const raw = 'password=abc123 C:\\Users\\me\\secret.txt test@example.com Bearer abc.def.ghi sk-ABCDEF1234567890'
  const once = trace.redactQuery(raw)
  const twice = trace.redactQuery(once)
  check('B1 密码/密钥/Bearer 被替换', /\[REDACTED\]/.test(once) && !once.includes('abc123') && !once.includes('sk-ABCDEF'), once)
  check('B1 路径/邮箱只留 hash', /<path:#[0-9a-f]{8}>/.test(once) && /<email:#[0-9a-f]{8}>/.test(once) && !once.includes('Users'), once)
  check('B1 脱敏幂等', once === twice, twice)
  check('B1 超长查询截到 240 字符', trace.redactQuery('字'.repeat(400)).length <= 240)
}

/* B2 行上限与截断位 ----------------------------------------------------- */
{
  const row = trace.buildTrace({
    sid: 's1', trigger: 'tool', query: 'q',
    steps: Array.from({ length: 30 }, (_, i) => ({ stage: 's' + i, n: i, ms: 1 })),
    candidates: Array.from({ length: 100 }, (_, i) => ({ uri: 'rcs://ws/w/insight/k' + i, kind: 'insight', rank: i + 1, score: i })),
    selected: Array.from({ length: 25 }, (_, i) => ({ uri: 'rcs://ws/w/insight/k' + i, kind: 'insight', rank: i + 1 })),
    candTotal: 100, selTotal: 25,
  })
  check('B2 候选 40 / 选中 20 / 步骤 16 上限',
    JSON.parse(row.candidates).length === 40 && JSON.parse(row.selected).length === 20 && JSON.parse(row.steps).length === 16,
    `${JSON.parse(row.candidates).length}/${JSON.parse(row.selected).length}/${JSON.parse(row.steps).length}`)
  check('B2 截断位记录候选/选中/步骤', (row.truncated & 1) && (row.truncated & 2) && (row.truncated & 4), row.truncated)
  check('B2 行不超过 16KB 且自审计 bytes', row.bytes <= 16384 && row.bytes > 0, row.bytes)
  check('B2 无 session / 未知 trigger 拒绝', trace.buildTrace({ trigger: 'tool' }) === null && trace.buildTrace({ sid: 's1', trigger: 'trace' }) === null)
}

/* B3 轨迹写入不产生事件/记录/FTS --------------------------------------- */
{
  const count = () => ({
    events: Number(store.db.prepare('SELECT COUNT(*) c FROM events').get()?.c),
    records: Number(store.db.prepare('SELECT COUNT(*) c FROM records').get()?.c),
    fts: Number(store.db.prepare('SELECT COUNT(*) c FROM records_fts').get()?.c),
  })
  const before = count()
  const row = trace.recordTrace(store, {
    sid: 's1', workspace: WS, trigger: 'recall', query: '端口 8848',
    steps: [{ stage: 'gate', n: 1, ms: 0 }],
    selected: [{ uri: 'rcs://ws/w/insight/port-0', kind: 'insight', rank: 1 }],
  })
  const after = count()
  check('B3 轨迹行已同步落盘', !!row && trace.listTraces(dbFile, { sid: 's1' }).traces.some((x) => x.trigger === 'recall'))
  check('B3 events/records/FTS 计数不变', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }))
}

/* B4 工具边界采集：search / ls ----------------------------------------- */
{
  const tools = Object.fromEntries(makeMemoryTools(store).map((t) => [t.name, t]))
  const exec = { agent: { session: { id: 's1', header: { cwd: WS } } } }
  await tools.memory_search.execute({ query: '8848', limit: 3 }, exec)
  const sr = trace.listTraces(dbFile, { sid: 's1', trigger: 'tool', limit: 10 })
  const hit = sr.traces.find((x) => x.preview.includes('8848'))
  check('B4 memory_search 写入 tool 轨迹', !!hit && hit.candTotal > 0 && hit.selTotal > 0, JSON.stringify(hit))
  const detail = trace.getTrace(dbFile, hit.id).trace
  check('B4 详情含步骤与候选→选中', detail.steps.length >= 1 && detail.candidates.length >= 1 && detail.selected.length >= 1 && detail.ref.startsWith('rcs-trace://'), JSON.stringify({ steps: detail.steps.length, cands: detail.candidates.length, sel: detail.selected.length }))

  await tools.memory_ls.execute({ uri: `rcs://ws/${mem.workspaceRootId(WS)}/insight/`, limit: 5 }, exec)
  const lr = trace.listTraces(dbFile, { sid: 's1', trigger: 'ls', limit: 10 })
  check('B4 memory_ls 写入 ls 轨迹', lr.traces.length >= 1 && lr.traces[0].mode === 'dir', JSON.stringify(lr.traces[0]))
}

/* B5 列表分页 / 导出哈希 / 清除单会话 -------------------------------- */
{
  // 直接补 recall/inject/handover，覆盖其余 trigger 词汇
  for (const trigger of ['recall', 'inject', 'handover']) {
    trace.recordTrace(store, { sid: 's1', workspace: WS, trigger, query: '', mode: trigger, steps: [{ stage: trigger, n: 1, ms: 0 }] })
  }
  trace.recordTrace(store, { sid: 's2', workspace: WS, trigger: 'tool', query: 'other', candidates: [{ uri: 'rcs://ws/w/insight/x', kind: 'insight', rank: 1 }] })
  const all = trace.listTraces(dbFile, { sid: 's1', limit: 2 })
  check('B5 列表按 (ts,id) 倒序并给出游标', all.traces.length === 2 && !!all.nextCursor && all.hasMore, JSON.stringify({ n: all.traces.length, next: all.nextCursor }))
  const cur = trace.listTraces(dbFile, { sid: 's1', limit: 2, cursor: trace.listTraces(dbFile, { sid: 's1', limit: 2 }).traces ? (() => { const m = /(\d+):(\d+)/.exec(all.nextCursor); return { ts: Number(m[1]), id: Number(m[2]) } })() : null })
  const ids1 = new Set(all.traces.map((x) => x.id))
  check('B5 游标翻页不重不漏', cur.traces.every((x) => !ids1.has(x.id)) && cur.traces.length > 0, JSON.stringify(cur.traces.map((x) => x.id)))
  trace.recordTrace(store, {
    sid: 's1', workspace: WS, trigger: 'tool', uri: `rcs://ws/${mem.workspaceRootId(WS)}/insight/port-0`,
    query: 'port', selected: [{ uri: `rcs://ws/${mem.workspaceRootId(WS)}/insight/port-0`, kind: 'insight', rank: 1 }],
  })
  const ex = trace.exportTraces(dbFile, { sid: 's1' })
  const exRow = ex.rows.find((x) => x.uri.includes('/insight/<key:'))
  check('B5 导出二次脱敏：sid/workspace/URI key 哈希', exRow && exRow.sid.startsWith('<sid:#') && exRow.workspace.startsWith('<ws:#') && /<key:#[0-9a-f]{8}>/.test(exRow.uri), JSON.stringify(exRow && { sid: exRow.sid, ws: exRow.workspace, uri: exRow.uri }))
  const c = trace.clearTraces(dbFile, 's2')
  check('B5 清除只删指定会话', c.ok && c.deleted === 1 && trace.listTraces(dbFile, { sid: 's2' }).traces.length === 0 && trace.listTraces(dbFile, { sid: 's1' }).traces.length > 0, JSON.stringify(c))
}

/* B6 WebUI 只读 API 契约 ----------------------------------------------- */
{
  const routes = []
  webui.apply({
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    effect: () => () => {},
  })
  const exact = routes.find((r) => r.kind === 'exact' && r.path === '/api/memory/traces')
  const prefix = routes.find((r) => r.kind === 'prefix' && r.path === '/api/memory/traces/')
  check('B6 路由已注册', !!exact && !!prefix)
  const call = (route, { method = 'GET', url, body = null, host = '127.0.0.1:3000' } = {}) => new Promise((resolve) => {
    const chunks = []
    const res = {
      code: null, headers: null, body: '',
      writeHead(code, headers) { this.code = code; this.headers = headers },
      end(b) { this.body = b === undefined ? '' : String(b); resolve(this) },
    }
    const req = body == null
      ? { method, url, headers: { host, origin: 'http://localhost:3000' }, on() {} }
      : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method, url, headers: { host, origin: 'http://localhost:3000' } })
    route.handler(req, res)
  })
  const l1 = await call(exact, { url: '/api/memory/traces?sessionId=s1&limit=2' })
  const j1 = JSON.parse(l1.body)
  check('B6 列表 200 + 游标', l1.code === 200 && j1.ok && j1.traces.length === 2 && !!j1.nextCursor, l1.body.slice(0, 120))
  const l2 = await call(exact, { url: '/api/memory/traces' })
  check('B6 缺 sessionId → 400', l2.code === 400 && JSON.parse(l2.body).error === 'missing-sessionId', l2.body)
  const l3 = await call(exact, { url: '/api/memory/traces?sessionId=s1&trigger=nope' })
  check('B6 非法 trigger → 400', l3.code === 400 && JSON.parse(l3.body).error === 'bad-trigger', l3.body)
  const l4 = await call(exact, { url: '/api/memory/traces?sessionId=s1', host: 'evil.example.com' })
  check('B6 非本机来源 → 403', l4.code === 403, l4.body)
  const id = j1.traces[0].id
  const d1 = await call(prefix, { url: `/api/memory/traces/${id}` })
  check('B6 详情 200 且含回放字段', d1.code === 200 && JSON.parse(d1.body).trace.id === id && Array.isArray(JSON.parse(d1.body).trace.steps), d1.body.slice(0, 120))
  const d2 = await call(prefix, { url: '/api/memory/traces/99999999' })
  check('B6 详情不存在 → 404', d2.code === 404, d2.body)
  const e1 = await call(prefix, { url: '/api/memory/traces/export?sessionId=s1&format=jsonl' })
  const lines = e1.body.trim().split('\n').filter(Boolean).map((x) => JSON.parse(x))
  check('B6 导出 jsonl + 附件头', e1.code === 200 && /attachment/.test(e1.headers['content-disposition'] || '') && lines.length >= 1 && lines.every((x) => x.sid.startsWith('<sid:#')), e1.body.slice(0, 100))
  const c1 = await call(prefix, { url: '/api/memory/traces/clear', method: 'POST', body: { sessionId: 's1' } })
  const cj = JSON.parse(c1.body)
  check('B6 清除 200 且删除本会话', c1.code === 200 && cj.ok && cj.deleted > 0 && trace.listTraces(dbFile, { sid: 's1' }).traces.length === 0, c1.body)
}

store.close()
console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
process.exitCode = fails ? 1 : 0
