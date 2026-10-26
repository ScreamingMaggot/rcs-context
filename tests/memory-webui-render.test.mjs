// 记忆面板客户端渲染冒烟：不依赖浏览器/React，只验证图谱/列表/设置三页的文字与结构确实出现在树里。
// 运行：node tests/memory-webui-render.test.mjs
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

let seed = []
let hook = 0
const fakeReact = {
  Component: class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState(s) { this.state = { ...this.state, ...s } }
  },
  useState(init) {
    const i = hook++
    if (!(i in seed)) seed[i] = typeof init === 'function' ? init() : init
    return [seed[i], (v) => { seed[i] = typeof v === 'function' ? v(seed[i]) : v }]
  },
  useEffect() {},
  useRef(v) { return { current: v } },
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
    return { type, props: props || {}, children }
  },
}

let mod = null
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) { mod = factory((name) => (name === 'react' ? fakeReact : undefined)) },
  },
}
await import(pathToFileURL('D:/RCS/src/contextinjector-webui/lib/client.js').href + '?render-test=' + Date.now())

const registered = []
const ctx = {
  get(name) { return name === 'slots' ? {} : undefined },
  slots: {
    inject(_name, fn) { return fn() },
    register(spec, comp) { registered.push({ spec, comp }); return () => {} },
  },
}
mod.apply(ctx)
const memory = registered.find((x) => x.spec.id === 'memory')
if (!memory) { console.log('FAIL  未注册记忆视图'); process.exit(1) }

const now = Date.now()
const wsScope = 'ws:c:/users/administrator/desktop/testspace'
const factId = 'fact:' + wsScope + '|alpha-fact'
const snapshot = {
  flags: { enabled: true, llmEnabled: true, injectCatalog: true, handoff: true, consolidateAuto: true, consolidateIdleMs: 900000 },
  db: { path: 'C:/tmp/memory.sqlite', exists: true, bytes: 2048 },
  totals: { active: 165, resolved: 0, insights: 9, errors: 4, workspaces: 2 },
  range: 'current', rangeEffective: 'current',
  current: {
    workspace: { scope: wsScope, title: 'TESTSPACE', path: 'C:\\Users\\Administrator\\Desktop\\TESTSPACE', records: 56, insights: 0 },
    session: { scope: 'sess:70b1abe8', title: '评估课表工具基础功能', records: 3, insights: 0 },
    records: 59, insights: 0,
  },
  workspaces: [
    { scope: wsScope, kind: 'workspace', label: 'TESTSPACE', path: 'C:\\Users\\Administrator\\Desktop\\TESTSPACE', n: 56, last: now, current: true },
    { scope: 'ws:c:/users/administrator/desktop/plugintestplace', kind: 'workspace', label: 'PLUGINTESTplace', path: 'C:\\Users\\Administrator\\Desktop\\PLUGINTESTplace', n: 67, last: now - 1000, current: false },
  ],
  sessions: [
    { scope: 'sess:70b1abe8', kind: 'session', sid: '70b1abe8', label: '会话「评估课表工具基础功能」', title: '评估课表工具基础功能', workspace: 'TESTSPACE', path: 'C:\\Users\\Administrator\\Desktop\\TESTSPACE', n: 3, last: now, current: true },
  ],
  insights: [{
    key: 'alpha-fact', summary: 'Alpha 的端口是 8848', confidence: 0.9, model: 'qwen3:4b',
    scope: wsScope, scopeLabel: '工作区 TESTSPACE',
    originSid: '70b1abe8', originTitle: '评估课表工具基础功能', updated_ts: now, evidence: 1, evidenceIds: [1],
  }],
  recent: [{
    kind: 'command', key: 'cmd:alpha', status: 'active',
    scope: wsScope, scopeLabel: '工作区 TESTSPACE',
    originSid: '70b1abe8', originTitle: '评估课表工具基础功能', updated_ts: now,
  }],
  graph: {
    nodes: [
      { scope: wsScope, kind: 'workspace', label: 'TESTSPACE', path: 'C:\\Users\\Administrator\\Desktop\\TESTSPACE', n: 56, last: now, current: true, facts: 1 },
      { scope: 'ws:c:/users/administrator/desktop/plugintestplace', kind: 'workspace', label: 'PLUGINTESTplace', path: 'C:\\Users\\Administrator\\Desktop\\PLUGINTESTplace', n: 67, last: now - 1000, current: false, facts: 0 },
      { scope: 'sess:70b1abe8', kind: 'session', sid: '70b1abe8', label: '会话「评估课表工具基础功能」', title: '评估课表工具基础功能', workspace: 'TESTSPACE', path: 'C:\\Users\\Administrator\\Desktop\\TESTSPACE', workspaceScope: wsScope, n: 3, last: now, current: true, facts: 0, originFacts: 1 },
      { id: factId, kind: 'fact', key: 'alpha-fact', summary: 'Alpha 的端口是 8848', factType: 'constraint', status: 'active', confidence: 0.9, scope: wsScope, scopeLabel: '工作区 TESTSPACE', originSid: '70b1abe8', originTitle: '评估课表工具基础功能', updated_ts: now, evidence: 1, model: 'qwen3:4b' },
    ],
    edges: [
      { source: factId, target: wsScope, kind: 'shared' },
      { source: factId, target: 'sess:70b1abe8', kind: 'origin' },
      { source: 'sess:70b1abe8', target: wsScope, kind: 'member' },
    ],
    stats: { workspaces: 2, sessions: 1, facts: 1, activeFacts: 1 },
  },
  session: {
    sid: '70b1abe8', title: '评估课表工具基础功能', records: 59, privateRecords: 3,
    privateInsights: 0, workspaceRecords: 56, workspaceInsights: 0, turns: 3,
    injected: true, injection: null, compiledThrough: 964, llmThrough: 261,
  },
  kinds: [{ kind: 'command', n: 100 }],
  compile: { cursors: 1, last: null },
  llmRoute: { provider: null, model: null },
  consolidate: { auto: true, idleMs: 900000, next: null, inflight: null, last: null, manualRoute: { provider: 'spark', model: 'spark-x2.6' } },
  janitor: {
    enabled: true, intervalMs: 1800000, route: { provider: 'ollama-local', model: 'qwen3:4b' },
    last: { ok: true, skipped: false, at: now - 60000, trigger: 'manual', workspace: 'c:/work/alpha', facts: 10,
      ops: { refresh: 7, forget: 2, rejected: 1, failed: 0 }, model: { provider: 'ollama-local', model: 'qwen3:4b', via: 'janitor' }, ms: 1234 },
    inflight: null,
  },
  vector: { enabled: false, mode: 'off', state: 'off', model: '', dim: 0, rows: 0, pending: 0, lastError: '', failAt: null },
  inflight: null, envLocked: {}, armed: true, sqlite: true, error: null, timestamp: now,
}

// 钩子顺序：data, err, busy, range, tab, type, status, query, selected, focus, viewport, hover,
//           memP, memM, memProviders, memModels, memMdlErr, evData, evErr, graphBox, kbId, zen, sinceDays, older, graphData, boxSelect,
//           traces, traceTrigger, traceDetail, traceDetailErr, metrics, janitorMsg
seed = [snapshot, null, false, 'current', 'graph', 'all', 'active', '', [], null, { x: 0, y: 0, k: 1 }, null, '', '', [], [], null, null, null, { w: 900, h: 560 }, null, false, 0, { sig: '', facts: [], cursor: null, hasMore: false, pages: 0, loading: false, err: null }, snapshot.graph, null,
  { sig: '', rows: [], cursor: null, hasMore: false, loading: false, err: null }, '', null, null, null, null]
hook = 0
function renderTree(n) {
  if (Array.isArray(n)) return n.map(renderTree)
  if (n == null || typeof n !== 'object') return n
  if (typeof n.type === 'function') { hook = 0; return renderTree(n.type(n.props || {})) }
  return { ...n, children: (n.children || []).map(renderTree) }
}
function render(tab) {
  if (tab) seed[4] = tab
  hook = 0
  return renderTree(memory.comp({ sessionId: '70b1abe8' }))
}
function walkText(n) {
  if (n == null || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(walkText).join('')
  return walkText(n.children)
}
function collect(tree, pred, out = []) {
  if (!tree || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { tree.forEach((x) => collect(x, pred, out)); return out }
  if (pred(tree)) out.push(tree)
  ;(tree.children || []).forEach((x) => collect(x, pred, out))
  return out
}

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const gtree = render('graph')
const gtext = walkText(gtree)
const gbuttons = collect(gtree, (n) => n.type === 'button')
const gselects = collect(gtree, (n) => n.type === 'select')
const btnText = (b) => walkText(b.children)
const btn = (label) => gbuttons.find((b) => btnText(b) === label)
const selByValue = (v) => gselects.find((s) => s.props.value === v)

check('① 三页签齐全', !!btn('图谱') && !!btn('列表') && !!btn('设置') && btn('图谱').props.className.includes('on'))
check('② 范围默认当前上下文', !!selByValue('current'), gselects.map((s) => s.props.value).join(','))
check('③ 范围选项可读', gtext.includes('当前上下文') && gtext.includes('本工作区') && gtext.includes('本会话私有') && gtext.includes('全部'))
check('③b 时间窗可选', !!selByValue('0') && gtext.includes('全部时间') && gtext.includes('最近 7 天')
  && gtext.includes('最近 30 天') && gtext.includes('最近 90 天'))
check('④ 概览条按当前上下文计数', gtext.includes('全库活跃记录') && gtext.includes('当前上下文记录') && gtext.includes('当前有效洞察') && gtext.includes('本会话私有记录'), gtext.slice(0, 160))
check('⑤ 图谱画出工作区/会话节点', gtext.includes('TESTSPACE') && gtext.includes('「评估课表工具基础功能」'))
check('⑤b 节点计数按当前可见事实', gtext.includes('TESTSPACE · 1'))
check('⑥ 图谱事实可读', gtext.includes('Alpha 的端口是 8848'))
const factLabels = collect(gtree, (n) => n.type === 'text' && n.props && n.props.className === 'mem-fact-label')
check('⑥b 小图默认显示事实摘要标签', factLabels.some((t) => walkText(t.children).startsWith('Alpha 的端口是')), factLabels.map((t) => walkText(t.children)).join(' | '))
check('⑦ 边已连出（共享+来源+成员）', collect(gtree, (n) => n.type === 'line').length === 3, collect(gtree, (n) => n.type === 'line').length)
check('⑧ 当前节点有圆环标记', collect(gtree, (n) => n.props && n.props.className === 'mem-ring').length >= 2)
const nodeGs = collect(gtree, (n) => n.type === 'g' && n.props && n.props['data-node'])
const nodePos = nodeGs.map((g) => {
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.props.transform || '')
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
})
const transformsOk = nodeGs.length === 3 && nodePos.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 900 && p.y >= 0 && p.y <= 560)
const spreadOk = nodePos.every((p, i) => nodePos.every((q, j) => i === j || Math.hypot(p.x - q.x, p.y - q.y) >= 14))
check('⑨ 布局坐标有限、在画布内且互不重叠', transformsOk && spreadOk, nodeGs.map((g) => g.props.transform).join(' '))
const gtree2 = render('graph')
const pos2 = collect(gtree2, (n) => n.type === 'g' && n.props && n.props['data-node']).map((g) => g.props.transform)
check('⑨b 布局确定性（重绘坐标不变）', JSON.stringify(pos2) === JSON.stringify(nodeGs.map((g) => g.props.transform)), pos2.join(' '))
const kbNodes = nodeGs.filter((g) => g.props.role === 'button' && g.props['aria-label'])
check('⑨c 节点可键盘到达且有 ARIA 标签', kbNodes.length === 3
  && nodeGs.filter((g) => g.props.tabIndex === 0).length === 1, kbNodes.map((g) => g.props['aria-label']).join(' | '))
seed[20] = 'sess:70b1abe8'
const ringTree = render('graph')
check('⑨d 键盘焦点显示焦点环', collect(ringTree, (n) => n.props && n.props.className === 'mem-focus-ring').length === 1)
seed[20] = null
seed[21] = true
const zenTree = render('graph')
check('⑨e 聚焦模式挂到根节点', String(zenTree.props.className).includes('mem-zen'))
seed[21] = false
check('⑩ 默认不画其他工作区', !gtext.includes('PLUGINTESTplace'))
check('⑪ 展开入口存在且可回退', !!btn('展开全部') && !btn('回到当前'))
check('⑫ 可见文字不含裸 scope', !gtext.includes('ws:') && !gtext.includes('sess:'))

const ltree = render('list')
const ltext = walkText(ltree)
check('⑬ 列表按作用域分组', ltext.includes('工作区 TESTSPACE') && ltext.includes('1 条'))
check('⑭ 工作区洞察标出来源会话', ltext.includes('来自「评估课表工具基础功能」'))
check('⑮ 最近记录仍可见', ltext.includes('最近记录') && ltext.includes('cmd:alpha'))

const factG = collect(gtree, (n) => n.type === 'g' && String(n.props && n.props['data-node']).startsWith('fact:'))[0]
factG.props.onDoubleClick({ stopPropagation() {} })
const lt2 = render()
const lt2selects = collect(lt2, (n) => n.type === 'select')
const l2text = walkText(lt2)
check('⑲ 双击可见事实不重置过滤器', !!lt2selects.find((s) => s.props.value === 'active')
  && l2text.includes('Alpha 的端口是 8848'), lt2selects.map((s) => s.props.value).join(','))

const stree = render('settings')
const stext = walkText(stree)
check('⑯ 设置页四个 KPI', stext.includes('全部活跃') && stext.includes('全部有效洞察') && stext.includes('工作区') && stext.includes('待处理错误'))
check('⑰ 开关与模型/数据库区在设置页', stext.includes('开关') && stext.includes('编译模型') && stext.includes('数据库') && stext.includes('自动整理'))
check('⑱ 整理信息不与图谱混排', !stext.includes('全库活跃') || !stext.includes('图谱'), true)

const savedStats = JSON.parse(JSON.stringify(snapshot.graph.stats))
snapshot.graph.stats = { ...savedStats, facts: 200, factTotal: 430, factLimit: 200, truncated: true }
const limText = walkText(render('graph'))
check('⑲b 截断时显示已载入/总数与钻取提示', limText.includes('已载入 200 / 共 430 条事实')
  && limText.includes('点工作区或会话钻取'), limText.slice(0, 160))
snapshot.graph.stats = savedStats

// 列表分页：更早事实只进列表；图谱仍只画首屏，并提示切到列表。
const olderSig = '70b1abe8|current||0'
const olderFact = {
  id: 'fact:' + wsScope + '|older-fact', kind: 'fact', key: 'older-fact', summary: '更早的事实',
  factType: 'state', status: 'active', confidence: 0.5, scope: wsScope, scopeLabel: '工作区 TESTSPACE',
  originSid: '70b1abe8', originTitle: '评估课表工具基础功能', updated_ts: now - 1000, evidence: 0,
}
snapshot.graph.stats = { ...savedStats, facts: 1, factTotal: 430, factLimit: 200, truncated: true,
  focusScope: wsScope, hasMore: true, nextCursor: '100:8' }
seed[23] = { sig: olderSig, facts: [olderFact], cursor: '100:8', hasMore: true, pages: 1, loading: false, err: null }
const pageList = render('list')
const pageText = walkText(pageList)
const pageBtn = collect(pageList, (n) => n.type === 'button').find((b) => btnText(b) === '加载更早')
check('⑲c 列表加载更早：合并去重并显示已载入/总数', pageText.includes('更早的事实')
  && pageText.includes('已载入 2 / 共 430 条事实') && pageText.includes('（含更早 1 条）')
  && !!pageBtn && pageText.includes('2 条洞察'), pageText.slice(0, 160))
const pageGraph = render('graph')
const pageGraphText = walkText(pageGraph)
check('⑲d 图谱不追加旧页，提示切到列表', !pageGraphText.includes('older-fact')
  && pageGraphText.includes('切到列表可加载更早的事实')
  && !collect(pageGraph, (n) => n.type === 'button').some((b) => btnText(b) === '加载更早'))
check('⑲e 列表计数与图谱计数分开', walkText(pageGraph).includes('1 条洞察'))
seed[23] = { ...seed[23], cursor: null, hasMore: false, pages: 2 }
const doneText = walkText(render('list'))
check('⑲f 翻到末页后按钮消失并提示到底', doneText.includes('已到最早一条')
  && !collect(render('list'), (n) => n.type === 'button').some((b) => btnText(b) === '加载更早'))
snapshot.graph.stats = savedStats
seed[23] = { sig: '', facts: [], cursor: null, hasMore: false, pages: 0, loading: false, err: null }

// 交互契约（源码级）：首帧无数据时 svg 不存在，滚轮 effect 若只依赖 tab 会永远挂不上；
// 拖拽位移必须按 viewBox 的 meet 缩放换算，否则 70px 拖拽只移动约 27px。
const clientSrc = readFileSync('D:/RCS/src/contextinjector-webui/lib/client.js', 'utf8')
check('⑳ 滚轮监听随图谱数据就绪重新挂载', /var hasGraph = !!graphData/.test(clientSrc)
  && /\[tab, hasGraph\]/.test(clientSrc))
check('㉑ 拖拽平移按 viewBox 缩放换算', /Math\.min\(r\.width \/ graphBox\.w, r\.height \/ graphBox\.h\)/.test(clientSrc)
  && /\(ev\.clientX - d\.x\) \/ d\.s/.test(clientSrc))
check('㉒ 事实标签随缩放出现且做贪心避让', /viewport\.k >= 1\.25/.test(clientSrc)
  && /labelBoxes\.some\(function \(b\) \{ return boxHit\(box, b\); \}\)/.test(clientSrc))
check('㉓ 证据链按事件惰性回查', /\/api\/memory\/evidence\?scope=/.test(clientSrc)
  && /mem-ev-raw/.test(clientSrc))
check('㉔ 布局按签名缓存', /memLayoutCache\.sig === sig/.test(clientSrc) && /memLayoutCache = \{ sig: sig, at: at \}/.test(clientSrc))
check('㉕ 方向键遍历与聚焦模式', /ArrowRight: \[1, 0\]/.test(clientSrc) && /moveFocus\(dir\[0\], dir\[1\]\)/.test(clientSrc)
  && /mem-zen/.test(clientSrc))
check('㉖ 聚焦时向服务端下钻并放宽上限', /focusScope=/.test(clientSrc) && /factLimit=/.test(clientSrc))
check('㉗ 时间窗按天换算为 sinceTs', /sinceTs=/.test(clientSrc) && /setSinceDays/.test(clientSrc))
check('㉘ 游标分页只追加到列表', /cursor=/.test(clientSrc) && /extraFacts: tab === "list"/.test(clientSrc)
  && /limitNotice\(true\)/.test(clientSrc) && /concat\(older\.facts \|\| \[\]\)/.test(clientSrc))

// 轨迹页（Phase 4）：当前会话列表 + 点开详情；查询文本按不可信数据显示。
const traceRows = [
  { id: 11, ts: now - 5000, trigger: 'tool', mode: 'fts-bi', candTotal: 12, selTotal: 3, ms: 4.2, preview: '端口 8848', uri: 'rcs://ws/x/insight/port', truncated: 0 },
  { id: 10, ts: now - 9000, trigger: 'inject', mode: 'catalog', candTotal: 0, selTotal: 0, ms: 0.4, preview: '', uri: '', truncated: 0 },
]
seed[26] = { sig: '70b1abe8|', rows: traceRows, cursor: '100:11', hasMore: true, loading: false, err: null }
seed[27] = ''
const ttree = render('traces')
const ttext = walkText(ttree)
const tbuttons = collect(ttree, (n) => n.type === 'button')
check('㉙ 轨迹页签与列表', !!collect(ttree, (n) => n.type === 'button').find((b) => btnText(b) === '轨迹')
  && ttext.includes('检索轨迹') && ttext.includes('端口 8848') && ttext.includes('工具') && ttext.includes('注入')
  && ttext.includes('3/12') && ttext.includes('加载更早')
  && collect(ttree, (n) => n.type === 'div' && String(n.props && n.props.className).includes('mem-trace')).length >= 2,
  ttext.slice(0, 200))
const triggerSel = collect(ttree, (n) => n.type === 'select')[0]
check('㉙b 轨迹按触发类型筛选', !!triggerSel && triggerSel.props.value === ''
  && triggerSel.children.some((o) => o && o.props && o.props.value === 'handover'),
  triggerSel && triggerSel.children.map((o) => o && o.props && o.props.value).join(','))
seed[28] = {
  id: 11, ts: now, trigger: 'tool', uri: 'rcs://ws/x/insight/port',
  query: { hash: 'abc123', text: '端口 8848', len: 7 }, mode: 'fts-bi',
  widened: ['kinddir→rootdir'], steps: [{ stage: 'fts-bi', n: 12, ms: 1.2, why: 'and' }, { stage: 'select', n: 3, ms: 0.3 }],
  candidates: [{ rank: 1, kind: 'insight', uri: 'rcs://ws/x/insight/port', score: 1.2, src: 'fts' }],
  selected: [{ rank: 1, kind: 'insight', uri: 'rcs://ws/x/insight/port' }],
  candTotal: 12, selTotal: 3, ms: 4.2, error: '', truncated: 5, ref: 'rcs-trace://s/11',
}
const tdetail = walkText(render('traces'))
check('㉚ 轨迹详情含阶段/候选/选中与回退', tdetail.includes('轨迹 #11') && tdetail.includes('阶段 · 2')
  && tdetail.includes('候选 · 显示 1 / 共 12') && tdetail.includes('选中 · 显示 1 / 共 3')
  && tdetail.includes('回退：kinddir→rootdir') && tdetail.includes('端口 8848')
  && tdetail.includes('详情已裁剪'), tdetail.slice(0, 260))
seed[28] = null

// 设置页巡检与诊断：开关/间隔/立即巡检/上次结果 + 向量状态与成功率。
const s2tree = render('settings')
const s2text = walkText(s2tree)
const s2buttons = collect(s2tree, (n) => n.type === 'button')
check('㉛ 设置页文件巡检入口', s2text.includes('文件巡检') && s2text.includes('立即巡检')
  && s2text.includes('30 分钟') && s2text.includes('刷新 7') && s2text.includes('失效 2')
  && s2text.includes('ollama-local / qwen3:4b'),
  s2text.slice(0, 260))
seed[30] = {
  compile: { success: 3, failure: 1, total: 4 }, retrieval: { success: 1, failure: 1, total: 2 },
  injection: { hit: 1, miss: 1, total: 2 }, vector: { armHit: 2, armMiss: 1, embedFail: 0, skippedExact: 3 }, lastUpdated: now,
}
const savedVector = snapshot.vector
snapshot.vector = { enabled: true, mode: 'on', state: 'ok', model: 'bge-m3', dim: 1024, rows: 9, pending: 1, lastError: '', failAt: null }
const s3text = walkText(render('settings'))
check('㉜ 设置页向量与指标诊断', s3text.includes('检索与向量') && s3text.includes('已嵌')
  && s3text.includes('bge-m3') && s3text.includes('1024')
  && s3text.includes('75%') && s3text.includes('50%') && s3text.includes('编译成功率')
  && s3text.includes('向量臂命中 2'), s3text.slice(0, 260))
snapshot.vector = savedVector
seed[30] = null
seed[26] = { sig: '', rows: [], cursor: null, hasMore: false, loading: false, err: null }
seed[27] = ''
check('㉝ 轨迹/巡检/向量数据面已接线', /\/api\/memory\/traces\?/.test(clientSrc)
  && /\/api\/memory\/traces\/clear/.test(clientSrc)
  && /\/api\/memory\/janitor/.test(clientSrc)
  && /memoryJanitorEnabled/.test(clientSrc)
  && /data\.janitor/.test(clientSrc) && /data\.vector/.test(clientSrc))

// 注入页「请求结构」：一次折叠可能有数百个同质节点，平铺会把面板撑成字墙（实测 303 节点）。
// 契约：一行摘要（节点数/总字节/最大的四组）+ 默认收起的明细（分组统计 + 逐节点）。保持逐节点可核验。
const frameFixture = [
  { role: 'system', src: 'system-prompt', bytes: 5787 },
  { role: 'assistant', src: 'model', bytes: 1000 },
  { role: 'assistant', src: 'model', bytes: 2500 },
  { role: 'tool', src: 'tool', bytes: 400 },
  { role: 'tool', src: 'tool', bytes: 600 },
  { role: 'user', src: 'compact-checkpoint', bytes: 9000 },
  { role: 'user', src: 'human', bytes: 300 },
]
const fs1 = mod.__test.frameSummary(frameFixture)
check('㉞ 请求结构按 role/src 聚合且总数正确', fs1.n === 7 && fs1.total === 19587
  && fs1.groups.length === 5
  && fs1.groups[0].k === 'user/compact-checkpoint' && fs1.groups[0].n === 1 && fs1.groups[0].b === 9000
  && fs1.groups.find((g) => g.k === 'assistant/model').n === 2
  && fs1.groups.find((g) => g.k === 'tool/tool').b === 1000,
  JSON.stringify(fs1))
check('㉟ 摘要只列前四组、明细保留逐节点', fs1.top.length === 4 && fs1.top[3].k === 'tool/tool'
  && fs1.text.split('\n').length === 7 && fs1.text.includes('tool/tool:400B'))
const fsEmpty = mod.__test.frameSummary(null)
check('㊱ 空/非法结构安全', fsEmpty.n === 0 && fsEmpty.total === 0 && fsEmpty.groups.length === 0
  && fsEmpty.text === '' && mod.__test.fmtB(1535) === '1.5KB' && mod.__test.fmtB(471859) === '460.8KB')
check('㊲ 注入页请求结构默认收起', /ci-frames/.test(clientSrc)
  && /e\("details", \{ key: "n", className: "ci-sub ci-frames" \}/.test(clientSrc)
  && !/lf\.afterNodes\.map\(/.test(clientSrc))
check('㊳ 轨迹详情对非 JSON 响应给出可读错误', /return r\.text\(\)\.then\(function \(t\)/.test(clientSrc)
  && /接口未匹配（404）/.test(clientSrc))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
