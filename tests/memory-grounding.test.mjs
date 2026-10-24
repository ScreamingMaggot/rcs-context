// 1–2 位数字的上下文闸：端口/行号/版本/时长/次数必须与原文同槽位吻合；
// 没有语义槽位的短数字只计量、不误杀。
// 运行：node tests/memory-grounding.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = mkdtempSync(join(tmpdir(), 'rcs-ground-'))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = root
const { MemoryStore, MemoryCompiler, groundedInsight, groundingReport, mergeableInsight, COMPILE_SYSTEM } = await import('../web/memory.mjs')

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

// ① ≥3 位数字：行为不变。
check('① 大数字逐字一致通过', groundedInsight({ summary: '接口端口固定为 8848' }, '端口固定为 8848，不要改'))
check('① 大数字抄错被拒', !groundedInsight({ summary: '接口端口固定为 8840' }, '端口固定为 8848'),
  groundingReport({ summary: '接口端口固定为 8840' }, '端口固定为 8848').reason)

// ② 端口：2 位数字按上下文校验，允许中英文关键字互换。
check('② 端口 80 与原文 port 80 互通', groundedInsight({ summary: '服务端口固定为 80' }, 'server listens on port 80'),
  JSON.stringify(groundingReport({ summary: '服务端口固定为 80' }, 'server listens on port 80')))
check('② 端口 80 被抄成 81 拒绝', !groundedInsight({ summary: '服务端口固定为 81' }, 'server listens on port 80'))
check('② 数字只出现在无关位置不算（第 80 行 ≠ 端口 80）',
  !groundedInsight({ summary: '服务端口是 80' }, '第80行\n注意：端口是 8080'))
check('② 数字在端口关键字之后也认', groundedInsight({ summary: '80 是服务端口' }, 'listen: 80'))

// ③ 行号。
check('③ 第 12 行与 line 12 互通', groundedInsight({ summary: '第 12 行是配置入口' }, 'config entry at line 12'))
check('③ 行号被改拒绝', !groundedInsight({ summary: '第 13 行是配置入口' }, 'config entry at line 12'))

// ④ 版本。
check('④ 版本 2 与 version 2 互通', groundedInsight({ summary: '接口版本 2 已冻结' }, 'API version 2 is frozen'))
check('④ 版本被改拒绝', !groundedInsight({ summary: '接口版本 3 已冻结' }, 'API version 2 is frozen'))

// ⑤ 时长/次数。
check('⑤ 超时 30 秒校验通过', groundedInsight({ summary: '请求超时 30 秒' }, 'timeout: 30 秒'))
check('⑤ 超时被改拒绝', !groundedInsight({ summary: '请求超时 45 秒' }, 'timeout: 30 秒'))
check('⑤ 重试 3 次校验通过', groundedInsight({ summary: '失败重试 3 次' }, '重试 3 次后报错'))

// ⑥ 无槽位短数字：只计量，不误杀。
{
  const rep = groundingReport({ summary: '产物是 a7 格式' }, '产物是 a7 格式')
  check('⑥ 无上下文短数字通过', rep.ok === true, JSON.stringify(rep))
  check('⑥ 无上下文短数字进入 unchecked', rep.unchecked.includes('7') && rep.checked.length === 0, JSON.stringify(rep))
}
{
  const rep = groundingReport({ summary: '端口 80，共 2 步' }, 'port 80, 共 2 步')
  check('⑥ 有槽位的进 checked、无槽位的进 unchecked', rep.ok && rep.checked.includes('80') && rep.unchecked.includes('2'), JSON.stringify(rep))
}

// ⑦ 归并：只有 1–2 位数字不同的两条事实不得合并。
check('⑦ 端口 80/81 相似但不归并', !mergeableInsight('服务端口固定为 80', '服务端口固定为 81'))
check('⑦ 数字一致才归并', mergeableInsight('服务端口固定为 80', '服务端口固定为 80'))

// ⑧ 编译层：抄错的端口被丢弃，正确的保留，未校验短数字计入 smallUnchecked。
{
  const sid = 'session-ground1'
  const store = new MemoryStore(new DatabaseSync(join(root, 'g.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
  store.ingest({ sid, seq: 1, kind: 'user_turn', key: 'u1', value: { text: '服务端口固定为 80，回答里写 a7 格式' }, source: { sid, seq: 1 } })
  const text = JSON.stringify({
    insights: [
      { key: 'port-fixed', summary: '服务端口固定为 80', confidence: 0.9 },
      { key: 'port-wrong', summary: '服务端口固定为 81', confidence: 0.9 },
      { key: 'format-a7', summary: '产物写 a7 格式', confidence: 0.7 },
    ],
  })
  const llm = {
    stream: async function* () {
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const c = new MemoryCompiler(store, { foldGraceMs: 0 })
  const r = await c.compileSession({ sid, llm, route: { provider: 'ollama-local', model: 'qwen3:4b' }, workspace: 'c:/proj/g' })
  const ins = store.insights('ws:c:/proj/g', 10)
  check('⑧ 正确端口条目保留', r.ok && ins.some((x) => x.key === 'port-fixed'), JSON.stringify(r))
  check('⑧ 抄错的端口条目被丢弃', r.dropped === 1 && !ins.some((x) => x.key === 'port-wrong'), JSON.stringify({ dropped: r.dropped }))
  check('⑧ 结果带 smallUnchecked 计量', r.smallUnchecked === 1, JSON.stringify({ smallUnchecked: r.smallUnchecked }))
  check('⑧ llmLast 也记录 smallUnchecked', String(store.getMetaRaw('llmLast:ground1')).includes('smallUnchecked'))
}

// ⑨ 系统提示里的示例事实不得被照抄成记忆；无数字/标识符的摘要必须有原文文本支撑。
{
  const sid = 'session-ground2'
  const store = new MemoryStore(new DatabaseSync(join(root, 'g2.sqlite')), { stateDir: root, rawDir: join(root, 'raw2') })
  store.ingest({ sid, seq: 1, kind: 'user_turn', key: 'u1', value: { text: '一步步来吧，先1' }, source: { sid, seq: 1 } })
  store.ingest({
    sid, seq: 2, kind: 'command', key: 'cmd:1',
    value: { action: 'pwsh', cmd: 'node verify.mjs 课表.html', status: 'OK', out_n: 2, head: '课表.html 58/58 全部通过' },
    source: { sid, seq: 2 },
  })
  const text = JSON.stringify({
    insights: [
      { key: 'canary-ratio', summary: '灰度发布初始比例为 5%', confidence: 0.8, type: 'constraint' },
      { key: 'timetable-page', summary: '课表页面文件是 课表.html', confidence: 0.9, type: 'state' },
    ],
  })
  const llm = {
    stream: async function* () {
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const c = new MemoryCompiler(store, { foldGraceMs: 0 })
  const r = await c.compileSession({ sid, llm, route: { provider: 'ollama-local', model: 'qwen3:4b' }, workspace: 'c:/proj/g2' })
  const ins = store.insights('ws:c:/proj/g2', 10)
  check('⑨ 照抄示例/无原文支撑的事实被丢弃', r.dropped === 1 && !ins.some((x) => x.key === 'canary-ratio'), JSON.stringify({ r, keys: ins.map((x) => x.key) }))
  check('⑨ 有原文支撑的散文事实保留', ins.some((x) => x.key === 'timetable-page'), JSON.stringify(ins.map((x) => x.key)))
  check('⑨ 编译提示不含可照抄的示例事实', !COMPILE_SYSTEM.includes('灰度发布初始比例为 5%'))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
