// 整理结果评测：共用 fixture + 结果打分器。
// 这里只做“最终事实是否正确/是否多改/是否复活了已失效事实”，不把模型自述的计数当成结果。
export const EVAL_WORKSPACE = 'c:/eval/consolidation'
export const EVAL_SID = 'eval-s1'
export const EVAL_SCENARIOS = ['update', 'confirm', 'reset']

export const EVAL_FACTS = [
  { key: 'project-root', summary: '项目根目录是 EvalProj，包含 src、docs、tests。', type: 'state' },
  { key: 'api-port', summary: '接口端口固定为 8848。', type: 'constraint' },
  { key: 'build-cmd', summary: '构建命令是 npm run build。', type: 'state' },
  { key: 'release-branch', summary: '发布分支是 release/1.2。', type: 'state' },
  { key: 'owner', summary: '项目负责人是 张三。', type: 'history' },
  { key: 'current-task', summary: '当前任务：整理构建脚本。', type: 'task' },
]

// update：只有 project-root / build-cmd 应该变更。
export const EVAL_REQUIRED = {
  'project-root': ['EvalProj2', 'app', 'lib', 'test'],
  'build-cmd': ['pnpm', 'build'],
  'api-port': ['8848'],
  'release-branch': ['release/1.2'],
  owner: ['张三'],
}
export const EVAL_UNCHANGED = {
  'api-port': '接口端口固定为 8848。',
  'release-branch': '发布分支是 release/1.2。',
}
export const EVAL_CHANGED = ['project-root', 'build-cmd']

// confirm：所有事实都被新事件确认，模型应返回空操作；任何状态改写都算 churn。
export const EVAL_CONFIRM_REQUIRED = {
  'project-root': ['EvalProj', 'src', 'docs', 'tests'],
  'build-cmd': ['npm', 'run', 'build'],
  'api-port': ['8848'],
  'release-branch': ['release/1.2'],
  owner: ['张三'],
}
export const EVAL_CONFIRM_UNCHANGED = {
  'project-root': '项目根目录是 EvalProj，包含 src、docs、tests。',
  'build-cmd': '构建命令是 npm run build。',
  'api-port': '接口端口固定为 8848。',
  'release-branch': '发布分支是 release/1.2。',
}

export const EVAL_EXPECT = {
  update: { required: EVAL_REQUIRED, unchanged: EVAL_UNCHANGED, changed: EVAL_CHANGED, absent: [] },
  confirm: { required: EVAL_CONFIRM_REQUIRED, unchanged: EVAL_CONFIRM_UNCHANGED, changed: [], absent: [] },
  reset: { required: {}, unchanged: {}, changed: [], absent: ['old-dir'] },
}

export function buildEvalFixture(store, { scenario = 'update', workspace = EVAL_WORKSPACE, sid = EVAL_SID, now = Date.now() } = {}) {
  const scope = 'ws:' + workspace
  if (scenario === 'reset') {
    store.ingest({
      sid, seq: 1, kind: 'insight', key: 'old-dir', scope,
      value: { summary: '旧目录是 COMP，包含 尸检.py。', type: 'state' },
      source: { sid, seq: 1 }, extractor: 'seed', ts: now - 10_000,
    })
    store.ingest({
      sid, seq: 2, kind: 'command', key: 'cmd:eval-reset', scope,
      value: { action: 'pwsh', status: 'OK', cmd: "Remove-Item 'COMP' -Recurse" },
      source: { sid, seq: 2 }, extractor: 'rule', ts: now - 5000,
    })
    return { scenario, workspace, sid, scope, expect: EVAL_EXPECT.reset }
  }

  EVAL_FACTS.forEach((f, i) => {
    store.ingest({
      sid, seq: i + 1, kind: 'insight', key: f.key, scope,
      value: { summary: f.summary, type: f.type },
      source: { sid, seq: i + 1 }, extractor: 'seed', ts: now - 10_000,
    })
  })
  const events = scenario === 'confirm'
    ? [
        { key: 'turn:eval-c1', text: '项目根目录仍然是 EvalProj，包含 src、docs、tests。' },
        { key: 'turn:eval-c2', text: '端口还是 8848，没变。' },
        { key: 'turn:eval-c3', text: '构建命令仍然是 npm run build。' },
        { key: 'turn:eval-c4', text: '发布分支仍然是 release/1.2。' },
        { key: 'turn:eval-c5', text: '负责人还是张三。' },
      ]
    : [
        { key: 'turn:eval-1', text: '项目根目录改成 EvalProj2 了，里面有 app、lib、test 三个目录。' },
        { key: 'turn:eval-2', text: '端口还是 8848，没变。' },
        { key: 'turn:eval-3', text: '构建命令改成 pnpm build。' },
        { key: 'turn:eval-4', text: '发布分支仍然是 release/1.2。' },
        { key: 'turn:eval-5', text: '今天先加一个日志开关。' },
      ]
  events.forEach((e, i) => {
    store.ingest({
      sid, seq: 100 + i, kind: 'user_turn', key: e.key, scope,
      value: { text: e.text }, source: { sid, seq: 100 + i }, extractor: 'rule', ts: now - 4000 + i * 500,
    })
  })
  if (scenario === 'update') {
    store.ingest({
      sid, seq: 110, kind: 'command', key: 'cmd:eval-dirs', scope,
      value: { action: 'pwsh', status: 'OK', cmd: 'Get-ChildItem .\\EvalProj2', out: 'app\nlib\ntest\n' },
      source: { sid, seq: 110 }, extractor: 'rule', ts: now,
    })
  }
  return { scenario, workspace, sid, scope, expect: EVAL_EXPECT[scenario] }
}

export function activeFactsFromStore(store, scope) {
  return store.db.prepare("SELECT key, value, fact_type FROM records WHERE scope=? AND kind='insight' AND status='active'").all(scope)
    .map((r) => {
      let v = {}
      try { v = JSON.parse(r.value) ?? {} } catch { /* keep key */ }
      return { key: r.key, summary: String(v.summary ?? ''), factType: r.fact_type || v.type || '' }
    })
}

export function appliedOpsFromStore(store) {
  const types = new Map(store.db.prepare("SELECT key, fact_type FROM records WHERE kind='insight'").all().map((r) => [r.key, r.fact_type]))
  return store.db.prepare("SELECT value FROM records WHERE kind='audit'").all()
    .map((r) => {
      try {
        const v = JSON.parse(r.value) ?? {}
        if (v.action !== 'consolidate') return null
        const target = String(v.target ?? '')
        return { op: String(v.op ?? ''), target, type: String(v.type ?? types.get(target) ?? '') }
      } catch { return null }
    })
    .filter(Boolean)
}

export function scoreConsolidation({ active = [], required = {}, unchanged = {}, changedKeys = [], absent = [], appliedOps = [], result = {} } = {}) {
  const byKey = new Map(active.map((x) => [String(x.key), x]))
  const summaryOf = (x) => String(x?.summary ?? x?.value?.summary ?? '')
  const req = Object.entries(required)
  const recallHits = req.filter(([k, needles]) => {
    const s = summaryOf(byKey.get(k))
    return (Array.isArray(needles) ? needles : [needles]).every((n) => s.includes(String(n)))
  }).length
  const recall = req.length ? recallHits / req.length : 1

  const un = Object.entries(unchanged)
  const precisionHits = un.filter(([k, s]) => summaryOf(byKey.get(k)) === String(s)).length
  const precision = un.length ? precisionHits / un.length : 1

  const allowed = new Set([...Object.keys(required), ...Object.keys(unchanged)])
  const extra = active
    .filter((x) => ['state', 'constraint'].includes(String(x.factType)) && !allowed.has(String(x.key)))
    .map((x) => String(x.key))
  const absentActive = absent.map(String).filter((k) => byKey.has(k))

  const changed = new Set(changedKeys.map(String))
  // task/history 不进入自动注入；它们的变化不算“当前状态被改错”。
  const injected = (o) => !['task', 'history'].includes(String(o.type ?? ''))
  const unexpectedApplied = appliedOps
    .filter((o) => injected(o) && !changed.has(String(o.target)))
    .map((o) => `${o.op}:${o.target}`)
  const withOps = new Set(appliedOps.map((o) => String(o.target)))
  const missingApplied = [...changed].filter((k) => !withOps.has(k))

  return {
    recall, precision, extra, absentActive, unexpectedApplied, missingApplied,
    safety: extra.length === 0 && absentActive.length === 0 && unexpectedApplied.length === 0,
    completed: result?.ok !== false,
    applied: appliedOps.length,
    reason: result?.reason ?? null,
    result: result ?? {},
  }
}
