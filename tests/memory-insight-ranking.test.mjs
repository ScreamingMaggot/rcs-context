// insight 选序：置信度² × 时间半衰 × 使用次数；并覆盖老库补列与工具命中计数。
// 运行：node tests/memory-insight-ranking.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, catalogDigest, makeMemoryTools, insightScore } from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const root = mkdtempSync(join(tmpdir(), 'rcs-rank-'))
const ws = 'c:/proj/rank'
const mk = (name) => new MemoryStore(new DatabaseSync(join(root, name)), { stateDir: root, rawDir: join(root, 'raw') })

{
  const s = mk('rank.sqlite')
  const put = (key, summary, confidence, seq, ageDays = 0) => {
    s.ingest({ sid: 's1', seq, kind: 'insight', key, scope: 'ws:' + ws, value: { summary, confidence }, source: { sid: 's1', seq } })
    if (ageDays) s.db.prepare('UPDATE records SET updated_ts=? WHERE scope=? AND kind=\'insight\' AND key=?').run(Date.now() - ageDays * 86400000, 'ws:' + ws, key)
  }
  put('ledger-order', '折叠账本以 (session_id, line_no) 为序，不存 wall-clock。', 0.95, 1, 1)
  for (let i = 0; i < 8; i++) put('trivia' + i, '边角料 ' + i + '：最近改过的小事。', 0.6, 2 + i, 0)

  const ins = s.insights('ws:' + ws, 8)
  check('① 旧的高置信约束不被 8 条近期边角料挤出', ins.some((x) => x.key === 'ledger-order'),
    ins.map((x) => x.key).join(','))
  check('① 目录注入也能看到该约束', catalogDigest(s, { sid: 'b', workspace: ws }).includes('line_no'))

  // 使用次数：同置信度/同龄，usage 更高的排前。
  put('used', '被反复查过的事实。', 0.7, 20, 2)
  put('unused', '从未被查过的事实。', 0.7, 21, 2)
  const usedRow = s.db.prepare("SELECT rowid FROM records WHERE scope=? AND key='used'").get('ws:' + ws)
  for (let i = 0; i < 10; i++) s.bumpUsage(usedRow.rowid)
  const top = s.insights('ws:' + ws, 100)
  check('② usage 高的同置信度 insight 排前', top.findIndex((x) => x.key === 'used') < top.findIndex((x) => x.key === 'unused'),
    top.slice(0, 4).map((x) => x.key + ':' + x.score.toFixed(3)).join(','))

  // 逻辑弃用（resolved）不再进入目录。
  s.db.prepare("UPDATE records SET status='resolved' WHERE scope=? AND key='unused'").run('ws:' + ws)
  check('③ resolved 的 insight 不再入选', !s.insights('ws:' + ws, 100).some((x) => x.key === 'unused'))

  // 工具层命中计数：memory_search / memory_get 才算“被用过”。
  const tools = Object.fromEntries(makeMemoryTools(s).map((t) => [t.name, t]))
  const exec = { agent: { session: { id: 'session-s1', header: { cwd: 'C:\\Proj\\Rank' } } } }
  const before = Number(s.db.prepare("SELECT usage FROM records WHERE scope=? AND key='ledger-order'").get('ws:' + ws).usage)
  const r = await tools.memory_search.execute({ query: '折叠账本', scope: 'project' }, exec)
  const after = Number(s.db.prepare("SELECT usage FROM records WHERE scope=? AND key='ledger-order'").get('ws:' + ws).usage)
  check('④ memory_search 命中 insight 后 usage+1', r.ok && r.results.some((x) => x.key === 'ledger-order') && after === before + 1,
    `${before}->${after}`)
  await tools.memory_get.execute({ kind: 'insight', key: 'ledger-order' }, exec)
  const afterGet = Number(s.db.prepare("SELECT usage FROM records WHERE scope=? AND key='ledger-order'").get('ws:' + ws).usage)
  check('④ memory_get 命中 insight 后 usage+1', afterGet === after + 1, `${after}->${afterGet}`)

  check('⑤ score 随年龄衰减、随置信度上升',
    insightScore({ confidence: 0.9, updated_ts: Date.now(), usage: 0 }) > insightScore({ confidence: 0.9, updated_ts: Date.now() - 120 * 86400000, usage: 0 })
    && insightScore({ confidence: 0.9, updated_ts: Date.now(), usage: 0 }) > insightScore({ confidence: 0.5, updated_ts: Date.now(), usage: 0 }))
  s.close()
}

{
  // 老 v2 库没有 usage/last_used_ts：打开时应补列且不丢数据。
  const db = new DatabaseSync(join(root, 'legacy.sqlite'))
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, sid TEXT NOT NULL, seq INTEGER, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, extractor TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1, scope TEXT NOT NULL DEFAULT '');
    CREATE TABLE records (rowid INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', updated_ts INTEGER NOT NULL, UNIQUE(scope, kind, key));
    CREATE VIRTUAL TABLE records_fts USING fts5(sid UNINDEXED, kind UNINDEXED, key UNINDEXED, value);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  db.prepare("INSERT INTO records (sid,scope,kind,key,value,source,status,updated_ts) VALUES ('s1',?, 'insight','old','{\"summary\":\"旧库事实\",\"confidence\":0.9}','{}','active',1)").run('ws:' + ws)
  db.prepare("INSERT INTO records_fts(rowid,sid,kind,key,value) VALUES (1,'s1','insight','old','{\"summary\":\"旧库事实\"}')").run()
  const s = new MemoryStore(db, { stateDir: root, rawDir: join(root, 'raw') })
  const cols = db.prepare('PRAGMA table_info(records)').all().map((c) => c.name)
  check('⑥ 老库打开后补 usage/last_used_ts 列', cols.includes('usage') && cols.includes('last_used_ts'), cols.join(','))
  check('⑥ 老数据保留且可排序', s.insights('ws:' + ws, 5).some((x) => x.key === 'old' && x.usage === 0))
  s.close()
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
