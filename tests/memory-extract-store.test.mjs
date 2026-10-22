// 外部记忆第一切片：确定性抽取 + SQLite 存储 + 事件游标 + 只读工具。
// 运行：node tests/memory-extract-store.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  recordsFromToolResult, MemoryStore, MemoryIngestor, makeMemoryTools, normPath, workspaceOf, scopeOf,
  digestOf, parseInsights, MemoryCompiler, groundedInsight, catalogDigest, summarySimilarity, mergeableInsight, explicitMemoryItems,
} from '../web/memory.mjs'

const root = mkdtempSync(join(tmpdir(), 'rcs-memory-'))
const rawDir = join(root, 'raw')
mkdirSync(rawDir, { recursive: true })
const file = join(root, 'a.mjs').replace(/\\/g, '/')
writeFileSync(file, 'abc', 'utf8')

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const fsStub = { readFileSync: () => Buffer.from('line1\nline2\n') }

/* ── ① 工具结果 → 结构化记录 ───────────────────────────────────────── */
{
  const r = recordsFromToolResult({ sid: 'session-abc', seq: 10, callId: 'c1', action: 'read', args: { file_path: 'C:\\Proj\\A.mjs' }, text: 'line1\nline2\n', isError: false, fs: fsStub })
  check('① read ⇒ 1 条 file_state', r.length === 1 && r[0].kind === 'file_state', JSON.stringify(r.map((x) => x.kind)))
  check('① 路径键归一（反斜杠/大小写）', r[0]?.key === 'file:c:/proj/a.mjs', r[0]?.key)
  check('① size/lines/sha8 取自真实字节', r[0]?.value?.size === 12 && r[0]?.value?.lines === 3 && /^[0-9a-f]{8}$/.test(r[0]?.value?.sha8), JSON.stringify(r[0]?.value))
  check('① sid 剥掉 session- 前缀', r[0]?.source?.sid === 'abc', r[0]?.source?.sid)
  check('① 源指针带 seq+callId', r[0]?.source?.seq === 10 && r[0]?.source?.callId === 'c1')
}
{
  const r = recordsFromToolResult({ sid: 's', seq: 11, action: 'edit', args: { file_path: 'C:/p/b.mjs' }, text: 'ok', isError: false, fs: { readFileSync: () => Buffer.from('ok') } })
  check('① edit ⇒ file_state（action=edit）', r[0]?.kind === 'file_state' && r[0]?.value?.action === 'edit')
}
{
  const r = recordsFromToolResult({ sid: 's', seq: 12, action: 'pwsh', args: { cmd: 'echo hi' }, text: 'hi\n', isError: false })
  check('① pwsh ⇒ command', r[0]?.kind === 'command' && r[0]?.value?.cmd === 'echo hi', JSON.stringify(r[0]?.value))
  check('① command 保留 exit/out_n', r[0]?.value?.exit === '0' && r[0]?.value?.out_n === 3, JSON.stringify(r[0]?.value))
  check('① command 原样 preview 保留换行', r[0]?.value?.preview === 'hi\n', JSON.stringify(r[0]?.value?.preview))
}
{
  const r = recordsFromToolResult({ sid: 's', seq: 13, action: 'grep', args: { pattern: 'foo' }, text: 'a\nb\nc', isError: false })
  check('① grep ⇒ search', r[0]?.kind === 'search' && r[0]?.value?.pattern === 'foo' && r[0]?.value?.count === 3, JSON.stringify(r[0]?.value))
}
{
  const r = recordsFromToolResult({ sid: 's', seq: 14, action: 'ask_user_question', args: { question: 'Pick?' }, text: 'yes', isError: false })
  check('① ask_user_question ⇒ user_answer 逐字', r[0]?.kind === 'user_answer' && r[0]?.value?.answer === 'yes', JSON.stringify(r[0]?.value))
}
{
  const r = recordsFromToolResult({ sid: 's', seq: 15, action: 'read', args: { file_path: 'C:/p/missing.mjs' }, text: 'Error: boom\ndetail', isError: true, fs: { readFileSync: () => { throw new Error('nope') } } })
  const kinds = r.map((x) => x.kind)
  check('① 失败 ⇒ file_state + error 两条', kinds.includes('file_state') && kinds.includes('error'), kinds.join(','))
  check('① error 保留首行原文', r.find((x) => x.kind === 'error')?.value?.err === 'Error: boom', JSON.stringify(r.find((x) => x.kind === 'error')?.value))
}
{
  const r = recordsFromToolResult({ sid: 's', seq: 18, action: 'pwsh', args: { cmd: 'type missing.txt' }, text: 'type : 找不到路径“C:\missing.txt”。', isError: false })
  check('① exit=0 但输出含找不到路径 ⇒ 额外 error 记录', r.some((x) => x.kind === 'error') && r.find((x) => x.kind === 'command')?.value?.status === 'OK',
    r.map((x) => x.kind).join(','))
}
{
  const r = recordsFromToolResult({ sid: 's', seq: 16, callId: 'c9', action: '?', args: {}, text: 'x', isError: false })
  check('① 未知动作落 unknown 桶', r[0]?.kind === 'tool_unknown' && r[0]?.key === 'tool:c9', r[0]?.key)
}
{
  const r = recordsFromToolResult({ sid: 's', seq: 17, action: 'memory_catalog', args: {}, text: '{}', isError: false })
  check('① 记忆查询工具自身不入记忆', r.length === 0, JSON.stringify(r))
}

/* ── ② 存储：幂等 / upsert / 游标 / 检索 ────────────────────────────── */
const db = new DatabaseSync(join(root, 'memory.sqlite'))
const store = new MemoryStore(db, { stateDir: root, rawDir })
const base = { sid: 's1', seq: 1, kind: 'file_state', key: 'file:/a', value: { size: 1 }, source: { sid: 's1', seq: 1, callId: 'c1' }, ts: 1000 }
check('② 首次 ingest 写入', store.ingest(base) === true)
check('② 同 (sid,seq,kind,key) 重放被吞掉', store.ingest(base) === false)
check('② events 只 1 行', Number(store.db.prepare('SELECT COUNT(*) c FROM events').get().c) === 1)
check('② records 只 1 行', Number(store.db.prepare('SELECT COUNT(*) c FROM records').get().c) === 1)
check('② 更新同一键 ⇒ events 追加、records 仍一行', store.ingest({ ...base, seq: 2, value: { size: 2 }, ts: 2000 }) === true
  && Number(store.db.prepare('SELECT COUNT(*) c FROM events').get().c) === 2
  && Number(store.db.prepare('SELECT COUNT(*) c FROM records').get().c) === 1)
check('② 当前视图取最新值', store.get({ sid: 's1', kind: 'file_state', key: 'file:/a' })?.value?.size === 2)

store.setCursor('s1', 5)
check('② 游标写入', store.getCursor('s1') === 5)
store.setCursor('s1', 3)
check('② 游标不回退', store.getCursor('s1') === 5)

store.ingest({ sid: 's1', seq: 6, kind: 'command', key: 'cmd:1', value: { cmd: 'echo hello' }, source: { sid: 's1', seq: 6 } })
store.ingest({ sid: 's1', seq: 7, kind: 'user_turn', key: 'turn:7', value: { text: '请记住端口 8741' }, source: { sid: 's1', seq: 7 } })
const fts = store.search({ sid: 's1', query: 'hello' })
check('② FTS/LIKE 检索命中英文值', fts.results.some((r) => r.kind === 'command'), fts.mode + ':' + fts.results.length)
const cn = store.search({ sid: 's1', query: '端口' })
check('② 中文子串走 LIKE 兜底', cn.results.some((r) => r.kind === 'user_turn'), cn.mode + ':' + cn.results.length)
const exact = store.search({ sid: 's1', key: 'file:/a' })
check('② 精确键检索', exact.mode === 'key' && exact.results.length === 1 && exact.results[0].value.size === 2)
const cat = store.catalog({ sid: 's1' }, 10)
check('② catalog 汇总种类与总数', cat.total >= 3 && cat.counts.some((c) => c.kind === 'file_state'), JSON.stringify(cat.counts))
check('② rowid 读取也受 sid 约束', store.get({ sid: 'other', rowid: store.get({ sid: 's1', kind: 'file_state', key: 'file:/a' }).rowid }) === null)

// 回归：工具结果记录曾漏带顶层 seq ⇒ events 里 seq=NULL ⇒ ① 编译候选被跳过、② 同键第二次结果被幂等误吞。
{
  const rr1 = recordsFromToolResult({ sid: 's9', seq: 20, action: 'read', args: { file_path: 'C:/p/x.mjs' }, text: 'a', fs: { readFileSync: () => Buffer.from('a') } })
  const rr2 = recordsFromToolResult({ sid: 's9', seq: 21, action: 'read', args: { file_path: 'C:/p/x.mjs' }, text: 'ab', fs: { readFileSync: () => Buffer.from('ab') } })
  check('② 工具记录带顶层 seq', rr1[0]?.seq === 20 && rr2[0]?.seq === 21, `${rr1[0]?.seq},${rr2[0]?.seq}`)
  store.ingest(rr1[0]); store.ingest(rr2[0])
  const xr = store.search({ sid: 's9', key: rr1[0].key })
  const ne = Number(store.db.prepare("SELECT COUNT(*) c FROM events WHERE sid='s9'").get().c)
  check('② 同键不同 seq ⇒ 两条 events、当前视图取最新', xr.results.length === 1 && xr.results[0].value.size === 2 && ne === 2, `${ne}/${xr.results[0]?.value?.size}`)
}

/* ── ③ 事件摄入：配对 / 真人轮过滤 / 任务 / 补课 ────────────────────── */
{
  const s = new MemoryStore(new DatabaseSync(join(root, 'ingest.sqlite')), { stateDir: root, rawDir })
  const ing = new MemoryIngestor(s)
  const calls = new Map()
  const callEv = { type: 'tool/call', seq: 10, data: { callId: 'x1', name: 'read', arguments: JSON.stringify({ file_path: file }) } }
  const resEv = { type: 'tool/result', seq: 11, data: { message: { role: 'tool', toolCallId: 'x1', isError: false, content: [{ type: 'text', text: 'abc' }] } } }
  ing.processEvent('s1', callEv, calls)
  ing.processEvent('s1', resEv, calls)
  const rows = s.search({ sid: 's1', kind: 'file_state' })
  check('③ call↔result 配对后落 file_state', rows.results.length === 1 && rows.results[0].value.size === 3, JSON.stringify(rows.results[0]?.value))
  check('③ 源指针指向 result seq', rows.results[0]?.source?.seq === 11 && rows.results[0]?.source?.callId === 'x1')

  const realUser = { type: 'user/message', seq: 12, data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '请记住端口 8741' }] } } }
  const injected = { type: 'user/message', seq: 13, data: { source: { kind: 'plugin:EXTREASON' }, message: { content: [{ type: 'text', text: '[R] noise' }] } } }
  ing.processEvent('s1', realUser, calls)
  ing.processEvent('s1', injected, calls)
  const ut = s.search({ sid: 's1', kind: 'user_turn' })
  check('③ 只收真人轮，注入轮不入记忆', ut.results.length === 1 && /8741/.test(JSON.stringify(ut.results[0].value)), String(ut.results.length))
  const goal = { type: 'goal/change', seq: 14, data: { operation: 'create', goalId: 'g1' } }
  ing.processEvent('s1', goal, calls)
  const task = s.get({ sid: 's1', kind: 'task', key: 'task:g1' })
  check('③ goal/change ⇒ TASK START', task?.value?.label === 'TASK START', JSON.stringify(task?.value))
  check('③ 游标推进到最后事件', s.getCursor('s1') === 14, String(s.getCursor('s1')))

  const session = { ownEvents: () => [callEv, resEv, realUser, injected, goal] }
  const s2 = new MemoryStore(new DatabaseSync(join(root, 'catchup.sqlite')), { stateDir: root, rawDir })
  const ing2 = new MemoryIngestor(s2)
  const first = ing2.ingestSession(session, 's2')
  const ev1 = Number(s2.db.prepare('SELECT COUNT(*) c FROM events').get().c)
  const again = ing2.ingestSession(session, 's2')
  const ev2 = Number(s2.db.prepare('SELECT COUNT(*) c FROM events').get().c)
  check('③ 首次补课处理事件', first.processed > 0, JSON.stringify(first))
  check('③ 重复补课幂等（events 不增）', ev1 === ev2 && again.processed === 0, `${ev1} → ${ev2}`)
  s.close(); s2.close()
}

/* ── ④ 只读工具：默认当前会话 / 无 scope 拒绝 / 输出形状 ────────────── */
{
  const tools = makeMemoryTools(store)
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  check('④ 三个工具都注册为只读定义', tools.length === 3 && tools.every((t) => typeof t.output?.render === 'function' && t.isConcurrencySafe() === true))
  const exec = { agent: { session: { id: 'session-s1' } } }
  const c = await byName.memory_catalog.execute({}, exec)
  check('④ catalog 默认当前会话', c.ok === true && c.sid === 's1' && c.total >= 3, JSON.stringify(c).slice(0, 160))
  const q = await byName.memory_search.execute({ query: 'hello' }, exec)
  check('④ search 返回结果', q.ok === true && q.count >= 1 && q.results[0].kind, JSON.stringify(q).slice(0, 160))
  store.ingest({ sid: 's1', seq: 8, kind: 'user_turn', key: 'turn:8', value: { text: 'zzz ' + 'x'.repeat(2000) }, source: { sid: 's1', seq: 8 } })
  const long = await byName.memory_search.execute({ query: 'zzz' }, exec)
  check('④ search 单条值截到 800 字符', long.results[0]?.value?.text?.length <= 801, String(long.results[0]?.value?.text?.length))
  const g = await byName.memory_get.execute({ kind: 'file_state', key: 'file:/a' }, exec)
  check('④ get 按 kind+key 取记录', g.ok === true && g.record.value.size === 2, JSON.stringify(g).slice(0, 160))
  const none = await byName.memory_catalog.execute({}, { agent: null })
  check('④ 无会话作用域 ⇒ 明确拒绝', none.ok === false && none.error === 'no-session-scope', JSON.stringify(none))
  const miss = await byName.memory_get.execute({ kind: 'file_state', key: 'nope' }, exec)
  check('④ 未命中 ⇒ not-found', miss.ok === false && miss.error === 'not-found')
}

/* ── ⑤ raw 指针回解 ────────────────────────────────────────────────── */
{
  writeFileSync(join(rawDir, 'session-s1.jsonl'), JSON.stringify({ t: Date.now(), seq: 100, msg: { content: [{ type: 'text', text: 'raw-body-here' }] } }) + '\n', 'utf8')
  const r = store.resolveRaw('s1', 100)
  check('⑤ raw 指针可回解到原文预览', r.resolved === true && /raw-body-here/.test(r.preview), JSON.stringify(r))
  const miss = store.resolveRaw('s1', 999)
  check('⑤ 不存在的 seq ⇒ 明确未解析', miss.resolved === false && miss.reason === 'seq-not-in-raw', JSON.stringify(miss))
}

/* ── ⑥ 工作区作用域：跨会话共享事实 / 轮次隔离 / 旧库迁移 ───────────── */
{
  const ws = 'c:/proj/x'
  check('⑥ workspaceOf 取 header.cwd 并归一', workspaceOf({ header: { cwd: 'C:\\Proj\\X\\' } }) === 'c:/proj/x', workspaceOf({ header: { cwd: 'C:\\Proj\\X\\' } }))
  check('⑥ 无 cwd ⇒ null', workspaceOf({}) === null)
  check('⑥ 事实归工作区、轮次归会话', scopeOf('file_state', 's1', ws) === 'ws:' + ws && scopeOf('user_turn', 's1', ws) === 'sess:s1')

  const s = new MemoryStore(new DatabaseSync(join(root, 'scope.sqlite')), { stateDir: root, rawDir })
  const ing = new MemoryIngestor(s)
  const callEv = { type: 'tool/call', seq: 1, data: { callId: 'k1', name: 'read', arguments: JSON.stringify({ file_path: file }) } }
  const resEv = { type: 'tool/result', seq: 2, data: { message: { role: 'tool', toolCallId: 'k1', content: [{ type: 'text', text: 'abc' }] } } }
  const userEv = { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '端口 8742' }] } } }
  const sessionA = { header: { cwd: 'C:\\Proj\\X' }, ownEvents: () => [callEv, resEv, userEv] }
  ing.ingestSession(sessionA, 'sa')
  const inA = s.catalog({ sid: 'sa', scope: 'project', workspace: ws })
  check('⑥ A 的 project 视图含事实与轮次', inA.counts.some((c) => c.kind === 'file_state') && inA.counts.some((c) => c.kind === 'user_turn'), JSON.stringify(inA.counts))

  const inB = s.catalog({ sid: 'sb', scope: 'project', workspace: ws })
  check('⑥ 同工作区 B 会话可见 A 的文件事实', inB.counts.some((c) => c.kind === 'file_state'), JSON.stringify(inB.counts))
  check('⑥ B 会话看不到 A 的用户轮次', !inB.counts.some((c) => c.kind === 'user_turn'), JSON.stringify(inB.counts))
  check('⑥ B 用 session 作用域看不到本项目事实', s.catalog({ sid: 'sb', scope: 'session', workspace: ws }).total === 0)
  check('⑥ 换工作区 C 看不到本项目事实', s.catalog({ sid: 'sc', scope: 'project', workspace: 'c:/other' }).total === 0)

  const fact = s.search({ sid: 'sb', scope: 'project', workspace: ws, kind: 'file_state' }).results[0]
  s.ingest({ sid: 'sb', seq: 9, kind: 'file_state', key: fact.key, value: { size: 99 }, source: { sid: 'sb', seq: 9 }, scope: 'ws:' + ws, ts: 3000 })
  const rowCount = Number(s.db.prepare("SELECT COUNT(*) c FROM records WHERE scope=? AND kind='file_state'").get('ws:' + ws).c)
  check('⑥ 跨会话更新同一键 ⇒ 仍一行且取最新值', rowCount === 1
    && s.get({ sid: 'sa', scope: 'project', workspace: ws, kind: 'file_state', key: fact.key })?.value?.size === 99, String(rowCount))
  check('⑥ rowid 读取跨工作区被拒', s.get({ sid: 'sc', scope: 'project', workspace: 'c:/other', rowid: fact.rowid }) === null)
  s.close()

  // v1 库（records 无 scope）自动迁移。
  const odb = new DatabaseSync(join(root, 'v1.sqlite'))
  odb.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, sid TEXT NOT NULL, seq INTEGER, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, extractor TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1);
    CREATE TABLE records (rowid INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', updated_ts INTEGER NOT NULL, UNIQUE(sid,kind,key));
    CREATE VIRTUAL TABLE records_fts USING fts5(sid UNINDEXED, kind UNINDEXED, key UNINDEXED, value);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  odb.prepare("INSERT INTO records (sid,kind,key,value,source,status,updated_ts) VALUES ('old','command','cmd:x','{\"cmd\":\"hi\"}','{}','active',1)").run()
  odb.prepare("INSERT INTO records_fts(rowid,sid,kind,key,value) VALUES (1,'old','command','cmd:x','{\"cmd\":\"hi\"}')").run()
  odb.prepare("INSERT INTO events (dedupe,ts,sid,seq,kind,key,value,source,extractor,confidence) VALUES ('d',1,'old',1,'command','cmd:x','{}','{}','rule',1)").run()
  const migrated = new MemoryStore(odb, { stateDir: root, rawDir })
  check('⑥ v1 库自动迁移：scope 回填 sess:<sid>', migrated.catalog({ sid: 'old', scope: 'session' }).total === 1)
  check('⑥ 迁移后 FTS 仍可检索', migrated.search({ sid: 'old', scope: 'session', query: 'hi' }).results.length >= 1)
  check('⑥ 迁移后 events 有 scope 列', odb.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'scope'))
  migrated.close()
}

/* ── ⑦ 轻 LLM 编译层：解析 / 预算 / 游标 / 失败冷却 ──────────────────── */
{
  check('⑦ parseInsights 剥围栏并解析', parseInsights('```json\n{"insights":[{"key":"port","summary":"端口 8741","confidence":1.4}]}\n```')[0]?.summary === '端口 8741')
  check('⑦ 置信度夹到 [0,1]', parseInsights('{"insights":[{"key":"k","summary":"s","confidence":1.4}]}')[0]?.confidence === 1)
  check('⑦ 非法 key 被丢弃', parseInsights('{"insights":[{"key":"Bad Key!","summary":"s"},{"key":"ok","summary":"s"}]}').map((x) => x.key).join(',') === 'ok')
  check('⑦ 占位 key 被丢弃', parseInsights('{"insights":[{"key":"placeholder-do-not-copy","summary":"s"},{"key":"short-stable-slug","summary":"s"}]}').length === 0)
  check('⑦ 非 JSON ⇒ 空数组', parseInsights('sorry, I cannot').length === 0)
  check('⑦ 数字幻觉被拦：8840 ≠ 原文 8848', groundedInsight({ summary: '端口 8840' }, '端口 8848') === false)
  check('⑦ 数字逐字一致则保留', groundedInsight({ summary: '端口 8848' }, '端口 8848') === true)
  check('⑦ 条目上限', parseInsights('{"insights":[' + Array.from({ length: 9 }, (_, i) => `{"key":"k${i}","summary":"s"}`).join(',') + ']}', { max: 4 }).length === 4)
  check('⑦ 瞬时执行型 key 被丢弃', parseInsights('{"insights":[{"key":"pwsh-command-echo-x","summary":"ok"},{"key":"cmd:8b6f","summary":"ok"},{"key":"api-port","summary":"8848"}]}').map((x) => x.key).join(',') === 'api-port')
  check('⑦ 缺引号的 JSON 可修复解析', parseInsights('{"insights:[{"key":"k","summary":"s"}]}').length === 1)
  check('⑦ 缺引号的空数组不报错', parseInsights('{"insights:[]}').length === 0)
  {
    const rows = [
      { id: 1, seq: 1, kind: 'user_turn', key: 'turn:1', value: JSON.stringify({ text: 'now add this into memory: any model working on this device is a member of my family' }) },
      { id: 2, seq: 2, kind: 'user_turn', key: 'turn:2', value: JSON.stringify({ text: '记住：接口端口固定为 8848' }) },
      { id: 3, seq: 3, kind: 'user_turn', key: 'turn:3', value: JSON.stringify({ text: 'what tools do you have' }) },
      { id: 4, seq: 4, kind: 'user_turn', key: 'turn:4', value: JSON.stringify({ text: "I don't remember what the port was" }) },
    ]
    const di = explicitMemoryItems(rows)
    check('⑦ 显式记忆指令被确定性捕获', di.length === 2
      && di[0].summary === 'any model working on this device is a member of my family'
      && di[1].summary === '接口端口固定为 8848', JSON.stringify(di))
    check('⑦ 普通消息不误捕', explicitMemoryItems([rows[2], rows[3]]).length === 0)
  }
  check('⑦ 仅标点/空白差异的摘要可归并', mergeableInsight('项目接口端口固定为 8848。', '项目接口端口固定为8848') === true)
  check('⑦ 端口号不同不归并', mergeableInsight('项目接口端口固定为8848', '项目接口端口固定为8849') === false)
  {
    const longA = '项目接口端口固定为8848，测试时不要改动，部署环境同样使用该端口，文档里已经写明，任何人不得修改'
    const longB = '项目接口端口固定为8849，测试时不要改动，部署环境同样使用该端口，文档里已经写明，任何人不得修改'
    check('⑦ 长摘要仅数字不同：相似度高但数字闸拒绝归并', summarySimilarity(longA, longB) >= 0.86 && mergeableInsight(longA, longB) === false, summarySimilarity(longA, longB).toFixed(3))
  }
  check('⑦ 不同摘要不相似', summarySimilarity('端口固定 8848', '测试命令统一用 npm test') < 0.4)

  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, seq: i, kind: 'command', key: 'cmd:' + i, value: JSON.stringify({ cmd: 'x'.repeat(300) }) }))
  const dg = digestOf(rows, 1200)
  check('⑦ digest 预算内且保留最新事件', dg.length <= 1200 && dg.includes('#20 ') && !dg.includes('#1 '), dg.slice(0, 40))

  const s = new MemoryStore(new DatabaseSync(join(root, 'llm.sqlite')), { stateDir: root, rawDir })
  const ws = 'c:/proj/x'
  s.ingest({ sid: 'c1', seq: 1, kind: 'file_state', key: 'file:/a', scope: 'ws:' + ws, value: { size: 1 }, source: { sid: 'c1', seq: 1 } })
  s.ingest({ sid: 'c1', seq: 2, kind: 'command', key: 'cmd:1', scope: 'ws:' + ws, value: { cmd: 'npm test' }, source: { sid: 'c1', seq: 2 } })
  s.ingest({ sid: 'c1', seq: 3, kind: 'user_turn', key: 'turn:3', scope: 'sess:c1', value: { text: '测试命令固定用 npm test' }, source: { sid: 'c1', seq: 3 } })

  const reply = '{"insights":[{"key":"test-command","summary":"本项目测试统一用 npm test","confidence":0.9}]}'
  const okLlm = { stream: async function* () { yield { type: 'text-delta', text: reply }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const route = { provider: 'fake', model: 'tiny' }
  const comp = new MemoryCompiler(s)
  const r1 = await comp.compileSession({ sid: 'c1', workspace: ws, llm: okLlm, route })
  check('⑦ 编译成功写入 insight', r1.ok === true && r1.insights === 1, JSON.stringify(r1))
  const ins = s.search({ sid: 'c1', scope: 'project', workspace: ws, kind: 'insight', query: 'npm' })
  check('⑦ insight 落在工作区作用域且可检索', ins.results.length === 1 && ins.results[0].scope === 'ws:' + ws, JSON.stringify(ins.results[0]?.value))
  check('⑦ insight 带证据与模型来源', Array.isArray(ins.results[0]?.value?.evidence) && ins.results[0]?.value?.model === 'fake/tiny')
  check('⑦ 游标推进到已编译末尾', s.getMetaRaw('llmThrough:c1') === '3')
  const r2 = await comp.compileSession({ sid: 'c1', workspace: ws, llm: okLlm, route })
  check('⑦ 无新事件 ⇒ 不再调用', r2.ok === false && r2.reason === 'too-few', JSON.stringify(r2))

  const badLlm = { stream: async function* () { yield { type: 'text-delta', text: '{"insights":[]}' }; yield { type: 'finish', reason: { kind: 'error' } } } }
  s.ingest({ sid: 'c2', seq: 1, kind: 'command', key: 'cmd:2', scope: 'ws:' + ws, value: { cmd: 'ls' }, source: { sid: 'c2', seq: 1 } })
  s.ingest({ sid: 'c2', seq: 2, kind: 'user_turn', key: 'turn:2', scope: 'sess:c2', value: { text: '看看目录' }, source: { sid: 'c2', seq: 2 } })
  s.ingest({ sid: 'c2', seq: 3, kind: 'command', key: 'cmd:3', scope: 'ws:' + ws, value: { cmd: 'pwd' }, source: { sid: 'c2', seq: 3 } })
  const r3 = await comp.compileSession({ sid: 'c2', workspace: ws, llm: badLlm, route })
  check('⑦ 非 stop 结束 ⇒ 失败且不推进游标', r3.ok === false && r3.reason === 'llm-failed' && s.getMetaRaw('llmThrough:c2') === null, JSON.stringify(r3))
  const r4 = await comp.compileSession({ sid: 'c2', workspace: ws, llm: okLlm, route })
  check('⑦ 失败后进入冷却（候选保留）', r4.ok === false && r4.reason === 'cooldown', JSON.stringify(r4))

  const r5 = await comp.compileSession({ sid: 'c9', workspace: ws, llm: okLlm, route })
  check('⑦ 完全没有新事件不调用', r5.ok === false && r5.reason === 'too-few')

  // 纯对话会话一轮只产出一条 user_turn：不能因为 minEvents 把它挡在编译之外。
  {
    const s1 = new MemoryStore(new DatabaseSync(join(root, 'single.sqlite')), { stateDir: root, rawDir })
    s1.ingest({ sid: 's1', seq: 1, kind: 'user_turn', key: 'turn:1', scope: 'sess:s1', value: { text: '测试命令固定用 npm test' }, source: { sid: 's1', seq: 1 } })
    const r = await new MemoryCompiler(s1).compileSession({ sid: 's1', workspace: ws, route, llm: okLlm })
    check('⑦ 单条真人轮即可编译', r.ok === true && r.insights === 1 && s1.getMetaRaw('llmThrough:s1') === '1', JSON.stringify(r))
    s1.close()
  }

  // 小模型判定"闲聊"时，用户显式"写入记忆"的原话仍要落库。
  {
    const s2 = new MemoryStore(new DatabaseSync(join(root, 'directive.sqlite')), { stateDir: root, rawDir })
    const summary = 'any model working on this device is a member of my family'
    s2.ingest({ sid: 'd2', seq: 1, kind: 'user_turn', key: 'turn:1', scope: 'sess:d2', value: { text: 'now add this into memory: ' + summary }, source: { sid: 'd2', seq: 1 } })
    const emptyLlm = { stream: async function* () { yield { type: 'text-delta', text: '{"insights":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    const r = await new MemoryCompiler(s2).compileSession({ sid: 'd2', workspace: ws, route, llm: emptyLlm })
    const res = s2.search({ sid: 'd2', scope: 'project', workspace: ws, kind: 'insight' })
    check('⑦ 模型返回空时显式指令仍落库', r.ok === true && r.insights === 1
      && res.results.length === 1 && res.results[0].key.startsWith('user-memo:')
      && res.results[0].value.summary === summary, JSON.stringify({ r, key: res.results[0]?.key }))
    s2.close()
  }

  check('⑦ 无 route 明确跳过', (await comp.compileSession({ sid: 'c1', workspace: ws, llm: okLlm, route: null })).reason === 'no-route')

  /* ⑦b 归并：同批与跨轮近重复都收敛到一条当前视图，重复计数可观测 */
  {
    const m = new MemoryStore(new DatabaseSync(join(root, 'merge.sqlite')), { stateDir: root, rawDir })
    const mws = 'c:/proj/merge'
    const fake = (insights) => ({ stream: async function* () { yield { type: 'text-delta', text: JSON.stringify({ insights }) }; yield { type: 'finish', reason: { kind: 'stop' } } } })
    m.ingest({ sid: 'm1', seq: 1, kind: 'user_turn', key: 'turn:1', scope: 'sess:m1', value: { text: '接口端口固定为8848，别改。' }, source: { sid: 'm1', seq: 1 } })
    m.ingest({ sid: 'm1', seq: 2, kind: 'command', key: 'cmd:2', scope: 'ws:' + mws, value: { cmd: 'grep 8848 config' }, source: { sid: 'm1', seq: 2 } })
    const mc = new MemoryCompiler(m)
    const a = await mc.compileSession({ sid: 'm1', workspace: mws, route, llm: fake([
      { key: 'api-port', summary: '项目接口端口固定为 8848。', confidence: 0.7 },
      { key: 'service-port', summary: '项目接口端口固定为8848', confidence: 0.9 },
    ]) })
    const one = m.search({ sid: 'm1', scope: 'project', workspace: mws, kind: 'insight' })
    check('⑦b 同批近重复合并为一条', a.ok === true && a.insights === 1 && a.merged === 1, JSON.stringify(a))
    check('⑦b 合并保留长摘要与高置信度', one.results.length === 1 && one.results[0].key === 'api-port'
      && one.results[0].value.summary === '项目接口端口固定为 8848。' && one.results[0].value.confidence === 0.9,
      JSON.stringify(one.results[0]?.value))

    m.ingest({ sid: 'm1', seq: 3, kind: 'user_turn', key: 'turn:3', scope: 'sess:m1', value: { text: '再确认一次，端口还是8848。' }, source: { sid: 'm1', seq: 3 } })
    m.ingest({ sid: 'm1', seq: 4, kind: 'command', key: 'cmd:4', scope: 'ws:' + mws, value: { cmd: 'echo 8848' }, source: { sid: 'm1', seq: 4 } })
    const b = await mc.compileSession({ sid: 'm1', workspace: mws, route, llm: fake([
      { key: 'service-port', summary: '项目接口端口固定为8848。', confidence: 0.8 },
    ]) })
    const two = m.search({ sid: 'm1', scope: 'project', workspace: mws, kind: 'insight' })
    check('⑦b 跨 key 近重复收敛到已有 key', b.ok === true && b.merged === 1 && two.results.length === 1
      && two.results[0].key === 'api-port' && !two.results.some((x) => x.key === 'service-port'),
      JSON.stringify({ r: b, keys: two.results.map((x) => x.key) }))
    check('⑦b 每轮归并只写一条 insight 事件（两轮共 2 条）', m.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='insight'").get().n === 2,
      String(m.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='insight'").get().n))
    m.close()

    // 数字闸：文本几乎相同、仅一个数字不同 ⇒ 视为两条事实，不归并。
    const m2 = new MemoryStore(new DatabaseSync(join(root, 'merge2.sqlite')), { stateDir: root, rawDir })
    m2.ingest({ sid: 'm2', seq: 1, kind: 'user_turn', key: 'turn:1', scope: 'sess:m2', value: { text: '接口端口 8848 或 8849 都出现过。' }, source: { sid: 'm2', seq: 1 } })
    m2.ingest({ sid: 'm2', seq: 2, kind: 'command', key: 'cmd:2', scope: 'ws:' + mws, value: { cmd: 'grep -E "8848|8849" config' }, source: { sid: 'm2', seq: 2 } })
    const mc2 = new MemoryCompiler(m2)
    const c = await mc2.compileSession({ sid: 'm2', workspace: mws, route, llm: fake([
      { key: 'port-a', summary: '项目接口端口固定为8848，测试时不要改动，部署环境同样使用该端口，文档里已经写明，任何人不得修改', confidence: 0.8 },
      { key: 'port-b', summary: '项目接口端口固定为8849，测试时不要改动，部署环境同样使用该端口，文档里已经写明，任何人不得修改', confidence: 0.8 },
    ]) })
    const three = m2.search({ sid: 'm2', scope: 'project', workspace: mws, kind: 'insight' })
    check('⑦b 仅数字不同不归并（两条独立事实）', c.ok === true && c.insights === 2 && c.merged === 0 && three.results.length === 2,
      JSON.stringify({ r: c, keys: three.results.map((x) => x.key) }))
    m2.close()
  }

  const dg2 = catalogDigest(s, { sid: 'c1', workspace: ws })
  check('⑧ 目录只含语义摘要（无 kind/计数/key）', dg2.startsWith('Known project memory') && dg2.includes('npm test')
    && !/records/.test(dg2) && !dg2.includes('test-command') && !dg2.includes('user_turn') && !dg2.includes('cmd:'), dg2)
  check('⑧ 目录摘要不超过 700 字符', dg2.length <= 700, String(dg2.length))
  check('⑧ 空库不产目录', catalogDigest(s, { sid: 'nobody', workspace: 'c:/nope' }) === '')
  {
    const bare = new MemoryStore(new DatabaseSync(join(root, 'bare.sqlite')), { stateDir: root, rawDir })
    bare.ingest({ sid: 'b1', seq: 1, kind: 'file_state', key: 'file:/b', scope: 'ws:c:/proj/bare', value: { size: 1 }, source: { sid: 'b1', seq: 1 } })
    check('⑧ 只有原始记录、没有 insight ⇒ 不注入', catalogDigest(bare, { sid: 'b1', workspace: 'c:/proj/bare' }) === '')
    bare.close()
  }
  s.close()
}

/* ── ⑨ 生命周期：错误消解 / 状态过滤 / 文件新鲜度 ───────────────────── */
{
  const s = new MemoryStore(new DatabaseSync(join(root, 'life.sqlite')), { stateDir: root, rawDir })
  const ing = new MemoryIngestor(s)
  const ws = 'c:/proj/life'
  const mk = (seq, isError) => [
    { type: 'tool/call', seq: seq - 1, data: { callId: 'k' + seq, name: 'read', arguments: JSON.stringify({ file_path: file }) } },
    { type: 'tool/result', seq, data: { message: { role: 'tool', toolCallId: 'k' + seq, isError, content: [{ type: 'text', text: isError ? 'Error: ENOENT' : 'abc' }] } } },
  ]
  const calls = new Map()
  for (const ev of mk(10, true)) ing.processEvent('s1', ev, calls, { workspace: ws })
  const err = s.search({ sid: 's1', scope: 'project', workspace: ws, kind: 'error' })
  check('⑨ 失败 ⇒ error 记录 active', err.results.length === 1 && err.results[0].status === 'active', JSON.stringify(err.results[0]?.key))

  for (const ev of mk(12, false)) ing.processEvent('s1', ev, calls, { workspace: ws })
  check('⑨ 同类调用成功 ⇒ 错误自动 resolved（默认检索隐藏）',
    s.search({ sid: 's1', scope: 'project', workspace: ws, kind: 'error' }).results.length === 0)
  const all = s.search({ sid: 's1', scope: 'project', workspace: ws, kind: 'error', status: 'all' })
  check('⑨ status:all 仍可见并带 resolvedBy',
    all.results.length === 1 && all.results[0].status === 'resolved' && all.results[0].value.resolvedBy === 12,
    JSON.stringify(all.results[0]?.value))

  const rec = s.get({ sid: 's1', scope: 'project', workspace: ws, kind: 'file_state', key: 'file:' + normPath(file).toLowerCase() })
  check('⑨ 文件未变 ⇒ changed=false', s.freshness(rec)?.changed === false, JSON.stringify(s.freshness(rec)))
  writeFileSync(file, 'abcd', 'utf8')
  check('⑨ 文件变化 ⇒ changed=true', s.freshness(rec)?.changed === true)
  const byName = Object.fromEntries(makeMemoryTools(s).map((t) => [t.name, t]))
  const exec = { agent: { session: { id: 's1', header: { cwd: 'C:\Proj\Life' } } } }
  const g = await byName.memory_get.execute({ kind: 'file_state', key: rec.key }, exec)
  check('⑨ memory_get 返回 fresh 标记', g.ok === true && g.fresh?.changed === true, JSON.stringify(g.fresh))
  writeFileSync(file, 'abc', 'utf8')
  s.close()
}

store.close()
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
