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
  inflight: null, envLocked: {}, armed: true, sqlite: true, error: null, timestamp: now,
}

// 钩子顺序：data, err, busy, range, tab, type, status, query, selected, focus, viewport, hover,
//           memP, memM, memProviders, memModels, memMdlErr, evData, evErr, graphBox, kbId, zen, sinceDays, older, graphData, boxSelect
seed = [snapshot, null, false, 'current', 'graph', 'all', 'active', '', [], null, { x: 0, y: 0, k: 1 }, null, '', '', [], [], null, null, null, { w: 900, h: 560 }, null, false, 0, { sig: '', facts: [], cursor: null, hasMore: false, pages: 0, loading: false, err: null }, snapshot.graph, null]
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

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
