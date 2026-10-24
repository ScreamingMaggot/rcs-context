// 事实生命周期：类型、重置失效、文件巡检、自动注入面。
// 运行：node tests/memory-lifecycle.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  MemoryStore, inferFactType, isDestructiveCommand, parseInsights, buildRecallHint,
} from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const root = mkdtempSync(join(tmpdir(), 'rcs-life-'))
const WS = 'c:/proj/life'
const store = new MemoryStore(new DatabaseSync(join(root, 'm.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
const seed = (key, summary, ts, extra = {}) => store.ingest({
  sid: 's1', seq: extra.seq ?? 1, kind: 'insight', key, scope: 'ws:' + WS,
  value: { summary, confidence: 0.9, ...extra.value }, source: { sid: 's1', seq: extra.seq ?? 1 },
  extractor: 'seed', confidence: 0.9, ts,
})

// ① 类型推断
{
  check('① 端口=约束', inferFactType('接口端口固定为 8848。') === 'constraint', inferFactType('接口端口固定为 8848。'))
  check('① 目录=状态', inferFactType('工作区包含 COMP 子目录与尸检.py。') === 'state')
  check('① 删除经过=历史', inferFactType('用户确认删除全部内容，包含子目录一起删除。') === 'history')
  check('① 未完成计划=意图', inferFactType('下一步打算创建工作区域和娱乐区域。') === 'task')
  check('① 用户认知=历史', inferFactType('用户已认知工作区结构与内容，包括子目录、文件类型及中文短故事与模型分析脚本') === 'history')
  check('① 强约束压过用户认知', inferFactType('用户已了解端口固定为 8848。') === 'constraint')
  check('① 显式类型优先', inferFactType('任意文本', { type: 'constraint' }) === 'constraint')
}

// ② 破坏性命令识别
{
  check('② Remove-Item 成功=重置', isDestructiveCommand("Remove-Item -LiteralPath 'C:\\x' -Recurse", { status: 'OK', exit: 0 }))
  check('② rm -rf=重置', isDestructiveCommand('rm -rf ./build', { status: 'OK' }))
  check('② git clean=重置', isDestructiveCommand('git clean -fdx', { status: 'OK' }))
  check('② 失败命令不算', isDestructiveCommand('Remove-Item -LiteralPath x', { status: 'FAILED', exit: 1 }) === false)
  check('② 只读命令不算', isDestructiveCommand('Get-ChildItem -LiteralPath .', { status: 'OK', exit: 0 }) === false)
  check('② REMOVING 输出也算', isDestructiveCommand('custom.ps1', { status: 'OK', exit: 0, head: 'REMOVING: C:\\x\\old' }))
}

// ③ 运行时重置：只失效重置前的 state
{
  const t0 = Date.now() - 10_000
  const tReset = Date.now() - 5_000
  seed('old-state', '工作区包含 COMP 子目录与旧脚本。', t0, { seq: 1 })
  seed('port-constraint', '接口端口固定为 8848。', t0, { seq: 2 })
  seed('old-task', '下一步打算创建娱乐区域。', t0, { seq: 3 })
  seed('old-history', '用户确认删除全部内容。', t0, { seq: 4 })
  store.ingest({
    sid: 's1', seq: 5, kind: 'command', key: 'cmd:reset', scope: 'ws:' + WS,
    value: { cmd: "Remove-Item -LiteralPath 'C:\\proj\\old' -Recurse -Force", status: 'OK', exit: 0 },
    source: { sid: 's1', seq: 5 }, extractor: 'rule', ts: tReset,
  })
  seed('new-state', '工作区包含 工作区域 与 娱乐区域。', Date.now() - 1_000, { seq: 6 })

  const st = (key) => store.db.prepare("SELECT status FROM records WHERE scope=? AND kind='insight' AND key=?").get('ws:' + WS, key)?.status
  check('③ 旧状态被标为 historical', st('old-state') === 'historical', st('old-state'))
  check('③ 约束不受重置影响', st('port-constraint') === 'active', st('port-constraint'))
  check('③ 重置后的新状态保留', st('new-state') === 'active', st('new-state'))
  check('③ 重置标记已写入', store.lastResetAt(WS) === tReset, store.lastResetAt(WS))

  const keys = store.insights('ws:' + WS, 20).map((x) => x.key).sort()
  check('③ 目录只给 state+constraint', JSON.stringify(keys) === JSON.stringify(['new-state', 'port-constraint']), JSON.stringify(keys))
  const all = store.insights('ws:' + WS, 20, { types: null }).map((x) => x.key).sort()
  check('③ 显式取全部仍能拿到 task/history', all.includes('old-task') && all.includes('old-history'), JSON.stringify(all))

  const r = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '工作区包含什么？' })
  check('③ 召回不带 task/history', !r || !r.keys.includes('old-task') && !r.keys.includes('old-history'), JSON.stringify(r?.keys))
  const s = store.search({ sid: 's1', scope: 'project', workspace: WS, query: '删除', status: 'all' })
  const hist = s.results.find((x) => x.key === 'old-history')
  check('③ status=all 可查历史并带类型', !!hist && hist.factType === 'history', JSON.stringify(hist?.factType))
}

// ④ 迁移扫描：已有库里的破坏性命令（未走 ingest 钩子）由 sweep 补记
{
  const legacyWs = 'c:/proj/legacy'
  const t0 = Date.now() - 20_000
  store.ingest({
    sid: 's9', seq: 1, kind: 'insight', key: 'legacy-state', scope: 'ws:' + legacyWs,
    value: { summary: '工作区包含 COMP 目录。', confidence: 0.9 }, source: { sid: 's9', seq: 1 }, extractor: 'seed', ts: t0,
  })
  store.db.prepare(`INSERT INTO records (sid, scope, kind, key, value, source, status, updated_ts, fact_type)
    VALUES ('s9', ?, 'command', 'cmd:legacy', ?, '{"sid":"s9","seq":2}', 'active', ?, '')`)
    .run('ws:' + legacyWs, JSON.stringify({ cmd: 'Remove-Item -LiteralPath .\\COMP -Recurse', status: 'OK', exit: 0 }), Date.now() - 10_000)
  const out = store.sweep({ workspace: legacyWs })
  check('④ sweep 从历史命令补出 reset', out.resets === 1, out.resets)
  check('④ 迁移后旧状态失效', store.db.prepare("SELECT status FROM records WHERE key='legacy-state'").get()?.status === 'historical')
  const again = store.sweep({ workspace: legacyWs })
  check('④ sweep 幂等', again.resets === 0 && again.invalidated === 0, JSON.stringify(again))
}

// ⑤ 文件巡检：存在的保留，缺失的标 stale
{
  const fw = 'c:/proj/files'
  const good = join(root, 'good.md')
  writeFileSync(good, 'hello')
  store.ingest({
    sid: 's2', seq: 1, kind: 'file_state', key: 'file:good', scope: 'ws:' + fw,
    value: { path: good, action: 'write', status: 'OK' }, source: { sid: 's2', seq: 1 }, extractor: 'rule', ts: Date.now(),
  })
  store.ingest({
    sid: 's2', seq: 2, kind: 'file_state', key: 'file:gone', scope: 'ws:' + fw,
    value: { path: join(root, 'gone.md'), action: 'write', status: 'OK' }, source: { sid: 's2', seq: 2 }, extractor: 'rule', ts: Date.now(),
  })
  const out = store.sweep({ workspace: fw })
  check('⑤ 缺失文件标 stale', out.stale === 1, JSON.stringify(out))
  const st = (key) => store.db.prepare("SELECT status FROM records WHERE key=?").get(key)?.status
  check('⑤ 存在文件保持 active', st('file:good') === 'active', st('file:good'))
  check('⑤ 缺失文件为 stale', st('file:gone') === 'stale', st('file:gone'))
}

// ⑥ 编译输出类型
{
  const got = parseInsights('{"insights":[{"key":"api-port","summary":"接口端口固定 8848","confidence":0.9,"type":"constraint"}]}')
  check('⑥ 编译 type 被保留', got[0]?.type === 'constraint', got[0]?.type)
  const def = parseInsights('{"insights":[{"key":"dir-note","summary":"工作区包含 COMP 目录","confidence":0.8}]}')
  check('⑥ 缺 type 时按摘要推断', def[0]?.type === 'state', def[0]?.type)
}

store.close()
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
