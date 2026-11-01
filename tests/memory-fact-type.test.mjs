// 事实类型改由出处决定（摘要措辞只作次级信号），并与注入门闭环。
// 背景（实测）：纯措辞判据把 "SCAN_ROOT 环境变量…" 判成 constraint（易失东西升格为长期规则），
// 把用户的设计立场判成 task（长期东西被挡在注入面外）。加了单一准入门以后，后者会真的丢失，
// 所以这条必须一起修。
// 运行：node tests/memory-fact-type.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, MemoryCompiler, deriveFactType, buildHandover, isInjectableFactType } from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

// ① 判定表
const U = '基础设计要包含卡点装置和生物工程属性，符合原有美术风格'
const T = '{"cmd":"python grid_audit.py --root D:\\\\work","head":"SCAN_ROOT 指向 D:/work/工业区"}'
check('① 只被工具输出支撑的"约束"降为易失状态',
  deriveFactType('SCAN_ROOT环境变量指向 work/工业区 目录', { userText: U, proposed: 'constraint' }) === 'state',
  deriveFactType('SCAN_ROOT环境变量指向 work/工业区 目录', { userText: U, proposed: 'constraint' }))
check('① 工具输出的"未找到"不再当成历史结论',
  deriveFactType('AGENTS.md 文件未找到，搜索无结果', { userText: U, proposed: 'history' }) === 'state',
  deriveFactType('AGENTS.md 文件未找到，搜索无结果', { userText: U, proposed: 'history' }))
check('① 用户自己的立场从 task 升为 constraint',
  deriveFactType('用户强调基础设计应包含卡点装置和生物工程属性', { userText: U, proposed: 'task' }) === 'constraint',
  deriveFactType('用户强调基础设计应包含卡点装置和生物工程属性', { userText: U, proposed: 'task' }))
check('① 明写待办的仍留在 task（不许被拔高）',
  deriveFactType('用户要求下一步实现卡点装置的导出', { userText: '下一步实现卡点装置的导出', proposed: 'task' }) === 'task',
  deriveFactType('用户要求下一步实现卡点装置的导出', { userText: '下一步实现卡点装置的导出', proposed: 'task' }))
check('① 用户给出的当前状态不被改写',
  deriveFactType('接口端口固定为 8848', { userText: '接口端口固定为 8848', proposed: 'state' }) === 'state')
check('① 升格后的立场确实可注入（与单一准入门闭环）',
  isInjectableFactType(deriveFactType('用户强调基础设计应包含卡点装置和生物工程属性', { userText: U, proposed: 'task' })))

// ② 端到端：同批两条，一条来自命令输出、一条来自用户的话
const root = mkdtempSync(join(tmpdir(), 'rcs-ftype-'))
const ws = 'c:/proj/ftype'
const store = new MemoryStore(new DatabaseSync(join(root, 'ftype.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
const sid = 'ft1'
const put = (rec) => store.ingest({ scope: 'ws:' + ws, ...rec })
put({ sid, seq: 1, kind: 'user_turn', key: 'u1', value: { text: U }, source: { sid, seq: 1 } })
put({ sid, seq: 2, kind: 'command', key: 'cmd:2', value: JSON.parse(JSON.stringify({ cmd: T, status: 'OK' })), source: { sid, seq: 2 } })

const llm = {
  stream: async function* () {
    yield {
      type: 'text-delta',
      text: '{"insights":['
        + '{"key":"scan-root","summary":"SCAN_ROOT 指向 D:/work/工业区","confidence":0.9,"type":"constraint"},'
        + '{"key":"user-design-preference","summary":"用户强调基础设计应包含卡点装置和生物工程属性","confidence":0.95,"type":"task"}'
        + ']}',
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const compiler = new MemoryCompiler(store, { foldGraceMs: 0, maxEvents: 40 })
const r = await compiler.compileSession({ sid, workspace: ws, llm, route: { provider: 'ollama-local', model: 'qwen3:4b' } })
const row = (key) => store.db.prepare('SELECT fact_type FROM records WHERE kind=\'insight\' AND key=?').get(key)?.fact_type
check('② 编译成功且两条都落库', r.ok === true && r.insights === 2, JSON.stringify(r))
check('② 命令来源的"约束"被降为 state', row('scan-root') === 'state', row('scan-root'))
check('② 用户立场被升为 constraint', row('user-design-preference') === 'constraint', row('user-design-preference'))
check('② 调整计数上报', r.typeAdjusted === 2, r.typeAdjusted)

// ③ 单一准入门 + 新类型 ⇒ 立场进入交接卡，工具快照也在（state 可注入但会随目录重置失效）
const h = buildHandover(store, { sid, workspace: ws })
const keys = h.insights.map((x) => x.key)
check('③ 立场出现在交接卡里（没有因为改判而丢失）', keys.includes('user-design-preference'), JSON.stringify(keys))

store.db.close()
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
