// Deterministic durability policy for Cycle 2 proposals.
//
// The model is good at copying text and bad at deciding whether a user message is
// a standing project rule or a one-off task/question. That decision is therefore
// made here, from the archived text alone, before any model call and again inside
// the evidence validator. The model still chooses the exact quote; this module
// only bounds where a quote may come from and how an overlapping predicate is
// named.
//
// Nothing here reads a clock, a model, or mutable state. Every result is a pure
// function of the input text, so a replay produces the same spans and predicates.

export const DURABILITY_POLICY_VERSION = 'durable-v1'

const RE = {
  // Prompt-injection / role confusion. Explicit instructions to rewrite memory are
  // never evidence, even when the text uses a durable-sounding label.
  injection: [
    /^\s*(SYSTEM|SYSTEM\s+OVERRIDE|系统指令|系统提示|SYSTEM\s+PROMPT)\s*[:：]/i,
    /(忽略|无视|忘记).{0,8}(之前|以上|前面|原有).{0,6}(规则|指令|约束|设定)/,
    /(把|将)(这条|这句话|上面这句|此条).{0,12}(写成|记为|记录为|设为|当作).{0,8}(约束|规则|偏好|决策|事实)/,
  ],
  assistantProse: [
    /^\s*(我会记住|我已记住|已经记住|已为你|已完成|已处理|总结如下|根据以上|以下是)/,
    /(我(会|将)(记住|记录)|已(经)?(记录|记住)|根据(你|您)的(要求|偏好))/,
  ],
  codeDump: [
    /^\s*```/,
    /^\s*(const|let|var|function|class|import|export)\s/m,
  ],
  question: [
    /[？?]\s*$/,
    /(吗|呢)\s*[。.]?\s*$/,
    // A request for the current turn ("简单些好吗", "这样可以吗") is not a standing
    // fact even when it carries a modal like 不要. The marker can sit mid-sentence.
    /(好吗|行吗|可以吗|好不好|成吗|行不行|可不可以)/,
  ],
  uncertain: [
    /(我(还)?没(想好|定|确定)|还没想好|还没定|未定|待定|等有结论|再说吧|回头再说|具体方案还没定|拿不准|不确定(要|是否|用|选|改|做)|你(觉得|看)呢)/,
  ],
  transient: [
    /(这次|本次|临时|暂时|先试|试试看|试一下|跑一下|抓一次|测试完|先这样)/,
  ],
  plan: [
    /(打算|计划|准备(?!好)|回头|下次再|以后再说|等有结论)/,
    /(如果|假如).{0,24}(发布|上线|发版|合并|关掉|恢复原设置)/,
  ],
  transientError: [
    /(刚才|刚刚|这次|本次).{0,24}(报错|报了|错误|失败|超时|异常).{0,12}(重试|再试|试试|一下|再跑|看下)/,
    /(构建|测试|运行|安装).{0,8}(失败|报错).{0,12}(重试|再跑|再试)/,
  ],
  fileObservation: [
    /(里写着|上写着|里已经写着|历史记录|只是历史|已经有.{0,16}(脚本|配置|文件|依赖))/,
    /(README|package\.json|源码|文档)(里|中)\s*(写|说|提到|记录|配置)/i,
  ],
  assignmentOpen: [
    /^\s*(你负责|你来做|你来|请你|请|帮我|麻烦|先|现在|这次|本次|临时|实现|修复|补足|运行|读取|写入|检查|启动|关闭|把|将|给我|重试|再试)/,
  ],
  assignmentCompletion: [
    /(完成后|做完|然后|再运行|再重新|并告诉我|告诉我|汇报|输出|贴出来|贴给我|确认结果|确认一下|运行测试|跑一遍|测试完|关掉|恢复原设置|抓一次|看看|查一下|问一下|搞定)/,
  ],
  directiveVerb: [
    /(实现|修复|补足|运行|读取|写入|检查|启动|关闭|调成|恢复|汇报|输出|贴出来|告诉我|定位|列出|修改|删除|移动|重命名|重试|跑|做|看)/,
  ],
  secondPerson: [/你|您/],
  strongDurable: [
    /(规则|约定|规范|标准|原则|约束)/,
    /(记下|记住|记录一下|请记录|写进记忆|加入记忆)/,
    /(以后|今后|往后|未来|长期|永久|始终|永远|每次|下一次)/,
  ],
  explicitRule: [
    /(规则|约定|规范|标准|原则|约束)\s*[:：]/,
    /(项目|业务|接口|部署|测试|命名|结算|开发|团队|代码|提交|评测|安全|数据|协作|发布|架构|设计)[^，。；：]{0,6}(规则|约定|规范|标准|原则|约束)/,
    /(这是|那是|作为|按照|根据|遵循)[^。；]{0,6}(规则|约定|规范|标准|原则|约束)/,
  ],
  memo: [
    /(记下|记住|记录一下|请记录|写进记忆|加入记忆)/,
  ],
  future: [
    /(以后|今后|往后|未来|长期|永久|始终|永远|每次|下一次)/,
  ],
  universal: [
    /(一律|统一|总是|所有|任何|全部|默认|优先|从不|绝不)/,
  ],
  modal: [
    /(必须|不得|不允许|禁止|不能|不要|别|只允许|只能|最多|至少|应当|应该|可回滚|全绿|不得超过|保持|视为|固定为|需要固定)/,
  ],
  decision: [
    /(决定|确定|定版|拍板|采用|改用|选用|迁移到|改为|改成|为准|最终方案|而不是|不引入|不再接受|不再适用|作废|撤回|取消|废弃|停用|撤销|回退|改回|不再使用)/,
  ],
  preference: [
    /(偏好|更喜欢|喜欢|习惯|倾向|希望|不喜欢|prefer|would rather)/i,
  ],
  interaction: [
    /(回答|回复|答复|沟通|先给结论|先给细节|先说明|先提问|提问|不要猜|命名|格式|风格|行文|报告|绝对路径|相对路径)/,
  ],
  retraction: [
    /(作废|撤回|取消|废弃|停用|撤销|不再适用|不再使用|回退|改回|不用了|不要了)/,
  ],
  english: [
    /\b(decided|decision|prefer|preference|must|never|always|should|requires?|required|avoid|convention|rule|constraint|from now on)\b/i,
  ],
  domain: [
    /(金额|折扣|优惠券|结算|测试|依赖|接口|部署|生产|字段|单位|四舍五入|端口|目录|路径|文件|版本|编码|日志|数据库|缓存|并发|安全|权限|响应|请求|API|JSON|错误|时间|时区|精度|上限|下限|类型|schema)/i,
  ],
}

function any(patterns, text) {
  for (const pattern of patterns) {
    if (pattern.test(text)) return pattern
  }
  return null
}

function describe(pattern) {
  return pattern?.source ?? null
}

// Sentence spans that keep their offsets. Chinese terminators and line breaks end a
// sentence; ASCII periods do not, because a decimal/version/path can contain one.
export function sentenceSpans(text) {
  if (typeof text !== 'string' || text === '') return []
  const spans = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\n' || char === '。' || char === '！' || char === '？' || char === '；' || char === ';') {
      const end = index + 1
      if (text.slice(start, end).trim() !== '') spans.push({ start, end })
      start = end
    }
  }
  if (start < text.length && text.slice(start).trim() !== '') {
    spans.push({ start, end: text.length })
  }
  return spans
}

function sentenceSignals(text) {
  return {
    explicitRule: any(RE.explicitRule, text),
    memo: any(RE.memo, text),
    future: any(RE.future, text),
    universal: any(RE.universal, text),
    modal: any(RE.modal, text),
    decision: any(RE.decision, text),
    preference: any(RE.preference, text),
    interaction: any(RE.interaction, text),
    retraction: any(RE.retraction, text),
    english: any(RE.english, text),
    domain: any(RE.domain, text),
  }
}

function hasSignal(signals) {
  return Object.values(signals).some(Boolean)
}

function strongSignal(signals) {
  return Boolean(signals.explicitRule || signals.memo || signals.future)
}

function mergeSpans(units) {
  const merged = []
  for (const unit of units) {
    const last = merged[merged.length - 1]
    if (last && last.end >= unit.start) {
      last.end = Math.max(last.end, unit.end)
      last.reasons.push(...unit.reasons)
      continue
    }
    merged.push({ ...unit, reasons: [...unit.reasons] })
  }
  return merged
}

function signalsOf(signals) {
  return Object.entries(signals)
    .filter(([, pattern]) => Boolean(pattern))
    .map(([name]) => name)
}

// Pure classification of one archived human message.
//
// `eligible` means a proposal may be generated from it. `spans` are the only text
// ranges a quote may occupy; a quote that crosses an ineligible sentence is
// refused by the validator even when the message as a whole is eligible.
export function analyzeDurableUtterance(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return {
      eligible: false, reason: 'empty', reasons: ['empty'], signals: [], spans: [],
      policyVersion: DURABILITY_POLICY_VERSION,
    }
  }
  // Keep the original offsets: callers compare these spans with an indexOf result
  // on the archived text, so trimming here would shift every unit.
  const raw = text
  const match = (patterns) => any(patterns, raw)
  const injection = match(RE.injection)
  const assistantProse = match(RE.assistantProse)
  const codeDump = match(RE.codeDump)
  const question = match(RE.question)
  const uncertain = match(RE.uncertain)
  const transient = match(RE.transient)
  const plan = match(RE.plan)
  const transientError = match(RE.transientError)
  const fileObservation = match(RE.fileObservation)
  const assignmentOpen = match(RE.assignmentOpen)
  const assignmentCompletion = match(RE.assignmentCompletion)
  const directiveVerb = match(RE.directiveVerb)
  const secondPerson = match(RE.secondPerson)
  const strong = match(RE.strongDurable)
  const future = match(RE.future)

  // Precedence is intentional. A transient or reported message must not become
  // durable just because it contains a decision verb ("临时决定…", "README 里写着
  // 决定…"), and a question must not become a fact because it contains "以后".
  let reason = null
  if (injection) reason = 'injection'
  else if (assistantProse) reason = 'assistant-prose'
  else if (codeDump) reason = 'code-dump'
  else if (question) reason = 'question'
  else if (uncertain) reason = 'uncertain'
  else if (transient && !future) reason = 'transient'
  else if (plan) reason = 'plan'
  else if (transientError) reason = 'transient-error'
  else if (fileObservation) reason = 'file-observation'

  const assignment = Boolean(
    assignmentOpen && (assignmentCompletion || (secondPerson && directiveVerb)),
  )
  if (reason === null && assignment && !strong) reason = 'task-assignment'

  const spans = sentenceSpans(raw)
  const units = []
  for (const span of spans) {
    const sentence = raw.slice(span.start, span.end)
    const signals = sentenceSignals(sentence)
    if (!hasSignal(signals)) continue
    if (assignment && !strongSignal(signals)) continue
    units.push({
      start: span.start,
      end: span.end,
      reasons: signalsOf(signals),
      text: sentence,
    })
  }

  if (reason === null && units.length === 0) reason = 'no-durable-signal'

  return {
    eligible: reason === null,
    reason,
    reasons: reason === null ? [] : [reason],
    signals: {
      injection: describe(injection),
      assistantProse: describe(assistantProse),
      codeDump: describe(codeDump),
      question: describe(question),
      uncertain: describe(uncertain),
      transient: describe(transient),
      plan: describe(plan),
      transientError: describe(transientError),
      fileObservation: describe(fileObservation),
      assignment: assignment ? 'assignment' : null,
      strongDurable: describe(strong),
      future: describe(future),
    },
    spans: mergeSpans(units).map(({ start, end, reasons }) => ({ start, end, reasons })),
    policyVersion: DURABILITY_POLICY_VERSION,
  }
}

// The taxonomy is defined by these cues, in this order. The model's predicate is
// advisory: when a cue is present the deterministic label wins, because an
// undefined taxonomy is what produced content-correct/predicate-wrong candidates.
export function resolveQuotePredicate(text) {
  if (typeof text !== 'string') return null
  const signals = sentenceSignals(text)
  if (signals.explicitRule) return { predicate: 'project.constraint', rule: 'explicit-rule-noun' }
  if (signals.preference || signals.interaction) {
    return { predicate: 'project.preference', rule: signals.preference ? 'preference-cue' : 'interaction-cue' }
  }
  if (signals.decision) return { predicate: 'project.decision', rule: 'decision-cue' }
  if (signals.english) {
    if (/\b(prefer|preference|would rather)\b/i.test(text)) {
      return { predicate: 'project.preference', rule: 'english-preference' }
    }
    if (/\b(decided|decision|chose|instead of)\b/i.test(text)) {
      return { predicate: 'project.decision', rule: 'english-decision' }
    }
    return { predicate: 'project.constraint', rule: 'english-deontic' }
  }
  if (signals.universal || signals.modal || signals.retraction) {
    return { predicate: 'project.constraint', rule: 'invariant-cue' }
  }
  // A domain noun alone ("数据库使用 SQLite") says what the statement is about,
  // not which taxonomy bucket it belongs to. Keep the model's label rather than
  // turning every unlabelled domain sentence into a constraint.
  return null
}

export function quoteWithinSpans(spans, start, end) {
  if (!Array.isArray(spans)) return false
  return spans.some((span) =>
    Number.isInteger(span.start) && Number.isInteger(span.end) &&
    start >= span.start && end <= span.end)
}
