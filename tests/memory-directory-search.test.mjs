// Phase 2：目录感知检索 —— memory_search(uri) 的作用域下推、显式回退与 trace。
// 运行：node tests/memory-directory-search.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  MemoryStore, makeMemoryTools, workspaceRootId, rcsUriOf,
} from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const root = mkdtempSync(join(tmpdir(), 'rcs-dirsearch-'))
const dbFile = join(root, 'dir.sqlite')
const WS1 = 'd:/proj/dir1'
const WS2 = 'd:/proj/dir2'
const store = new MemoryStore(new DatabaseSync(dbFile), { stateDir: root, rawDir: join(root, 'raw') })
let seq = 0
const put = (sid, kind, key, value, scope, extra = {}) => store.ingest({
  sid, seq: ++seq, kind, key, scope, ts: 5000 + seq,
  value, source: { sid, seq }, ...extra,
})
put('s1', 'insight', 'port', { summary: '接口端口固定为 8848，禁止改动。', confidence: 0.9, type: 'constraint', evidence: [1] }, 'ws:' + WS1)
put('s1', 'insight', 'deploy', { summary: '部署脚本统一放在 scripts 目录，必须使用绝对路径。', confidence: 0.9, type: 'constraint' }, 'ws:' + WS1)
put('s1', 'file_state', 'file:d:/proj/dir1/a.md', { path: 'd:/proj/dir1/a.md', size: 12 }, 'ws:' + WS1)
put('s1', 'command', 'cmd:ls', { cmd: 'ls -la', action: 'shell' }, 'ws:' + WS1)
put('s1', 'command', 'cmd:echo1', { cmd: 'echo one', action: 'shell' }, 'ws:' + WS1)
put('s1', 'command', 'cmd:echo2', { cmd: 'echo two', action: 'shell' }, 'ws:' + WS1)
put('s1', 'error', 'err:read:a', { action: 'read', target: 'a.md', err: 'ENOENT: missing a.md' }, 'ws:' + WS1)
put('s1', 'insight', 'old', { summary: '旧目录已被清理，不再使用。', confidence: 0.6, type: 'state' }, 'ws:' + WS1)
put('s1', 'user_turn', 'turn:1', { text: '请记住端口 8848' }, 'sess:s1')
put('s2', 'insight', 'other', { summary: '另一个工作区的 8848 事实。', confidence: 0.9, type: 'constraint' }, 'ws:' + WS2)
put('s2', 'insight', 'secret', { summary: '另一个会话的 8848 秘密。', confidence: 0.9, type: 'constraint' }, 'sess:s2')
const oldRec = store.get({ sid: 's1', scope: 'session', kind: 'insight', key: 'old' })
store.setStatus(oldRec.rowid, 'resolved')

const wsRoot = `rcs://ws/${workspaceRootId(WS1)}/`
const ws2Root = `rcs://ws/${workspaceRootId(WS2)}/`
const kindRoot = (kind = '') => wsRoot + kind + (kind ? '/' : '')
const tools = Object.fromEntries(makeMemoryTools(store).map((t) => [t.name, t]))
const exec = { agent: { session: { id: 's1', header: { cwd: 'D:/Proj/Dir1' } } } }
const search = (opts) => store.search({ sid: 's1', workspace: WS1, ...opts })
const rows = (r) => (r.results || []).map((x) => x.rowid)

/* ── ① 基本作用域与等价 ────────────────────────────────────────────── */
{
  const r = search({ uri: wsRoot, query: '8848' })
  check('D2 rootdir 只返回本工作区 scope',
    r.ok && r.level === 'rootdir' && r.uriScope === true && r.count > 0
    && r.results.every((x) => x.scope === 'ws:' + WS1), JSON.stringify(r.results.map((x) => x.scope)))
  check('D2 rootdir 带 trace 与 attempts',
    r.attempts.length === 1 && r.attempts[0].mode && r.trace?.scopeUri === wsRoot
    && r.trace.visited.length === 1 && r.trace.fallback.length === 0 && r.fallbackUsed === false)
}

{
  const combos = []
  for (const q of ['8848', '部署', 'a.md', 'ENOENT', 'ls', 'echo']) {
    for (const kind of ['insight', 'file_state', 'command', 'error']) combos.push({ q, kind })
  }
  let same = 0
  for (const { q, kind } of combos) {
    const scoped = search({ uri: kindRoot(kind), query: q, kind, fallback: false })
    const legacy = search({ query: q, kind, limit: 10 })
    if (JSON.stringify(rows(scoped)) === JSON.stringify(rows(legacy))) same++
  }
  check('D3 kinddir 与既有 kind 过滤逐 rowid 等价', same === combos.length, `${same}/${combos.length}`)
}

{
  const recs = store.db.prepare('SELECT rowid, kind, key, value FROM records WHERE scope=?').all('ws:' + WS1)
  let same = 0
  for (const x of recs) {
    const uri = rcsUriOf({ scope: 'ws:' + WS1, kind: x.kind, key: x.key })
    const r = search({ uri, status: 'all' })
    const got = store.get({ sid: 's1', scope: 'project', workspace: WS1, kind: x.kind, key: x.key, status: 'all' })
    if (r.ok && r.mode === 'record' && r.count === 1 && r.results[0].rowid === x.rowid && got?.rowid === x.rowid
      && JSON.stringify(r.results[0].value) === JSON.stringify(got.value)) same++
  }
  check('D4 record URI 与 memory_get(kind,key) 同值', same === recs.length, `${same}/${recs.length}`)
  const one = search({ uri: rcsUriOf({ scope: 'ws:' + WS1, kind: 'insight', key: 'port' }), query: 'ignored' })
  check('D4 record + query 标注 queryIgnored', one.queryIgnored === true && one.count === 1)
}

/* ── ② 拒绝跨域与非法入口 ──────────────────────────────────────────── */
{
  const crossWs = search({ uri: ws2Root, query: '8848' })
  check('D5 跨工作区 not-visible（不是 0 条）', crossWs.ok === false && crossWs.error === 'not-visible', JSON.stringify(crossWs))
  const crossSess = search({ uri: 'rcs://sess/s2/', query: '8848' })
  check('D6 跨会话 not-visible', crossSess.ok === false && crossSess.error === 'not-visible')
  const missingRoot = search({ uri: 'rcs://ws/nope-00000000/', query: '8848' })
  check('D7 不存在 root → not-found', missingRoot.ok === false && missingRoot.error === 'not-found')
  const rootUri = search({ uri: 'rcs://' })
  const treeUri = search({ uri: 'rcs://ws/' })
  check('D13 root/tree 不是检索入口',
    rootUri.error === 'not-a-search-uri' && treeUri.error === 'not-a-search-uri'
    && rootUri.ok === false && treeUri.ok === false, JSON.stringify([rootUri.error, treeUri.error]))
  const bad = search({ uri: 'rcs://ws/not-a-root/' })
  check('D13 非法 root 直接拒绝', bad.ok === false && bad.error === 'bad-root', JSON.stringify(bad))
}

{
  const mismatch = search({ uri: kindRoot('insight'), kind: 'command', query: '8848' })
  check('D14 kinddir 与 kind 冲突 → kind-mismatch',
    mismatch.ok === false && mismatch.error === 'kind-mismatch' && mismatch.uriKind === 'insight', JSON.stringify(mismatch))
  const recMismatch = search({ uri: rcsUriOf({ scope: 'ws:' + WS1, kind: 'insight', key: 'port' }), kind: 'command' })
  check('D14 record 与 kind 冲突 → kind-mismatch', recMismatch.error === 'kind-mismatch')
  const keyWithUri = search({ uri: wsRoot, key: 'port' })
  check('D16 目录 URI + key → key-with-uri', keyWithUri.error === 'key-with-uri', JSON.stringify(keyWithUri))
  const recKey = search({ uri: rcsUriOf({ scope: 'ws:' + WS1, kind: 'insight', key: 'port' }), key: 'other' })
  check('D16 record URI + 不同 key → key-with-uri', recKey.error === 'key-with-uri')
}

/* ── ③ 显式回退与空结果 ────────────────────────────────────────────── */
{
  const auditUri = kindRoot('audit')
  const r = search({ uri: auditUri, query: '8848' })
  check('D8 空 kinddir 回退到同 root，并回传 widenedFrom/attempts',
    r.ok && r.count > 0 && r.fallbackUsed === true && r.widenedFrom === auditUri
    && r.scopeFallback === 'kinddir->rootdir' && r.attempts.length === 2
    && r.attempts[0].level === 'kinddir' && r.attempts[1].level === 'rootdir'
    && r.results.every((x) => x.scope === 'ws:' + WS1), JSON.stringify({ wide: r.widenedFrom, at: r.attempts.map((a) => a.level) }))

  const off = search({ uri: auditUri, query: '8848', fallback: false })
  check('D9 fallback=false 只尝试一次并 exhausted',
    off.ok && off.count === 0 && off.attempts.length === 1 && off.fallbackUsed === false
    && off.exhausted === true && off.widenedFrom === undefined, JSON.stringify(off.attempts))

  const rootKind = search({ uri: wsRoot, kind: 'audit', query: '8848' })
  check('D8b rootdir + kind 空结果按 kind-filter 回退',
    rootKind.ok && rootKind.count > 0 && rootKind.attempts.length === 2
    && rootKind.widenedFrom === wsRoot && rootKind.scopeFallback === 'kind-filter', JSON.stringify(rootKind.scopeFallback))

  const empty = search({ uri: wsRoot, query: '不存在xyzq' })
  check('D10 rootdir 空结果不扩大', empty.ok && empty.count === 0 && empty.attempts.length === 1
    && empty.fallbackUsed === false && empty.exhausted === true, JSON.stringify(empty.attempts))
}

{
  const miss = search({ uri: rcsUriOf({ scope: 'ws:' + WS1, kind: 'insight', key: 'missing' }) })
  check('D11 record 缺失 → missing，不扩大',
    miss.ok && miss.missing === true && miss.count === 0 && miss.attempts.length === 0 && miss.exhausted === true)

  const oldUri = rcsUriOf({ scope: 'ws:' + WS1, kind: 'insight', key: 'old' })
  const hidden = search({ uri: oldUri })
  const visible = search({ uri: oldUri, status: 'all' })
  check('D12 resolved 默认不可见、status=all 可见',
    hidden.missing === true && visible.count === 1 && visible.results[0].key === 'old', JSON.stringify([hidden.missing, visible.count]))
}

{
  const r = search({ uri: wsRoot, query: 'echo', limit: 1 })
  check('D15 limit 生效且 trace 标注可能截断',
    r.count === 1 && r.trace?.truncated === true, JSON.stringify({ count: r.count, tr: r.trace?.truncated }))
  const all = search({ uri: wsRoot, query: '清理', status: 'all' })
  check('D15 status=all 能返回 resolved 事实', all.count >= 1 && all.results.some((x) => x.status === 'resolved'))
}

/* ── ④ trace 形状与计数缓存 ────────────────────────────────────────── */
{
  const r = search({ uri: kindRoot('audit'), query: '8848' })
  const t = r.trace
  check('D18 trace 完整且不含正文',
    t && t.scopeUri === kindRoot('audit') && t.requestedUri === kindRoot('audit')
    && t.effectiveUri === wsRoot && t.tree === 'ws' && t.level === 'kinddir'
    && t.visited.length === 2 && t.fallback.length === 1
    && t.fallback[0].from === kindRoot('audit') && t.fallback[0].to === wsRoot
    && t.candidates.length === r.results.length
    && t.candidates.every((c) => c.uri && c.kind && c.mode === r.mode && c.value === undefined && c.summary === undefined),
    JSON.stringify(t).slice(0, 240))
  check('D18 结果 scope 全在解析出的集合内',
    r.results.every((x) => x.scope === 'ws:' + WS1))
}

{
  const a = store.catalog({ sid: 's1', workspace: WS1 })
  const b = store.catalog({ sid: 's1', workspace: WS1 })
  check('D19 计数缓存命中后结果一致', JSON.stringify(a) === JSON.stringify(b))
  const before = a.counts.find((x) => x.kind === 'command')?.n ?? 0
  put('s1', 'command', 'cmd:cache1', { cmd: 'echo cache', action: 'shell' }, 'ws:' + WS1)
  const after = store.catalog({ sid: 's1', workspace: WS1 }).counts.find((x) => x.kind === 'command')?.n ?? 0
  check('D19 本连接写入立即失效缓存', after === before + 1, JSON.stringify([before, after]))

  // 另一个连接：data_version 变化（≤500ms 检查窗口后）清空缓存。
  const before2 = after
  const other = new DatabaseSync(dbFile)
  other.prepare(`INSERT INTO records (sid, scope, kind, key, value, source, status, updated_ts, usage, last_used_ts, fact_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('s9', 'ws:' + WS1, 'command', 'cmd:otherconn', JSON.stringify({ cmd: 'echo other' }), '{}', 'active', 9000, 0, 0, '')
  other.close()
  const stale = store.catalog({ sid: 's1', workspace: WS1 }).counts.find((x) => x.kind === 'command')?.n ?? 0
  await new Promise((r) => setTimeout(r, 650))
  const fresh = store.catalog({ sid: 's1', workspace: WS1 }).counts.find((x) => x.kind === 'command')?.n ?? 0
  check('D19 其他连接提交后 data_version 失效', fresh === before2 + 1, JSON.stringify({ stale, fresh, want: before2 + 1 }))
}

/* ── ⑤ 工具层形状与开关 ────────────────────────────────────────────── */
{
  const name = tools.memory_search.name
  const props = tools.memory_search.parameters.properties
  check('D20 工具 schema 暴露 uri/fallback 且仍拒绝未知字段',
    name === 'memory_search' && !!props.uri && !!props.fallback && tools.memory_search.parameters.additionalProperties === false)

  const plain = await tools.memory_search.execute({ query: '8848' }, exec)
  check('D20 无 uri 响应不含 URI 字段（I1）',
    plain.ok && plain.attempts === undefined && plain.uriScope === undefined && plain.trace === undefined
    && plain.count >= 1)

  const scoped = await tools.memory_search.execute({ uri: wsRoot, query: '8848' }, exec)
  check('D20 工具 uri 响应带 trace/attempts，结果压缩且 insight 带 layers',
    scoped.ok && scoped.scope === 'uri' && scoped.uriScope === true
    && Array.isArray(scoped.attempts) && !!scoped.trace
    && scoped.results.every((x) => x.overview === undefined && x.layerOf === undefined)
    && scoped.results.filter((x) => x.kind === 'insight').every((x) => x.layers?.l0))

  const denied = await tools.memory_search.execute({ uri: ws2Root, query: '8848' }, exec)
  check('D20 工具层跨域错误透传', denied.ok === false && denied.error === 'not-visible' && denied.scope === 'uri')
  const badKind = await tools.memory_search.execute({ uri: kindRoot('insight'), kind: 'command' }, exec)
  check('D20 工具层 kind-mismatch 透传 uriKind', badKind.error === 'kind-mismatch' && badKind.uriKind === 'insight')

  const old = process.env.DSH_MEMORY_DIR_SEARCH
  process.env.DSH_MEMORY_DIR_SEARCH = '0'
  const off = await tools.memory_search.execute({ uri: wsRoot, query: '8848' }, exec)
  if (old === undefined) delete process.env.DSH_MEMORY_DIR_SEARCH
  else process.env.DSH_MEMORY_DIR_SEARCH = old
  check('D20 DSH_MEMORY_DIR_SEARCH=0 可关（无需回滚数据）', off.ok === false && off.error === 'dir-search-disabled')
}

store.close()
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
