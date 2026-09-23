// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// chunk.mjs — Phase A 纯函数模块（无 DSH 运行时依赖，可离线单测）
//   1. chunkForCompressor  按语义断点切分超窗口文本（§5.2 / §5.3）
//   2. detectMilestone     不依赖 LLM 的里程碑语块检测（§5.4，仅检测信号）
//   3. classifyCondenseError 压缩失败分型（§6.1）
//   4. CONDENSE_BUDGET     压缩预算表（§5.6，v1.1 已决）
// 设计依据：docs/v2-优化设计.md

// ============ 1. 分块压缩（§5.2 / §5.3） ============
export const CHUNK_DEFAULT_WINDOW_LINES = 24 // 回找上限（行）
// 切点优先级（§5.3）：段落空行 > 换行 > 句末标点（不含 '.'，避免劈开 obj.method()/URL/小数）
const SENT_END_RE = /[。！？!?]/

// 在 [start, hardEnd) 区间内，从截断处往回找最佳语义断点；找不到且 allowHardCut ⇒ 硬切
function findCut(src, start, maxBytes, windowBytes, allowHardCut) {
  const hardEnd = Math.min(start + maxBytes, src.length)
  if (hardEnd >= src.length) return src.length // 末尾，整段为一块
  const lookStart = Math.max(start, hardEnd - windowBytes)
  const seg = src.slice(lookStart, hardEnd)
  // 优先：段落空行（\n[ \t]*\n）
  let idx = seg.lastIndexOf('\n\n')
  if (idx < 0) idx = seg.lastIndexOf('\n \n')
  if (idx >= 0) return lookStart + idx + 2 // 含空行，下块从空行后起
  // 次：换行（按行切对代码类工具结果最安全）
  const nl = seg.lastIndexOf('\n')
  if (nl >= 0) return lookStart + nl + 1
  // 再次：句末标点（中/英，不含孤立 '.'）
  for (let i = seg.length - 1; i >= 0; i--) {
    if (SENT_END_RE.test(seg[i])) return lookStart + i + 1
  }
  // 兜底：硬切（allowHardCut）或整段作单块（交由上层）
  return allowHardCut ? hardEnd : src.length
}

export function chunkForCompressor(text, maxBytes, opts = {}) {
  const windowLines = opts.windowLines ?? CHUNK_DEFAULT_WINDOW_LINES
  const allowHardCut = opts.allowHardCut !== false
  const windowBytes = windowLines * 120 // 行→字节量级近似
  const src = String(text)
  const out = []
  let start = 0
  while (start < src.length) {
    const cut = findCut(src, start, maxBytes, windowBytes, allowHardCut)
    if (cut <= start) { out.push(src.slice(start)); break } // 兜底防死循环
    out.push(src.slice(start, cut))
    start = cut
  }
  return out
}

// ============ 2. 里程碑检测（§5.4，仅检测信号） ============
export const MILESTONE_THRESHOLD_K_DEFAULT = 3 // 默认 3× 起步（评审建议值 2026-09-08）
export const MILESTONE_MIN_BYTES = 512 // 绝对下限 512B（评审建议值）
// 描述性/总结性启发式词（命中才视作"阶段总结"而非普通工具输出）
const MILESTONE_DESCRIPTIVE_RE = /(已完成|总结|发现|关键|阶段性|本轮|结论|成果|重大|进展|已解决|已确认|成功|失败|注意)/

export function detectMilestone(text, stat = {}) {
  const minBytes = stat.minBytes ?? MILESTONE_MIN_BYTES
  const k = stat.thresholdK ?? MILESTONE_THRESHOLD_K_DEFAULT
  const mean = stat.meanBlockBytes && stat.meanBlockBytes > 0 ? stat.meanBlockBytes : minBytes
  const len = String(text).length
  if (len < minBytes) return false
  if (!MILESTONE_DESCRIPTIVE_RE.test(text)) return false // 非描述性/总结性 ⇒ 不算里程碑
  return len > k * mean
}

// ============ 3. 压缩失败分型（§6.1） ============
// 把自由文本失败原因归一到 enum 值；disposal 由调用方按处置路径填（见 §6.3）
export function classifyCondenseError(reason) {
  const r = String(reason ?? '')
  if (/llm service unavailable|llm 服务缺失|未提供 llm/.test(r)) return 'llm-unavailable'
  if (/condense route missing|no condense route|无浓缩路由/.test(r)) return 'route-missing'
  if (/stream error|流错误|流式异常/i.test(r)) return 'stream-error'
  if (/no finish chunk|无 finish/.test(r)) return 'no-finish'
  if (/finish=/.test(r)) {
    const m = r.match(/finish=(\w+)/)
    return m ? 'finish-' + m[1] : 'finish-other'
  }
  if (/parse|解析失败|行协议|不合规/.test(r)) return 'parse-error'
  if (/payload|值校验|保真|载荷未过/.test(r)) return 'fidelity-blocked'
  if (/timeout|超时|abort/i.test(r)) return 'timeout'
  if (/ollama/i.test(r)) return 'ollama-error'
  if (/empty|空输出|返回空/.test(r)) return 'empty-output'
  if (/未短|not shortened|复读|未缩短/.test(r)) return 'not-shortened'
  return 'other'
}

// ============ 4. 压缩预算表（§5.6，v1.1 已决） ============
// 预算 = 该信息类型的保真权重（浓缩强度上限，1=全保真、0=可全丢）；与档位(single/double)正交
export const CONDENSE_BUDGET = {
  user_instruction: 0.9, // 用户指令：高保真
  tool_error: 0.6, // 工具错误：保留诊断
  ai_summary: 0.15, // AI 阶段性总结：最可压缩
  exploration: 0.05, // 探索/试错往返：最低保真
}
// 按 [A] 块上下文推断信息类型（启发式；与相邻 [T] ERR / 里程碑 / 普通轮流）：
//   - 附近 [T] 带 ERR ⇒ tool_error
//   - 命中里程碑（detectMilestone） ⇒ ai_summary
//   - 否则普通 AI 轮 ⇒ exploration
export function inferBlockType(text, opts = {}) {
  if (opts.nearToolError) return 'tool_error'
  if (opts.milestone) return 'ai_summary'
  return 'exploration'
}

// ============ 5. 消息来源分型（§13，2026-09-08 实测） ============
// 背景：DSH 把系统注入（system-reminder / background job 通知 / 审批策略变更 / subagent
//   回传）以 role:'user' 写进会话历史，旧判定只看 role ⇒ ROUND 被灌水 4.8×（实测 29 轮仅 6 轮真实）。
//
// 事件/消息结构（关键）：
//   user/message 事件：data = { content, source, role, id }
//     —— source 在 **data.source**；不存在 data.message 这一层。
//        （旧 logcompiler 误取 data.message?.source，导致 source 检查恒为 undefined、从未生效）
//   deriveMessages() 的消息：m.source（同一 MessageSource 形状）
//
// source.kind 是 merge-extensible 联合类型，除文档四选一 user/plugin/model/tool 外，
//   实测另有 skill-catalog / subagent-settled / subagent-report ⇒
//   **只能用 kind === 'user' 判真实用户轮**，不可做"非 user 即插件"的二分假设。
export const SELF_PLUGIN_NAME = 'CONTEXTinjector'
// 已知 notice 类插件名 → 子类（用于 [N] 行细分）
const NOTICE_SUB_BY_PLUGIN = { 'tool-jobs': 'job', 'user-approval': 'approval' }

// 【#2 修复（取自 RCS-0.1.0 返回包）】注入类 user 消息的文本前缀集 —— **单一来源**。
// 背景：注入器与 logcompiler 在 source 缺失（DSH 规定必填，缺失属异常）时的回退分支
//   此前各写一套前缀，同一事件可能一侧跳过、一侧计入 ROUND → 审计轮号与注入侧分叉。
//   此处提为唯一来源，两处均从此导入，杜绝再次漂移。
export const INJECTED_USER_PREFIXES = [
  'Current runtime context',
  'Current DSH file policy',
  'Current DSH permission mode',
  'sandbox:',
  '[ROUND]',
]

export function classifyMessageSource(source, opts = {}) {
  const self = opts.selfPlugin ?? SELF_PLUGIN_NAME
  const src = source ?? null
  if (!src || typeof src !== 'object') return { cls: 'opaque', kind: undefined }
  const kind = src.kind
  const form = src.form
  const plugin = src.plugin
  if (kind === 'user') return { cls: 'user' }
  if (kind === 'plugin' && plugin === self) return { cls: 'self' }
  // 【extreason 接入（取自 RCS-0.1.0）】外置推理简报：文本本身已是 `[R] …` 行 ⇒ 单独一类，
  //   两个转录器都按行保留、不计 ROUND。它是 append-only 日志的一部分（会被折进转录并永久保留），
  //   不是易失注入。位置必须在 opaque 兜底之前，否则会落 opaque ⇒ 两转录器都不转录（静默丢内容）。
  if (kind === 'plugin' && plugin === 'EXTREASON') return { cls: 'extreason' }
  // subagent 报告：内容需主模型看到，但语义接近工具结果 ⇒ 走 [T]/[V]，不计 ROUND
  if (kind === 'subagent-report' || form === 'relay') return { cls: 'relay', agentId: opts.agentId ?? null }
  if (kind === 'subagent-settled') return { cls: 'notice', sub: 'subagent' }
  // 无 form 的 notice 类插件（实测 user-approval 不带 form）
  if (kind === 'plugin' && NOTICE_SUB_BY_PLUGIN[plugin]) return { cls: 'notice', sub: NOTICE_SUB_BY_PLUGIN[plugin] }
  if (form === 'snapshot') return { cls: 'snapshot', sections: Array.isArray(src.sections) ? src.sections : [] }
  if (form === 'catalog' || kind === 'skill-catalog') return { cls: 'catalog' }
  if (form === 'notice') return { cls: 'notice', sub: NOTICE_SUB_BY_PLUGIN[plugin] ?? 'notice' }
  // 未知 kind（含未来新增）⇒ 保守跳过并回传 kind，便于调用方计数/上报
  return { cls: 'opaque', kind }
}

// 事件适配器：读 data.source（**不是** data.message.source）
export function classifyUserMessage(ev, opts = {}) {
  return classifyMessageSource(ev?.data?.source, opts)
}

const SUBAGENT_ID_RE = /subagent\s+([0-9a-fA-F][0-9a-fA-F-]{7,})/
export function subagentIdOf(text) {
  const m = SUBAGENT_ID_RE.exec(String(text ?? ''))
  return m ? m[1] : null
}

// 快照摘要：只留 sections 名。runtime 快照每 step 重注入（实测 14 次），
// 全量转录会显著膨胀，故 [S] 行只存摘要。
export function snapshotSummary(sections) {
  if (!Array.isArray(sections) || !sections.length) return 'runtime snapshot'
  const names = sections.map((s) => s && s.name).filter(Boolean)
  return names.length ? 'runtime snapshot: ' + names.join(', ') : 'runtime snapshot'
}

// ============ 6. 单块压缩 token 预算（§4.2 纯算术部分） ============
// 说明：§4 的完整 resolveCondenseMaxTokens 需异步取 ctx.llm.resolveModelInfo（真机侧），
//   此处仅落**纯算术**分支（§4.2）：给定已解析的 ctxWindow / defaultMaxTokens / 硬覆盖，
//   折算单块压缩 token 预算。真机接线在拿到窗口值后调用本函数即可，默认回退内置 700，
//   无回退风险、不触碰折叠主链路。建议值（评审 2026-09-08）：min(defaultMaxTokens,
//   ctxWindow − inputBudget − 20%余量)，不必 ×0.5；预算下限 256。
//   MAX_TOKEN_FLOOR = 256（语义：预算过小会退回无损，故设下限防无意义压缩）
export const MAX_TOKEN_FLOOR = 256
export function resolveMaxTokenBudget({ hardOverride, ctxWindow, defaultMaxTokens, inputBudget = 0, fallback = 700, floor = MAX_TOKEN_FLOOR } = {}) {
  const b = Math.max(0, Number(inputBudget) || 0)
  if (hardOverride != null && Number.isFinite(hardOverride)) return Math.max(floor, Math.floor(hardOverride))
  if (ctxWindow != null && defaultMaxTokens != null && ctxWindow > 0 && defaultMaxTokens > 0) {
    const ctxW = Math.floor(ctxWindow)
    const headroom = Math.max(0, ctxW - b - Math.floor(ctxW * 0.2))
    return Math.max(floor, Math.min(defaultMaxTokens, headroom))
  }
  if (defaultMaxTokens != null && defaultMaxTokens > 0) return Math.max(floor, Math.floor(defaultMaxTokens))
  if (ctxWindow != null && ctxWindow > 0) {
    const ctxW = Math.floor(ctxWindow)
    return Math.max(floor, Math.floor(ctxW * 0.8 - b))
  }
  return Math.max(floor, Math.floor(fallback))
}