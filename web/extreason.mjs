// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// EXTREASON v0.2 —— 外置推理（M1：fork 子代理 + 只读工具 + `[R]` 行简报并入 CONTEXT）
//
// 与 M0 的差别：
//   · 推理器从"插件内直调 LLM"改为 **fork 子代理**（继承父会话上下文 = 与主模型同一场景）
//   · 推理器**有工具**（只读白名单）——这正是"给想配上工具"
//   · 交付**不用工具**：子代理自然输出 `[R] …` 行，插件取它最后一条正文（v3，2026-09-09 简化）；
//     简报以会话节点形式当轮注入，并被 StateCompiler 转录进 append-only 转录
//   · 激活条件：主模型 reasoning = off（或模型无思维链能力）——插件启用时主模型不再自己推理
//   · 上限：整轮 45s——它是**真正掐断**的那一个（到点 abort signal + interrupt 子会话）；
//     单次工具调用 10s 只**记一条账**，不会中断任何调用（见 EXTREASON_TOOL_TIMEOUT 处的说明）；失败开放
//   · 账单：父/子两条流的 token/cache/时延分别落盘
//
// 开关：EXTREASON=0 关闭；EXTREASON_FORCE=1 跳过激活判定（测试用）；
//       EXTREASON_CHILD_EFFORT=follow 让推理器子会话**跟随主模型**（不覆盖思考档）
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = process.env.EXTREASON_STATE_DIR || join(DSH_HOME, 'state-extreason')
// 【修 4】brief.txt / brief.json 已经**没有任何读取方**：旧注释写"StateCompiler 注入器读这里"，
//   但那个"注入器读 brief.txt"的机制在本代码库里不存在了——简报的正式通路是"当轮作为会话节点注入 +
//   由 StateCompiler 从会话事件转录进 append-only 转录"。故落盘只作**可选调试产物**，须显式开启。
const BRIEF_DIR = join(DSH_HOME, 'state-compiler', 'extreason')
const BRIEF_TXT = join(BRIEF_DIR, 'brief.txt')
const BRIEF_JSON = join(BRIEF_DIR, 'brief.json')
const DEBUG_BRIEF = process.env.EXTREASON_DEBUG_BRIEF === '1'   // =1 才落盘 brief.txt/brief.json
const METRICS = join(STATE_DIR, 'metrics.jsonl')
const ENABLED = process.env.EXTREASON !== '0'
const FORCE = process.env.EXTREASON_FORCE === '1'
// 【2026-09-11】自动代劳的两条兜底路径默认**关闭**，只保留"显式 off / FORCE"：
//   · EXTREASON_ARM_ON_NO_CAPABILITY=1：模型未声明 reasoning 能力（或该路由 defaultEffort=off）时代劳；
//   · EXTREASON_ARM_ON_NO_BLOCKS=1：上一轮 assistant 没有 reasoning/thinking 块时代劳。
//   用户报障原文：「思考模式没有关，为什么会拉起外部思考」——旧默认两条都开，导致档位没关也被代劳。
const ARM_ON_NO_CAPABILITY = process.env.EXTREASON_ARM_ON_NO_CAPABILITY === '1'
const ARM_ON_NO_BLOCKS = process.env.EXTREASON_ARM_ON_NO_BLOCKS === '1'
const TURN_TIMEOUT_MS = Number(process.env.EXTREASON_TURN_TIMEOUT ?? 45000)
// 【修 3】这个数**只用来记一条账**（到点写一行 tool-timeout），它不会 abort 任何工具调用——
//   旧注释把它叫"看门狗"名不副实。真正能掐断的是 TURN_TIMEOUT_MS（abort signal + interrupt 子会话）。
const TOOL_TIMEOUT_MS = Number(process.env.EXTREASON_TOOL_TIMEOUT ?? 10000)
// 推理器工具预算：调够这么多次就 steer 它收尾（0 = 不限制）
const STEER_AT = Number(process.env.EXTREASON_STEER_AT ?? 8)
const MAX_BRIEF_CHARS = Number(process.env.EXTREASON_MAX_BRIEF ?? 8000)      // 【修 7】默认总量 8000 字符（0 = 不限）
const CHILD_LABEL = '外部思考中'   // 子代理标签（也用于进程重启后从持久子会话列表找回）
// 推理器子会话的思考档。**默认 off**：本插件的设计意图是"子代理用工具核实 + 产出可核对的简报"
// 来**替代**主模型的 reasoning 阶段；如果它自己再跑一遍隐藏思维链，就等于把同样的内部推理
// 搬到子会话里再付一次钱，与"外置"背道而驰（用户 2026-09-09 指正）。
// 实测（同任务）：off 比适配器默认 high 更快（7.0s vs 8.7s）且简报更长（1832 vs 1665 字符）。
// 需要更高质量时可显式抬档：EXTREASON_CHILD_EFFORT=low|high|max。
// 【修 5】`off` 不再是"无脑强制"：DSH 在请求前会用**适配器声明的能力**校验档位
//   （dsh-llm/lib/index.js:1462 `resolveCallWithInfo`——模型没声明 reasoning、或 efforts 里没有该档，
//   就抛 `provider "x" model "y" does not support reasoning effort "off"`）⇒ 强制一个模型不支持的档
//   等于**把整轮子会话直接打死**（用户实测 `ollama/openbmb/minicpm5:latest`）。
//   故覆盖前先查能力：不支持 / 查不到一律**不覆盖**（跟随主模型）。
const CHILD_EFFORT_ENV = String(process.env.EXTREASON_CHILD_EFFORT ?? '').trim().toLowerCase()
// follow | inherit | same ⇒ **永不覆盖**：子会话完全跟随主模型（父会话）实际使用的档位。
//   这是用户明确要的"跟随主模型"模式，也是"这个模型支持哪些档我说不准"时的安全档。
const CHILD_EFFORT_FOLLOW = ['follow', 'inherit', 'same'].includes(CHILD_EFFORT_ENV)
// 具体档位 = "**尝试**强制成这一档"，仍须通过上面的能力核对；缺省/无法识别 ⇒ off
const CHILD_EFFORT = CHILD_EFFORT_FOLLOW
  ? null
  : (['off', 'low', 'high', 'max'].includes(CHILD_EFFORT_ENV) ? CHILD_EFFORT_ENV : 'off')
const READONLY = ['read', 'glob', 'grep', 'web_search']

// 【修 1】ENABLED 判定必须在**任何副作用之前**生效：旧实现无条件 mkdir 两个目录，然后在 apply()
//   里先打印 armed 横幅、最后才 `if (!ENABLED) return` ⇒ 设 EXTREASON=0"完全关闭"仍会留下
//   state-extreason/ 与 state-compiler/extreason/ 两个空目录 + 一条 armed 横幅。
if (ENABLED) {
  mkdirSync(STATE_DIR, { recursive: true })
  // 【修 4】brief 已无人读取 ⇒ 不开启调试产物时连目录都不建
  if (DEBUG_BRIEF) mkdirSync(BRIEF_DIR, { recursive: true })
}

const log = (row) => { try { appendFileSync(METRICS, JSON.stringify({ t: Date.now(), plugin: 'EXTREASON', ...row }) + '\n', 'utf8') } catch {} }

// 人设/提示词原则（2026-09-09 用户指正）：
//   ① **不要写纪律手册**——正常模型没有"第 0 步/分诊/反例/穷尽性条款"；
//   ② **英文**——同语义比中文省 token（用户 2026-09-09 决定）；
//   ③ **输出结构只保留捕捉契约**：只要交付行以 `[R] ` 开头即可（StateCompiler 按这个前缀抓取），
//      不再强制 结论/证据/建议/待改位置/未知 五标签模板——那会限制它表达，也不省事；
//      唯一保留的强建议是"要改文件时把 文件:行号+原文逐字+目标文本 写在同一行"，因为实测
//      这是执行者一次改对的关键（M2 T1：无此行则漏改正文，有则一次成功）。
//   ④ 明确"用用户的语言回答"，避免英文人设把简报带成英文。
const PERSONA = [
  'You are this session\'s external reasoner. The main model is not reasoning now: you work out what should happen and hand back the facts and the next step.',
  'You may read files, search code, and search the web (read-only). Check what you are unsure about; do not guess.',
  '',
  'Delivery: start every line you want the main model to receive with `[R] ` (one item per line; free-form, keep it short).',
  '- If this turn needs a file edited, put file:line, the current text verbatim, and the target text on one `[R] ` line — the executor replaces it literally.',
  '- Quote only what you actually read; never invent.',
  '- Nothing worth checking this turn? One `[R] ` line saying so is enough.',
  'Write in the language of the user\'s message. Do not call the report tool — it is disabled for this sub-session.',
].join('\n')

// v1.10.27 (DSH rc.3+/0.1.7 compat): `session.events` public array removed; enumerate via
// ownEvents()/snapshotEvents() when present. `?? []` alone was a silent-degrade trap.
function allEvents(session) {
  if (typeof session?.ownEvents === 'function') return session.ownEvents()
  const snap = session?.snapshotEvents
  if (typeof snap === 'function') { try { return snap.call(session) } catch { return [] } }
  return session?.events ?? []
}

function textOf(m) {
  return (Array.isArray(m?.content) ? m.content : [])
    .map((b) => {
      if (b?.type === 'text') return b.text ?? ''
      if (b?.type === 'tool-call') return `[tool-call ${b.name ?? '?'}]`
      if (b?.type === 'tool-result') return `[tool-result ${String(b.content ?? '').slice(0, 200)}]`
      return ''
    }).join('').replace(/\s+/g, ' ').trim()
}

// 限幅原则（2026-09-09 放宽输出结构后重写）：
//   · **不再按标签分桶**——标签只是可选修辞，子代理可以自由组织 `[R] ` 行；
//     按标签限幅会让"没写标签"的行完全不受限，也可能反过来整条被丢掉。
//   · 只保留三道上限：**条数 / 单行长度 / 总量**。宁可多留几十字符，也不悄悄丢内容。
// 限幅原则（2026-09-10 用户要求"推理子对话不要裁剪"后再放宽）：
//   · 简报（子代理 → 主模型）是交付物，**默认不做长度裁剪**：条数/单行/总量三道上限只在
//     显式设置 env 时生效，且一旦真的裁了就写一条 `brief-clipped` 度量，绝不静默丢内容。
//   · 规范化 `[R]xxx` → `[R] xxx` 仍然保留（这是接口口径，不是裁剪）。
const MAX_BRIEF_ROWS = Number(process.env.EXTREASON_MAX_ROWS ?? 40)         // 【修 7】默认 40 条（0 = 不限）
const MAX_BRIEF_ROW = Number(process.env.EXTREASON_MAX_ROW_CHARS ?? 1200)   // 【修 7】默认单行 1200 字符（0 = 不限）
function parseBriefRows(raw) {
  const rows = String(raw ?? '').split('\n').map((l) => l.trim()).filter((l) => /^\[R\]\s*\S/.test(l))
  if (!rows.length) return ''
  const clipped = { rows: 0, rowChars: 0, total: 0 }
  const keep = []
  for (const l of rows) {
    if (MAX_BRIEF_ROWS > 0 && keep.length >= MAX_BRIEF_ROWS) { clipped.rows += 1; continue }
    // 规范化 `[R]xxx` → `[R] xxx`：注入器/转录器的口径是 `/^\[R\] /`（有空格），
    //   若这里放行无空格的写法，简报会进请求却**不会进 append-only 转录**（两边不一致）。
    const s = l.replace(/^\[R\](?=\S)/, '[R] ')
    if (MAX_BRIEF_ROW > 0 && s.length > MAX_BRIEF_ROW) { clipped.rowChars += 1; keep.push(s.slice(0, MAX_BRIEF_ROW) + ' …(truncated)') }
    else keep.push(s)
  }
  let out = keep.join('\n')
  if (MAX_BRIEF_CHARS > 0 && out.length > MAX_BRIEF_CHARS) { clipped.total = out.length - MAX_BRIEF_CHARS; out = out.slice(0, MAX_BRIEF_CHARS) + ' …(truncated)' }
  if (clipped.rows || clipped.rowChars || clipped.total) {
    // 绝不静默：裁剪发生时留一条度量（默认三道上限都是 0 = 不裁，此分支正常不会触发）
    try { console.log(`[EXTREASON] brief-clipped rowsDropped=${clipped.rows} longRows=${clipped.rowChars} totalCut=${clipped.total}（如需完整简报，把 EXTREASON_MAX_ROWS/MAX_ROW_CHARS/MAX_BRIEF 设为 0）`) } catch { /* best-effort */ }
  }
  return out
}

// route-A 度量：从简报里抽出"执行者将要碰的文件"。
// 与输出结构解耦（2026-09-09）：不再依赖 待改位置/文件事实 标签，而是在**任何** `[R] ` 行里找
// 路径样 token（含分隔符、末段带扩展名），这样标签退回可选修辞后度量依然可用。
// 说明：盘符必须**连分隔符一起**吃掉（`D:\` / `D:/`），否则 `D:\DSH\…` 会从 `DSH\` 开始匹配，
//   丢掉盘符（实测）；末段必须含扩展名才算文件（在 extractTargets 里过滤）。
const TARGET_RE = /(?:[A-Za-z]:[\\/]|[\\/]{1,2})?(?:[\w.\-]+[\\/])+[\w.\-]+|\b[\w\-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|ya?ml|md|py|go|rs|java|cs|cpp|cc|h|hpp|sh|ps1|toml|ini|cfg|conf|txt|html|css|sql|patch|diff)\b/gi
function extractTargets(rows) {
  const out = new Set()
  for (const l of String(rows ?? '').split('\n')) {
    if (!/^\[R\]/.test(l.trim())) continue
    for (const m of l.matchAll(TARGET_RE)) {
      const p = m[0].replace(/:\d+(-\d+)?$/, '').replace(/[.,;:]+$/, '')
      if (!p || p.length > 260) continue
      if (/[\\/]$/.test(p)) continue        // 目录不是可读目标
      const base = p.split(/[\\/]/).pop() ?? ''
      if (!base.includes('.')) continue     // 末段没有扩展名 ⇒ 当作目录/标识符
      out.add(p.replace(/\\/g, '/').toLowerCase())
    }
  }
  return [...out]
}

function argsText(raw) {
  if (typeof raw === 'string') return raw
  try { return JSON.stringify(raw ?? {}) } catch { return '' }
}

// —— 父会话增量摘要（喂给持久子会话，让它的"场景"跟上主模型）——
// 输出行与 StateCompiler 的转录同形（[U]/[A]/[T]），子代理读起来一致。
// 【修 2】0 必须**真的关闭**摘要：旧实现只把它当截断上限，而 `slice(-0)` 等于 `slice(0)`（整串）
//   ⇒ EXTREASON_DIGEST_MAX=0 反而把**完整**摘要发出去，与"=0 关闭"的宣称相反。
//   现在 0（或负数）⇒ 不构建、不发送摘要。
// 【修 5 · 2026-09-10 用户要求】推理子会话的摘要**默认不再裁剪**：
//   旧实现逐行裁（[U] 300 字符 / [A] 400 字符）+ 总量上限 4000 并插 `…（更早的增量已省略）`，
//   后果是实测中子会话只看到半句话 → 误判"上一轮回复被截断"并把这个误判当结论写进简报。
//   现在：默认**不裁行、不设总量上限**（完整增量发给持久子会话；它本来就该跟得上主模型）。
//   【修 8】总量上限恢复为默认 24000：完全不裁会让父会话增量（含未切片的 [A] 全文）膨胀到 10 万字符级，`n//     子会话每轮都要吃下这份输入（实测用户看到『已截断，共 101076 字符』）——慢且贵。截断仍按**行边界**丢弃`n//     最旧整行并保留"更早的增量已省略"标记（不做行内切片，避免上轮"只看到半句话"的误判）；=0 表示不发摘要。
const DIGEST_MAX_CHARS = Number(process.env.EXTREASON_DIGEST_MAX ?? 24000) // 【修 8】默认 24000 字符上限（0 = 不设上限）
const DIGEST_ON = !(Number.isFinite(DIGEST_MAX_CHARS) && DIGEST_MAX_CHARS === 0 && process.env.EXTREASON_DIGEST_MAX !== undefined)
const DIGEST_CLAMP = Number.isFinite(DIGEST_MAX_CHARS) && DIGEST_MAX_CHARS > 0
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
function digestTargetOf(raw) {
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw ?? {})
    const p = a.file_path ?? a.path ?? a.filePath ?? a.pattern ?? a.command ?? ''
    return oneLine(p).slice(0, 120)
  } catch { return '' }
}
// 只取**正文**（text 块）：textOf 会把 tool-call 渲染成 `[tool-call pwsh]`，
// 直接用它会让"只有工具调用的 assistant 消息"产出 `[A] [tool-call pwsh]` 这种噪音行。
const textOnly = (m) => oneLine((Array.isArray(m?.content) ? m.content : []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n'))
function buildDigest(events, fromSeq) {
  if (!DIGEST_ON) return ''   // 【修 2】EXTREASON_DIGEST_MAX=0 ⇒ 不构建摘要（调用方也不发）
  const rows = []
  const pending = new Map() // callId -> {op, target}
  // 当前轮的用户消息单独在 prompt 里给出，摘要里跳过"最后一条真人消息"
  let lastUserSeq = -1
  for (const e of events) if (e?.type === 'user/message' && e?.data?.source?.kind === 'user') lastUserSeq = e.seq
  for (const e of events) {
    if (!e || (e.seq ?? 0) <= fromSeq) continue
    const d = e.data ?? {}
    if (e.type === 'user/message') {
      if (d.source?.kind !== 'user') continue
      if (e.seq === lastUserSeq) continue
      const t = textOnly(d.message ?? d)
      if (t) rows.push(`[U] ${t}`)     // 【修 5】不再截断（旧：slice(0, 300)）
    } else if (e.type === 'assistant/message') {
      const t = textOnly(d.message ?? d)
      if (t) rows.push(`[A] ${t}`)     // 【修 5】不再截断（旧：slice(0, 400)）
    } else if (e.type === 'tool/call') {
      if (d.callId) pending.set(d.callId, { op: d.name ?? '?', target: digestTargetOf(d.arguments) })
    } else if (e.type === 'tool/result') {
      const cid = (d.message?.content ?? []).find?.((b) => b?.type === 'tool-result')?.toolCallId
      const p = (cid && pending.get(cid)) || { op: '?', target: '' }
      const bad = !!d.error || /(^|\n)\s*Error:/i.test(String((d.message?.content ?? []).find?.((b) => b?.type === 'tool-result')?.content ?? ''))
      rows.push(`[T] ${p.op} | ${p.target || '-'} | ${bad ? 'ERR' : 'OK'}`)
      if (cid) pending.delete(cid)
    }
  }
  let out = rows.join('\n')
  // 【修 5】默认不再裁剪：只有显式设了正数上限（DIGEST_CLAMP）才按行边界截断
  if (DIGEST_CLAMP && out.length > DIGEST_MAX_CHARS) {
    // 按**行边界**截断：别把一条 `[T] …` 行切一半（否则子代理会看到 `| OK` 这种残行）
    const tail = out.slice(-DIGEST_MAX_CHARS)
    const nl = tail.indexOf('\n')
    out = '…（更早的增量已省略）\n' + (nl >= 0 ? tail.slice(nl + 1) : tail)
  }
  return out
}
// 事件流里流式分片（assistant/chunk 等）没有 seq ⇒ 取**最大 seq** 当游标，别取"最后一条"
const maxSeqOf = (events) => (events ?? []).reduce((m, e) => Math.max(m, e?.seq ?? 0), 0)

export default {
  name: 'EXTREASON',
  inject: ['tools', 'subagents', 'llm'],
  apply(ctx) {
    // 【修 1】关闭时**什么都不做**：不建目录、不打横幅、不注册任何钩子（旧版先打横幅再 return）
    if (!ENABLED) return
    console.log(`[EXTREASON] armed (v0.3 M2 (v4 source kind + sendMessage seam); enabled=${ENABLED}; force=${FORCE}; stateDir=${STATE_DIR}; briefDir=${DEBUG_BRIEF ? BRIEF_DIR : '(debug off)'})`)

    // —— 关掉 DSH 原生 subagent 的 report 机制（仅针对本插件的推理器子会话）——
    //   dsh-tool-subagent-report 通过 continuable-setup 给**每个持久子会话**装：
    //     · 一个 `report` 工具（注册在子会话**自己的层**里 ⇒ toolFilter 拦不住）
    //     · 一段系统提示 "Deliver your result with the report tool before you finish…"
    //   实测后果：推理器"搞一半跑去 report"（report 会把内容作为 relay 消息投给父会话，
    //   既不结束它自己的回合，又给主模型上下文添噪音）。
    //   同名 section 在**同一层**会重复报错，所以改用**子会话作用域的 guard** 直接拒绝该调用；
    //   人设里再补一句交付方式。识别方式：子会话日志里的 `subagent/descriptor.label`。
    try {
      ctx.subagents.registerContinuableSetup((childCtx) => {
        try {
          const evs = allEvents(childCtx?.agent?.session)
          const descriptor = evs.find((e) => e?.type === 'subagent/descriptor')
          const label = descriptor?.data?.label
          if (label !== CHILD_LABEL) return () => { /* 不是我们的推理器：什么都不做 */ }
          const off = childCtx.tools.guard((exec) => (exec?.name === 'report'
            ? 'No report tool in this sub-session: write `[R] ` lines in your reply text.'
            : undefined))
          log({ tag: 'child-report-guard', childId: childCtx?.agent?.session?.id ?? null, label })
          return off
        } catch (e) {
          log({ tag: 'child-setup-failed', err: String(e?.message ?? e) })
          return () => {}
        }
      })
    } catch (e) { log({ tag: 'setup-reg-failed', err: String(e?.message ?? e) }) }

    const reasoningOff = new Map()   // sid -> boolean（由 agent/request 观测）

    // 激活判定用的"主模型 reasoning 档"：优先服务，其次 settings.yaml（headless 下服务可能尚未就绪）
    function defaultEffortNow() {
      try {
        const e = ctx.get('agentDefaultModel')?.currentSelection?.()?.reasoningEffort
        if (e !== undefined) return String(e)
      } catch { /* ignore */ }
      try {
        const t = readFileSync(join(DSH_HOME, 'settings.yaml'), 'utf8')
        const m = t.match(/agent-default-model:[\s\S]{0,200}?reasoningEffort:\s*([A-Za-z0-9_-]+)/)
        if (m) return m[1]
      } catch { /* ignore */ }
      return null
    }

    // 与 defaultEffortNow 同源的"主模型**线路**"（provider/model）：同样优先服务，其次 settings.yaml。
    //   用途：子会话思考档的能力核对需要一条具体路由（没路由 = 查不了能力 = 不覆盖）。
    function defaultRouteNow() {
      try {
        const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
        if (sel?.provider && sel?.model) return { provider: String(sel.provider), model: String(sel.model) }
      } catch { /* ignore */ }
      try {
        const t = readFileSync(join(DSH_HOME, 'settings.yaml'), 'utf8')
        const block = t.match(/agent-default-model:[\s\S]{0,200}/)?.[0] ?? ''
        const provider = block.match(/provider:\s*([^\s#]+)/)?.[1] ?? null
        const model = block.match(/model:\s*([^\s#]+)/)?.[1] ?? null
        if (provider && model) return { provider, model }
      } catch { /* ignore */ }
      return { provider: null, model: null }
    }

    // —— 账单 + 子代理动作观测 + 单次工具调用看门狗 + route-A 度量 ——
    const childSessions = new Set()
    const toolTimers = new Map()   // callId -> {timer, sid, name}
    // route-A 度量：执行者的"探索性调用 / 定位步数"（写任务无法省掉读取，故度量探索成本）
    const execStats = new Map()    // sid -> {targets:Set, glob, grep, readTarget, readOther, edits, callsAtFirstEdit}
    const childLastText = new Map() // 子会话 sid -> 最后一条正文（= 简报；不再依赖工具交付）
    const childToolCalls = new Map() // 子会话 sid -> 本轮工具调用计数（预算/steer 用）
    const childByParent = new Map()  // 父会话 sid -> 持久子会话 id（一个父会话只用一个子会话）
    const startingFor = new Set()    // 正在为其创建子会话的父会话（让首条请求也能吃到思考档覆盖）
    const digestCursor = new Map()   // 父会话 sid -> 已喂给子会话的最大事件 seq（增量摘要游标）
    const childTurnWaiters = new Map() // 子会话 sid -> {resolve}：等它这一轮 turn/end
    const childTurnCount = new Map()   // 子会话 sid -> 已完成 turn 数（防"结束早于注册等待者"的竞态）

    // 子代理 Agent（steer 用）：continuable 路径不返回 localAgent，从 agents 注册表按 id 取
    const agentOf = (cid) => { try { return ctx.get('agents')?.get(cid) ?? null } catch { return null } }
    // 等子会话"这一轮"结束。
    //   ⚠ 竞态（2026-09-09 用户指出"有时候灵有时候不灵"）：快子代理可能在 followup() 返回**之前**
    //   就已走完 turn/end；若那时才注册等待者，就会一直等到 45s 超时（随后 interrupt、简报缺失）。
    //   故用**完成计数基线**：调用方在发 prompt 前取 baseline；若计数已 > baseline，说明它已经跑完，
    //   立刻返回；否则注册等待者。
    const waitChildTurn = (cid, ms, parentAgent, sid, baseline) => new Promise((resolve) => {
      if (!cid) return resolve('no-child')
      if ((childTurnCount.get(cid) ?? 0) > (baseline ?? 0)) return resolve('already-ended')
      const timer = setTimeout(() => {
        childTurnWaiters.delete(cid)
        try { ctx.subagents.interrupt(cid, { kind: 'ancestor', agent: parentAgent }) } catch (e) { log({ tag: 'interrupt-failed', sid, childId: cid, err: String(e?.message ?? e) }) }
        log({ tag: 'child-turn-timeout', sid, childId: cid, ms })
        resolve('timeout')
      }, ms)
      childTurnWaiters.set(cid, { resolve: (why) => { clearTimeout(timer); resolve(why) } })
    })
    const statOf = (sid) => {
      if (!execStats.has(sid)) execStats.set(sid, { targets: new Set(), glob: 0, grep: 0, readTarget: 0, readOther: 0, edits: 0, callsAtFirstEdit: null, calls: 0 })
      return execStats.get(sid)
    }
    const EDIT_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
    // 子代理识别（防递归）。依据 DSH 自己写进子会话的 meta（dsh-subagent childSessionMeta）：
    //   origin='subagent' / delegationDepth>0 / parentSession 指向父会话；再用 childSessions 兜底。
    const isSubagentAgent = (agent, sid) => {
      try {
        if (sid && childSessions.has(sid)) return true
        const meta = agent?.session?.meta ?? {}
        if (meta.origin === 'subagent') return true
        if (typeof meta.delegationDepth === 'number' && meta.delegationDepth > 0) return true
        if (meta.parentSession != null && meta.parentSession !== sid) return true
        const opt = agent?.options ?? {}
        if (typeof opt.subagentDepth === 'number' && opt.subagentDepth > 0) return true
        return false
      } catch { return false }
    }
    const isTargetPath = (rawArgs, targets) => {
      try {
        if (!targets || targets.size === 0) return false
        const a = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs ?? {})
        const p = String(a.file_path ?? a.path ?? a.filePath ?? '')
        if (!p) return false
        const norm = p.replace(/\\/g, '/').toLowerCase()
        for (const t of targets) if (norm.endsWith(String(t).replace(/\\/g, '/').toLowerCase())) return true
        return false
      } catch { return false }
    }
    ctx.on('session/event', (subject, event) => {
      try {
        const sid = subject?.id ?? null
        const isChild = childSessions.has(sid)
        if (event?.type === 'assistant/message') {
          const m = event.data?.message
          const blocks = (m?.content ?? []).map((b) => (b.type === 'tool-call' ? `tc:${b.name}` : b.type)).join('+')
          // 保留换行：简报是"一行一条 [R]"，压成一行会被行解析与限幅误伤（实测曾整份被丢）
          const rawTxt = (m?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n').trim()
          const txt = rawTxt.replace(/\s+/g, ' ')
          // 子代理的最后一条正文 = 简报（无论它有没有写成 [R] 行；没写就在取用处包一层）
          if (isChild && rawTxt) childLastText.set(sid, rawTxt)
          log({ tag: 'assistant', sid, isChild, step: event.data?.step ?? null, blocks, usage: event.data?.usage ?? null, text: txt.slice(0, 300) })
        } else if (event?.type === 'tool/call') {
          const callId = event.data?.callId ?? null
          const name = event.data?.name ?? null
          if (isChild && callId) {
            // 【修 3】这里**只记账、不中断**：到点写一行 `tool-timeout-observed` 并从表里摘掉计时器，
            //   不会 abort 这次工具调用（它爱跑多久跑多久）。真正掐断的是整轮 TURN_TIMEOUT_MS。
            const timer = setTimeout(() => { log({ tag: 'tool-timeout-observed', note: 'accounting-only; not a watchdog; the real abort is TURN_TIMEOUT', sid, name, ms: TOOL_TIMEOUT_MS }); toolTimers.delete(callId) }, TOOL_TIMEOUT_MS)
            toolTimers.set(callId, { timer, sid, name })
          }
          // 子代理工具预算：到点用 **steer**（DSH 官方的"最近一步转向"通道）催它收尾，
          //   而不是在提示词里写纪律。背景：实测一次大审校任务里推理器 glob 了 */*/*/*/* 一路翻目录，
          //   45s 到点被掐断、一个字都没交出来。给预算后它会在下一步边界收到"该给结论了"。
          if (isChild && sid) {
            const n = (childToolCalls.get(sid) ?? 0) + 1
            childToolCalls.set(sid, n)
            if (n === STEER_AT) {
              // 必须**延迟到 append 发布完成之后**：session/event 监听器里直接 steer 会撞上
              //   "session append cannot reenter while another append is being published"（实测）。
              setTimeout(() => {
                try {
                  const childAgent = agentOf(sid)
                  if (!childAgent?.steer) { log({ tag: 'steer-no-agent', sid, n }); return }
                  childAgent.steer({
                    id: randomUUID(),
                    role: 'user',
                    content: [{ type: 'text', text: 'Wrap up now: write what you already know as `[R] ` lines; no need to open more files.' }],
                    source: { kind: 'plugin:EXTREASON' },
                  })
                  log({ tag: 'steer', sid, n, at: STEER_AT })
                } catch (e) { log({ tag: 'steer-failed', sid, err: String(e?.message ?? e) }) }
              }, 0)
            }
          }
          if (!isChild && sid) {
            const st = statOf(sid)
            st.calls += 1
            const args = event.data?.arguments
            if (name === 'glob') st.glob += 1
            else if (name === 'grep') st.grep += 1
            else if (name === 'read') { if (isTargetPath(args, st.targets)) st.readTarget += 1; else st.readOther += 1 }
            if (EDIT_TOOLS.has(String(name))) {
              st.edits += 1
              if (st.callsAtFirstEdit === null) st.callsAtFirstEdit = st.calls
            }
          }
          log({ tag: 'tool-call', sid, isChild, name, args: argsText(event.data?.arguments).slice(0, 200) })
        } else if (event?.type === 'tool/result') {
          const callId = (event.data?.message?.content ?? []).find?.((b) => b?.type === 'tool-result')?.toolCallId
          if (callId && toolTimers.has(callId)) { clearTimeout(toolTimers.get(callId).timer); toolTimers.delete(callId) }
          const preview = (event.data?.message?.content ?? []).filter((b) => b.type === 'tool-result').map((b) => JSON.stringify(b.content).slice(0, 160)).join(' ')
          log({ tag: 'tool-result', sid, isChild, preview })
        } else if (event?.type === 'turn/end' && sid && isChild) {
          // 子会话这一轮结束 ⇒ 计数 +1，并唤醒等待者（continuable 路径靠它拿"简报已就绪"）
          childTurnCount.set(sid, (childTurnCount.get(sid) ?? 0) + 1)
          const w = childTurnWaiters.get(sid)
          if (w) { childTurnWaiters.delete(sid); w.resolve('end') }
        } else if (event?.type === 'turn/end' && sid && !isChild) {
          // route-A 度量落盘：执行者在"已知目标文件"下还要花多少探索调用
          const st = execStats.get(sid)
          if (st && st.calls > 0) {
            log({
              tag: 'exec-stats', sid, turn: event.data?.turn ?? null, targets: [...st.targets], nTargets: st.targets.size,
              glob: st.glob, grep: st.grep, readTarget: st.readTarget, readOther: st.readOther,
              edits: st.edits, callsAtFirstEdit: st.callsAtFirstEdit, calls: st.calls,
            })
          }
          if (st) execStats.delete(sid)
        }
      } catch { /* ignore */ }
    })

    // agent/request 是 waterfall：必须 return next()；顺带记录主模型实际 reasoningEffort。
    // 【v7 说明】推理器子会话默认会被 DSH 赋予**适配器默认档（high）**：resolveChildAgentOptions
    //   只把 provider/model/maxTokens 传给子代理，**不传 reasoningEffort**。实测同一环境同一轮：
    //     主模型 header.config.reasoningEffort = "off"（来自 settings.yaml agent-default-model）
    //     子代理 header.config.reasoningEffort = "high"（适配器默认）⇒ 它自己在那跑思维链
    //   这与本插件"用子代理**替代**主模型 reasoning"的意图相反，故这里把它按到 CHILD_EFFORT
    //   （默认 off：核实靠工具、交付靠 [R] 行，不再偷偷内部推理）。
    // 【修 5】这一步现在**先查能力、再覆盖**：目标档不被该 provider/model 支持就不覆盖（见文件头）。
    const isOurChild = (ag, cid) => {
      try {
        if (cid && childSessions.has(cid)) return true
        const parentSid = ag?.session?.header?.parentSession ?? ag?.session?.meta?.parentSession ?? null
        // 首条请求可能早于 childByParent 写入 ⇒ 用"正在为哪个父会话建子会话"兜住
        if (parentSid != null && (startingFor.has(parentSid) || childByParent.get(parentSid) === cid)) return true
        return false
      } catch { return false }
    }

    // —— 子会话思考档的能力核对（修 5）——
    // 子会话"实际会跑在哪条 provider/model 上"：优先**本次请求的提议配置**（cfg）——那正是 DSH
    //   接下来要做能力校验的那条路线（dsh-agent-loop/lib/index.js:698 的 route →
    //   dsh-llm/lib/index.js:1462 resolveCallWithInfo）；其次该会话已落盘的请求头（本文件其它地方
    //   也这么读）；再退到父会话的请求头（子会话首条请求时它自己还没有请求头）；最后默认选择/settings.yaml。
    const childRoute = (cfg, ag) => {
      const pick = (o) => (o?.provider && o?.model ? { provider: String(o.provider), model: String(o.model) } : null)
      try { const r = pick(cfg); if (r) return r } catch { /* ignore */ }
      try { const r = pick(ag?.session?.requestHeader?.()?.config); if (r) return r } catch { /* ignore */ }
      try {
        const psid = ag?.session?.header?.parentSession ?? ag?.session?.meta?.parentSession ?? null
        const r = pick(psid != null ? agentOf(psid)?.session?.requestHeader?.()?.config : null)
        if (r) return r
      } catch { /* ignore */ }
      return defaultRouteNow()
    }

    // 决策（不是"强制"）：返回**要覆盖成的档位**，或 null = 不覆盖（子会话跟随主模型）。
    //   全部不确定情形一律向"跟随"开放：宁可放弃本插件的档位意图，也不能因为一个档位把整轮子会话打挂。
    const childEffortDecided = new Map()   // `${sid}|${provider}/${model}` -> 档位或 null（每个子会话每条线路只判定一次）
    const decideChildEffort = async (cfg, ag, sid) => {
      const route = childRoute(cfg, ag)
      const key = `${sid}|${route.provider}/${route.model}`
      const decide = (decided, reason) => {
        childEffortDecided.set(key, decided)
        // 每个子会话只记一条判定行（provider/model 不是密钥，可安全落盘）
        log({ tag: 'child-effort', sid, provider: route.provider, model: route.model, want: CHILD_EFFORT ?? 'follow', decided, reason })
        return decided
      }
      if (childEffortDecided.has(key)) return childEffortDecided.get(key) ?? null
      if (!CHILD_EFFORT) return decide(null, 'follow-env')   // EXTREASON_CHILD_EFFORT=follow|inherit|same
      try {
        const llm = ctx.get('llm')
        if (!route.provider || !route.model || typeof llm?.resolveModelInfo !== 'function') return decide(null, 'unknown')
        const info = await llm.resolveModelInfo(route.provider, route.model)
        const efforts = info?.reasoning?.efforts
        // 判据与 DSH 完全一致（dsh-llm/lib/index.js:1470-1475）：没有 `reasoning` 字段 ⇒ 该模型
        //   不声明任何档位（pi-ai 对无推理能力的模型就是这样回报的，dsh-llm-pi-ai/lib/index.js:1591）；
        //   `efforts` 里没有想要的 id ⇒ 该档不被支持。两种都**不覆盖**。
        if (!Array.isArray(efforts)) return decide(null, 'unsupported')
        if (!efforts.some((e) => e?.id === CHILD_EFFORT)) return decide(null, 'unsupported')
        return decide(CHILD_EFFORT, 'applied')
      } catch (e) {
        // 能力查询本身失败（provider 未注册、适配器抛错……）⇒ 不覆盖，并留下原因
        log({ tag: 'child-effort-probe-failed', sid, provider: route.provider, model: route.model, err: String(e?.message ?? e) })
        return decide(null, 'unknown')
      }
    }

    ctx.on('agent/request', async (payload, next) => {
      const cfg = await next()
      // 被这层 try 兜住的只有**本插件自己的逻辑**：next() 抛错时不存在"可用的 config"，
      //   吞掉只会把真实错误藏起来（DSH 侧随后还会以更含糊的 "no provider/model" 报出）。
      try {
        const sid = payload?.agent?.session?.id ?? null
        if (sid) {
          reasoningOff.set(sid, cfg?.reasoningEffort === 'off' || (cfg?.reasoningEffort === undefined && defaultEffortNow() === 'off'))
          if (isOurChild(payload?.agent, sid)) {
            const decided = await decideChildEffort(cfg, payload?.agent, sid)
            if (decided && cfg?.reasoningEffort !== decided) return { ...cfg, reasoningEffort: decided }
          }
        }
      } catch { /* ignore */ }
      return cfg
    })

    const seenTurn = new Map()   // sid -> 已推理过的轮号（防止同一轮多步重复推理；按会话定界）
    const briefByTurn = new Map()   // sid -> {turn}：本轮已推理（后续步不重复注入）
    // sid -> 已记录过"该会话工具集里没有只读工具"（工具集被 preset 裁剪时每轮都会命中预检，
    //   但账本只记一次，避免刷屏；preset 换回带只读工具时交集非空 ⇒ 自动恢复，不受此集合影响）
    const skipNoToolsReported = new Set()

    // 简报注入方式（实测 DSH 源码后定）：作为 **pre-step 决策的末尾消息**，由循环以
    //   surfaceOp:'append' 落库（lib/index.js:554）。要点：
    //   · 必须用 `{ prepend: true }` 注册——waterfall 里**最先注册的 handler 最后包裹**，
    //     它追加的消息才会排在 skill 目录等更外层 handler 的消息**之后**（实测否则简报落在目录之前）；
    //   · 位置在最末 ⇒ 前缀缓存只在末尾断点，旧前缀照吃缓存；
    //   · 每轮只 append 一次，下一轮折叠时它落在"最后一个 DSH 注入节点之后" ⇒ 被折掉，不累积；
    //   · source.plugin='EXTREASON' 让 StateCompiler 识别（不计真人 ROUND、可折叠、[R] 行永久转录）。
    // 注：不能用"自己 session.append + 原位 replace"——那会把节点钉在会话开头（seq 早于用户消息），
    //   每轮改动都会从该点起击穿前缀缓存，且因 keepInject 的避让规则永远折不掉。
    // 注2：也不能在 session/event 监听里补位——DSH 禁止在 append 发布期间重入 append
    //   （实测报 "session append cannot reenter while another append is being published"）。
    const withBrief = (decision, text) => {
      if (!text || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const msg = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:EXTREASON' },
      }
      return { ...decision, messages: [...decision.messages, msg] }
    }

    // 【2026-09-09 v7】拦掉"我们自己子会话"的 `subagent-settled` 落定通知。
    //   背景（用户实测）：DSH 对 **continuable** 子会话在它每轮结束后会发一条 settled 通知给父会话；
    //   父会话正在跑 ⇒ `parent.steer(...)` 变成当前轮多出一步（主模型被再调一次），
    //   父会话空闲 ⇒ `parent.followup(...)` 直接**新开一轮**。实测 one-shot 子代理 0 条，
    //   continuable 子代理每轮 1 条（session-1bf4f93d: turns=6/users=6/settled=6）。
    //   我们在最外层 pre-step 里把这类消息从决策里删掉：它既不会进父会话上下文，也不会触发一次
    //   多余的模型调用（若整批只剩它，claimed 归零 ⇒ 本轮直接结束，不调模型）。
    //   只删**我们自己**的子会话（senderSessionId ∈ childSessions），别的插件的子代理不受影响。
    const isOurSettled = (m) => {
      try {
        const s = m?.source
        return s?.kind === 'subagent-settled' && s?.senderSessionId != null && childSessions.has(s.senderSessionId)
      } catch { return false }
    }
    const dropSettled = (decision) => {
      if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      if (!decision.messages.some(isOurSettled)) return decision
      const kept = decision.messages.filter((m) => !isOurSettled(m))
      log({ tag: 'drop-settled', dropped: decision.messages.length - kept.length, kept: kept.length })
      return { ...decision, messages: kept }
    }

    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
      // 先滤掉"我们自己子会话的落定通知"，再按剩余消息判断这一轮要不要推理
      const claimedMsgs = (Array.isArray(messages) ? messages : []).filter((m) => !isOurSettled(m))
      const claimed = claimedMsgs.length
      if (claimed === 0) return dropSettled(await next())
      const sid = agent?.session?.id ?? null
      // 防递归：**只跳过"我们自己 fork 出来的子代理"**，而不是"进程里第一个代理"。
      //   ⚠ 2026-09-09 用户实测暴露的 bug：旧实现用进程级 root.id（第一个碰到 pre-step 的代理），
      //     在 web 环境（一个进程服务多个会话）里只有**第一个会话**能激活，其余会话静默跳过——
      //     用户用 OFF 模式却"没有激活思考"就是这个原因。
      //   子代理识别依据（dsh-subagent childSessionMeta）：session.meta.origin='subagent' /
      //     delegationDepth>0 / parentSession 指向父会话；另加 childSessions 兜底。
      if (isSubagentAgent(agent, sid)) {
        log({ tag: 'skip', reason: 'subagent', sid, turn })
        return dropSettled(await next())
      }

      // 本轮已推理过 ⇒ 不重跑，也不重复注入（节点已在 surface 里）
      const cached = sid ? briefByTurn.get(sid) : null
      if (cached && cached.turn === turn) {
        log({ tag: 'inject-brief', sid, turn, step, source: 'surface-retained' })
        return dropSettled(await next())
      }

      // —— 激活判定：主模型 reasoning 必须为 off（或模型无思维链）——
      let armed = FORCE
      let effort = null
      let armReason = FORCE ? 'force' : 'unknown'
      if (!armed) {
        if (reasoningOff.has(sid)) armed = reasoningOff.get(sid) === true
        else {
          effort = defaultEffortNow()
          try {
            const c = agent?.session?.requestHeader?.()?.config
            if (c?.reasoningEffort !== undefined) effort = String(c.reasoningEffort)
          } catch { /* ignore */ }
          // 【2026-09-11 收紧】两条自动代劳路径默认关闭，只保留显式 off 与 EXTREASON_FORCE=1。
          //   用户报障：思考模式没有关，为什么拉起外部思考——旧默认下，模型未声明 reasoning 能力、
          //   或上一轮 assistant 没有 reasoning 块，都会被当成主模型不会思考而自动代劳；
          //   本地模型（ollama 手写路由）恰好两条都命中 ⇒ 档位没关也被代劳。
          //   恢复旧行为：EXTREASON_ARM_ON_NO_CAPABILITY=1 / EXTREASON_ARM_ON_NO_BLOCKS=1。
          if (effort === 'off') { armed = true; armReason = 'observed-off' }
          else if (effort === null && ARM_ON_NO_CAPABILITY) {
            try {
              const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
              const llm = ctx.get('llm')
              if (sel?.provider && sel?.model && typeof llm?.resolveModelInfo === 'function') {
                const info = await llm.resolveModelInfo(sel.provider, sel.model)
                const r = info?.reasoning
                if (r === undefined) { armed = true; armReason = 'no-reasoning-capability(env)' }
                else if (r?.defaultEffort === 'off') { armed = true; armReason = 'off-default-capability(env)' }
              }
            } catch (e) { log({ tag: 'cap-probe-failed', sid, err: String(e?.message ?? e) }) }
          }
          if (!armed && effort !== null && effort !== 'off' && ARM_ON_NO_BLOCKS) {
            try {
              const msgs = agent?.session?.deriveMessages?.() ?? []
              const lastAssistant = [...msgs].reverse().find((m) => m?.role === 'assistant')
              const blocks = Array.isArray(lastAssistant?.content) ? lastAssistant.content : []
              if (blocks.length > 0 && !blocks.some((b) => b?.type === 'reasoning' || b?.type === 'thinking')) { armed = true; armReason = 'no-reasoning-blocks(env)' }
            } catch { /* ignore */ }
          }
        }
      }
      // 每个会话每轮都记一条判定行（便于在 web 环境核对"为什么这个会话没激活"）
      log({ tag: 'arm-check', sid, turn, armed, effort, reason: (typeof armReason === 'string' ? armReason : 'force') })
      if (!armed) return dropSettled(await next())

      // —— 只读工具可用性预检（2026-09-11 真机修）——
      // 背景：子代理的 toolFilter.allow 里写死了 READONLY(read/glob/grep/web_search)，但**工具集是可被
      //   preset 裁剪的**（实测 minimal preset 只给 pwsh / str_replace_editor）。此时 DSH 的
      //   `tools.restrict()` 直接抛 `names unknown global tools "read","glob","grep","web_search"; known: pwsh, ...`，
      //   于是：子代理根本起不来、**每轮白跑一次**（136~178ms）、账本留一串 no-brief 报错，
      //   而且末尾还会写一行 `inject-brief chars:0`（看起来像注入过 ⇒ 误导排查）。
      // 现在先问工具注册表"这个 agent 作用域里到底看得见哪些工具"（`ctx.tools.schemas(agent)`，公开 API），
      //   取交集：① 交集非空 ⇒ 用交集（少一个 web_search 也照跑）；② 交集为空 ⇒ **干净跳过**，
      //   记一条 `skip-no-readonly-tools`（每会话只记一次，不刷屏），既不触发异常也不注入空简报；
      //   ③ 拿不到注册表（老 DSH / 无该服务）⇒ 返回 null，沿用旧行为，不因预检把功能关掉。
      let usableReadonly = null
      try {
        const rows = ctx?.tools?.schemas?.(agent)
        if (Array.isArray(rows)) {
          const visible = new Set(rows.map((r) => r?.name).filter(Boolean))
          usableReadonly = READONLY.filter((n) => visible.has(n))
          if (usableReadonly.length === 0) {
            if (!skipNoToolsReported.has(sid)) {
              skipNoToolsReported.add(sid)
              log({ tag: 'skip-no-readonly-tools', sid, turn, wanted: [...READONLY], visible: [...visible].sort() })
              console.log(`[EXTREASON] 本会话的工具集里没有可用的只读工具（wanted=${READONLY.join(',')}；visible=${[...visible].sort().join(',') || '(none)'}）⇒ 本轮不跑外置推理（属预期：该 preset 裁剪了工具集）`)
            }
            return dropSettled(await next())
          }
        }
      } catch (e) { log({ tag: 'tool-precheck-failed', sid, err: String(e?.message ?? e) }) }
      const childTools = usableReadonly ?? [...READONLY]

      // 本轮已推理过 ⇒ 不重跑（用 per-session 的轮号标记，避免 Set 随轮次无限增长）
      if (seenTurn.get(sid) === turn) return dropSettled(await next())
      seenTurn.set(sid, turn)

      const userText = (Array.isArray(claimedMsgs[claimed - 1]?.content) ? claimedMsgs[claimed - 1].content : [])
        .filter((b) => b?.type === 'text').map((b) => b.text).join('')

      // —— 起/续 fork 子代理（整轮 45s 上限）——
      // 不注册任何"交付工具"：子代理自然输出 `[R] …` 行，插件取它最后一条正文当简报。
      // （2026-09-09 用户指正：强制调 ReasonReport 属于过度工程——实测子代理常常直接回复
      //   `[R]` 行而不调工具；把交付绑在工具调用上会平白多出一个失败模式。）
      //
      // 【2026-09-09 v5】每个父会话只用一个**持久子会话**（continuable）：
      //   旧做法每轮 start() 一个一次性子代理 ⇒ DSH 的 subagent 目录（subagents.list，读持久化
      //   会话列表，按 createdAt 排序）每轮多一条，轮次一多，顶栏点开就是一大串。
      //   现改为：首轮 startContinuable() 建立持久子会话，之后每轮 followup() 续用同一个；
      //   子会话自己的历史（它读过的文件、上一轮简报）也留下来了，等于省掉重复读。
      //   逃生门：EXTREASON_CHILD_MODE=oneshot 退回旧行为（每轮一次性子代理）。
      const childMode = process.env.EXTREASON_CHILD_MODE === 'oneshot' ? 'oneshot' : 'continuable'
      // 测试钩子：EXTREASON_TEST_PROMPT 会追加到子代理 prompt 末尾（用于逼它调 report 验证 guard）
      const testPrompt = process.env.EXTREASON_TEST_PROMPT ? [String(process.env.EXTREASON_TEST_PROMPT)] : []
      const promptBlocks = [{ type: 'text', text: [
        `User's current message:\n${userText}`,
        '',
        'Work out this turn; check with read-only tools what you are unsure about,',
        'then write what the main model needs as `[R] ` lines.',
        ...testPrompt,
      ].join('\n') }]
      const t0 = Date.now()
      const ctrl = new AbortController()
      const onAbort = () => { try { ctrl.abort(new Error('turn timeout')) } catch { /* ignore */ } }
      try { signal?.addEventListener?.('abort', onAbort, { once: true }) } catch { /* ignore */ }
      const timer = setTimeout(() => { log({ tag: 'turn-timeout', sid, turn, ms: TURN_TIMEOUT_MS }); onAbort() }, TURN_TIMEOUT_MS)
      let childId = null
      let err = null
      let childBaseline = 0   // 发 prompt 前的子会话完成计数（见 waitChildTurn 的竞态说明）
      try {
        if (childMode === 'oneshot') {
          // 【v0.3】0.1.6+ 移除了 start(providerName, req) 一次性接口 ⇒ 统一走 startContinuable
          //   （子会话本就可续用，行为等价）。旧 start 路径保留给 0.1.5。
          if (typeof ctx.subagents?.start === 'function') {
            const res = await ctx.subagents.start('fork', {
              label: CHILD_LABEL,
              prompt: promptBlocks,
              parent: agent,
              persona: PERSONA,
              toolFilter: { allow: [...childTools] },
              signal: ctrl.signal,
            })
            childId = res?.id ?? null
            if (childId) childSessions.add(childId)
            await res?.result
          } else {
            const res = await ctx.subagents.startContinuable({
              provider: 'fork',
              label: CHILD_LABEL,
              request: { parent: agent, persona: PERSONA, toolFilter: { allow: [...childTools] }, prompt: promptBlocks },
              signal: ctrl.signal,
            })
            childId = res?.childId ?? null
            if (childId && sid) { childByParent.set(sid, childId); childSessions.add(childId) }
            await waitChildTurn(childId, TURN_TIMEOUT_MS, agent, sid, 0)
            log({ tag: 'child-start', sid, childId, mode: 'oneshot-as-continuable' })
          }
        } else {
          childId = sid ? (childByParent.get(sid) ?? null) : null
          // 缓存丢失（进程重启/长驻会话）⇒ 从 DSH 的持久子会话列表**找回**上一次那个，
          //   否则每重启一次就会多出一个子代理条目（用户实测的"有时候灵有时候不灵"）。
          if (!childId && sid) {
            try {
              const rows = await ctx.subagents.listChildren(sid)
              const mine = (rows ?? []).filter((r) => r?.kind === 'child' && r?.mode === 'continuable' && r?.label === CHILD_LABEL)
              if (mine.length) {
                childId = mine[mine.length - 1].id
                childByParent.set(sid, childId)
                childSessions.add(childId)
                log({ tag: 'child-recovered', sid, childId, found: mine.length })
              }
            } catch (e) { log({ tag: 'child-recover-failed', sid, err: String(e?.message ?? e) }) }
          }
          if (childId) {
            childBaseline = childTurnCount.get(childId) ?? 0
            // 续用同一个子会话：清掉上一轮的观测（正文/工具计数），再发这一轮的 prompt
            childLastText.delete(childId)
            childToolCalls.set(childId, 0)
            // 【v6】带上父会话**增量摘要**（[U]/[A]/[T] 行）：持久子会话保留的是自己的历史，
            //   不带上增量它就不知道主模型这一轮做了什么（容易给过时建议）。摘要按 seq 游标增量取，
            //   只发上一次之后的部分，长度上限 EXTREASON_DIGEST_MAX。
            let digest = ''
            // 【修 2】EXTREASON_DIGEST_MAX=0 ⇒ 整段跳过：不构建、不推进游标、不往 followup 里塞摘要块
            if (DIGEST_ON) {
              try {
                const evs = allEvents(agent?.session)
                const fromSeq = digestCursor.get(sid) ?? 0
                digest = buildDigest(evs, fromSeq)
                digestCursor.set(sid, maxSeqOf(evs) || fromSeq)
              } catch (e) { log({ tag: 'digest-failed', sid, err: String(e?.message ?? e) }) }
            }
            const followBlocks = digest
              ? [{ type: 'text', text: `What the main model did since your last turn (incremental log, for situational alignment):\n${digest}` }, ...promptBlocks]
              : promptBlocks
            // 【v0.3 / DSH 0.1.6+】subagents seam 重命名：followup(agent, childId, blocks, {source,signal})
            //   → sendMessage(agent, childId, blocks, {signal})；source 参数消失（消息归属由宿主
            //   producer-owned 标记，插件不再自报 source——恰是 v4 "producer-owned source kind" 的语义）。
            //   保留旧 API 回退，同一文件仍可跑 0.1.5。
            if (typeof ctx.subagents?.sendMessage === 'function') {
              await ctx.subagents.sendMessage(agent, childId, followBlocks, { signal: ctrl.signal })
            } else {
              await ctx.subagents.followup(agent, childId, followBlocks, {
                source: { kind: 'plugin:EXTREASON' },
                signal: ctrl.signal,
              })
            }
            log({ tag: 'child-followup', sid, childId, digestChars: digest.length })
          } else {
            childBaseline = 0
            if (sid) startingFor.add(sid)   // 首条请求早于 childByParent 写入 ⇒ 用这个兜住思考档覆盖
            let res = null
            try {
              res = await ctx.subagents.startContinuable({
                provider: 'fork',
                label: CHILD_LABEL,
                request: { parent: agent, persona: PERSONA, toolFilter: { allow: [...childTools] }, prompt: promptBlocks },
                signal: ctrl.signal,
              })
            } finally {
              if (sid) startingFor.delete(sid)
            }
            childId = res?.childId ?? null
            if (childId && sid) {
              childByParent.set(sid, childId)
              childSessions.add(childId)
              // 子会话的 seed 已覆盖"此刻之前的父日志"⇒ 增量摘要从此刻起算
              try {
                const evs = allEvents(agent?.session)
                digestCursor.set(sid, maxSeqOf(evs))
              } catch { /* ignore */ }
            }
            log({ tag: 'child-start', sid, childId })
          }
          // 等这一轮子会话结束（turn/end）；到点没结束就 interrupt 它，用已有的正文兜底。
          // baseline 见 waitChildTurn：防"快子代理在注册等待者之前就跑完了"。
          const waitWhy = await waitChildTurn(childId, TURN_TIMEOUT_MS, agent, sid, childBaseline)
          log({ tag: 'child-wait', sid, childId, why: waitWhy, baseline: childBaseline, count: childId ? (childTurnCount.get(childId) ?? 0) : null })
        }
      } catch (e) {
        err = String(e?.message ?? e)
      } finally {
        clearTimeout(timer)
        try { signal?.removeEventListener?.('abort', onAbort) } catch { /* ignore */ }
        for (const [, v] of toolTimers) clearTimeout(v.timer)
        toolTimers.clear()
      }

      // —— 取简报：子代理最后一条正文（没写成 [R] 行就包一层，避免"白跑一趟"）——
      const childText = childId ? childLastText.get(childId) : null
      const captured = childText
        ? { brief: /\[R\] /.test(childText) ? childText : `[R] ${childText.slice(0, 600)}`, caller: childId, at: Date.now() }
        : null
      if (childId) childLastText.delete(childId)
      if (childId) childToolCalls.delete(childId)
      const rows = parseBriefRows(captured?.brief)
      // 健壮性观测：没拿到任何简报（子代理没产出 [R] 行 / 超时）或简报被限幅清空 ⇒ 明确记一笔，
      //   便于归因"这次为什么没帮上忙"（不注入、不报错，失败开放）。
      if (!captured) log({ tag: 'no-brief', sid, turn, childId, ms: Date.now() - t0, err })
      else if (!rows) log({ tag: 'brief-empty', sid, turn, childId, chars: captured.brief.length })
      let targets = []
      if (rows) {
        // 【修 4】brief.txt / brief.json 只是**可选调试产物**（须 EXTREASON_DEBUG_BRIEF=1）。
        //   旧注释称"StateCompiler 注入器读这里"——该机制在本代码库里已不存在，落盘文件没有读取方。
        if (DEBUG_BRIEF) {
          try {
            writeFileSync(BRIEF_TXT, rows + '\n', 'utf8')
            writeFileSync(BRIEF_JSON, JSON.stringify({ t: Date.now(), turn, sid, rows: rows.split('\n').length, chars: rows.length, childId }) + '\n', 'utf8')
          } catch (e) { log({ tag: 'brief-write-failed', err: String(e?.message ?? e) }) }
        }
        targets = extractTargets(rows)
      }
      // route-A 度量：本轮的"已知目标文件"与计数器（执行者的探索成本就相对它来量）
      try {
        const st = statOf(sid)
        st.targets = new Set(targets)
        st.glob = 0; st.grep = 0; st.readTarget = 0; st.readOther = 0; st.edits = 0; st.calls = 0; st.callsAtFirstEdit = null
      } catch { /* ignore */ }
      log({ tag: 'turn', sid, turn, childId, ms: Date.now() - t0, briefChars: rows.length, reportChars: captured ? captured.brief.length : 0, targets, err, turnTimeoutMs: TURN_TIMEOUT_MS })

      // —— 同一轮内注入：简报作为本次请求的最后一条消息 ——
      // 注入包裹文本用英文（用户 2026-09-09：同语义更省 token）；每条 `[R] ` 行本身就是子代理写的，
      //   语言由它按用户消息决定。
      const briefText = rows
        ? `<external-reasoning brief (same session; follow it directly, no need to re-verify the file facts given)>\n${rows}\n</external-reasoning brief>`
        : ''
      if (briefText && sid) briefByTurn.set(sid, { turn })
      // 只在**真的注入了内容**时记 inject-brief：空简报是 no-op（withBrief 对空文本原样返回），
      //   旧实现照记一行 `chars:0`，看起来像"注入过一次简报" ⇒ 真机排查时误导（2026-09-11 修）。
      if (briefText) log({ tag: 'inject-brief', sid, turn, step, chars: briefText.length, mode: 'decision-tail' })
      else log({ tag: 'inject-skipped', sid, turn, step, why: err ? 'child-error' : (captured ? 'brief-empty' : 'no-brief') })

      return withBrief(dropSettled(await next()), briefText)
    }, { prepend: true })   // prepend：本 handler 最先注册 ⇒ 其追加的消息排在最后（见上）
  },
}
