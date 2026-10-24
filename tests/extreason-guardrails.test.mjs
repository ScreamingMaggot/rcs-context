// EXTREASON（外部思考）护栏回归测试 —— 守汇报第 5 页承诺的三条边界与简报口径。
//   被守住的主张：
//     · 只给只读工具：推理子会话拿不到任何写/执行类工具（"核查过程不写任何文件"）
//     · 预算：整轮 45s 硬掐断、工具调用满 8 次引导收尾
//     · 简报体积上限 8000 字符 / 40 条 / 单行 1200，且**裁剪绝不静默**
//     · 简报行必须规范化成 `[R] `（带空格）—— 注入器与转录器都按 `/^\[R\] /` 抓，
//       不规范化会出现"进了请求却没进 append-only 转录"的两边不一致
//     · 摘要上限 =0 必须**真的不发**（旧实现 slice(-0) 反而发全量，是修过的病灶）
//   运行：node tests/extreason-guardrails.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-ext-'))
mkdirSync(join(root, 'state-a'), { recursive: true })
mkdirSync(join(root, 'state-b'), { recursive: true })
mkdirSync(join(root, 'state-c'), { recursive: true })

// 内部常量/函数未导出 ⇒ 复制一份并在末尾追加导出（不改动仓库源文件）
const EXPORTS = '\nexport const __t = { READONLY, subagentStartKind, PERSONA, groundBriefRows, TURN_TIMEOUT_MS, TOOL_TIMEOUT_MS, STEER_AT,'
  + ' MAX_BRIEF_CHARS, MAX_BRIEF_ROWS, MAX_BRIEF_ROW, CHILD_LABEL, DIGEST_ON, DIGEST_CLAMP,'
  + ' parseBriefRows, extractTargets, buildDigest, maxSeqOf, toolResultInfo, pickChildBrief, trivialContinuation, IDLE_SKIP }\n'
const src = readFileSync(join(SRC, 'web', 'extreason.mjs'), 'utf8')
writeFileSync(join(root, 'ext-a.mjs'), src + EXPORTS, 'utf8')
writeFileSync(join(root, 'ext-b.mjs'), src + EXPORTS, 'utf8')
writeFileSync(join(root, 'ext-c.mjs'), src + EXPORTS, 'utf8')

const load = async (file, env) => {
  const saved = {}
  for (const k of ['EXTREASON_STATE_DIR', 'EXTREASON_TURN_TIMEOUT', 'EXTREASON_STEER_AT',
    'EXTREASON_MAX_ROWS', 'EXTREASON_MAX_BRIEF', 'EXTREASON_DIGEST_MAX', 'EXTREASON_TOOL_TIMEOUT']) {
    saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]
  }
  const mod = await import(pathToFileURL(join(root, file)).href)
  for (const k in saved) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  return mod.__t
}
const A = await load('ext-a.mjs', { EXTREASON_STATE_DIR: join(root, 'state-a') })
let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

/* ──  只读边界：白名单里不许混进任何写/执行类工具 ─────────────────────── */
const WRITEISH = ['write', 'edit', 'str_replace', 'multiedit', 'notebook_edit', 'pwsh', 'bash', 'shell',
  'todo_write', 'task_create', 'task_update', 'subagent', 'report', 'create_goal', 'update_goal',
  'delete_file', 'apply_patch', 'web_upload', 'browser_click', 'browser_type']
check('① 白名单逐项固定（改动须显式写理由）',
  A.READONLY.join(',') === 'read,glob,grep,web_search,memory_catalog,memory_search,memory_get,transcript_expand',
  A.READONLY.join(','))
check('① 取证面含记忆检索与转录展开（只读）',
  ['memory_catalog', 'memory_search', 'memory_get', 'transcript_expand'].every((n) => A.READONLY.includes(n)),
  A.READONLY.join(','))
check('① 白名单与"写/执行类工具"零交集',
  A.READONLY.filter((n) => WRITEISH.includes(n)).length === 0,
  A.READONLY.filter((n) => WRITEISH.includes(n)).join(','))
check('① 简报交付不走工具（report 被禁 ⇒ 只读边界不因交付而破口）',
  WRITEISH.includes('report') && !A.READONLY.includes('report'))
check('① 新宿主 startActivation 被识别', A.subagentStartKind({ startActivation() {} }) === 'activation')
check('① 旧宿主 startContinuable 仍优先', A.subagentStartKind({ startContinuable() {}, startActivation() {} }) === 'continuable')
check('① 无子代理 API ⇒ none（干净跳过）', A.subagentStartKind({}) === 'none')
check('① 记忆取证提示：默认 project scope、不误限 kind、空结果不许猜',
  /default project scope/.test(A.PERSONA) && /omit kind/.test(A.PERSONA)
  && /count 0/.test(A.PERSONA) && /Never guess/.test(A.PERSONA))

/* ── ② 预算常量（deck 第 5 页写死的三个数） ────────────────────────────── */
check('② 整轮硬掐断 45s', A.TURN_TIMEOUT_MS === 45000, A.TURN_TIMEOUT_MS)
check('② 工具调用满 8 次引导收尾', A.STEER_AT === 8, A.STEER_AT)
check('② 简报上限 8000 字符 / 40 条 / 单行 1200',
  A.MAX_BRIEF_CHARS === 8000 && A.MAX_BRIEF_ROWS === 40 && A.MAX_BRIEF_ROW === 1200)
check('② 单次工具超时只记账不掐断（真掐断只有整轮那道）',
  A.TOOL_TIMEOUT_MS === 10000 && A.TOOL_TIMEOUT_MS < A.TURN_TIMEOUT_MS)
check('② 界面标签为「外部思考中」', A.CHILD_LABEL === '外部思考中', A.CHILD_LABEL)

/* ──  简报行解析 ────────────────────────────────────────────────────── */
check('③ 只保留 [R] 行，噪声与空行丢弃',
  A.parseBriefRows('前言\n[R] 结论一\n\n[R] 结论二\n尾部噪声') === '[R] 结论一\n[R] 结论二')
check('③ 无空格写法被规范化（否则进得了请求、进不了转录）',
  A.parseBriefRows('[R]紧凑') === '[R] 紧凑', A.parseBriefRows('[R]紧凑'))
check('③ 规范化结果与转录器口径 /^\\[R\\] / 完全一致',
  A.parseBriefRows('[R]x').split('\n').every((l) => /^\[R\] /.test(l)))
check('③ 简报数字有出处 ⇒ 保留', (() => {
  const g = A.groundBriefRows('[R] 接口端口是8848。', '接口端口固定为8848')
  return g.dropped === 0 && g.text === '[R] 接口端口是8848。'
})())
check('③ 简报数字无出处 ⇒ 整行丢弃', (() => {
  const g = A.groundBriefRows('[R] 接口端口是3306。', '接口端口固定为8848')
  return g.dropped === 1 && g.text === ''
})())
check('③ 无数字结论不受影响', (() => {
  const g = A.groundBriefRows('[R] 未找到相关记忆。', '')
  return g.dropped === 0 && g.text === '[R] 未找到相关记忆。'
})())
check('③ 一条 [R] 都没有 ⇒ 空串（调用方据此 fail-open，不阻塞本轮）',  A.parseBriefRows('只有普通文本\n第二行') === '')
check('③ null / undefined 安全', A.parseBriefRows(null) === '' && A.parseBriefRows(undefined) === '')
const many = Array.from({ length: 55 }, (_, i) => `[R] 第 ${i} 条`).join('\n')
const clipped = A.parseBriefRows(many)
check('③ 超 40 条 ⇒ 裁到 40 条（不静默：另有 console 记录）',
  clipped.split('\n').length === 40, clipped.split('\n').length)
check('③ 保留的是前 40 条（顺序不重排）',
  clipped.startsWith('[R] 第 0 条') && clipped.endsWith('[R] 第 39 条'))
const longRow = '[R] ' + 'x'.repeat(3000)
check('③ 单行超 1200 ⇒ 行内截断并留可见标记',
  A.parseBriefRows(longRow).includes('…(truncated)') && A.parseBriefRows(longRow).length < 1300)

/* ── ③b 子代理多步正文：后一句 prose 不得覆盖先前的 [R] 简报 ───────────── */
check('③b 后续 prose 不覆盖已有 [R]', A.pickChildBrief('[R] 端口 8848', 'I will check that now.') === '[R] 端口 8848')
check('③b 后续 [R] 覆盖先前 [R]', A.pickChildBrief('[R] 旧', '[R] 新') === '[R] 新')
check('③b 全程 prose 仍保留（由上层判 no-brief，不注入）', A.pickChildBrief('', 'prose only') === 'prose only')

/* ── ③c 空简报后的极窄跳过：只跳纯确认，不跳问句/报错/路径 ─────────────── */
check('③c 空简报后“继续”可跳过', A.IDLE_SKIP === true && A.trivialContinuation('继续') && A.trivialContinuation('继续搞吧'))
check('③c 带问号/报错/路径/长文本一律不跳',
  !A.trivialContinuation('继续，顺便看下端口？')
  && !A.trivialContinuation('报错了')
  && !A.trivialContinuation('看下 src/web/memory.mjs')
  && !A.trivialContinuation('继续把语义压缩和值保真两条线都跑一遍'))

/* ── ④ extractTargets：度量用，别把目录/标识符当文件 ───────────────────── */
check('④ Windows 盘符完整保留（旧实现从 DSH\\ 起匹配，丢盘符）',
  A.extractTargets('[R] 改 D:\\DSH\\web\\index.mjs:88 这一行').includes('d:/dsh/web/index.mjs'),
  A.extractTargets('[R] 改 D:\\DSH\\web\\index.mjs:88 这一行').join('|'))
check('④ 行号被剥掉', A.extractTargets('[R] 见 src/a.py:12-30').includes('src/a.py'))
check('④ 目录（以分隔符结尾）不算可读目标', A.extractTargets('[R] 目录在 src/components/').length === 0)
check('④ 末段无扩展名 ⇒ 当作标识符忽略', A.extractTargets('[R] 变量 my_var_name 未定义').length === 0)
check('④ 非 [R] 行里的路径不取', A.extractTargets('普通叙述提到 notes.md').length === 0)

/* ── ⑤ buildDigest：与转录同形，且 0 必须真关 ─────────────────────────── */
const ev = (seq, type, data) => ({ seq, type, data })
const events = [
  ev(1, 'user/message', { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '第一条指令' }] } }),
  ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: '我先看文件' }] } }),
  ev(3, 'tool/call', { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/a.py' }) }),
  ev(4, 'tool/result', { message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: 'ok' }] } }),
  ev(5, 'tool/call', { callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'pytest' }) }),
  ev(6, 'tool/result', { message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', content: 'Error: 1 failed' }] } }),
  ev(7, 'user/message', { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '最后一条（当前轮）' }] } }),
  ev(8, 'assistant/chunk', { text: '流式分片没有 seq 语义' }),
]
const dig = A.buildDigest(events, 0)
check('⑤ 摘要行与转录同形（[U]/[A]/[T]）',
  /^\[U\] /m.test(dig) && /^\[A\] /m.test(dig) && /^\[T\] /m.test(dig))
check('⑤ 工具行带出 op 与目标', /\[T\] read \| src\/a\.py \| OK/.test(dig), dig.split('\n').filter(l => l.startsWith('[T]')).join(' ;; '))
check('⑤ 错误结果标 ERR（且命令目标带出，供核对）', /\[T\] pwsh \| pytest \| ERR/.test(dig))
check('⑤ 当前轮的用户消息不进摘要（避免与 prompt 重复）', !dig.includes('最后一条'))
check('⑤ 无 seq 的流式分片不产行', !dig.includes('流式分片'))
check('⑤ maxSeqOf 取最大而非末条（分片在尾部时游标不回退）',
  A.maxSeqOf(events) === 8 && A.maxSeqOf(null) === 0 && A.maxSeqOf([{ seq: undefined }]) === 0)
check('⑤ 默认开摘要、总量上限 24000（【修 8】恢复：不裁会膨胀到 10 万字符级）',
  A.DIGEST_ON === true && A.DIGEST_CLAMP === true)
check('⑤ 逐行不截半（行内 slice 是修 5 的病灶：子会话会误判"回复被截断"）',
  dig.split('\n').every((l) => !l.startsWith('[A] ') || l === '[A] 我先看文件'))

/* ── ⑤b DSH 0.1.7 工具结果形态：{role:'tool', toolCallId, content:[text]}，无 tool-result 块 ── */
// 旧实现只认块级 tool-result ⇒ [T] 行整类消失、haystack 恒空 ⇒ 数字出处闸会把**正确**简报误删。
const newShape = [
  ev(1, 'tool/call', { callId: 'c3', name: 'memory_search', arguments: JSON.stringify({ query: '接口端口' }) }),
  ev(2, 'tool/result', { message: { role: 'tool', toolCallId: 'c3', isError: false, content: [{ type: 'text', text: '{"count":1,"results":[{"value":"接口端口是 8848"}]}' }] } }),
]
const dig2 = A.buildDigest(newShape, 0)
check('⑤b 0.1.7 形态仍产 [T] 行', /\[T\] memory_search \| - \| OK/.test(dig2), dig2)
const infoOk = A.toolResultInfo(newShape[1])
check('⑤b 正文进 haystack（数字出处闸能查到）',
  infoOk.text.includes('8848') && infoOk.callId === 'c3' && infoOk.isError === false, JSON.stringify(infoOk))
check('⑤b 消息层 isError=true ⇒ ERR（块级缺失时不能一律当成功）',
  /\[T\] memory_search \| - \| ERR/.test(A.buildDigest([
    ev(1, 'tool/call', { callId: 'c4', name: 'memory_search', arguments: '{}' }),
    ev(2, 'tool/result', { message: { role: 'tool', toolCallId: 'c4', isError: true, content: [{ type: 'text', text: 'boom' }] } }),
  ], 0)))

/* ── ⑥ env 覆盖与"0 必须真关"（修 2 的病灶回归） ───────────────────────── */
const B = await load('ext-b.mjs', {
  EXTREASON_STATE_DIR: join(root, 'state-b'), EXTREASON_TURN_TIMEOUT: '1000',
  EXTREASON_STEER_AT: '3', EXTREASON_MAX_ROWS: '2', EXTREASON_DIGEST_MAX: '0',
})
check('⑥ 45s/8 次可被 env 覆盖（预算是参数不是硬编码）',
  B.TURN_TIMEOUT_MS === 1000 && B.STEER_AT === 3)
check('⑥ MAX_ROWS=2 生效', B.parseBriefRows(many).split('\n').length === 2)
check('⑥ DIGEST_MAX=0 ⇒ 摘要真的不构建（旧实现 slice(-0) 会发全量）',
  B.DIGEST_ON === false && B.buildDigest(events, 0) === '')
const C = await load('ext-c.mjs', { EXTREASON_STATE_DIR: join(root, 'state-c'), EXTREASON_DIGEST_MAX: '60' })
const cut = C.buildDigest(events, 0)
check('⑦ 超上限时按**行边界**丢最旧整行（不出现半行残行）',
  cut.startsWith('…（更早的增量已省略）') &&
  cut.split('\n').slice(1).every((l) => dig.split('\n').includes(l)),
  cut.split('\n').slice(1).join(' ⏎ ').slice(0, 90))
check('⑦ 截断后仍不超过上限 + 标记长度', cut.length <= 60 + '…（更早的增量已省略）'.length)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
