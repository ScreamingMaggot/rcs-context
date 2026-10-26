// 记忆面板的“会话 / 工作区”维度：标签、当前标记、范围筛选。
// 运行：node tests/memory-webui-scope.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = mkdtempSync(join(tmpdir(), 'rcs-webui-scope-'))
const state = join(root, 'state')
mkdirSync(state, { recursive: true })
mkdirSync(join(root, 'sessions'), { recursive: true })
mkdirSync(join(root, 'storages', 'session_projcache', 'sessions'), { recursive: true })
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = state
process.env.DSH_MEMORY_DB = join(root, 'memory.sqlite')
writeFileSync(join(state, 'control.json'), JSON.stringify({ memoryEnabled: true }), 'utf8')

writeFileSync(join(root, 'storages', 'workspace.json'), JSON.stringify({
  tables: {
    workspaces: {
      wa: { path: 'C:\\Work\\Alpha', title: 'Alpha', sessionIds: ['session-s1'] },
      wb: { path: 'C:\\Work\\Beta', title: 'Beta', sessionIds: ['session-s2'] },
    },
  },
  global: {},
}), 'utf8')
writeFileSync(join(root, 'storages', 'session_projcache', 'sessions', 'session-s1.json'), JSON.stringify({
  record: {
    identity: { cwd: 'C:\\Work\\Alpha' },
    rows: {
      title: { val: 'Alpha 任务' },
      workingDirectory: { val: 'C:\\Work\\Alpha' },
    },
  },
}), 'utf8')

const { MemoryStore } = await import(pathToFileURL('D:/RCS/src/web/memory.mjs').href)
const store = new MemoryStore(new DatabaseSync(join(root, 'memory.sqlite')), { stateDir: state, rawDir: join(root, 'raw') })
const put = (sid, seq, kind, key, scope, value) => store.ingest({
  sid, seq, kind, key, scope, value, source: { sid, seq },
})
put('s1', 1, 'insight', 'alpha-fact', 'ws:c:/work/alpha', { summary: 'Alpha 的端口是 8848', confidence: 0.9, type: 'constraint' })
put('s1', 2, 'command', 'cmd:alpha', 'ws:c:/work/alpha', { action: 'pwsh', cmd: 'npm test', status: 'OK' })
put('s2', 3, 'insight', 'beta-fact', 'ws:c:/work/beta', { summary: 'Beta 的目录是 docs', confidence: 0.9, type: 'state' })
put('s1', 4, 'user_turn', 'turn:4', 'sess:s1', { text: 'Alpha 私有轮次' })
put('s2', 5, 'user_turn', 'turn:5', 'sess:s2', { text: 'Beta 私有轮次' })
// alpha-fact 挂上真实事件证据 + reset/probe 引用，供 /api/memory/evidence 回查。
const evId = store.db.prepare("SELECT id FROM events WHERE key='cmd:alpha'").get().id
store.db.prepare("UPDATE records SET value=? WHERE scope=? AND kind='insight' AND key=?").run(
  JSON.stringify({ summary: 'Alpha 的端口是 8848', confidence: 0.9, type: 'constraint', evidence: [evId, 'r:9', 'f:0'] }),
  'ws:c:/work/alpha', 'alpha-fact')
// beta-fact 设为 100 天前，用于时间窗过滤测试；总数/最近记录不受影响。
store.db.prepare("UPDATE records SET updated_ts=? WHERE scope=? AND kind='insight' AND key=?").run(
  Date.now() - 100 * 86400000, 'ws:c:/work/beta', 'beta-fact')
// armedPid 被同进程的另一实例清 0 是已知现象；面板应以新鲜心跳判活。
store.setMetaRaw('armedPid', '0')
store.setMetaRaw('armedAt', String(Date.now()))
store.close()

const mod = await import(pathToFileURL('D:/RCS/src/contextinjector-webui/lib/index.mjs').href)
const routes = []
mod.default.apply({
  webServer: { register(h) { routes.push(h); return () => {} } },
  effect(fn) { fn() },
})
const statusRoute = routes.find((r) => r.path === '/api/memory/status')
const evidenceRoute = routes.find((r) => r.path === '/api/memory/evidence')
const graphRoute = routes.find((r) => r.path === '/api/memory/graph')
const configRoute = routes.find((r) => r.path === '/api/memory/config')
const janitorRoute = routes.find((r) => r.path === '/api/memory/janitor')
const call = (route, url) => new Promise((resolve) => {
  const req = Readable.from([])
  req.method = 'GET'; req.url = url; req.headers = { host: '127.0.0.1:8080' }
  const res = {
    code: 0,
    writeHead(c) { this.code = c },
    end(buf) { resolve({ code: this.code, body: JSON.parse(String(buf)) }) },
  }
  route.handler(req, res)
})
const get = (url) => call(statusRoute, url)
const getGraph = (url) => call(graphRoute, url)

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const keys = (xs) => (xs || []).map((x) => x.key)

// ① 有会话时默认 current：当前工作区 + 本会话私有，且带可读标签。
{
  const s = (await get('/api/memory/status?sessionId=session-s1')).body
  check('① 默认 range=current', s.range === 'current' && s.rangeEffective === 'current', JSON.stringify({ r: s.range, e: s.rangeEffective }))
  check('① armedPid=0 但心跳新鲜仍算运行中', s.armed === true, JSON.stringify({ armed: s.armed }))
  check('① current 工作区名/计数', s.current?.workspace?.title === 'Alpha'
    && s.current.workspace.records === 2 && s.current.workspace.insights === 1, JSON.stringify(s.current?.workspace))
  check('① current 会话标题/私有计数', s.current?.session?.title === 'Alpha 任务'
    && s.current.session.records === 1 && s.current.session.insights === 0, JSON.stringify(s.current?.session))
  check('① current 合计只含 Alpha + s1', keys(s.insights).join(',') === 'alpha-fact' && s.recent.length === 3, JSON.stringify({ i: keys(s.insights), r: s.recent.length }))
  check('① 当前工作区/会话有 current 标记', s.workspaces.find((w) => w.current)?.label === 'Alpha'
    && s.sessions.find((x) => x.current)?.title === 'Alpha 任务', JSON.stringify({ w: s.workspaces, s: s.sessions }))
  check('① 标签不含裸 scope', s.insights[0]?.scopeLabel === '工作区 Alpha'
    && s.sessions.every((x) => !String(x.label).includes('sess:')), JSON.stringify(s.insights[0]))
  check('① 工作区共享洞察标出来源会话', s.insights[0]?.originTitle === 'Alpha 任务', s.insights[0]?.originTitle)
  check('① 本会话产生/私有/工作区共享分列', s.session.records === 3 && s.session.privateRecords === 1 && s.session.workspaceRecords === 2, JSON.stringify({ r: s.session.records, p: s.session.privateRecords, w: s.session.workspaceRecords }))
  const g = (await getGraph('/api/memory/graph?sessionId=session-s1&range=current')).body.graph
  const gf = g.nodes.filter((n) => n.kind === 'fact')
  check('① 图谱只含当前范围事实', gf.map((n) => n.key).join(',') === 'alpha-fact', JSON.stringify(gf.map((n) => n.key)))
  check('① 图谱边含共享与来源会话', g.edges.some((x) => x.kind === 'shared') && g.edges.some((x) => x.kind === 'origin'), JSON.stringify(g.edges))
  check('① 图谱节点带当前标记', g.nodes.some((n) => n.kind === 'workspace' && n.current && n.label === 'Alpha')
    && g.nodes.some((n) => n.kind === 'session' && n.current && n.title === 'Alpha 任务'), JSON.stringify(g.stats))
  const ids = g.nodes.map((n) => n.id)
  check('① 图谱节点 id 唯一且边端点均可解析', ids.every(Boolean) && new Set(ids).size === ids.length
    && g.edges.every((e) => ids.includes(e.source) && ids.includes(e.target)), JSON.stringify(ids))
}

// ② workspace / session / all 三种范围各自只返回对应 scope。
{
  const w = (await get('/api/memory/status?sessionId=session-s1&range=workspace')).body
  check('② workspace 只含工作区共享', keys(w.insights).join(',') === 'alpha-fact' && w.recent.every((x) => x.scope === 'ws:c:/work/alpha'), JSON.stringify(keys(w.insights)))
  const p = (await get('/api/memory/status?sessionId=session-s1&range=session')).body
  check('② session 只含本会话私有', p.insights.length === 0 && p.recent.length === 1 && p.recent[0].scope === 'sess:s1', JSON.stringify(p.recent))
  const a = (await get('/api/memory/status?sessionId=session-s1&range=all')).body
  check('③ all 含两个工作区', keys(a.insights).sort().join(',') === 'alpha-fact,beta-fact' && a.recent.length === 5, JSON.stringify(keys(a.insights)))
  const ag = (await getGraph('/api/memory/graph?sessionId=session-s1&range=all')).body.graph
  check('③ all 图谱含两条事实与两个工作区', ag.nodes.filter((n) => n.kind === 'fact').length === 2
    && ag.nodes.filter((n) => n.kind === 'workspace').some((n) => n.label === 'Beta'), JSON.stringify(ag.stats))
}

// ④ 无会话：默认 all，current=null。
{
  const s = (await get('/api/memory/status')).body
  check('④ 无会话默认 all', s.range === 'all' && s.rangeEffective === 'all' && s.current === null, JSON.stringify({ r: s.range, c: s.current }))
  check('④ 作用域仍分工作区/会话两组', s.workspaces.length === 2 && s.sessions.length === 2, JSON.stringify({ w: s.workspaces.length, s: s.sessions.length }))
  check('④ 两个工作区都有可读名', s.workspaces.map((x) => x.label).sort().join(',') === 'Alpha,Beta', JSON.stringify(s.workspaces.map((x) => x.label)))
}

// ⑤ 未知会话：current 无法定位 ⇒ 回退 all，不伪造 current。
{
  const s = (await get('/api/memory/status?sessionId=session-unknown&range=current')).body
  check('⑤ 未知会话回退 all 且不伪造 current', s.rangeEffective === 'all' && s.current === null && s.session === null, JSON.stringify({ e: s.rangeEffective, c: s.current, s: s.session }))
}

// ⑥ 非法 range 不穿透到 SQL：按缺省 current 处理。
{
  const s = (await get('/api/memory/status?sessionId=session-s1&range=bogus')).body
  check('⑥ 非法 range 回落 current', s.range === 'current' && s.rangeEffective === 'current', JSON.stringify({ r: s.range, e: s.rangeEffective }))
}

// ⑦ 心跳判活：过期 ⇒ 待重启；心跳虽新但 pid 属于别的进程 ⇒ 也不算本进程已武装。
{
  const store2 = new MemoryStore(new DatabaseSync(join(root, 'memory.sqlite')), { stateDir: state, rawDir: join(root, 'raw') })
  store2.setMetaRaw('armedPid', String(process.pid))
  store2.setMetaRaw('armedAt', String(Date.now() - 200000))
  store2.close()
  const stale = (await get('/api/memory/status?sessionId=session-s1')).body
  check('⑦ 心跳过期 => 未武装', stale.armed === false, JSON.stringify({ armed: stale.armed }))

  const store3 = new MemoryStore(new DatabaseSync(join(root, 'memory.sqlite')), { stateDir: state, rawDir: join(root, 'raw') })
  store3.setMetaRaw('armedPid', String(process.pid + 1))
  store3.setMetaRaw('armedAt', String(Date.now()))
  store3.close()
  const other = (await get('/api/memory/status?sessionId=session-s1')).body
  check('⑦ 心跳新鲜但 pid 属于别的进程 => 未武装', other.armed === false, JSON.stringify({ armed: other.armed }))
}

// ⑧ 证据钻取：事件回查、来源会话、reset/probe 引用、缺失与非法参数。
{
  const e = await call(evidenceRoute, '/api/memory/evidence?scope=' + encodeURIComponent('ws:c:/work/alpha') + '&key=alpha-fact')
  check('⑧ 证据接口返回 ok 与摘要', e.body.ok === true && e.body.summary === 'Alpha 的端口是 8848', JSON.stringify({ ok: e.body.ok, s: e.body.summary }))
  check('⑧ 事件证据带内容/时间/来源会话', e.body.evidence[0]?.kind === 'command'
    && /npm test/.test(e.body.evidence[0]?.content || '')
    && e.body.evidence[0]?.sessionTitle === 'Alpha 任务'
    && e.body.evidence[0]?.ts > 0, JSON.stringify(e.body.evidence[0]))
  check('⑧ 原始 JSON 可展开', /"cmd":\s*"npm test"/.test(e.body.evidence[0]?.raw || ''), (e.body.evidence[0]?.raw || '').slice(0, 60))
  check('⑧ reset/probe 引用可读', e.body.evidence.some((x) => x.kind === 'reset' && x.content.includes('重置事件 9'))
    && e.body.evidence.some((x) => x.kind === 'probe' && x.content.includes('文件探针 0')), JSON.stringify(e.body.evidence.map((x) => x.kind)))
  const miss = await call(evidenceRoute, '/api/memory/evidence?scope=' + encodeURIComponent('ws:c:/work/alpha') + '&key=nope')
  check('⑧ 未知 key 明确 not-found', miss.body.ok === false && miss.body.error === 'not-found', JSON.stringify(miss.body))
  const bad = await call(evidenceRoute, '/api/memory/evidence?scope=not-a-scope&key=x')
  check('⑧ 非法 scope 返回 400', bad.code === 400 && bad.body.error === 'bad-request', JSON.stringify({ c: bad.code, e: bad.body.error }))
}

// ⑨ 事实分页与作用域钻取：默认 200 条行为不变，focusScope 与 factLimit 只在显式传入时生效。
{
  const page = (await getGraph('/api/memory/graph?sessionId=session-s1&range=all&factLimit=1')).body
  check('⑨ factLimit 生效且上报总数/截断', page.graph.stats.factLimit === 1 && page.graph.stats.factTotal === 2
    && page.graph.stats.facts === 1 && page.graph.stats.truncated === true, JSON.stringify(page.graph.stats))
  const wsNode = page.graph.nodes.find((n) => n.kind === 'workspace' && n.label === 'Alpha')
  check('⑨ 节点带作用域事实总数', wsNode?.factTotal === 1, JSON.stringify(wsNode && { f: wsNode.facts, t: wsNode.factTotal }))
  const sess = (await getGraph('/api/memory/graph?sessionId=session-s1&range=all&focusScope=' + encodeURIComponent('sess:s1'))).body
  check('⑨ 会话钻取只回本会话产生/私有的事实', sess.graph.stats.focusScope === 'sess:s1'
    && sess.graph.nodes.filter((n) => n.kind === 'fact').every((x) => x.originSid === 's1'), JSON.stringify(sess.graph.stats))
  const ws = (await getGraph('/api/memory/graph?sessionId=session-s1&range=all&focusScope=' + encodeURIComponent('ws:c:/work/alpha'))).body
  check('⑨ 工作区钻取只回本工作区共享事实', ws.graph.nodes.filter((n) => n.kind === 'fact').length === 1, JSON.stringify(ws.graph.stats))
  const bad = (await getGraph('/api/memory/graph?sessionId=session-s1&range=all&focusScope=bogus&factLimit=99999')).body
  check('⑨ 非法 focusScope 忽略、factLimit 收紧到 1000', bad.graph.stats.focusScope === null
    && bad.graph.stats.factLimit === 1000, JSON.stringify(bad.graph.stats))
}

// ⑩ 时间窗：只过滤事实/最近记录，不改全库 totals 与范围之外的数据。
{
  const since = Date.now() - 30 * 86400000
  const w = (await getGraph('/api/memory/graph?sessionId=session-s1&range=all&sinceTs=' + since)).body
  check('⑩ 时间窗过滤旧事实', w.graph.stats.factTotal === 1 && w.graph.stats.sinceTs === since, JSON.stringify(w.graph.stats))
  check('⑩ 旧事实所在节点 factTotal 归零', w.graph.nodes.find((n) => n.kind === 'workspace' && n.label === 'Beta')?.factTotal === 0,
    JSON.stringify(w.graph.nodes.filter((n) => n.kind === 'workspace').map((n) => [n.label, n.factTotal])))
  const bad = (await getGraph('/api/memory/graph?sessionId=session-s1&range=all&sinceTs=abc')).body
  check('⑩ 非法 sinceTs 忽略', bad.graph.stats.sinceTs === 0, JSON.stringify(bad.graph.stats))
}

// ⑪ 游标分页：同 updated_ts 用 rowid 破平；两页不重叠，末页 hasMore=false。
{
  const dbPath = join(root, 'memory.sqlite')
  const store5 = new MemoryStore(new DatabaseSync(dbPath), { stateDir: state, rawDir: join(root, 'raw') })
  const sameTs = Date.now() - 3600000
  for (let i = 1; i <= 3; i++) {
    store5.ingest({
      sid: 's2', seq: 20 + i, kind: 'insight', key: 'beta-page-' + i, scope: 'ws:c:/work/beta',
      value: { summary: 'Beta 分页事实 ' + i, confidence: 0.8, type: 'state' }, source: { sid: 's2', seq: 20 + i },
    })
  }
  store5.db.prepare("UPDATE records SET updated_ts=? WHERE scope='ws:c:/work/beta' AND key LIKE 'beta-page-%'").run(sameTs)
  store5.close()

  const focus = '&focusScope=' + encodeURIComponent('ws:c:/work/beta')
  const factKeys = (s) => keys((s.graph.nodes || []).filter((n) => n.kind === 'fact'))
  const p1 = (await getGraph('/api/memory/graph?range=all&factLimit=2' + focus)).body
  const k1 = factKeys(p1)
  check('⑪ 首页按 rowid 稳定取两条同时间戳事实', k1.length === 2
    && p1.graph.stats.hasMore === true && /^\d+:\d+$/.test(String(p1.graph.stats.nextCursor || ''))
    && p1.graph.stats.factTotal === 4, JSON.stringify({ k: k1, s: p1.graph.stats }))
  const p2 = (await getGraph('/api/memory/graph?range=all&factLimit=2&cursor=' + encodeURIComponent(p1.graph.stats.nextCursor) + focus)).body
  const k2 = factKeys(p2)
  check('⑪ 下一页沿用游标且与首页无重叠', k2.length === 2 && !k2.some((k) => k1.includes(k))
    && p2.graph.stats.cursor === p1.graph.stats.nextCursor, JSON.stringify({ k1, k2, c: p2.graph.stats.cursor }))
  check('⑪ 末页 hasMore=false 且 nextCursor 清空', p2.graph.stats.hasMore === false && p2.graph.stats.nextCursor === null,
    JSON.stringify(p2.graph.stats))
  check('⑪ 两页恰好覆盖全部四条事实', [...k1, ...k2].sort().join(',') === 'beta-fact,beta-page-1,beta-page-2,beta-page-3',
    [...k1, ...k2].join(','))
  const bad = (await getGraph('/api/memory/graph?range=all&factLimit=2&cursor=bogus' + focus)).body
  check('⑪ 非法游标忽略并回首页', factKeys(bad).join(',') === k1.join(',') && bad.graph.stats.cursor === null,
    JSON.stringify({ k: factKeys(bad), c: bad.graph.stats.cursor }))
}

// ⑫ 图谱独立端点：/api/memory/graph 只返回 graph 部分，不含 records/insights/recent。
{
  const g = (await getGraph('/api/memory/graph?range=all')).body
  check('⑫ 图谱端点返回 graph 对象', !!g.graph && Array.isArray(g.graph.nodes) && Array.isArray(g.graph.edges),
    JSON.stringify({ hasGraph: !!g.graph, nodes: g.graph?.nodes?.length, edges: g.graph?.edges?.length }))
  check('⑫ 图谱端点不含 status 字段', g.records === undefined && g.insights === undefined && g.recent === undefined,
    JSON.stringify({ records: g.records, insights: g.insights, recent: g.recent }))
  check('⑫ 图谱端点含 stats', !!g.graph.stats && typeof g.graph.stats.facts === 'number',
    JSON.stringify(g.graph.stats))
  const gFocus = (await getGraph('/api/memory/graph?range=all&focusScope=' + encodeURIComponent('ws:c:/work/beta'))).body
  check('⑫ 图谱端点支持 focusScope 钻取', gFocus.graph.stats.focusScope === 'ws:c:/work/beta',
    gFocus.graph.stats.focusScope)
  const gLimit = (await getGraph('/api/memory/graph?range=all&factLimit=2')).body
  check('⑫ 图谱端点支持 factLimit 分页', gLimit.graph.stats.factLimit === 2 && gLimit.graph.stats.facts <= 2,
    JSON.stringify({ limit: gLimit.graph.stats.factLimit, facts: gLimit.graph.stats.facts }))
}

// ⑬ Phase A 文件巡检 + Phase 3 向量诊断：status/config/手动触发数据面。
const post = (route, url, body, host = '127.0.0.1:8080') => new Promise((resolve) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))])
  req.method = 'POST'
  req.url = url
  req.headers = { host, 'content-type': 'application/json' }
  const res = {
    code: 0,
    writeHead(c) { this.code = c },
    end(buf) { resolve({ code: this.code, body: JSON.parse(String(buf || '{}')) }) },
  }
  route.handler(req, res)
})
{
  const s = (await get('/api/memory/status?sessionId=session-s1')).body
  check('⑬ 向量诊断默认关闭', !!s.vector && s.vector.state === 'off' && s.vector.rows === 0 && s.vector.pending === 0,
    JSON.stringify(s.vector))
  check('⑬ 巡检默认关闭且 30 分钟', !!s.janitor && s.janitor.enabled === false && s.janitor.intervalMs === 1800000,
    JSON.stringify(s.janitor))
}
{
  const dir = join(state, '.memory')
  mkdirSync(join(dir, 'janitor-last'), { recursive: true })
  mkdirSync(join(dir, 'janitor-inflight'), { recursive: true })
  writeFileSync(join(dir, 'janitor-last', 's1.json'), JSON.stringify({
    ok: true, skipped: false, at: Date.now(), trigger: 'manual', workspace: 'c:/work/alpha', facts: 10,
    ops: { refresh: 2, forget: 1, rejected: 0, failed: 0 }, model: { provider: 'p', model: 'm', via: 'janitor' }, ms: 10,
  }))
  writeFileSync(join(dir, 'janitor-inflight', 's1.json'), JSON.stringify({ at: Date.now(), trigger: 'manual', facts: 10, stage: 'llm' }))
  const s = (await get('/api/memory/status?sessionId=session-s1')).body
  check('⑬ status 回传上次巡检与在飞', s.janitor.last?.ops?.refresh === 2 && s.janitor.inflight?.stage === 'llm',
    JSON.stringify({ l: s.janitor.last, i: s.janitor.inflight }))
  check('⑬ 无会话时不串其它会话的巡检结果', (await get('/api/memory/status')).body.janitor.last === null)
  writeFileSync(join(dir, 'janitor-inflight', 's1.json'), JSON.stringify({ at: Date.now() - 11 * 60000, trigger: 'auto', facts: 1, stage: 'llm' }))
  check('⑬ 陈旧在飞标记忽略', (await get('/api/memory/status?sessionId=session-s1')).body.janitor.inflight === null)
}
{
  // Phase 4 轨迹详情：前缀路由必须以路径段结尾（宿主匹配是 pathname===prefix 或 prefix+'/'）。
  // 旧值 '/api/memory/traces/' 要求双斜杠 ⇒ 详情请求落到宿主纯文本 404，面板报 JSON 解析错。
  const tracePrefix = routes.find((r) => r.kind === 'prefix' && r.path === '/api/memory/traces')
  const matchPrefix = (p, x) => x === p || x.startsWith(p + '/')
  check('⑬ 轨迹详情前缀路由可被宿主匹配', !!tracePrefix
    && matchPrefix(tracePrefix.path, '/api/memory/traces/123')
    && !matchPrefix(tracePrefix.path, '/api/memory/tracesx'), tracePrefix && tracePrefix.path)
  const callTrace = (url) => new Promise((resolve) => {
    const req = Readable.from([])
    req.method = 'GET'; req.url = url; req.headers = { host: '127.0.0.1:8080' }
    const res = {
      code: 0,
      writeHead(c) { this.code = c },
      end(buf) { resolve({ code: this.code, body: JSON.parse(String(buf || '{}')) }) },
    }
    tracePrefix.handler(req, res)
  })
  const missing = await callTrace('/api/memory/traces/999999')
  check('⑬ 轨迹详情缺行返回 JSON（不是宿主纯文本）',
    (missing.code === 404 && missing.body?.error === 'not-found')
    || (missing.code === 200 && missing.body?.available === false && missing.body?.trace === null),
    JSON.stringify(missing))
  const badId = await callTrace('/api/memory/traces/not-a-number')
  check('⑬ 轨迹详情非法 id 返回 JSON 404', badId.code === 404 && badId.body?.error === 'not-found',
    JSON.stringify(badId))
}
{
  const dir = join(state, '.memory')
  const mdb = new DatabaseSync(join(root, 'memory.sqlite'))
  mdb.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run('lastSid:c:/work/alpha', 's2nd')
  mdb.close()
  writeFileSync(join(dir, 'janitor-last', 's2nd.json'), JSON.stringify({
    ok: true, skipped: false, at: Date.now(), trigger: 'auto', workspace: 'c:/work/alpha', facts: 3,
    ops: { refresh: 1, forget: 0, rejected: 0, failed: 0 }, model: { provider: 'p', model: 'm', via: 'janitor' }, ms: 5,
  }))
  unlinkSync(join(dir, 'janitor-last', 's1.json'))
  const fb = (await get('/api/memory/status?sessionId=session-s1')).body
  check('⑬ 无本会话记录时回退工作区最近一次', fb.janitor.last?.ops?.refresh === 1 && fb.janitor.last?.fromSid === 's2nd',
    JSON.stringify(fb.janitor.last))
  writeFileSync(join(dir, 'janitor-last', 's1.json'), JSON.stringify({
    ok: true, skipped: false, at: Date.now(), trigger: 'manual', workspace: 'c:/work/alpha', facts: 1,
    ops: { refresh: 9, forget: 0, rejected: 0, failed: 0 }, ms: 1,
  }))
  const own = (await get('/api/memory/status?sessionId=session-s1')).body
  check('⑬ 本会话记录优先于工作区回退', own.janitor.last?.ops?.refresh === 9 && own.janitor.last?.fromSid === undefined,
    JSON.stringify(own.janitor.last))
}
{
  const r = await post(janitorRoute, '/api/memory/janitor', { sessionId: 'session-s1' })
  const f = join(state, '.memory', 'janitor-request', 's1.json')
  check('⑬ 立即巡检写入请求文件', r.code === 202 && r.body.ok === true && existsSync(f)
    && JSON.parse(readFileSync(f, 'utf8')).sessionId === 's1', JSON.stringify(r))
  const bad = await post(janitorRoute, '/api/memory/janitor', {})
  check('⑬ 缺 sessionId 返回 400', bad.code === 400 && bad.body.error === 'missing-sessionId')
  const remote = await post(janitorRoute, '/api/memory/janitor', { sessionId: 's1' }, 'evil.example:80')
  check('⑬ 非本机来源拒绝触发', remote.code === 403)
}
{
  const before = JSON.parse(readFileSync(join(state, 'control.json'), 'utf8'))
  const r = await post(configRoute, '/api/memory/config', {
    memoryJanitorEnabled: true, memoryJanitorIntervalMs: 900000,
    memoryJanitorProvider: 'p', memoryJanitorModel: 'm',
  })
  const c = JSON.parse(readFileSync(join(state, 'control.json'), 'utf8'))
  check('⑬ 配置写入巡检开关/间隔/成对路由', r.code === 200 && r.body.ok === true && c.memoryJanitorEnabled === true
    && c.memoryJanitorIntervalMs === 900000 && c.memoryJanitorProvider === 'p' && c.memoryJanitorModel === 'm'
    && r.body.flags.janitorEnabled === true && r.body.janitorRoute?.model === 'm',
    JSON.stringify({ c, flags: r.body.flags, route: r.body.janitorRoute }))
  await post(configRoute, '/api/memory/config', { memoryJanitorProvider: '', memoryJanitorModel: '' })
  const c2 = JSON.parse(readFileSync(join(state, 'control.json'), 'utf8'))
  check('⑬ 空值清除巡检路由', !('memoryJanitorProvider' in c2) && !('memoryJanitorModel' in c2), JSON.stringify(c2))
  writeFileSync(join(state, 'control.json'), JSON.stringify(before), 'utf8')
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
