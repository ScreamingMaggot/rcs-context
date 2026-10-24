// 中文检索回归：默认 unicode61 会把连续中文当成一个 token，中文词/数字检索会漏。
// 运行：node tests/memory-cjk-search.test.mjs
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

const root = mkdtempSync(join(tmpdir(), 'rcs-cjk-'))
const ws = 'c:/proj/cjk'
const newStore = (name) => new MemoryStore(new DatabaseSync(join(root, name)), { stateDir: root, rawDir: join(root, 'raw') })

{
  const s = newStore('cjk.sqlite')
  s.ingest({
    sid: 's1', seq: 1, kind: 'user_turn', key: 'turn:1', scope: 'sess:s1',
    value: { text: '接口端口固定为 8848，禁止改动。' }, source: { sid: 's1', seq: 1 },
  })
  s.ingest({
    sid: 's1', seq: 2, kind: 'command', key: 'cmd:1', scope: 'ws:' + ws,
    value: { cmd: 'npm run test-cjk', status: 'OK' }, source: { sid: 's1', seq: 2 },
  })

  const four = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '接口端口' })
  check('① 中文四字词命中', four.results.some((r) => r.kind === 'user_turn'), four.mode + ':' + four.results.length)
  check('① 中文词走 trigram 索引', four.mode === 'fts-tri', four.mode)

  const digits = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '8848' })
  check('② 中文串里的数字命中', digits.results.some((r) => r.kind === 'user_turn'), digits.mode + ':' + digits.results.length)

  // 两个中文词用空格分隔：旧 FTS 按整段中文分词、LIKE 又按整串匹配，都会漏。
  const mixed = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '接口端口 禁止' })
  check('③ 中文多词查询命中', mixed.results.some((r) => r.kind === 'user_turn'), mixed.mode + ':' + mixed.results.length)
  check('③ 中文多词走索引而非整段 LIKE', (mixed.mode === 'fts-tri' || mixed.mode === 'bigram'), mixed.mode)

  const two = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '端口' })
  check('④ 两字词回落到词元索引且命中', (two.mode === 'like' || two.mode === 'bigram') && two.results.some((r) => r.kind === 'user_turn'), two.mode + ':' + two.results.length)

  const en = s.search({ sid: 's1', scope: 'project', workspace: ws, query: 'npm run' })
  check('⑤ 英文查询仍可用', en.results.some((r) => r.kind === 'command'), en.mode + ':' + en.results.length)

  s.ingest({
    sid: 's1', seq: 3, kind: 'user_turn', key: 'turn:1', scope: 'sess:s1',
    value: { text: '接口端口固定为 9999，禁止改动。' }, source: { sid: 's1', seq: 3 },
  })
  check('⑥ 更新后旧数字不再命中', s.search({ sid: 's1', scope: 'project', workspace: ws, query: '8848' }).results.length === 0)
  check('⑥ 更新后新数字命中', s.search({ sid: 's1', scope: 'project', workspace: ws, query: '9999' }).results.some((r) => r.kind === 'user_turn'))
  s.close()
}

{
  // 旧库只有 records_fts（unicode61），启动时应自动建 trigram 表并回填。
  const db = new DatabaseSync(join(root, 'legacy.sqlite'))
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, sid TEXT NOT NULL, seq INTEGER, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, extractor TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1, scope TEXT NOT NULL DEFAULT '');
    CREATE TABLE records (rowid INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', updated_ts INTEGER NOT NULL, UNIQUE(scope, kind, key));
    CREATE VIRTUAL TABLE records_fts USING fts5(sid UNINDEXED, kind UNINDEXED, key UNINDEXED, value);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  db.prepare("INSERT INTO records (sid,scope,kind,key,value,source,status,updated_ts) VALUES ('old','sess:old','user_turn','turn:1','{\"text\":\"旧库中文事实 8848\"}','{}','active',1)").run()
  db.prepare("INSERT INTO records_fts(rowid,sid,kind,key,value) VALUES (1,'old','user_turn','turn:1','{\"text\":\"旧库中文事实 8848\"}')").run()
  const migrated = new MemoryStore(db, { stateDir: root, rawDir: join(root, 'raw') })
  const r = migrated.search({ sid: 'old', scope: 'session', query: '中文事实' })
  check('⑦ 旧库启动后回填 trigram 索引', r.mode === 'fts-tri' && r.results.length === 1, r.mode + ':' + r.results.length)
  migrated.close()
}

{
  // 规模回归：200 条同词 file_state 曾把后建的 insight 挤出 FTS 候选（先取 rowid 再过滤），
  // 即使 limit=50 也取不回；候选必须在过滤/排序后再截断。
  const s = newStore('crowd.sqlite')
  for (let i = 1; i <= 200; i++) {
    s.ingest({
      sid: 's' + i, seq: i, kind: 'file_state', key: 'file:doc' + i + '.md', scope: 'ws:' + ws,
      value: { path: 'doc' + i + '.md', excerpt: '登录页面使用 8080' }, source: { sid: 's' + i, seq: i },
    })
  }
  s.ingest({
    sid: 's1', seq: 999, kind: 'insight', key: 'login', scope: 'ws:' + ws,
    value: { summary: '登录页面固定走 8848 端口' }, source: { sid: 's1', seq: 999 },
  })
  const r = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '登录页面', limit: 10 })
  check('⑧ 200 条同词文档不会挤掉 insight', (r.mode === 'fts-tri' || r.mode === 'bigram') && r.results[0]?.kind === 'insight',
    r.mode + ':' + r.results.map((x) => x.kind).join(','))
  const multi2 = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '登录 页面', limit: 10 })
  check('⑨ 两个两字词空格分隔仍命中（LIKE 逐词 AND）', multi2.results.length > 0,
    multi2.mode + ':' + multi2.results.length)
  s.close()
}

{
  // 可见性下推：别的 workspace 的同词文档不得占满候选集。
  const s = newStore('crowd-ws.sqlite')
  for (let i = 1; i <= 200; i++) {
    s.ingest({
      sid: 'other' + i, seq: i, kind: 'file_state', key: 'file:other' + i + '.md', scope: 'ws:c:/other',
      value: { path: 'other' + i + '.md', excerpt: '登录页面使用 8080' }, source: { sid: 'other' + i, seq: i },
    })
  }
  s.ingest({
    sid: 's1', seq: 999, kind: 'insight', key: 'login', scope: 'ws:' + ws,
    value: { summary: '登录页面固定走 8848 端口' }, source: { sid: 's1', seq: 999 },
  })
  const r = s.search({ sid: 's1', scope: 'project', workspace: ws, query: '登录页面', limit: 10 })
  check('⑩ 其他工作区同词文档不占候选', r.results.length === 1 && r.results[0].kind === 'insight',
    r.mode + ':' + r.results.length)
  s.close()
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)