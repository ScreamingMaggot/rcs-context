// 交接卡的溯源：证据指针必须能被 dereference，水位必须只代表本会话。
// 背景（实测）：workspace 级事实会跨会话共享，但 evidence 渲染的是全局 events.id、
// throughSeq 取的是所有记录（含别的会话）的 max ⇒ f5026a65 报 "through seq 3176" 而自身只到 1843，
// 并举出 [2678,2679,2680] 这种在本会话里根本不存在的"seq"。
// 运行：node tests/memory-handover-provenance.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, buildHandover, handoverMarkdown } from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const root = mkdtempSync(join(tmpdir(), 'rcs-prov-'))
const ws = 'c:/proj/provenance'
const s = new MemoryStore(new DatabaseSync(join(root, 'prov.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
const put = (rec) => s.ingest({ scope: 'ws:' + ws, ...rec })
const eventId = (sid, seq) => Number(s.db.prepare('SELECT id FROM events WHERE sid=? AND seq=?').get(sid, seq)?.id ?? 0)

// 会话 b（另一场对话）里的高水位事件与它自己的 insight。
put({ sid: 'b', seq: 500, kind: 'command', key: 'cmd:500', value: { cmd: 'python out/grid_audit.py', status: 'OK', exit: '0' }, source: { sid: 'b', seq: 500 } })
put({ sid: 'b', seq: 501, kind: 'file_state', key: 'file:proof/grid_audit.log', value: { path: 'proof/grid_audit.log', action: 'read' }, source: { sid: 'b', seq: 501 } })
const bTokens = [eventId('b', 500), eventId('b', 501)].filter((x) => x > 0)
put({ sid: 'b', seq: 502, kind: 'insight', key: 'grid-audit', value: { summary: 'grid_audit.log 位于 proof 目录下', confidence: 0.9, evidence: bTokens }, source: { sid: 'b', seq: 502 } })

// 会话 a 自己的低水位内容。
put({ sid: 'a', seq: 10, kind: 'user_turn', key: 'turn:10', scope: 'sess:a', value: { text: '先把场景拆成四层' }, source: { sid: 'a', seq: 10 } })
put({ sid: 'a', seq: 20, kind: 'file_state', key: 'file:scripts/dw_sets.py', value: { path: 'scripts/dw_sets.py', action: 'edit' }, source: { sid: 'a', seq: 20 } })

const h = buildHandover(s, { sid: 'a', workspace: ws })

// ① 水位只代表本会话：a 自身最大 seq 是 20，绝不能报成 b 的 500+。
check('① throughSeq 不被别的会话污染', h.throughSeq !== null && h.throughSeq <= 20, `throughSeq=${h.throughSeq}`)
const hb = buildHandover(s, { sid: 'b', workspace: ws })
check('① 同一 workspace 下另一会话的水位是它自己的', hb.throughSeq >= 500, `throughSeq=${hb.throughSeq}`)

// ② 证据指针必须带所属会话，且 (sid, seq) 真的能在事件流里查到。
const shared = h.insights.find((x) => x.key === 'grid-audit') ?? hb.insights.find((x) => x.key === 'grid-audit')
check('② 事实出现在同 workspace 的会话交接里', Boolean(shared), JSON.stringify(h.insights.map((x) => x.key)))
const pts = shared?.evidence ?? []
check('② 指针不是裸数字，而是 (会话, seq)',
  pts.length > 0 && pts.every((p) => p && typeof p === 'object' && p.sid && Number.isFinite(p.seq)),
  JSON.stringify(pts))
check('② 指针标明真实归属（b 而非读它的 a）',
  pts.every((p) => String(p.sid) === 'b'), JSON.stringify(pts.map((p) => p.sid)))
check('② 每个指针都能 dereference 到一条真实事件',
  pts.every((p) => Number(s.db.prepare('SELECT COUNT(*) c FROM events WHERE sid=? AND seq=?').get(p.sid, p.seq).c) === 1),
  JSON.stringify(pts))
check('② 指针 seq 落在 b 的事件区间、且不在 a 的区间里（避免误读成本会话 seq）',
  pts.every((p) => p.seq >= 500), JSON.stringify(pts.map((p) => p.seq)))

// ③ markdown 渲染出的必须是可核对的坐标，而不是一串会被当成本会话 seq 的数字。
const md = handoverMarkdown(h)
const line = (md.split('\n').find((l) => l.includes('grid_audit')) ?? '')
check('③ 渲染成 sid8#seq 形式', /evidence b#5\d\d/.test(line), line)
check('③ 不再输出裸 id 列表', !/\[evidence \d{3,}(,\d{3,})*\]/.test(md), line)

// ④ 旧 JSON（token 还是裸 id）仍要渲染得出去，不能崩或留空。
const legacy = { ...h, insights: [{ key: 'grid-audit', summary: '旧格式事实', confidence: 0.8, evidence: bTokens, seq: 502 }] }
const legacyMd = handoverMarkdown(legacy)
check('④ 旧形状 token 仍可渲染', legacyMd.includes('旧格式事实') && /\[evidence \d+/.test(legacyMd), legacyMd.split('\n').find((l) => l.includes('旧格式事实')))

s.db.close()
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
