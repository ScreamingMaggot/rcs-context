// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// contextinjector.mjs — CONTEXTinjector v1 注入侧插件
//
// F+ 事件序列注入架构（主设计 设计_事件序列注入方案.md §一/§8.1 v1.1 裁决）。
// 与 LOGcompiler（编译侧，StateCompiler/LOGcompiler/logcompiler.mjs）配对：
//   LOGcompiler       —— 订阅 session/event，把原始事件纯规则转录为五类行落盘（编译/观测用）
//   CONTEXTinjector   —— 本插件。在 round 边界把"已闭合前缀"经官方 replace 通道折叠成
//                         一条单调在场的转录消息，使真实请求 = [system]+[转录]+[本轮U]
//
// 折叠算法与通道用法直接复用实证通过的 replace-probe（实证实验-Fplus/scripts/replace-probe.mjs，
// P1 fold 通过校验 / P2 折叠消息字节在场 / P3 881→443B 裁剪 / S 折叠后任务语义延续）。
// 设计依据：CONTEXTinjector/版本说明文档/v1-提案.md（触发调度 / 防自转录 / 断代衔接）。
//
// 折叠纪律（主设计 §8.1）：
//   1 只折已闭合前缀；2 新折叠消息 = 旧折叠消息 + 纯拼接增量（单调在场）；
//   3 触发点仅 round 边界；4 自身节点 source.kind='plugin:CONTEXTinjector'（防自转录；v1.10.27 起 v4 形态，读侧双形态兼容）；5 禁工具正文。
// v1.5 condense 档（off/single/double，默认 off；红线勘误见主设计 §8.2）：
//   折叠增量内新 [A] 前向浓缩（single：语义浓缩；double：双提取=语义+载荷直抄），
//   [U]/[T]/[ROUND] 与旧 transcript 不动绝不回写；失败自动回退无损；
//   raw 全量存证 <STATE_DIR>/.ctxinjector/raw/。无损转录（§8.1）仍为默认档与底线。
// v1.8 浓缩模型通道（可移植性改造）：浓缩不再依赖本地 Ollama，改为调用 **DSH 已注册的模型**
//   （ctx.llm 流式服务）：默认跟随会话当前 provider/model（session.requestHeader().config），
//   可用 env 或 control.json 显式指定；DSH 无 llm 服务时回退无损折叠，绝不中断。
//   本机实验若要走本地 4B，显式设 DSH_CONTEXTINJECTOR_LOSSY_OLLAMA=<url> 启用直连通道。
//
// 启用门控（缺省全关，防误伤；v1.2 起支持持久化白名单，见 v1-提案 §控制模型）：
//   优先级：TEST_ROUND(回归) > DSH_CONTEXTINJECTOR_ENABLED=1(env 直通) >
//           control.json(enabled && 当前 session ∈ whitelist) > off(默认)
//   DSH_CONTEXTINJECTOR_STATE_DIR=<dir>  状态目录（默认 $DSH_HOME/state-compiler，DSH_HOME 缺省 ~/.dsh；不依赖任何本机前缀）
//   DSH_CONTEXTINJECTOR_OUT=<path>  观测 jsonl（未设则不落盘）
//   DSH_CONTEXTINJECTOR_THRESHOLD=<pct>  断代窗口阈值（默认 70；v1 仅记录不执行）
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
// A档：结构化工具折叠（纯规则 [T]+[V]，见 toolfold/）。默认 OFF，仅在 control.toolfoldStructured 开启时启用。
import { foldOne as foldToolResult } from '../toolfold/toolfold.mjs'
// §13 消息来源分型（condense/ 共享纯模块，仿 ../toolfold 顶层兄弟目录惯例）：
//   注入器侧转录 ROUND 仅计真人轮（source.kind==='user'），subagent 回传等不再漏进 [U]。
//   与 LOGcompiler §13 修复对仗。设计见 docs/v2-优化设计.md §13。
import { classifyMessageSource, subagentIdOf, snapshotSummary, classifyCondenseError, chunkForCompressor, INJECTED_USER_PREFIXES, pluginIdOf } from '../condense/chunk.mjs'
import { ivrLoad, ivrRecord } from '../condense/ivr.mjs' // #5 IVR 注入经济计量簿记（仅 node:fs）

const ENABLED = process.env.DSH_CONTEXTINJECTOR_ENABLED === '1'
const OUT_FILE = process.env.DSH_CONTEXTINJECTOR_OUT || ''
const THRESHOLD = Number(process.env.DSH_CONTEXTINJECTOR_THRESHOLD ?? 70)
// 回归通道（缺省关，不破坏纪律 3）：headless CLI 每次只跑单轮，无第二个 user turn，
// round 边界折叠永不触发。DSH_CONTEXTINJECTOR_TEST_ROUND=1 允许"闭合前缀即折"
// （等价 replace-probe 的 FOLD_PROBE 已实证路径）；TRACE=1 记录每步请求中折叠消息字节/hash，
// 用于验证折叠消息进入 deriveMessages 后逐字节稳定在场。
const TEST_ROUND = process.env.DSH_CONTEXTINJECTOR_TEST_ROUND === '1'
const TRACE = process.env.DSH_CONTEXTINJECTOR_TRACE === '1'

// v1.10.1 = v1.10 + keepInject 头部补录（foldHeadTranscript：注入节点之前的首条 user 不再从转录里消失）。
// 注意：**不占用 v1.11–v1.14 号**——那些号已被 RCS 后继分支（v1.14.1，另一条 lineage）使用，避免版本号撞车。
const PLUGIN_VERSION = 'v1.10.27 (DSH session-format v4 兼容：④source.kind=plugin 属退役形态⇒写侧全部改 producer-owned kind=plugin:X（与官方 v3→v4 迁移同形态；v3 宿主对 kind 无枚举校验，单形态双宿主通吃）；读侧（防自转录/注入避让/分类器）统一走 pluginIdOf 双形态识别；⑤session.events 公开数组 rc.3+ 已移除，枚举改 ownEvents/snapshotEvents 兜底，杜绝空表静默降级。内嵌 v1.10.26 (DSH 0.1.5 兼容：①session.events[seq] → session.eventAt(seq)，0.1.5 已移除 events 公开数组，旧写法在 resume-seed/折叠时抛 "Cannot read properties of undefined (reading \'<seq>\')"；②surfaceOp replace 字段 start/end → startSeq/endSeq，0.1.5 按三键定长校验，旧字段名致 "carries an invalid replace surfaceOp"；③遮蔽集排除 role===\'system\' 节点，0.1.5 新增"seq 0 的 system prompt 只能被 system/message 且仅覆盖该节点"保护，旧行为使折叠范围从 0 起 ⇒ "node 0 holds the system prompt" 被拒。三处均保留旧版回退路径，同一文件可跑 0.1.1-rc.2 与 0.1.5-rc.2。含 v1.10.25 及此前全部修复)'
// 持久化门控与状态（供 WebUI 面板读写/展示；只写纯标量 JSON，无内部活体对象）
// v1.8 可移植：不再硬编码本机绝对路径。DSH_HOME 由启动器注入（start-dsh-web.cmd）；
// 缺省回落到 ~/.dsh，使插件在任何人的机器上开箱可用（显式 env 仍最高优先）。
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = process.env.DSH_CONTEXTINJECTOR_STATE_DIR || join(DSH_HOME, 'state-compiler')
const CONTROL_FILE = join(STATE_DIR, 'control.json')       // { enabled, sessions[], condense, updatedAt } —— UI 开关 + session 白名单 + 压缩档
const RUNTIME_FILE = join(STATE_DIR, 'runtime.json')       // 运行参数/最近折叠摘要（UI 展示用）
const LAST_FOLD_FILE = join(STATE_DIR, 'last-fold.json')   // 最近一次折叠详情（含注入内容预览）

// —— condense 档（v1.5，取代 v1.4 布尔 lossy）：off | single | double ——
//   off    = 无损转录折叠（默认档与底线，§8.1）
//   single = 增量内新 [A] 走 4B 前向语义浓缩（留结论/浓缩推理）——v1.4 lossy 原行为
//   double = 双提取：语义浓缩 + 载荷直抄（p1c 架构；孤立载荷值额外清单并入 [A] 行，保真最高、调用更多）
// [U]/[T]/[ROUND] 与旧 transcript（foldText）绝不触碰/绝不回写（只拼新浓缩行，monotonic 前缀保持）。
// 浓缩失败（ollama 离线/超时/返回空/未缩短）自动回退无损：该 [A] 行保留原文，折叠不中断。
// 底气：raw 权威存证——被遮蔽节点原文全量追加 <STATE_DIR>/.ctxinjector/raw/<sid>.jsonl，随时可回放/审计。
// v1.7 增补：per-session 档位 control.json.sessionModes = { <sid>: 'off'|'single'|'double' }，
//   由 composer「本会话压缩模式」（首轮发送前即可选）写入，只作用于该会话。
// v1.9 修订（2026-09-06，档位权威收口）：顶部面板「AI 输出压缩档」已删除——每会话已有独立档位，
//   全局默认（control.json.condense / 旧 lossy 布尔）**不再参与裁决**（字段留作惰性残余，不读写）。
//   档位来源优先级：env DSH_CONTEXTINJECTOR_LOSSY（0/off/single/double，1=兼容 single）>
//                   control.json.sessionModes[<sid>]（本会话档，v1.7，唯一 UI 档位来源）>
//                   （gate=test/env 无 UI 部署：默认无损 off 兜底，保 headless/回归通道）
//   gate=control 时若会话无本会话档 ⇒ **不折叠**（白名单仅门控残余，档位以 sessionModes 为准）。
const ENV_MODE = String(process.env.DSH_CONTEXTINJECTOR_LOSSY ?? '').toLowerCase().trim()
const LOSSY_MODEL = process.env.DSH_CONTEXTINJECTOR_LOSSY_MODEL || 'qwen3:4b-instruct-2507-q4_K_M'
// v1.8：Ollama 直连降级为**可选**通道 —— 仅当显式设置该 env 才启用（保留本机本地 4B 实验路径）。
// 未设置时浓缩一律走 DSH 已注册模型（见 llmText/resolveCondenseRoute），无本地模型的机器也可用。
const LOSSY_OLLAMA = process.env.DSH_CONTEXTINJECTOR_LOSSY_OLLAMA || ''
const LOSSY_MIN_BYTES = Number(process.env.DSH_CONTEXTINJECTOR_LOSSY_MIN ?? 240)   // [A] 正文 < 此长度不浓缩（不值得）
// 【取自 RCS-0.1.0 返回包】minBytes 热读：`control.condenseMinBytes`（int）可覆盖内置 240，
//   免重启生效（面板改 control.json 即生效，与 #7 condenseMaxTokens 同机制）。
//   缺省仍是 240 ⇒ 不配置时行为与旧版完全一致。注意：调低 = 更多 [A] 会各触发一次浓缩模型调用。
function minBytesOf(io) {
  const n = io && io.minBytes
  return Number.isFinite(n) && n >= 0 ? n : LOSSY_MIN_BYTES
}
// 【v1.10.19 · P1 修复（用户 2026-09-12 实证报告）】默认上限 700 → 2048：
//   实测单次浓缩在 700 下大量 `finish=max-tokens`（double 8/12 运行、single 5/12 运行），
//   截断 ⇒ 视为失败 ⇒ 整条 [A] 无损回退（命中率仅 5–7%）。700 对"要写一段压缩后正文"的任务
//   本就偏紧（尤其是更长的 [A] 或中文），而调大到 8096 后截断归零（命中率 18–20%）。
//   但"一律 8096"会让小输入也按大额度生成、白等延迟（实测单次折叠 2.5s→7.7s），
//   故改为：**上限 2048 + 每次调用按输入长度自适应**（见 effectiveMaxTokens）。
const LOSSY_MAX_TOKENS = Number(process.env.DSH_CONTEXTINJECTOR_LOSSY_MAXTOK ?? 2048)
const LOSSY_TIMEOUT_MS = Number(process.env.DSH_CONTEXTINJECTOR_LOSSY_TIMEOUT ?? 90000)
// 【v1.10.20 · 经济性 P0】浓缩/载荷调用的推理档位，缺省 `off`（禁用思维链）。
//   为什么这是本版最大的一笔经济性修复：`reasoningEffort` 是 dsh-llm 的一等请求项，
//   deepseek 适配器把 'off' 解析为 `{thinking:{type:'disabled'}}`（dsh-llm-deepseek:34）；
//   而**推理 token 与正文 token 共同占用 maxTokens、且一并按输出计费**。
//   本插件此前只传 `purpose:'compaction'`，而未像 harness 的辅助调用（`purpose:'session-title'`，
//   见 dsh-llm-deepseek:31）那样关掉思维链 ⇒ 模型把整个输出额度烧在推理上。
//   实测（1801 字 [A] @maxTokens=768）：reasoningTokens=768 / 输出正文 0 字 / finish=max-tokens
//   ⇒ 整条 [A] 判失败、无损回退：**既付了钱，又没换来任何压缩**。
//   而"压缩"本质是纯删除+逐字摘抄任务，推理无收益。关闭后实测：成功率 3/9 → 9/9、
//   压缩率约 2 倍、单次调用耗时降为 1/3~1/4（见 tools/.probe 证据）。
//   允许值：''（不传，恢复旧行为）| 'off' | 'low' | 'high' | 'max'；非法值一律回落 'off'。
const LOSSY_EFFORTS = new Set(['', 'off', 'low', 'high', 'max'])
const LOSSY_EFFORT = (() => {
  const s = String(process.env.DSH_CONTEXTINJECTOR_LOSSY_EFFORT ?? 'off').trim().toLowerCase()
  return LOSSY_EFFORTS.has(s) ? s : 'off'
})()
function effortOf(io) {
  const s = String((io && io.reasoningEffort) ?? LOSSY_EFFORT).trim().toLowerCase()
  return LOSSY_EFFORTS.has(s) ? s : 'off'
}
// 【v1.10.20 · 经济性 P2】截断抢救（salvage）：`finish=max-tokens` 且正文已明显缩短时，
//   **保留已生成的部分**而不是把这条 [A] 整条判失败。
//   理由：一条被截断的输出，我们已经为输入 token + 已生成的输出 token 全额付过费；
//   整条丢弃 ⇒ 钱花了、上下文一点没省（这正是 P1 观测到的 `aFallback 8/8` 的浪费形态）。
//   改为接受"尾部少了几个要点"的部分结果，换来"这条 [A] 真的变短了"——两者相较，后者才是在跑压缩。
//   两道闸（缺一不可，宁可回退也不污染上下文）：
//     ① 缩短必须达标：`outLen <= inLen * SALVAGE_MAX_RATIO`（只短一点点不值得冒截断风险）；
//     ② 不得残留**半截占位符**（见 DANGLING_PLACEHOLDER_RE）。
const SALVAGE_MAX_RATIO = 0.85
// guardText 把 uuid/hex/路径换成了 `⟦ID0⟧` 这样的占位符，`restoreText` 之后会规则回填成真值。
//   · 完整占位符 `⟦ID0⟧` 在浓缩结果里是**合法**的（回填后即真值）；
//   · 但截断恰好切在占位符中间会留下 `⟦ID` / `⟦ID0` 这种**半截**，`restoreText` 匹配不上 ⇒
//     原样漏进 transcript，既污染上下文、又可能被后续轮次当成真实值。这种必须拒收。
const DANGLING_PLACEHOLDER_RE = /⟦(?![A-Z]+\d+⟧)/
const RAW_DIR = join(STATE_DIR, '.ctxinjector', 'raw')
mkdirSync(RAW_DIR, { recursive: true })
// #4 per-session 最近折叠：除全局 last-fold.json，另按会话存一份，供注入面板"按当前会话"展示
const LAST_FOLD_PER = join(STATE_DIR, '.ctxinjector', 'last-fold')
mkdirSync(LAST_FOLD_PER, { recursive: true })
// 【在飞折叠标记】面板「上一轮输出压缩中…」的数据源（用户报：后台折叠期间面板一片空白，以为没折）。
//   目录/命名与上面 per-session 副本**同款口径**（bare sid → 非法字符换 _ → 截断 120），
//   内容 { sessionId, trigger, startedAt, step, round? }。
//   【v1.10.2 修复 2026-09-10（用户实测报障）】旧实现只在 scheduleFold（= agent/turn-stopping 的排队路径）
//   写标记、在它那个 Promise 落定时删；而 pre-step 路径是**直接调用 foldAttempt**、完全绕过 scheduleFold
//   ⇒ 只有 turn-stopping 折才有标记。用户会话实际走 pre-step（last-fold.json: trigger=pre-step）⇒
//   /status.foldInflight 恒为 null ⇒ 会话页「压缩中」小标真机上永不出现。槽位/位置/CSS 都是对的
//   （localStorage.ciFoldChipForce='1' 强制可见即证），坏的是数据侧——本文件。
//   现在生命周期搬进**折叠主体**：foldAttempt 入口写、finally 删 ⇒ pre-step / turn-stopping / 将来任何
//   新触发点一律自动覆盖，不存在"某条触发路径忘了写"的余地（单点收口，不再依赖调用方自觉）。
//   UX（本修复的重点，不是副作用）：pre-step 折叠的"压缩中"窗口 = **下一轮已开始、模型还没开始流式
//   输出的那几秒**——这正是用户盯着屏幕等回复的时刻，是最该显示小标的位置；而旧实现只在 turn-stopping
//   显示，那一刻用户正在读上一条回复、并不在等，等于把指示器放在没人看的窗口里。
//   per-sid 语义：一会话一枚标记；同 sid 重入/并发（如 join 超时后 pre-step 又自折一次）用计数只清最后一次。
//   陈旧标记（进程崩溃残留）不由本侧清理——host /status 有 10 分钟陈旧闸兜底（见 webui/lib/index.mjs）。
//   ⚠ 读写全部 try/catch：标记只是观测面，**绝不允许**影响折叠本身。
const FOLD_INFLIGHT_DIR = join(STATE_DIR, '.ctxinjector', 'fold-inflight')
mkdirSync(FOLD_INFLIGHT_DIR, { recursive: true })
// 【v1.10.5 ★必须-1（协作：TESTBRANCH 规格方 LogCompiler K）】折叠索引：seq 区间 ↔ 转录**累计行号**。
//   为什么不用 last-fold.json：它会被后续折叠覆盖，不能做溯源锚点。本文件**只追加**（NDJSON）。
//   为什么用累计行号而不是段内行号：转录是单调前缀（foldText 只追加），段内行号在 1MB 轮转下
//   会歧义（每文件从 1 起还是跨文件连续？），累计行号自带不变量
//   cumLines.before(后一条) ≥ cumLines.after(前一条)，且 bytes.transcript 单调不减可做第二重校验。
const FOLD_INDEX_DIR = join(STATE_DIR, '.ctxinjector', 'fold-index')
// rotate.index = 该会话转录当前已轮转出的段数（logcompiler 每超 ROTATE_BYTES 切一份 <sid>.log.N）
function foldRotateIndex(sid) {
  try {
    const bare = String(sid ?? '').replace(/^session-?/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
    const dir = process.env.LOGCOMPILER_OUT ? dirname(process.env.LOGCOMPILER_OUT) : join(STATE_DIR, 'transcripts')
    let n = 0
    while (existsSync(join(dir, bare + '.log.' + (n + 1)))) n += 1
    return n
  } catch { return 0 }
}
// 只在折叠**提交成功后**调用（失败/延后如 pair-split 不写）；写失败绝不影响折叠。
function writeFoldIndex(rec) {
  try {
    mkdirSync(FOLD_INDEX_DIR, { recursive: true })
    const bare = String(rec.sid ?? '').replace(/^session-?/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
    const line = JSON.stringify({
      t: Date.now(), sessionId: rec.sid, foldSeq: rec.foldSeq, shadowedSeqs: rec.shadowedSeqs ?? [],
      cumLines: { before: rec.cumBefore, after: rec.cumAfter },
      bytes: { shadowed: rec.shadowedBytes, transcript: rec.transcriptBytes },
      // v1.10.25 经济性口径（附加字段，旧消费方零改动）：live = 提交后真实请求体量；
      //   raw = 本折新原料字节；appended = 本折新增转录字节（foldRatio = appended/raw）
      ...(Number.isFinite(rec.liveBytes) ? { live: rec.liveBytes } : {}),
      ...(Number.isFinite(rec.incrementalRawBytes) ? { raw: rec.incrementalRawBytes } : {}),
      ...(Number.isFinite(rec.appendedBytes) ? { appended: rec.appendedBytes } : {}),
      monotonic: true, rotate: { file: 'transcripts', index: foldRotateIndex(rec.sid) }, trigger: rec.trigger,
      // v1.10.13 多段转录：本次折叠同时遮蔽的 head 段 seq（附加字段，cumLines 语义不变 ⇒ 消费方无需改）
      ...(Array.isArray(rec.headSeqs) && rec.headSeqs.length > 0 ? { headSeqs: rec.headSeqs } : {}),
    })
    appendFileSync(join(FOLD_INDEX_DIR, bare + '.jsonl'), line + '\n', 'utf8')
  } catch (err) { console.error('[contextinjector] fold-index failed:', err?.message ?? err) }
}
function foldInflightFile(sid) {
  return join(FOLD_INFLIGHT_DIR, sanitizeSid(String(sid ?? '').replace(/^session-?/i, '')) + '.json')
}
function writeFoldInflight(args) {
  try {
    const fp = foldInflightFile(args?.sid)
    try { rmSync(fp, { force: true }) } catch { /* 旧残留删不掉也不阻断写入（force 已忽略不存在） */ }
    const meta = {
      sessionId: args?.sid ?? null,
      trigger: args?.trigger ?? null,
      startedAt: Date.now(),
      step: Number.isFinite(args?.stepNo) ? args.stepNo : 0,
    }
    if (Number.isFinite(args?.round)) meta.round = args.round // 调用方已知轮号时带上（JSON.stringify 会省略 undefined）
    writeFileSync(fp, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  } catch (err) { console.error('[contextinjector] fold-inflight write failed:', err?.message ?? err) }
}
function clearFoldInflight(sid) {
  try { rmSync(foldInflightFile(sid), { force: true }) } catch (err) {
    console.error('[contextinjector] fold-inflight clear failed:', err?.message ?? err)
  }
}
// 在飞折叠深度（per-sid）：**只清最后一次**。可能真并发的唯一场景是 join 超时——
//   pre-step join 一个有超时闸的后台折叠，超时后 pre-step 自己又折一次（同一 sid 两次在飞）。
//   若各自 finally 都无条件删标记，先落定的那个会把仍在飞的那个的标记删掉（小标提前熄灭、界面撒谎）。
//   故：入口 +1，出口 -1，减到 0 才删文件；重入时 writeFoldInflight 覆盖写（startedAt 刷新为本次的真实起点）。
const foldInflightDepth = new Map() // sid -> 在飞折叠次数
// 入口（foldAttempt 的第一件事）。**绝不抛**：标记坏了也不能让折叠消失。
function enterFoldInflight(args) {
  try {
    const sid = args?.sid
    foldInflightDepth.set(sid, (foldInflightDepth.get(sid) ?? 0) + 1)
    writeFoldInflight(args) // 覆盖写：startedAt 取本次折叠的真实起点，不留上一次的旧时间戳
  } catch (err) { console.error('[contextinjector] fold-inflight enter failed:', err?.message ?? err) }
}
// 出口（foldAttempt 的 finally）。成功 / 失败 / 提前 return / 异常一律走到这里。**绝不抛**。
function exitFoldInflight(sid) {
  try {
    const n = (foldInflightDepth.get(sid) ?? 0) - 1
    if (n > 0) { foldInflightDepth.set(sid, n); return } // 同 sid 还有折叠在飞 ⇒ 标记必须留着
    foldInflightDepth.delete(sid) // 计数缺失（n<0）也会走到这里 ⇒ 失败方向是"删掉"，绝不留"永久压缩中"
    clearFoldInflight(sid)
  } catch (err) { console.error('[contextinjector] fold-inflight exit failed:', err?.message ?? err) }
}

// v1.7：本会话档（sessionModes）查询——命中则优先于全局默认档；键与运行时 id 都做前缀归一比较
function perSessionMode(ctrl, sid) {
  const sm = ctrl?.sessionModes
  if (!sid || !sm || typeof sm !== 'object') return null
  const n = normSessionId(sid)
  for (const k of Object.keys(sm)) {
    if (normSessionId(k) === n) {
      const v = sm[k]
      if (v === 'double' || v === 'single' || v === 'off') return v
    }
  }
  return null
}
function condenseMode(gate, ctrl, sid) {
  if (gate === 'off') return 'off'
  if (ENV_MODE === 'double') return 'double'
  if (ENV_MODE === 'single' || ENV_MODE === '1') return 'single'
  if (ENV_MODE && ENV_MODE !== 'off' && ENV_MODE !== '0') return 'single' // 其它非空值按 single 保守处理
  const per = perSessionMode(ctrl, sid)
  if (per) return per
  // v1.9：全局默认档（control.condense / lossy 布尔）已废止、不再参与裁决。
  // test/env 直通（headless/回归/operator 部署）无本会话档 → 无损 off 兜底；
  // control 门控下无本会话档 → null（调用方判"不折叠"，无隐式默认）。
  if (gate === 'test' || gate === 'env') return 'off'
  return null
}
// —— v1.6 keepInject 档（注入节点避让折叠，见版本说明文档 v1.6）——
//   false = v1.5 旧路径：遮蔽整段（含 DSH 注入节点）→ 每轮 policy 重注入（~492B/轮）
//   true  = v1.6 路径：遮蔽候选截断在最后一个 DSH 注入节点之后 → 快照始终在场 → 零补发
// 【默认值翻转（取自 RCS-0.1.0）2026-09-10】默认改为 **true**：RCS 实测"关闭时折叠把 DSH 的
//   runtime 快照 / skill 目录节点折掉 → DSH 每轮补发一份（8 次折叠 → 8 次补发，9 轮出现 9 份快照
//   + 9 份目录）"；本机 2026-09-10 在测试分支复现同一现象（control.json 无 keepInject 字段的实例
//   最新转录里 [S] 快照行出现 4 次）。故与 RCS 对齐：默认避让，改由显式值关闭。
// 档位来源优先级：env=1 强制 ON / env=0 强制 OFF > control.json.keepInject===false 关闭 > **默认 ON**
const KEEP_INJECT_ENV = process.env.DSH_CONTEXTINJECTOR_KEEPINJECT
function keepInjectOn(gate, ctrl) {
  if (gate === 'off') return false
  if (KEEP_INJECT_ENV === '1') return true
  if (KEEP_INJECT_ENV === '0') return false
  if (ctrl?.keepInject === false) return false
  return true // 0.2.3/RCS 起默认 ON（旧行为可用 DSH_CONTEXTINJECTOR_KEEPINJECT=0 或 control.keepInject=false 恢复）
}

// —— #6 折叠时机（取自 RCS-0.1.0 返回包）——
// 用户诉求："一旦压缩完成就先进入 LOG 并且渲染在 WEB，这样用户能及时得到指令"。
// 旧实现只在**下一轮** agent/pre-step 折叠 ⇒ 本轮回复读完到下一轮发请求之间才压缩，
// 面板上的「最近一次折叠」与 last-fold.json 永远慢一拍。现增加 turn 结束即折（后台），
// pre-step 只做 join，保证下一轮请求看到的仍是已折叠 surface（语义与旧实现等价）。
const FOLD_AT_TURN_END_ENV = process.env.DSH_CONTEXTINJECTOR_FOLD_AT_TURN_END
// 默认**开**（用户明确要求）；显式 control.foldAtTurnEnd=false 或 env=0 关闭 → 恢复"只 pre-step 折"的旧行为
function foldAtTurnEndOn(ctrl, env = FOLD_AT_TURN_END_ENV) {
  const e = String(env ?? '').trim()
  if (e === '0') return false
  if (e === '1') return true
  return ctrl?.foldAtTurnEnd !== false
}
// join 超时（**安全闸**）：turn 结束的后台折叠可能要调浓缩模型（本地 4B 约 7–18s）。
//   若下一轮 pre-step 无限期等它，用户的下一轮就会被一个慢模型卡住（这是本项目一直不敢开 turn-end 折的原因）。
//   故 join 必须有上限：超时即放弃等待、照旧走"本轮要用的 surface"（折叠结果晚一点落，等价于今天的旧行为），
//   并只记一条 fold-join-timeout（不刷屏）。缺省 3000ms；非法值/负数一律回落缺省。
const FOLD_JOIN_TIMEOUT_MS = Number(process.env.DSH_CONTEXTINJECTOR_FOLD_JOIN_MS ?? 3000)
function foldJoinTimeoutMs(ctrl, fallback = FOLD_JOIN_TIMEOUT_MS) {
  const fb = Number.isFinite(fallback) && fallback > 0 ? fallback : 3000
  const n = ctrl?.foldJoinTimeoutMs
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.floor(n)
  return fb
}
// 折叠门控（env 为最高优先，与 keepInject 同款语义）：
//   env=1 强制（无视白名单，供真机实验）> env=0 强制关 > gate !== 'off'（白名单/回归通道）
function foldGateOpen(ctrl, gate, env = FOLD_AT_TURN_END_ENV) {
  const e = String(env ?? '').trim()
  if (e === '1') return true
  if (e === '0') return false
  return gate !== 'off'
}

mkdirSync(STATE_DIR, { recursive: true })
if (OUT_FILE) mkdirSync(dirname(OUT_FILE), { recursive: true })

function readControl() {
  try { return JSON.parse(readFileSync(CONTROL_FILE, 'utf8')) } catch { return null }
}
function sessionIdOf(session) {
  return session?.id ?? session?.sessionId ?? session?.goalId ?? session?.name ?? null
}
// 目录名可能是 session-<uuid>，运行时 session.id 可能是同值或去前缀的 uuid —— 归一比较
const normSessionId = (s) => String(s ?? '').replace(/^session-?/i, '')
// 【RCS 接入 2026-09-09，取自 RCS-0.1.0 返回包】子代理会话**不参与折叠**：
//   子代理的价值恰恰是它读过的原始内容，折成 `[T] read | 文件 | OK` 之后它会"忘掉读过什么"
//   并重新读；而且每次折叠还要多调一次浓缩模型。这直接旁路，语义上不折。
//   判据：DSH 写进会话 header 的 `origin === 'subagent'`（dsh-subagent childSessionMeta；
//   持久化读法见 list-children）。取不到时返回 false ⇒ 退化为"不旁路"，不会误伤主会话。
function isSubagentSession(session) {
  try {
    return session?.header?.origin === 'subagent' || session?.meta?.origin === 'subagent'
  } catch { return false }
}
function gateFor(sid, control, session) {
  if (isSubagentSession(session)) return { gate: 'off', subagent: true } // 最高优先级：先于 TEST_ROUND/ENABLED
  if (TEST_ROUND) return { gate: 'test' }
  if (ENABLED) return { gate: 'env' }
  const n = normSessionId(sid)
  if (control && control.enabled === true && sid &&
      Array.isArray(control.sessions) && control.sessions.some((s) => normSessionId(s) === n)) return { gate: 'control' }
  return { gate: 'off' }
}
function persistLastFold(meta) {
  try {
    writeFileSync(LAST_FOLD_FILE, JSON.stringify(meta, null, 2) + '\n', 'utf8')
    // #4 per-session 副本：注入面板按当前会话读自己的最近折叠，而非串到别的会话
    if (meta && meta.sessionId) {
      const bare = String(meta.sessionId).replace(/^session-?/i, '')
      writeFileSync(join(LAST_FOLD_PER, sanitizeSid(bare) + '.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
    }
  } catch (err) { console.error('[contextinjector] lastFold persist failed:', err?.message ?? err) }
}

const hash256 = (s) => createHash('sha256').update(String(s)).digest('hex')

// #5 压缩器IO比（2026-09-10 口径重写，取自 RCS-0.1.0）：**不再需要 S**（固定注入前缀净字节）。
//   ivrRecord 只用 shadowedBytes / transcriptBytes 两个数算 inBytes/outBytes/ratio；
//   旧的 _sysBytesCache + ivrSystemBytes()（每会话取 requestHeader().system 并缓存）已删除——
//   它唯一的用途就是把 S 喂给旧 IVR 公式（S 只会把读数推向 1，在 RCS 架构下测量的是"空气"）。
//   `ivrEnsure(stateDir, sid, S)` 的 S 形参保留以兼容旧调用方，函数体内显式忽略。

function blocksOf(m) { return Array.isArray(m?.content) ? m.content : [] }
// §1.2 content-only：reasoning/thinking 块恒剥离（注入器不转录思维链）。
// 实测 deepseek-v4-flash 无独立 reasoning 块（内容以 text 到）；qwen/ollama 类以 thinking 块到则在此剥掉，
// 使 [A] 只收真实正文 —— 降注入前缀 / 压缩器输入，避免旧思维链回流诱导。
function isReasoningBlock(b) { return b?.type === 'reasoning' || b?.type === 'thinking' }
function inline(s) { return String(s ?? '').replace(/[\r\n]+/g, ' ').trim() }

function log(tag, row = {}) {
  if (!OUT_FILE) return
  try {
    appendFileSync(OUT_FILE, JSON.stringify({ t: Date.now(), enabled: ENABLED ? 1 : 0, tag, ...row }) + '\n', 'utf8')
  } catch (err) {
    console.error('[contextinjector] log failed:', err?.message ?? err)
  }
}

// 【v1.10.25 · 计量修复（★经济性口径的根因）】块文本提取。
//   为什么必须有它：`tool-result` 的正文在 `content` 字段里，而它的**实际形状是块数组**
//   （真机日志实证：`{"type":"tool-result","toolCallId":"call_…","content":[{"type":"text","text":"…"}]}`）。
//   旧实现写的是 `tr:${b.name}:${b.content}` —— 对数组做模板字符串 ⇒ 一律得到 `[object Object]`，
//   于是**工具结果正文（真机上占会话字节的大头，实测 159KB/185KB）在计量里只算 ~30B**。
//   后果（2026-09-14 付费跑批 A01-off-1 实证）：主指标 `shrink = transcriptBytes/shadowedBytes`
//   长期停在 0.998 附近 ⇒ 从文件层看"折叠几乎什么都没省"，而被折掉的恰恰是工具正文。
//   这不是显示问题：`shadowedBytes` 是**经济性指标**，计量盲区会让"折叠有没有收益"无法从文件层
//   判断——协作方据此得出了与事实相反的结论（详见 docs/DESIGN-prompt-cost-accounting.md）。
function blockTextOf(c) {
  if (c === null || c === undefined) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(blockTextOf).join('')
  if (typeof c === 'object') {
    if (typeof c.text === 'string') return c.text
    if (c.content !== undefined) return blockTextOf(c.content)
    try { return JSON.stringify(c) } catch { return '' }
  }
  return String(c)
}
function messageBytes(m) {
  const parts = blocksOf(m).map((b) => {
    switch (b.type) {
      case 'text': return `text:${b.text ?? ''}`
      case 'tool-call': return `tc:${b.name ?? ''}:${b.arguments ?? ''}`
      // tool-result：正文按块结构取全文（v1.10.25 修复）；name 缺失时退回 toolCallId，便于辨识
      case 'tool-result': return `tr:${b.name ?? b.toolCallId ?? ''}:${blockTextOf(b.content)}`
      default: return `${b.type}:${JSON.stringify(b).slice(0, 120)}`
    }
  })
  return `${m?.role ?? '?'}\u0001${parts.join('\u0001')}`
}
function summarize(m) {
  const bytes = messageBytes(m)
  return { role: m?.role ?? '?', src: m?.source?.kind, bytes: bytes.length, hash: hash256(bytes).slice(0, 16) }
}
function snapshotOf(session) {
  try { return session.deriveMessages().map((m) => summarize(m)) } catch { return null }
}
// 折叠消息视图：只挑 CONTEXTinjector 自己的折叠消息（runtime-context 等注入面也带
// plugin 族 source，但标识不同；v1.10.27 起双形态——旧 kind:'plugin'+plugin 字段 / 新 kind:'plugin:X'），
// 验证其进入真实请求后逐字节在场
function transcriptNodesOf(msgs) {
  return (msgs ?? [])
    .filter((m) => pluginIdOf(m?.source) === 'CONTEXTinjector')
    .map((m) => { const b = messageBytes(m); return { bytes: b.length, hash: hash256(b).slice(0, 16) } })
}

function pathOf(argsJson) {
  try {
    const a = JSON.parse(argsJson ?? '{}')
    for (const k of ['file_path', 'path', 'directory']) if (typeof a[k] === 'string' && a[k].trim()) return a[k].trim()
  } catch { /* not json */ }
  return '-'
}

// 可折叠前缀端点（#4 修复 2026-09-10，取自 RCS-0.1.0 返回包：配对安全钳制）：
//   原实现两缺口：a) 每消息只取首个 tool-result（.find）→ 并行工具/多结果消息漏配、pending 残留；
//                b) 仅以"最后一条已配对结果"为端点，未校验"call 在区间内、其 result 在区间外"的切分
//                   → 遮蔽区间切出孤儿 tool-result → INVALID_REQUEST（与 §13 分类改动同源风险区）。
//   现：① 收集全部 call/result（多结果消息不漏）；② 候选端点后做配对钳制——任何"call 在内 result
//       在外/缺失"或"result 在内 call 在外/缺失"的配对都把端点回退到该配对之前，迭代至稳定，
//       保证区间内每个 tool-call↔tool-result 配对完整（永不切 pair）。
// 【v1.10.17】中止一轮留下的**悬空 tool-call**：call 在 surface 上、结果永远不会来（用户按了停止）。
//   判据：该 call 所属的那一轮**已经结束**（其节点 seq 之后存在 `turn/end` 事件）⇒ 结果确定不会再来。
//   这类 call 允许被跨越；**轮未结束**（工具在飞、结果可能马上到）时绝不跨越 —— 否则结果晚到会成
//   孤儿 tool-result（v1.6 的 INVALID_REQUEST 血债）。拿不准一律返回空集（保守）。
export function collectDeadCalls(entries, session) {
  try {
    const calls = new Map()   // id -> 在 entries 中的下标
    const results = new Set()
    for (let i = 0; i < (entries?.length ?? 0); i++) {
      for (const b of blocksOf(entries[i]?.msg)) {
        if (b.type === 'tool-call') { const id = b.id ?? b.toolCallId; if (id && !calls.has(id)) calls.set(id, i) }
        else if (b.type === 'tool-result') { const id = b.toolCallId ?? b.callId ?? b.id; if (id) results.add(id) }
      }
    }
    const dead = new Set()
    if (calls.size === 0) return dead
    const evs = allEvents(session)
    for (const [id, i] of calls) {
      if (results.has(id)) continue
      const seq = entries[i]?.seq
      if (!Number.isFinite(seq)) continue
      for (let s = seq + 1; s < evs.length; s++) {
        if (evs[s]?.type === 'turn/end') { dead.add(id); break }
      }
    }
    return dead
  } catch { return new Set() }
}
// opts.deadCalls：已确定不会有结果的 call id 集合（见 collectDeadCalls）—— 它们不算"未闭合"。
export function closedPrefixEnd(msgs, opts = {}) {
  const dead = opts?.deadCalls instanceof Set ? opts.deadCalls : null
  const isDead = (id) => !!(dead && dead.has(id))
  const callIdx = new Map()   // id -> 首个 call 下标
  const resultIdx = new Map() // id -> 首个 result 下标
  let lastClosed = -1
  for (let i = 0; i < msgs.length; i++) {
    for (const b of blocksOf(msgs[i])) {
      if (b.type === 'tool-call') {
        const id = b.id ?? b.toolCallId ?? ''
        if (id && !callIdx.has(id)) callIdx.set(id, i)
      } else if (b.type === 'tool-result') {
        const id = b.toolCallId ?? b.callId ?? ''
        if (id) {
          if (!resultIdx.has(id)) resultIdx.set(id, i)
          if (callIdx.has(id)) lastClosed = Math.max(lastClosed, i)
        }
      }
    }
  }
  if (msgs.length === 0) return -1
  // 悬空但已定死的 call 视同闭合；仍在飞的不算（保守）
  const allClosed = [...callIdx.keys()].every((id) => resultIdx.has(id) || isDead(id))
  let end = allClosed ? msgs.length - 1 : lastClosed
  if (end < 0) return -1
  // 配对安全钳制（迭代至稳定）
  for (let guard = 0; guard < msgs.length + 2; guard++) {
    let bad = -1
    for (const [id, ci] of callIdx) {
      if (isDead(id) && !resultIdx.has(id)) continue // 已定死的悬空 call：允许被跨越
      const ri = resultIdx.has(id) ? resultIdx.get(id) : Number.POSITIVE_INFINITY
      if (ci <= end && !(ri <= end)) bad = Math.max(bad, ci) // call 在内、result 在外/缺失
    }
    for (const [id, ri] of resultIdx) {
      const ci = callIdx.has(id) ? callIdx.get(id) : -1
      if (ri <= end && !(ci >= 0 && ci <= end)) bad = Math.max(bad, ri) // result 在内、call 在外/缺失
    }
    if (bad < 0) break
    end = bad - 1
    if (end < 0) return -1
  }
  return end
}

// 【#4 修复 2026-09-10，取自 RCS-0.1.0 返回包】跨界配对守卫：返回"被折叠边界切分"的配对 id（空 = 安全）。
// 场景：遮蔽集（将被 replace 掉的 [start..end]）与尾部（保留在 surface）之间若存在
//   "call 在遮蔽集、result 留在尾部"或反之 → surface 出现孤儿 tool 消息 → INVALID_REQUEST
//   （本机 2026-09-08 会话 7a5301d7 并行 subagent 场景实测崩溃，与 §13 分类改动同源风险区；
//    ki 前截断 / 注入节点剔除 / 边界计算都可能造成）。
// 用法：折叠提交前调用；非空则延后本次折叠（defer），绝不提交切分配对。
export function pairSplitIds(insideMsgs, outsideMsgs) {
  const collect = (msgs) => {
    const calls = new Set()
    const results = new Set()
    for (const m of msgs) {
      for (const b of blocksOf(m)) {
        if (b.type === 'tool-call') {
          const id = b.id ?? b.toolCallId ?? ''
          if (id) calls.add(id)
        } else if (b.type === 'tool-result') {
          const id = b.toolCallId ?? b.callId ?? ''
          if (id) results.add(id)
        }
      }
    }
    return { calls, results }
  }
  const a = collect(insideMsgs)
  const b = collect(outsideMsgs)
  const bad = []
  for (const id of a.calls) if (b.results.has(id) && !a.results.has(id)) bad.push(id) // call 在内、result 在外
  for (const id of a.results) if (b.calls.has(id) && !a.calls.has(id)) bad.push(id)   // result 在内、call 在外
  return bad
}

// 转录簿记：text 块 / tool-call↔tool-result 配对，产出五类行（主设计 §2 v1 定稿）。
// 防自转录/防污染：真实用户输入 = 非 plugin 且非 DSH 自动注入快照。
// DSH 以 user 角色注入的 runtime/policy 快照（Current runtime context / Current DSH file policy /
// sandbox:policy …）常不带 plugin source，若被记成 [U] 会污染转录 → 主 AI 复述时出现"伪历史"。
// 跳过：plugin source / [ROUND] 开头（自身折叠消息重放兜底）/ runtime 与 file-policy 快照 / sandbox: 前缀。
// 【#2 修复（取自 RCS-0.1.0 返回包）】INJECTED_USER_PREFIXES 已提为共享单源（condense/chunk.mjs），
//   由本文件与 LOGcompiler 共同导入 —— 旧实现两处各写一套前缀，source 缺失时轮号会分叉。
// 注入型 user 节点：DSH runtime/policy 快照（dsh-system-prompt 每 step 追加）。
// v1.6 归因定稿（2026-09-06，skiphead/splitfold 行为实验；取代 v1.5"replace 触发、不可修"错误结论）：
//   触发源 = 折叠把 runtime context 节点遮蔽掉 → surface 缺 policy 快照 → DSH 补发（~492B/轮）。
//   证据：fold2 遮蔽含 runtime → 折叠后 runtime 消失 1 步 → 下一步前重注入；
//         skiphead 遮蔽段避开注入节点 → 折叠后 8 step runtimeCount 恒 1、supersedes 零新增、任务完成；
//         splitfold 同一步两次 surfaceOp replace 均 ok:true（注入节点穿插时可分段）。
//   对策（v1.6 keepInject）：遮蔽区间永不包含 DSH 注入节点 → 快照始终在场 → 零补发。
// isDshInjected（v1.6）：DSH 注入判定精确化——**自身转录消息（plugin 标识='CONTEXTinjector'）不算注入**，
//   必须可遮蔽（新转录以旧文本为前缀，遮蔽换新安全）；其余 plugin 族与 runtime/policy 前缀 user 才算注入。
//   v1.10.27：plugin 族判定走 pluginIdOf（双形态兼容 v4 的 kind:'plugin:X'）。
function isOwnTranscript(m) {
  return pluginIdOf(m?.source) === 'CONTEXTinjector'
}
// 【取自 RCS-0.1.0】DSH 以非 plugin 形式注入的节点 kind 白名单（实测 skill 目录节点：
//   kind==='skill-catalog'、文本以 <system-reminder> 开头）——不判为注入的话它会被折进遮蔽区，
//   DSH 随即补发一份目录 ⇒ 遮蔽边界更保守地"视为注入、留在表面"。
const DSH_INJECTED_KINDS = new Set(['skill-catalog'])
function isDshInjected(m) {
  if (!m || m.role !== 'user') return false
  // 【extreason 接入（取自 RCS-0.1.0）】外置推理简报节点（plugin 标识==='EXTREASON'）**不算 DSH 注入**：
  //   它是易失量（每轮由插件重发），必须可被折叠吞掉；否则会被 keepInject 钉在 surface 上、逐轮累积。
  const pid = pluginIdOf(m.source)
  if (pid === 'EXTREASON') return false
  if (pid !== null) return !isOwnTranscript(m)
  if (DSH_INJECTED_KINDS.has(m.source?.kind)) return true
  const text = blocksOf(m)
    .filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    .replace(/[\r\n]+/g, ' ').trim()
  return INJECTED_USER_PREFIXES.some((p) => text.startsWith(p))
}
// v1.5 兼容语义：任何 plugin user（含自身转录消息）都视为注入 —— 用于 keepInject=false 的末端剔除（保持旧行为）。
// ⚠ 注意：此处**必须保持旧版语义**，勿把 subagent/system 按 §13 算作注入。
//   它决定折叠遮蔽边界（keepInject=false 时 `while end` 往回跳注入）。把 subagent（kind 非 plugin）
//   判为注入会改变遮蔽区间 → 在并行 subagent 的 tool-result 与其 assistant(tool_calls) 之间切出
//   孤儿 tool 消息 → INVALID_REQUEST（A/B 真机实测：§13 改此处即崩溃，回退即恢复）。
//   subagent 转录不进 [U] 已由 transcribeIncremental 的 §13 分型单独处理，与本函数无关。
function isInjectedUser(m) {
  if (!m || m.role !== 'user') return false
  // 【extreason 接入（取自 RCS-0.1.0）】同上：简报节点在 keepInject 关闭的旧语义下也必须可折叠
  const pid = pluginIdOf(m.source)
  if (pid === 'EXTREASON') return false
  if (pid !== null) return true
  const text = blocksOf(m)
    .filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    .replace(/[\r\n]+/g, ' ').trim()
  return INJECTED_USER_PREFIXES.some((p) => text.startsWith(p))
}
// v1.10 重启续传：DSH 装载会话不重放历史事件，重启后 foldText/foldSeq/foldRound 归零，
// 但自身折叠转录节点已持久化在 surface。首次（本进程）接触该会话且要折叠时，
// 找到最后一个自身折叠转录节点，回填 foldText/foldSeq/foldRound → 后续折叠仍是"旧转录+增量"单调拼接，
// 不丢旧轮注入历史（否则会用"仅尾部"的转录 replace 掉整段旧折叠）。
// 【v1.10.13 多段转录（control.segments，默认关闭）·读取侧】
//   v1.10 旧实现只取**最后一个**自身转录节点 ⇒ surface 上存在多段时（standalone 的旧段、
//   多段契约的 head 段/历史段）前面的段在重启后静默消失，后续折叠也就丢了历史。
//   现改为：**按 seq 升序拼接全部自身转录节点** —— 单段会话结果与旧版逐字相同（只有一个文本），
//   多段会话才体现差异。seq 取**最后一段**的起点（后续增量判据 `seq > foldSeq` 依赖它）。
// 纯函数（可单测）：items = surface 顺序的 { seq, text }。
export function mergeOwnSegments(items) {
  const segs = (items ?? []).filter((it) => it && typeof it.text === 'string' && it.text !== '')
  if (segs.length === 0) return { text: '', seq: -1, round: 0, segCount: 0, segs: [] }
  let mx = 0
  for (const it of segs) for (const m of it.text.matchAll(/^\[ROUND\]\s*(\d+)/gm)) { const n = Number(m[1]); if (n > mx) mx = n }
  return {
    text: segs.map((it) => it.text).join('\n'),
    seq: segs[segs.length - 1].seq,
    round: mx,
    segCount: segs.length,
    segs: segs.map((it) => parseSegHeader(it.text, it.seq)),
  }
}
// 段文本装配（多段转录的写入侧，纯函数）：**只有行，没有任何机器可读头**。
//   【v1.10.16 修正（用户实测报障 2026-09-11）】0.1.9–0.1.11 曾在首行插一行
//   `# SC-SEG <segIndex> <baseCumLines> <prevSegSeq>`，当时按"每段约 40B"当作可接受代价。
//   用户实际看到它出现在**注入的上下文里**（会话转录首行 `# SC-SEG 4 16 5383`）⇒ 机器元数据
//   不该进模型上下文：那既是噪声、又会让模型对"这是什么格式"产生无谓猜测。
//   现在段信息**只**落两处（都不进上下文）：
//     · `last-fold.segments[]`（本次折叠各段的 segIndex/kind/seq/cumLines/bytes）
//     · `.ctxinjector/fold-index/<sid>.jsonl`（每次折叠的 cumLines 前后值与 seq 集合）
//   顺序不依赖文本自证：surface 节点列表本身是有序的（续传 seed 就按它拼接），
//   `verify-fold-integrity.mjs` 仍可用 last-fold.segments + fold-index 复核。
// 只算不提交 —— 调用方"先算全部、再依次 append"。
export function segmentText(rows) {
  return (rows ?? []).join('\n')
}
// 兼容读取：0.1.9–0.1.11 落过段头的会话，其文本里仍留着那一行（历史不改写）。
//   本函数仍可解析出来供审计；无段头（0.1.12 起的新契约）⇒ 三个字段记 null，绝不抛。
export function parseSegHeader(text, seq = -1) {
  const s = String(text ?? '')
  const m = /^# SC-SEG (\d+) (\d+) (-|\d+)\s*$/.exec(s.split('\n', 1)[0])
  return {
    seq,
    segIndex: m ? Number(m[1]) : null,
    baseCumLines: m ? Number(m[2]) : null,
    prevSegSeq: m && m[3] !== '-' ? Number(m[3]) : null,
    bytes: s.length,
  }
}
// v1.10.26 (RCS↔DSH 0.1.5 compat): DSH 0.1.5 refuses any replace range whose
// first node is the system prompt (surface node 0 must be rewritten only by a
// system/message over exactly that node). Keep system nodes on the surface so a
// fold range never starts at seq 0.
function isSystemNode(m) {
  return m?.role === 'system'
}
// v1.10.26 (RCS↔DSH 0.1.5 compat): DSH 0.1.5 validates a replace surfaceOp as
// exactly {op,startSeq,endSeq}, while <=0.1.1 used {op,start,end}. Emit the new
// shape; the three-key exact-length check forbids sending both spellings.
function replaceOp(startSeq, endSeq) {
  return { op: 'replace', startSeq, endSeq }
}
// v1.10.26 (RCS↔DSH 0.1.5 compat): DSH 0.1.5 dropped the public `session.events`
// array and exposes `eventAt(seq)` instead. Keep both paths so one file runs on
// 0.1.1-rc.2 and 0.1.5-rc.2 alike.
function evAt(session, seq) {
  if (typeof session?.eventAt === 'function') return session.eventAt(seq)
  return session?.events?.[seq]
}
// v1.10.27 (DSH rc.3+/0.1.7 compat): the public `session.events` array is gone there;
// enumerate via ownEvents() when present. `?? []` alone was a silent-degrade trap —
// empty event lists read as "no dead calls / no transcript" without any error.
function allEvents(session) {
  if (typeof session?.ownEvents === 'function') return session.ownEvents()
  const snap = session?.snapshotEvents
  if (typeof snap === 'function') { try { return snap.call(session) } catch { return [] } }
  return session?.events ?? []
}
function seedFoldState(session, surface, st) {
  try {
    const nodes = [...(surface?.nodes ?? [])]
    const entries = nodes.map((seq) => ({ seq, msg: session.deriveEventMessage(evAt(session, seq)) }))
    const own = []
    for (const e of entries) {
      if (!e.msg || !isOwnTranscript(e.msg)) continue
      const text = blocksOf(e.msg).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      if (text) own.push({ seq: e.seq, text })
    }
    if (own.length === 0) return false
    const merged = mergeOwnSegments(own) // v1.10.13：拼接全部段（旧版只取最后一个 ⇒ 多段会丢前面的段）
    st.foldText = merged.text
    st.foldSeq = merged.seq
    st.foldRound = merged.round
    st.segCount = merged.segCount
    st.lastSegSeq = merged.seq
    st.seeded = true
    console.log(`[contextinjector] resume-seed seq=${merged.seq} round=${st.foldRound} segments=${merged.segCount} foldBytes=${merged.text.length} (process-restart resume)`)
    return true
  } catch (err) {
    console.error('[contextinjector] resume-seed failed:', err?.message ?? err)
    return false
  }
}
function argsOf(argsJson) {
  try { const a = JSON.parse(argsJson ?? '{}'); return (a && typeof a === 'object') ? a : {} } catch { return {} }
}
const TOOL_DOMAIN = {
  read: 'fs', read_image: 'fs', write: 'fs', edit: 'fs', str_replace: 'fs',
  glob: 'fs-search', grep: 'fs-search', pwsh: 'shell', bash: 'shell',
  create_goal: 'goal', get_goal: 'goal', update_goal: 'goal',
  job_list: 'jobs', job_output: 'jobs', job_kill: 'jobs',
  ask_user_question: 'ask-user', web_search: 'web', web_fetch: 'web',
  todo_write: 'todo', subagent: 'subagent',
}
function toolDomainOf(op) { return TOOL_DOMAIN[op] || op }
// 收集工具结果的可读正文（text 块 + tool-result 的 content）——结构化档用来算 head/tail/err 原文/指纹；
// 旧档不调用，仍不回流正文。
function toolResultText(m, resultBlock) {
  const parts = []
  for (const x of blocksOf(m)) if (x && x.type === 'text' && x.text) parts.push(x.text)
  if (resultBlock && typeof resultBlock.content === 'string' && resultBlock.content) parts.push(resultBlock.content)
  return parts.join('\n')
}
function transcribeIncremental(msgs, roundState, opts = {}) {
  const rows = []
  const pending = new Map() // callId -> {op, path, args}
  const structured = !!(opts && opts.structured)
  for (const m of msgs) {
    const role = m?.role
    const src = m?.source?.kind
    for (const b of blocksOf(m)) {
      if (isReasoningBlock(b)) continue // §1.2 content-only：reasoning 块剥离（不转录）
      // 注：subagent relay/settled 正文实测以 text 块到达（deepseek-v4-flash），不受此影响；
      //     若未来某 provider 把 relay 正文放 reasoning 块，需在 relay 分支单独透传（见报告 §4-B）。
      if (b.type === 'text') {
        const txt = inline(b.text)
        if (!txt) continue
        if (role === 'user') {
          // §13：按 source 分型——ROUND 仅真人轮（kind==='user'）；subagent 回传/系统注入
          // 不再漏进 [U]。旧判 src==='plugin' + 文本前缀抓不到 subagent-report/settled（kind 非 plugin）。
          const cls = classifyMessageSource(m?.source)
          if (cls.cls === 'opaque' && !m?.source) {
            // source 缺失（异常）⇒ 回退旧文本前缀启发式
            if (INJECTED_USER_PREFIXES.some((p) => txt.startsWith(p))) continue
            roundState.n += 1
            rows.push(`[ROUND] ${roundState.n}`)
            rows.push(`[U] ${txt}`)
            continue
          }
          switch (cls.cls) {
            case 'user': // 仅真人输入递增 ROUND
              roundState.n += 1
              rows.push(`[ROUND] ${roundState.n}`)
              rows.push(`[U] ${txt}`)
              break
            case 'catalog': // skill 目录，不计 ROUND
              rows.push(`[C] ${txt}`)
              break
            case 'snapshot': // runtime 快照，只存 sections 摘要防膨胀
              rows.push(`[S] ${snapshotSummary(cls.sections)}`)
              break
            case 'notice': // job 通知 / 审批变更 / subagent 结束，不计 ROUND
              rows.push(`[N] ${cls.sub} | ${txt}`)
              break
            case 'relay': // subagent 报告：走 [T]/[V] 带锚点，内容保留但不计 ROUND
              rows.push(`[T] subagent | ${subagentIdOf(txt) ?? cls.agentId ?? '?'} | OK`)
              rows.push(`[V] ${txt}`)
              break
            case 'extreason': { // 【extreason 接入（取自 RCS-0.1.0）】外置推理简报：文本本身已是 `[R] …` 行
              //   —— 必须用 b.text 原始行，不能用 inline 后的 txt（inline 把换行压成空格、丢行结构）
              for (const line of String(b.text ?? '').split('\n')) {
                const s = line.trim()
                if (/^\[R\] /.test(s)) rows.push(s)
              }
              break
            }
            default:
              break // self（本插件折叠注入）/ opaque ⇒ 不转录
          }
        } else if (role === 'assistant') {
          rows.push(`[A] ${txt}`)
        }
        continue
      }
      if (b.type === 'tool-call') {
        const id = b.id ?? b.toolCallId ?? ''
        if (id) pending.set(id, { op: b.name ?? '?', path: pathOf(b.arguments), args: argsOf(b.arguments) })
        continue
      }
      if (b.type === 'tool-result') {
        const id = b.toolCallId ?? b.callId ?? ''
        const isErr = b.isError === true
        const rec = pending.get(id) ?? { op: b.name ?? '?', path: '-', args: {} }
        if (structured) {
          const text = toolResultText(m, b)
          const { t, vs } = foldToolResult({ action: rec.op, args: rec.args || {}, text, isError: isErr, fs: { readFileSync }, tool: toolDomainOf(rec.op) })
          for (const v of vs) rows.push(v)
          rows.push(t)
        } else {
          rows.push(`[T] ${rec.op} | ${rec.path} | ${isErr ? 'ERR' : 'OK'}`)
        }
      }
    }
  }
  return rows
}

// ========== v1.10.1 keepInject 头部补录（修复"折叠转录缺第 1 轮"）==========
// 病根（2026-09-10 用户实测 session-2ae3f3f9「晚上吃什么→偏清淡→那就鲈鱼」）：DSH 的 runtime/policy
//   快照节点（user 角色 / source.plugin='@deepseek-ai/dsh-system-prompt'）实测**紧跟首条真人 user**
//   （该会话 seq8=user「晚上吃什么」/ seq9=runtime 快照 / seq10=EXTREASON 简报 / seq268=首条 [A]）。
//   keepInject ON 的遮蔽段从"最后一个注入节点之后"起算 ⇒ 注入**之前**的普通节点（＝首条 user）
//   永远进不了遮蔽集，于是也永远没被转录：last-fold.full 以孤儿行 `[R]…[A]…` 开头，
//   首个 `[ROUND]` 已是第二轮「偏清淡」，而面板 parseTranscript 丢弃 `[ROUND]` 之前的行
//   ⇒ 用户看到"第一轮（首条 user + 首条 AI 回复）整体消失"。
// 修法（最小正确）：把"注入节点之前、因而永远无法遮蔽"的那段节点**只转录、不遮蔽**，且只在
//   **本会话第一次折叠**（foldText === ''）时补录一次 ⇒ 转录恢复为完整记录（ROUND 1 = 首条 user），
//   而 keepInject 的保证分毫未动：注入节点既不进遮蔽区间、也不进 head（绝不遮蔽 ⇒ 零快照补发）。
// 代价（实测极小）：这段文本在请求里出现两次（原节点仍在表面 + 转录行）——本例 ≈ 一条 user 文本 +
//   一行 `[ROUND] 1` ≈ 30B；换来转录/面板的记录完整性。旧转录（foldText 非空，含重启 seedFoldState）
//   一律不补录：把 head 插到转录中段会破坏 monotonic 前缀纪律（既有历史会话保持现状，新会话起生效）。
// ⚠ 纯函数（可单测）：entries = surface 顺序的 {seq,msg}（msg 已过滤 null）、hasPriorTranscript =
//   foldText !== ''；roundState 会被**就地推进**（head 里的真人轮先占号，随后的增量行轮号连续）。
export function foldHeadTranscript(entries, hasPriorTranscript, roundState, opts = {}) {
  let lastInject = -1
  for (let i = 0; i < entries.length; i++) if (isDshInjected(entries[i].msg)) lastInject = i
  if (lastInject < 0) return { head: [], tail: entries, hadInject: false, rows: [] } // 无注入节点 ⇒ 与旧版逐字同行为
  const head = hasPriorTranscript ? [] : entries.slice(0, lastInject) // 已存在转录 ⇒ 不补录（幂等）
  const tail = entries.slice(lastInject + 1)
  const rows = head.length > 0 ? transcribeIncremental(head.map((e) => e.msg), roundState, opts) : []
  return { head, tail, hadInject: true, rows }
}

// ================= condense 档（v1.5）：增量 [A] 前向浓缩 =================
// 只处理增量内"新 [A]"行的正文；[ROUND]/[U]/[T] 原样通过；结果只拼接到 foldText 之后，
// 旧 transcript 从不重新浓缩（monotonic 前缀由调用方保证）。
// 【v1.10.18 默认提示词重写（用户提"两个压缩器默认提示词不够好"）· A/B 实测见 docs/PROD-RCS-0.1.14-NOTES.txt】
//   旧版（v1.10.17 及以前）的病根：把要求写成"必须保留：结论、做出的决定、任务目标与完成状态、
//   关键数字/文件名/路径…"这样一份**清单** ⇒ 4B 级模型会为凑满清单而**编造**任务目标/完成状态/文件路径
//   （真机实证：`核心文件路径为：/memory/architecture/cerebral-memory-v1.2.yaml`，原文里根本没有）。
//   新版改成"**只删不改**"的约束式写法 + 点名禁止那几句模板，并在 A/B 上用真机数据验证（12 条真实 [A] 原文）：
//     · 旧提示词：编造状态 5/12 条、编造值 3/12 条，中位耗时 17.0s
//     · 新提示词：编造状态 **0/12**、编造值 2/12，中位压缩比 0.464（旧 0.437 ≈ 同级），中位耗时 **4.5s**
// 【v1.10.20 · 经济性 P1 提示词收紧（A/B 实测）】
//   上一版只写了"目标不超过原文的四分之一"这一条**相对**约束。问题：对"原文本身就是流水"的 [A]，
//   模型会把它理解成"只要比原文短就行"，于是贴着上限写 ⇒ 输出 token 高、压缩率差。
//   这一版只**追加一句绝对字数锚点**（"原文约 1000 字时输出控制在 150 字以内"），不动其余任何约束
//   （铁律一/二、取舍顺序、形式全部逐字保留 ⇒ 不引入新的编造风险）。
//   真机 A/B（同一组 3 条真实 [A]，均 1758 字，reasoningEffort=off）：
//     · maxTokens=768 ：压缩比 0.319 → **0.258**，输出 token 298 → **232**（-22%）
//     · maxTokens=1536：压缩比 0.336 → **0.273**，输出 token 311 → **250**（-20%）
//     · 对照组 terse（整段重写的另一版提示词）：0.311 / 0.303 ⇒ 并不优于原版，被弃用
//   两档预算下一致更优 ⇒ 收益来自提示词本身，而非预算。证据：tools/.probe/summary-e3.json。
const CONDENSE_SYS = '你是 AI 输出的有损压缩器。把给定的一条 AI 消息压成一段明显更短的文本，供长期携带上下文使用。\n\n铁律一（只删不改）：原文里没有的路径、文件名、版本号、数字、ID、hash、状态词一律不得出现；原文里的具体值必须逐字照抄，不得改写、缩写、翻译、补全或猜测；不确定就省略。\n铁律二（不许编结论/进度）：禁止写原文没有的"已完成/已交付/已通过/已验证/已修复/已上线"等说法；禁止写"任务目标：…""完成状态：…""关键文件路径：…"这类模板句，除非原文本身就有对应内容。\n\n取舍顺序：先保结论与决定、真实状态与卡点、未决问题与下一步，以及所有具体值（数字/路径/文件名/ID/链接）；这些比措辞重要——为了给它们腾地方，优先删掉修饰语、过程叙述、客套、重复与无关举例。原文若是过程流水，就只留"做了什么 + 结果 + 待办"，不要替它总结出原文没有的结论。\n\n形式：单段纯文本，要点之间用"；"连接；不加标题、编号、标签、前缀或解释；使用与原文相同的语言。\n长度：目标不超过原文的四分之一；原文本身已是简短结论时，基本原样保留。硬约束：无论原文多长，输出都必须明显短于原文——原文约 1000 字时输出控制在 150 字以内，更要紧的是**不要复述原文**，只留结论、状态、卡点、下一步与具体值。'
// double 档第二轮：载荷直抄（离线 p1c [A·K] 思想，收敛版）。本输入无 ⟦ 占位符，只收孤立名词性值；
// 含谓词的整句/步骤编号一律剔（p1c naive→v4 实测教训），输出行级去重。
// double 档第二轮：载荷直抄（离线 p1c [A·K] 思想，收敛版）。本输入无 ⟦ 占位符，只收孤立名词性值；
// 含谓词的整句/步骤编号一律剔（p1c naive→v4 实测教训），输出行级去重。
// 【v1.10.18 重写 · A/B 实测】旧版列了 4 条"禁止事项"，但没把"只许逐字摘抄、原文没有的绝不许出现、
//   找不到值就输出空"立成硬规则 ⇒ 真机实测 10 条原文里 **5 条出现非逐字行**（共 148 行，多为把
//   `_xchg\FROM-….md` 之类规范化/补全）。新版把这些立成铁律后：**非逐字行 0**、输出行 962→756
//   （召回 243→201，即"宁可漏抄不可改字"——正是本插件既定原则"错误载荷比丢失更糟"）。
const KEYS_SYS = '你是载荷值提取器：从给定原文里，把"未来可能被引用的具体值"逐字摘抄成清单，一行一个。\n\n只允许摘抄，不允许改写：每个值都必须与原文逐字节一致；不得翻译、缩写、补全、换算或猜测。原文里没有的值，绝不许出现在输出里；一个合格的值都找不到时，输出空（不要为凑输出而编）。\n\n合格的值：孤立的数值（结果 24、比率 0.31、端口 8787、行号 200）、短 ID 或 hash 片段（e7b40c73、DC364B19）、标记词（CLEANUP_OK）、文件名或目录名（summary.txt、branch1）、版本号（v1.10.17）、链接（http://…）。\n不合格：整句、从句、动宾短语、对话正文、段落残余、步骤标题或编号（Step 1、步骤2、操作：pwsh）、占位符（⟦ID0⟧ 及其碎片）。含谓词（是/请/提供/执行/需要/无法/完成/确认）的行一律不算值。\n\n输出：每行一个值，不加编号、项目符号、引号或任何解释；重复的值只留一次。'
// #10：把内置默认压缩提示词暴露给 WebUI（runtime.json.defaultPrompts），供用户在自定义前查看/对照。
// 单一来源——不重复到 host，只在此写一次；host /status 已读 runtime.json。
try {
  let _cur = null
  try { _cur = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) } catch { _cur = {} }
  _cur.defaultPrompts = { single: CONDENSE_SYS, keys: KEYS_SYS }
  writeFileSync(RUNTIME_FILE, JSON.stringify(_cur, null, 2) + '\n', 'utf8')
} catch { /* runtime.json 不可写则忽略，折叠时再补 */ }
// —— [A] 浓缩管道 guard（p1b 实证复用）：结构可识别载荷先占位、浓缩后再规则回填——弱模型从不接触真值，
//    无从抄错/截断/幻觉（e2e 实测 4B 把 branchID=e7b40c73 写成 e7b4073、幻觉 e7b40c77）。——
const G_SLOT_RE = /⟦([A-Z]+)(\d+)⟧/g
function guardText(text) {
  const slots = []
  const hit = (m, tag) => { slots.push(m); return `⟦${tag}${slots.length - 1}⟧` }
  let s = String(text)
  const p = (m) => hit(m, 'P'), id = (m) => hit(m, 'ID'), hx = (m) => hit(m, 'HX')
  s = s.replace(/[A-Za-z]:\\[^\s"'<>，。；⟦]+/g, p) // PATH 先抽：路径内 ID/hex 只进一个占位，防嵌套
  s = s.replace(/(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id)
  s = s.replace(/[0-9a-f]{6,}/gi, hx) // 8 位短 id / 长 hash 全占位（e7b40c73 在此被保护）
  return { text: s, slots }
}
function restoreText(text, slots) {
  const unfold = (s) => s.replace(G_SLOT_RE, (_, __, i) => slots[Number(i)] ?? '')
  let s = String(text)
  let out = unfold(s)
  while (out !== s) { s = out; out = unfold(s) } // 递归展开，防嵌套残留
  return out
}
const PREDICATE_RE = /是|请|提供|执行|需要|无法|完成|确认|正在|已经|应该|可以|让我/
const dedupeKeys = (raw) => {
  const seen = new Set(); const lines = []
  for (const rawLine of String(raw).split('\n')) {
    const ln = rawLine.trim().replace(/^[（(【\[][^）)】\]]{0,12}[）)】\]]\s*/, '') // 剥前缀标签
    if (!ln || ln.length > 80 || PREDICATE_RE.test(ln)) continue
    if (seen.has(ln)) continue
    seen.add(ln); lines.push(ln)
  }
  return lines.join('\n')
}
// ================= v1.8 浓缩模型通道：DSH 已注册模型（ctx.llm） =================
// 为什么：v1.5–v1.7 只走本地 Ollama，没有本地部署的机器上 single/double 档等同不可用。
// 现在调用 DSH 自身注册的 provider/model（官方 deepseek 或用户配置的任意 provider），零额外部署。
// 为什么软取：硬 inject:['llm'] 在服务缺失时让插件停在 PENDING 且**不报错**（手册 §4.4），
// 那会连无损折叠一起废掉。故一律软取；取不到就回退无损，纪律不变。
function llmOf(ctx) {
  try {
    const viaGet = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    return viaGet ?? ctx?.llm ?? null
  } catch { return null }
}
// 会话当前模型路由（与官方 dsh-session-title-llm 同源：request/header 快照）
function routeFromSession(session) {
  try {
    const h = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const c = h?.config
    if (c && typeof c.provider === 'string' && typeof c.model === 'string' && c.provider && c.model) {
      return { provider: c.provider, model: c.model, via: 'session' }
    }
  } catch { /* best-effort */ }
  return null
}
// 兜底：注册表首个 provider 的首个模型（会话尚无 header 时，如首轮之前）
async function routeFromRegistry(llm) {
  try {
    const ps = llm.listProviders?.() ?? []
    for (const p of ps) {
      const id = typeof p === 'string' ? p : p?.id
      if (!id) continue
      const ms = await llm.listModels?.(id).catch(() => null) ?? []
      const first = ms?.[0]
      const mid = typeof first === 'string' ? first : first?.id
      return mid ? { provider: id, model: mid, via: 'registry' } : null
    }
  } catch { /* best-effort */ }
  return null
}
// 路由优先级：env > control.json > 会话当前模型 > 注册表首个
async function resolveCondenseRoute(ctx, session, ctrl, llmFixed) {
  const envP = process.env.DSH_CONTEXTINJECTOR_CONDENSE_PROVIDER
  const envM = process.env.DSH_CONTEXTINJECTOR_CONDENSE_MODEL
  if (envP && envM) return { provider: envP, model: envM, via: 'env' }
  const cp = ctrl?.condenseProvider
  const cm = ctrl?.condenseModel
  if (typeof cp === 'string' && typeof cm === 'string' && cp && cm) return { provider: cp, model: cm, via: 'control' }
  const llm = llmFixed ?? llmOf(ctx) // v1.10.19：优先用上层固化的句柄（作用域可能已经/即将被回收）
  if (!llm) return null
  return routeFromSession(session) ?? await routeFromRegistry(llm)
}
// user message 构造：优先 dsh-llm 的规范构造器（动态 import；解析失败则退回等价手写值）
let _msgCtor = null
let _msgTried = false
async function userMessage(text) {
  if (!_msgTried) {
    _msgTried = true
    try { _msgCtor = (await import('@deepseek-ai/dsh-llm')).createUserMessage ?? null } catch { _msgCtor = null }
  }
  const content = [{ type: 'text', text }]
  const source = { kind: 'plugin:CONTEXTinjector' }
  if (_msgCtor) {
    try { return _msgCtor({ content, source }) } catch { /* 退回手写值 */ }
  }
  return { id: 'msg-' + randomUUID(), role: 'user', content, source }
}
// 一次流式旁路调用；非 stop 结束（错误/中止/截断）一律视为失败 → 调用方回退无损。
// v1.9：可选 sink(reason) 收集失败原因（llm 缺失/路由缺失/流错误/非 stop finish），
//   供折叠把真实错误上浮到 lastFold.condenseErr → WebUI 面板展示（此前错误只隐没在 aFallback 计数里）。
async function llmText(ctx, route, system, user, maxTokens, sink, llmFixed, opts) {
  // 【v1.10.19 · P3】优先用调用方固化的句柄（折叠开始时取到的那一个），取不到才实时解析。
  const llm = llmFixed ?? llmOf(ctx)
  if (!llm) { sink?.('llm service unavailable'); return null }
  if (!route?.provider || !route?.model) { sink?.('condense route missing'); return null }
  // 【v1.10.20 · P0】推理档位（缺省 off）。opts.effort 显式给定则优先，否则沿用 io/env 解析结果。
  const eff = opts && opts.effort !== undefined ? String(opts.effort).trim().toLowerCase() : LOSSY_EFFORT
  const meta = (opts && opts.meta) || null // 可选：回填 finish 详情，供调用方做截断抢救判定
  const messages = [await userMessage(user)]
  let text = ''
  let finish = null
  let usage = null
  const req = {
    provider: route.provider,
    model: route.model,
    messages,
    system,
    temperature: 0,
    maxTokens,
    purpose: 'compaction',
  }
  // 只在显式取值时下发 reasoningEffort；'' 表示"完全不传"（保留旧行为，便于对照实验/回滚）。
  if (LOSSY_EFFORTS.has(eff) && eff !== '') req.reasoningEffort = eff
  // 只要发生了一次真实调用，钱就花了 —— 因此**无论成功/失败/被拒绝**都要计量（幂等：只记一次）。
  let usageRecorded = false
  const recordUsage = () => {
    if (usageRecorded || !usage) return
    usageRecorded = true
    if (meta) {
      meta.inTokens = usage.inputTokens ?? 0
      meta.cacheReadTokens = usage.cacheReadTokens ?? 0
      meta.outTokens = usage.outputTokens ?? 0
    }
    const sink2 = opts && opts.usageSink
    if (sink2) {
      sink2.calls += 1
      sink2.in += usage.inputTokens ?? 0
      sink2.cacheRead += usage.cacheReadTokens ?? 0
      sink2.out += usage.outputTokens ?? 0
    }
  }
  try {
    for await (const chunk of llm.stream(req)) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      // 【v1.10.23 · 经济性计量】过去只认 text-delta/finish，把 **usage 分块整个丢掉** ——
      //   于是辅助调用（浓缩/K）花了多少 token 在插件侧完全不可见：bench 的 billed 只统计会话里的
      //   assistant 事件，也不含这次调用。结果是"压缩到底花了多少钱"只能靠估。
      //   现在把真实 usage 记进 opts.usageSink（由调用方聚合到 io.aux），并回填 meta 供日志核验。
      else if (chunk.type === 'usage') usage = chunk.usage ?? chunk
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (err) {
    recordUsage()
    sink?.('stream error: ' + String(err?.message ?? err))
    return null
  }
  recordUsage()
  if (!finish) { sink?.('no finish chunk'); return null }
  const kind = String(finish.kind ?? '')
  if (meta) { meta.finishKind = kind; meta.truncated = kind !== 'stop' && /max.?tokens|length|truncat/i.test(kind) }
  // 【v1.10.20 · P2】截断抢救：仅当调用方显式开启 opts.salvage 且确为"额度用尽"型结束，
  //   才把**已生成的部分正文**交回调用方（由它做缩短幅度/占位符完整性两道闸）。
  //   其余非 stop（error/aborted/…）依旧一律失败 ⇒ 无损回退，语义不变。
  if (kind !== 'stop') {
    const salvageable = !!(opts && opts.salvage) && meta && meta.truncated && text.trim().length > 0
    // 【v1.10.21 · 诊断】过去这里只记 kind，把真正的失败载荷（failure.code/message）丢掉了 ——
    //   导致"K 通道 keysErr=12/12"到底是**调用失败**还是**返回了但没可用值**无法区分。
    //   现在把 payload 一并带出（截断到 160 字符）。分型正则仍只看 `finish=<kind>` 前缀，语义不变。
    const pay = finish.failure ? ' ' + String(finish.failure.code ?? '') + ':' + String(finish.failure.message ?? '').slice(0, 160) : ''
    if (!salvageable) { sink?.('finish=' + kind + pay); return null }
    sink?.('salvage=' + kind)
  }
  if (!text.trim()) { sink?.('empty output'); return null } // P5：空输出过去是"静默回退"，连原因都不留
  return text.trim()
}

// 串行链：多会话并发折叠时对模型调用排队，避免打爆本地/远端推理
let _condChain = Promise.resolve()
// v1.9：io.errs（可选数组）收集模型调用失败原因 → 上浮到 lastFold.condenseErr
function pushErr(io, reason) {
  if (io && Array.isArray(io.errs) && reason) io.errs.push(String(reason))
}
// 【v1.10.19 · P1】每次调用的输出上限：以 io 给出的**上限**为天花板，按输入长度自适应。
//   为什么自适应：压缩目标本身就是"比原文短得多"，给一条 800 字的 [A] 开 2048 token 的额度纯属浪费
//   （模型会写满、延迟上去了、压缩率还变差）；给一条 8000 字的 [A] 只开 700 又会截断。
//   经验式：≈ 输入的 1/2 token 足够让模型把"压缩后正文"写完并正常 stop（压到 1/4 字符 ≈ 1/6 token，
//   这里留 3 倍余量）；下限 768（短输入也要写完一整段），上限取传入的天花板。
export function effectiveMaxTokens(bodyChars, ceiling) {
  const cap = Number.isFinite(ceiling) && ceiling > 0 ? Math.floor(ceiling) : LOSSY_MAX_TOKENS
  const n = Number.isFinite(bodyChars) ? Math.max(0, Math.floor(bodyChars)) : 0
  // 先保底（短输入也要够写完一段），再受天花板约束 —— 顺序反了会让 control 显式调小失效
  return Math.min(cap, Math.max(768, Math.ceil(n / 2)))
}
// =====================================================================================
// 【v1.10.23 · 经济性准入闸（payback gate）】——把"字节门槛"升级为"回本门槛"
// =====================================================================================
// 为什么必须加这道闸（实测标定见 tools/agg-cost.mjs，n=56 条带真实 usage 的探针记录）：
//   折一条 [A] 要花**一次付费调用**，而它省下的 token 在后续回合里是**缓存读**——只值 D 倍。
//   于是产生一个致命不对称：**今天按 1.0 全额付费，换取明天每回合 0.25 的折扣**。
//
//   计费等价（billed-equivalent token）：
//     成本（一次性）  = 正文 token            [未缓存，1.0]
//                     + 被缓存的提示词前缀 × D [实测中位 cacheRead=640 tok]
//                     + 输出 token × pOut      [输出与输入同价计，偏保守]
//     收益（每后续回合）= (正文 token − 输出 token) × D
//     ⇒ 回本回合 m*(S) = cost(S) / benefitPerTurn(S)
//
//   由此得到一个**渐进下界**：m* → (1+pOut·r) / ((1−r)·D)。只要 D<1，m* 就永远大于 1——
//   也就是说"折了就赚"是不成立的，任何一次折叠都必须用**后续回合数**来摊还。
//   当前 minBytes=240B 对应的 m* 远大于这些会话的实际剩余回合 ⇒ 折了注定回不了本（旧的纯字节闸的盲区）。
//   故缺省要求"预计 8 回合内回本"，否则**不发起调用**（不花钱），记 `payback` 并走无损折叠。
//
//   旋钮：
//     DSH_CONTEXTINJECTOR_LOSSY_PAYBACK=<n>   允许的回本视界（回合）；**缺省 0 = 关闭该闸**（行为不变）
//     DSH_CONTEXTINJECTOR_CACHE_DISCOUNT=<f>  缓存读折扣 D（默认 0.25，与 bench 的 BENCH_D 同量级）
//     DSH_CONTEXTINJECTOR_CACHED_PREFIX_TOKENS=<n> 辅助调用被缓存的提示词前缀（默认 640，实测中位）
//
//   ★为什么缺省**关**：下面那组"字符→token / 输出比"常数是从探针语料反推的，而该语料在 token 拆分上
//     自相矛盾（同一批记录里输入约 5 字符/token、输出约 2 字符/token），**不足以支撑一个会改变线上
//     行为的硬闸**——若按它设 horizon=8，则任何规模都通不过（估计器自身的渐进下界就是 16 回合），
//     等于**悄悄把有损档整体停用**。那是产品决策，不该藏在一个估错的常数里。
//     故本版只做两件事：①把辅助调用的**真实 usage 计量落实**（此前 usage 分块被整块丢弃）；
//     ②把"预估回本"与"实测回本"并列落盘。等实测数据回来、模型被真值校准后，再把闸默认打开。
const PB_HORIZON = (() => {
  const raw = process.env.DSH_CONTEXTINJECTOR_LOSSY_PAYBACK
  if (raw === undefined || raw === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 0
})()
const PB_CACHE_DISCOUNT = (() => {
  const n = Number(process.env.DSH_CONTEXTINJECTOR_CACHE_DISCOUNT)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.25
})()
const PB_CACHED_PREFIX_TOKENS = (() => {
  const n = Number(process.env.DSH_CONTEXTINJECTOR_CACHED_PREFIX_TOKENS)
  return Number.isFinite(n) && n > 0 ? n : 640
})()
// 字符→token 折算（中英混排经验值）与输出/输入 token 比。两者都取**偏保守**（宁可高估成本），
// 因为闸的失效方向不对称：误折一次 = 实打实花钱；误跳一次 = 只是没省到。
const PB_CHARS_PER_TOKEN = 2.5
const PB_OUT_TOKEN_RATIO = 0.6
// 预估一次折叠的成本/收益/回本回合（单位统一为计费等价 token）
function paybackOf(bodyChars) {
  const bodyTok = Math.max(1, (Number(bodyChars) || 0) / PB_CHARS_PER_TOKEN)
  const outTok = bodyTok * PB_OUT_TOKEN_RATIO
  const cost = bodyTok + PB_CACHED_PREFIX_TOKENS * PB_CACHE_DISCOUNT + outTok
  const benefitPerTurn = Math.max(0, bodyTok - outTok) * PB_CACHE_DISCOUNT
  return { bodyTok, outTok, cost, benefitPerTurn, turns: benefitPerTurn > 0 ? cost / benefitPerTurn : Infinity }
}
// 实测回本回合（用真实 usage 反算；无 usage 时返回 null）。用于把"预估"与"实付"对照写进 last-fold。
function paybackMeasured(aux, bodyChars, outChars) {
  if (!aux || !aux.calls) return null
  const cost = aux.in + aux.cacheRead * PB_CACHE_DISCOUNT + aux.out
  const savedTok = Math.max(0, (Number(bodyChars) || 0) - (Number(outChars) || 0)) / PB_CHARS_PER_TOKEN
  const benefitPerTurn = savedTok * PB_CACHE_DISCOUNT
  return { cost, benefitPerTurn, turns: benefitPerTurn > 0 ? cost / benefitPerTurn : Infinity }
}
// 【v1.10.19 · P5】回退原因分型计数：过去只统计"总共回退了多少条"，不区分原因（显式失败/空输出/
//   没变短/预算到顶/值保真闸拒收），导致"大量静默回退"无从排查（用户实证报告 P5）。现分五类计数，
//   随 stat 一起写进 last-fold（`fallbackReasons`）与折叠日志。
function fbBump(io, kind) {
  try { if (io && io.fb) io.fb[kind] = (io.fb[kind] ?? 0) + 1 } catch { /* ignore */ }
}
// 【v1.10.21 · 诊断】K 通道失败归因：`keysErr` 一个计数混了两种完全不同的病因 ——
//   (a) 调用本身失败（无服务/路由/凭证/超时）  (b) 调用成功但 dedupeKeys 认为"没有一个合格值"。
//   两者修复方向相反（修路由 vs 修提示词/闸门），故必须分开记，否则会一直误诊。
function kd(io, kind, extra) {
  try { if (io && Array.isArray(io.kd)) io.kd.push(extra == null ? kind : kind + ':' + extra) } catch { /* ignore */ }
}
// v1.8：优先 DSH 已注册模型（io.route），其次显式配置的 Ollama 直连，都不行 → null（回退无损）
// 【v1.10.19 · P3 修复】`io.llm` = 折叠开始时**固化**的 llm 服务句柄（见 foldBody）。为什么必须固化：
//   后台折叠（turn-stopping 触发的异步任务）跑到一半时，请求作用域的 ctx 可能已被回收 ⇒
//   每次调用都重新 `llmOf(ctx)` 会越跑越取不到服务（实测：single 每条 [A] 1 次调用 1/12 失败，
//   double 每条 [A] 2 次调用 **12/12** 失败，且调用越慢失败率越高 —— 典型的"句柄在折叠进行中失效"）。
//   固化后：优先用句柄；句柄为空才回退到实时解析（行为不变，只是不再随作用域回收而丢失）。
async function condenseText(text, io) {
  const body = String(text).trim()
  if (body.length < minBytesOf(io)) { fbBump(io, 'tooShort'); return null }
  // 【v1.10.23 · 经济性准入】字节门槛之上再加一道**回本**闸：预计回本回合 m* 超过允许视界就
  //   **不发起调用**（一分钱不花），记 `payback` 走无损折叠。这是**外生**判定（花钱之前，用预估成本）；
  //   实际花费由 paybackMeasured 事后核验并写进 last-fold，便于把"预估 vs 实付"对上。
  const horizon = Number.isFinite(io?.paybackHorizon) ? io.paybackHorizon : PB_HORIZON
  const pbEst = paybackOf(body.length)
  if (io) io.pbEst = pbEst
  if (horizon > 0 && pbEst.turns > horizon) {
    fbBump(io, 'payback')
    if (io) { io.pbSkip = (io.pbSkip ?? 0) + 1; io.pbHorizon = horizon }
    return null
  }
  const run = _condChain.then(async () => {
    const mx = effectiveMaxTokens(body.length, io && io.maxTokens)
    const condenseSys = (io && io.condenseSys) || CONDENSE_SYS // #10 可自定义提示词
    const meta = {}
    const a0 = io?.aux ? { ...io.aux } : null
    const viaDsh = await llmText(io?.ctx, io?.route, condenseSys, '原文：\n' + body + '\n\n——\n浓缩：', mx, (r) => pushErr(io, r), io?.llm, { effort: effortOf(io), salvage: true, meta, usageSink: io?.aux })
    // 事后核验：本次调用真实花了多少（含失败——失败也付费），以及据此算出的实测回本回合
    if (io && a0 && io.aux && io.aux.calls > a0.calls) {
      const d = { calls: io.aux.calls - a0.calls, in: io.aux.in - a0.in, cacheRead: io.aux.cacheRead - a0.cacheRead, out: io.aux.out - a0.out }
      io.pbLast = { ...d, ...paybackMeasured(d, body.length, viaDsh ? viaDsh.length : 0), horizon, split: '1x' }
    }
    if (viaDsh) {
      const c = viaDsh.trim()
      // 回退判据不变：空输出 / 未缩短（弱模型偶尔复读原文）→ 视为浓缩失败，走无损
      if (!c) fbBump(io, 'empty')
      else if (c.length >= body.length) fbBump(io, 'noShrink')
      else if (meta.truncated) {
        // 【v1.10.20 · P2】截断抢救的两道闸：缩短达标 + 无半截占位符。任一不过 ⇒ 记 truncated 并回退无损。
        if (c.length > body.length * SALVAGE_MAX_RATIO || DANGLING_PLACEHOLDER_RE.test(c)) fbBump(io, 'truncated')
        else { fbBump(io, 'salvaged'); return c }
      } else return c
    } else {
      // P5 分型：把"为什么没拿到浓缩结果"记清楚，别都堆成一句 llmErr。
      //   · finish=max-tokens ⇒ `truncated`（P1 的症状：额度不够、被截断）
      //   · empty output     ⇒ `empty`（模型正常 stop 但没吐字）
      //   · 其余（无服务/路由/流错误/超时）⇒ `llmErr`
      const last = String((io?.errs ?? [])[(io?.errs ?? []).length - 1] ?? '')
      fbBump(io, /max-tokens/.test(last) ? 'truncated' : (/empty output/.test(last) ? 'empty' : 'llmErr'))
    }
    if (!LOSSY_OLLAMA) return null // 未显式配置直连通道 → 到此为止，无损回退
    const r = await fetch(LOSSY_OLLAMA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOSSY_MODEL,
        messages: [{ role: 'system', content: ((io && io.condenseSys) || CONDENSE_SYS) }, { role: 'user', content: '原文：\n' + body + '\n\n——\n浓缩：' }],
        stream: false, temperature: 0,
        options: { num_ctx: 16384 }, max_tokens: mx,
      }),
      signal: AbortSignal.timeout(LOSSY_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const j = await r.json().catch(() => null)
    if (!j) return null
    const c = (j.choices?.[0]?.message?.content ?? '').trim()
    if (!c || c.length >= body.length) return null
    return c
  }).catch(() => null) // 模型不可用/超时 → 回退无损，折叠不中断
  _condChain = run.then(() => {}, () => {})
  return run
}
// double 档第二轮：载荷直抄清单（null = 无载荷/失败，不并入）
// 【v1.10.22 · 并发双通道】opts.parallel=true ⇒ **不排队、立即发起**。
//   为什么这是关键：`extractKeys` 消费的是**原文**（不是浓缩产物），与浓缩无数据依赖；
//   而"折叠内第 2 次调用必失败(NO_ADAPTER)"的根因是两次调用之间作用域被回收。
//   把 K 与同一条消息的第 1 次浓缩调用**在同一存活窗口内并发发起**，即可结构性绕开该约束。
async function extractKeys(text, io, opts) {
  const body = String(text).trim()
  if (body.length < minBytesOf(io)) return null
  const work = async () => {
    const mx = effectiveMaxTokens(body.length, io && io.maxTokens)
    const keysSys = (io && io.keysSys) || KEYS_SYS // #10 可自定义载荷提示词
    // 【v1.10.20 · P0】K 通道同样关掉思维链（它和浓缩是同一类"只删不改/逐字摘抄"任务，推理无收益）。
    //   【P2】但 K 通道**不开**截断抢救：截断会切在某个值中间，产出一个"半个值"，
    //   而本插件的既定原则是"错误载荷比丢失更糟" ⇒ K 通道截断仍整条判失败。
    const viaDsh = await llmText(io?.ctx, io?.route, keysSys, '原文：\n' + body + '\n\n——\n载荷清单，一行一个：', mx, (r) => pushErr(io, r), io?.llm, { effort: effortOf(io), usageSink: io?.aux })
    if (viaDsh) {
      const lines = dedupeKeys(viaDsh)
      if (lines) { kd(io, 'ok', viaDsh.length + '->' + lines.split('\n').length); return lines }
      kd(io, 'noValues', viaDsh.length) // 调用成功、但闸门判定无合格值（≠ 调用失败）
    } else {
      kd(io, 'callFailed', String((io?.errs ?? [])[(io?.errs ?? []).length - 1] ?? '').slice(0, 120))
    }
    // 【v1.10.19 · P2/P5】K 通道失败单独计数：真机上 `keys` 恒为 0 却看不出原因（用户实证报告 P2）——
    //   现在它会明确记成 `keysErr`，与"整条 [A] 回退"分开，便于定位（P3 修好后本计数应回到 0）。
    fbBump(io, 'keysErr')
    if (!LOSSY_OLLAMA) return null
    const r = await fetch(LOSSY_OLLAMA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOSSY_MODEL,
        messages: [{ role: 'system', content: ((io && io.keysSys) || KEYS_SYS) }, { role: 'user', content: '原文：\n' + body + '\n\n——\n载荷清单，一行一个：' }],
        stream: false, temperature: 0,
        options: { num_ctx: 16384 }, max_tokens: mx,
      }),
      signal: AbortSignal.timeout(LOSSY_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const j = await r.json().catch(() => null)
    if (!j) return null
    const lines = dedupeKeys(j.choices?.[0]?.message?.content ?? '')
    return lines || null
  }
  // parallel：立即发起，**不**占用 _condChain（否则会排在浓缩之后，等于没并发）；也不改写链尾。
  const par = !!(opts && opts.parallel)
  const run = (par ? Promise.resolve().then(work) : _condChain.then(work)).catch(() => null)
  if (!par) _condChain = run.then(() => {}, () => {})
  return run
}
// 值保真闸（e2e double 实测教训）：弱 4B 会把 branchID=e7b40c73 截断成 e7b4073、并幻觉 e7b40c77。
// 错误载荷比丢失更糟——规则级校验，不依赖模型自觉：浓缩/直抄中的"承重 token"若在原文不存在，
// 判定为改值/幻觉 → 该 [A] 整体回退无损（宁不压缩，不可传错值）。
const PAYLOAD_CHECK = [
  /[0-9a-f]{6,}/gi, // uuid 段 / 长 hex / 8 位短 id（e7b4073、e7b40c73 均命中）
  /\b[A-Za-z0-9_.-]+\.(?:txt|json|md|log|yml|yaml|jsonl|zstd|mjs|js|ts|csv|png|jpg|zstd)\b/gi, // 文件名
  /\b[A-Z][A-Z0-9_]{3,}\b/g, // 大写状态/标记词（CLEANUP_OK）
  /https?:\/\/[^\s]+/gi, // 链接
  /\b\d{3,}(?:\.\d+)?\b/g, // 端口/大数/比率（8787、0.31；2 位小计数不核对，降误报）
]
// 整词出现校验：token 必须在原文以"完整值"出现（两侧不是可延续字符）——
// 否则 token 可能是被截断的前缀（port=878 是 port=8787 的前缀），判假。
function occursWhole(source, token) {
  const src = String(source ?? '').toLowerCase()
  const k = String(token ?? '').toLowerCase()
  if (!k) return false
  let i = 0
  while ((i = src.indexOf(k, i)) !== -1) {
    const before = src[i - 1] || ''
    const after = src[i + k.length] || ''
    if (!/[a-z0-9_.@]/.test(before) && !/[a-z0-9_.@]/.test(after)) return true
    i += k.length
  }
  return false
}
function verifyAgainstSource(condensed, source) {
  for (const re of PAYLOAD_CHECK) {
    for (const m of String(condensed ?? '').match(re) || []) {
      if (!occursWhole(source, m)) return false
    }
  }
  return true
}
// 处理增量行：仅 [A] 行浓缩；失败回退原文。
// single = 语义浓缩；double = 语义浓缩 + 载荷直抄（去重并入 [A] 行，不新增行类，保五类行纪律）
// 弱模型只接触 guard 化文本（值→占位符），浓缩后规则回填 → 值不可能被改/截断/幻觉。
const A_LINE_RE = /^\[A\] /
async function applyCondense(rows, mode = 'single', io = null) {
  const stat = { a: 0, folded: 0, fallback: 0, keys: 0, rawBytes: 0, outBytes: 0 }
  // 【默认与 RCS-0.1.0 对齐 · 2026-09-10】值保真闸 `verifyAgainstSource` 默认**关闭**：
  //   RCS 实测三类误杀（`README.md → 伪 token README`；URL 贪婪吞中文标点；`0.111.0 → 伪 token 111.0`）
  //   会让整条 [A] 白退化成无损回退、白花一次模型调用。
  //   本仓库保留这个安全网，但改为**按 control 显式开启**：`control.payloadCheck === true` 时恢复
  //   旧严格语义（弱模型改值 ⇒ 整段回退）。guardText/restoreText 占位符化与 occursWhole 关键值过滤
  //   在任何档位下都照旧生效，故"值被改坏"仍有第一道防线。
  const pc = !!(io && io.payloadCheck === true)
  // 【v1.10.3 硬预算】一次折叠必须有上限：本地小模型下 double 档每条 [A] 要两次调用、长行还会分块，
  //   实测出现过单次折叠 243 秒把用户的下一轮请求整个堵住。这里给浓缩阶段两道硬闸：
  //   · condenseBudgetMs：墙钟预算（默认 15000ms），超时后**不再发起新调用**，剩余 [A] 走无损回退；
  //   · condenseMaxCallsPerFold：调用次数上限（默认 12），防止单次调用极慢时仍然堆叠。
  //   两者都由 control 热读，折叠照常提交（转录保持单调），只是没来得及浓缩的行原样保留。
  const budgetMs = Number.isFinite(io && io.budgetMs) && io.budgetMs >= 0 ? io.budgetMs : 15000
  const maxCalls = Number.isFinite(io && io.maxCalls) && io.maxCalls >= 0 ? io.maxCalls : 12
  const t0 = Date.now()
  let foldCalls = 0
  let budgetHit = false
  const out = []
  for (const line of rows) {
    if (!A_LINE_RE.test(line)) { out.push(line); continue }
    stat.a++
    const body = line.slice(4)
    // 硬预算：超时或超次数 ⇒ 本行不再送模型，按无损路径保留原文（与浓缩失败同一出口）
    if (foldCalls >= maxCalls || (budgetMs > 0 && Date.now() - t0 > budgetMs)) {
      budgetHit = true
      fbBump(io, foldCalls >= maxCalls ? 'maxCalls' : 'budgetMs')
      out.push(line); stat.fallback++; stat.outBytes += body.length; continue
    }
    stat.rawBytes += body.length
    const g = guardText(body) // guard：uuid/hex/路径 → 占位符，不入模型上下文
    // 【v1.10.22 · 并发双通道（double 重设计）】K 通道消费的是**原文** g.text，与浓缩产物无数据依赖,
    //   故在此处（本行第一次调用发起之前）就把 K 调用**并发发出**：两者落在同一个作用域存活窗口内。
    //   这直接针对实测根因——串行时 K 总是"折叠内第 2 次调用"，而第 2 次调用 12/12 以
    //   `NO_ADAPTER: no adapter registered` 失败（两次调用之间作用域已回收）。
    //   代价：放弃 _condChain 的全局排队（K 不再等浓缩），换来 K 通道可用。
    let pKeys = null
    if (mode === 'double') {
      // 只在**本行确实会发起调用**时才占用名额：minBytes 未过 ⇒ extractKeys 内部会立即返回 null，
      //   若仍 `foldCalls += 1`，就会让"免付费的短行"白吃 maxCalls 预算并虚高 `calls` 统计。
      if (g.text.length < minBytesOf(io)) { /* 短行：K 与浓缩都不会调用，不记账 */ }
      // 预留 2 个名额（本条浓缩 + 本条 K），保证并发之后 `calls` 仍不会越过 maxCalls 硬闸。
      else if (foldCalls + 2 > maxCalls) fbBump(io, 'keysSkippedBudget')
      else { foldCalls += 1; pKeys = extractKeys(g.text, io, { parallel: true }) }
    }
    // #8 分块：单块输入超预算时按语义断点切块、逐块浓缩再拼接（chunkForCompressor，纯规则）。
    // 预算 maxChars ≈ io.maxTokens×4 字符（token→字符粗略系数；守卫只防"一段塞爆窗口"，非精确）。
    const maxChars = Math.max(512, (io && io.maxTokens ? io.maxTokens : LOSSY_MAX_TOKENS) * 4)
    let text = null
    if (g.text.length > maxChars) {
      const chunks = chunkForCompressor(g.text, maxChars, { allowHardCut: true })
      const parts = []
      let ok = true
      for (const ch of chunks) {
        foldCalls += 1
const cRaw = await condenseText(ch, io)
        const c = cRaw ? restoreText(cRaw, g.slots) : null
        if (!c || (pc && !verifyAgainstSource(c, body))) { ok = false; if (c && pc) fbBump(io, 'payloadGate'); break }
        parts.push(c)
      }
      if (ok && parts.length) text = parts.join('\n')
    } else {
      foldCalls += 1
const acRaw = await condenseText(g.text, io)
      const ac = acRaw ? restoreText(acRaw, g.slots) : null
      if (ac && (!pc || verifyAgainstSource(ac, body))) text = ac
      else if (ac && pc) fbBump(io, 'payloadGate')
    }
    if (text == null) { out.push(line); stat.fallback++; stat.outBytes += body.length; continue } // 浓缩失败/非规则值被改 → 无损回退
    stat.folded++
    // 【v1.10.22】K 调用已在上面并发发出（pKeys）；此处只做**等待 + 收编**，不再发起新调用。
    //   旧实现（串行）：`if (foldCalls >= maxCalls) skip else { foldCalls+=1; await extractKeys(...) }`
    //   —— 那正是"第 2 次调用"的成因。次数与预算记账已在发起处完成，语义不变。
    if (mode === 'double' && pKeys) {
      const keys = await pKeys
      if (keys) {
        // 模型若抄占位符行（违背 prompt）整行弃；直抄值必须以整词出现在原文（剔幻觉/截断/前缀）
        const ks = keys.split('\n').map((x) => x.trim()).filter(Boolean)
          .filter((k) => !/⟦[A-Z]+\d+⟧/.test(k))
          .filter((k) => occursWhole(body, k))
          .filter((k) => !text.includes(k))
        if (ks.length) { text = text + '  [关键值] ' + ks.join('；'); stat.keys += ks.length }
      }
    }
    out.push('[A] ' + text)
    stat.outBytes += text.length
  }
  stat.calls = foldCalls; stat.ms = Date.now() - t0; stat.budgetHit = budgetHit
  // 【v1.10.19 · P5】回退原因分型（只统计非零项，避免污染 last-fold）
  // 【v1.10.20 · P2】`salvaged` 单列进 stat：它是**成功**（换了条路拿到可用的浓缩结果），
  //   不是回退，混进 fallbackReasons 会让人误读成"又回退了几条"。
  if (io && io.fb) {
    const fb = {}
    for (const [k, v] of Object.entries(io.fb)) if (v > 0 && k !== 'salvaged') fb[k] = v
    if (Object.keys(fb).length) stat.fallbackReasons = fb
    if (io.fb.salvaged > 0) stat.salvaged = io.fb.salvaged
  }
  // 生效推理档位随 stat 一起上浮：persistLastFold 的两处字面量位于声明 `ioc` 的那个块**之外**，
  //   在那里直接引用 ioc 会抛 `ioc is not defined` 并让**整次折叠**失败（已踩过一次）。
  //   挂在 stat 上既保证作用域正确，也保证"写进日志的档位"与"实际下发的档位"同源。
  stat.condenseReasoningEffort = effortOf(io)
  // 【v1.10.21】K 通道归因随 stat 上浮（同 condenseReasoningEffort 的理由：persistLastFold 在 ioc 作用域之外）
  if (io && Array.isArray(io.kd) && io.kd.length) stat.keysDiag = io.kd.slice(0, 12)
  // 【v1.10.23 · 经济性计量】把辅助调用**真实用量**与**回本回合**上浮到 last-fold。
  //   此前"压缩花了多少钱"在插件侧完全不可见（usage 分块被丢掉、bench 的 billed 也只统计会话内
  //   assistant 事件），只能靠估；现在预估（paybackEst）与实测（paybackMeasured）**并列落盘**，
  //   便于验证估值模型本身准不准。
  if (io && io.aux && io.aux.calls) {
    stat.auxCalls = io.aux.calls
    stat.auxTokens = { in: io.aux.in, cacheRead: io.aux.cacheRead, out: io.aux.out }
    stat.auxBilled = Math.round(io.aux.in + io.aux.cacheRead * PB_CACHE_DISCOUNT + io.aux.out)
  }
  if (io && Number.isFinite(io.paybackHorizon)) stat.paybackHorizon = io.paybackHorizon
  if (io && io.pbSkip) stat.paybackSkipped = io.pbSkip
  if (io && io.pbEst) stat.paybackEst = Math.round(io.pbEst.turns * 10) / 10
  if (io && io.pbLast && Number.isFinite(io.pbLast.turns)) stat.paybackMeasured = Math.round(io.pbLast.turns * 10) / 10
  return { rows: out, stat }
}
// raw 权威存证：被遮蔽节点（本次 fold 的增量段）原文全量追加落盘，供回放/审计/有损后的无损恢复
const sanitizeSid = (s) => String(s ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
function rawAppend(sid, entries) {
  try {
    if (!entries || entries.length === 0) return
    // 【v1.10.25】只存**原料**：单段模式下"上一版转录节点"的事件 seq 落在日志尾部 ⇒ 必然落在本次增量里
    //   （见增量集合处的注释），于是它的**全文（数十 KB）每次折叠都被当成"被遮蔽原文"再存一遍**。
    //   实测（付费跑批 A01-off-1）：raw 存证 2,350,121B 里 1,908,405B 是**我们自己的转录**（62 行/63 折），
    //   真正的原料只有 223,038B ⇒ 存证体积 ~10× 虚高，且任何"把 raw 当原文来统计"的分析都会
    //   把转录重复计入 62 次（这与"重复注入 29 次"的误判同源）。转录是 raw 的**派生物**，不该回灌自己。
    const material = entries.filter((e) => !(e?.msg && isOwnTranscript(e.msg)))
    if (material.length === 0) return
    const fp = join(RAW_DIR, sanitizeSid(sid) + '.jsonl')
    const body = material.map((e) => JSON.stringify({ t: Date.now(), seq: e.seq, msg: e.msg })).join('\n')
    appendFileSync(fp, body + '\n', 'utf8')
  } catch (err) {
    console.error('[contextinjector] raw append failed:', err?.message ?? err)
  }
}

export default {
  name: 'CONTEXTinjector',
  apply(ctx) {
    console.log(`[CONTEXTinjector] armed (${PLUGIN_VERSION}; threshold=${THRESHOLD}%; out=${OUT_FILE || '-'}; stateDir=${STATE_DIR})`)
    // 诊断行显示**生效值**而非原始字段（2026-09-10 默认翻转后，旧文案会谎报 "default OFF"）
    const _kiCtrl = readControl()
    const _kiEff = keepInjectOn('control', _kiCtrl)
    console.log(`[CONTEXTinjector] keepInject(v1.6): env=${KEEP_INJECT_ENV ?? '-'} control=${_kiCtrl?.keepInject ?? '-'} ⇒ ${_kiEff ? 'ON（避让 DSH 注入节点 ⇒ 快照零补发）' : 'OFF（v1.5 路径：会遮蔽注入节点 ⇒ DSH 每轮补发快照）'} [默认 ON；env=0 或 control.keepInject=false 可关闭]`)
    console.log(`[CONTEXTinjector] gate priority: test=${TEST_ROUND ? 1 : 0} env=${ENABLED ? 1 : 0} else ${CONTROL_FILE} whitelist (default OFF)`)
    // #6 折叠时机：**不缓存生效值**——与本模块其它 control 项（keepInject/condenseMinBytes/prompts）同规矩，
    //   每次触发现读 control.json，改档无需重启（生效值的时点在这里无法断言 gate，故不谎报 ON/OFF）。
    console.log(`[CONTEXTinjector] fold timing(#6): turn-stopping(后台折，缺省 ON) + pre-step(join，超时 ${FOLD_JOIN_TIMEOUT_MS}ms) | env DSH_CONTEXTINJECTOR_FOLD_AT_TURN_END=${FOLD_AT_TURN_END_ENV ?? '-'} / DSH_CONTEXTINJECTOR_FOLD_JOIN_MS=${process.env.DSH_CONTEXTINJECTOR_FOLD_JOIN_MS ?? '-'} | control.foldAtTurnEnd / control.foldJoinTimeoutMs 热读（=false / env=0 恢复"仅 pre-step 折"）`)
    const ctrl0 = readControl()
    console.log(`[CONTEXTinjector] condense modes: off|single|double; env=${ENV_MODE || '-'} (v1.9: no global default — sessionModes authoritative; control-gated sessions without a mode do NOT fold); minBytes=${LOSSY_MIN_BYTES}(default; control.condenseMinBytes overrides live); rawDir=${RAW_DIR}`)
    // v1.8 浓缩模型通道自检（软取，不影响装载）：无 llm 服务时 single/double 自动回退无损折叠
    const llm0 = llmOf(ctx)
    const forced0 = ctrl0?.condenseProvider && ctrl0?.condenseModel ? `${ctrl0.condenseProvider}/${ctrl0.condenseModel}` : '-'
    console.log(`[CONTEXTinjector] condense model(v1.8): llm-service=${llm0 ? 'available' : 'ABSENT'} route=${forced0 === '-' ? 'follow-session' : forced0} ollama-direct=${LOSSY_OLLAMA ? 'on' : 'off'}`)
    // 注意：不再提前 return——钩子始终注册，启停由运行时门控逐 step 判定（支持 WebUI 开关/session 白名单，无需重启）

    // 折叠状态必须按会话隔离：真实 WebUI 一个进程同时服务多个会话，
    // 进程级单例会把某会话的 foldText 接进另一会话的转录（触发不稳定 + 伪历史）。
    const sessionStates = new Map() // sid -> { foldSeq, foldText, foldRound, foldedOnce, segCount, lastSegSeq }
    function stateOf(sid) {
      const key = sid ?? '__unknown__'
      let s = sessionStates.get(key)
      // segCount/lastSegSeq（v1.10.13 多段转录）：段号与上一段起点 seq（段头据此编号、标明承接关系）
      if (!s) { s = { foldSeq: -1, foldText: '', foldRound: 0, foldedOnce: false, segCount: 0, lastSegSeq: -1 }; sessionStates.set(key, s) }
      return s
    }

    // ── 折叠主体（pre-step 与 turn-stopping 共用）【#6 压缩时机提前，取自 RCS-0.1.0】─────
    // 把原 pre-step 内联的折叠逻辑整体抽成函数，两个触发点复用同一套
    //   边界计算（closedPrefixEnd）/ 注入避让（keepInject）/ pairSplitIds 跨界守卫 /
    //   extreason 转录 / 浓缩调用。返回 {folded, reason, ...}。
    // ⚠ 契约：本函数**绝不抛**（内部已 try/catch），调用方无需再包一层；**不调用** next()。
    //
    // 【在飞标记生命周期收口】外层 foldAttempt 只做一件事：入口写标记、finally 删标记，然后转交 foldBody。
    //   为什么必须在这里而不是调用方：pre-step 是**直接调用**本函数的（见触发点 1），turn-stopping 才经
    //   scheduleFold 排队——旧实现把写/删放在 scheduleFold 里 ⇒ pre-step 折（用户的实际路径）永无标记。
    //   放这里则任何触发点、任何提前 return / 抛错 / 被 abort 都自动覆盖，调用方无需（也**不得**）自己写删。
    //   标记始终是 best-effort：enterFoldInflight / exitFoldInflight 内部全 try/catch，绝不影响折叠本身。
    async function foldAttempt(args) {
      enterFoldInflight(args) // 入口即"压缩中"：含真实 trigger / step / startedAt
      try {
        return await foldBody(args)
      } catch (err) {
        // 【v1.10.7（协作 r9 ★必须-4 建议）】foldBody 抛错过去**只经 finally 冒泡**：既不落痕，又让两个
        //   触发点（pre-step 直调 / turn-stopping 排队）同时全灭——v1.10.5 的 TDZ 正是这样让折叠静默停摆。
        //   现在一律记账并降级为"本次不折"，绝不静默：reason=error 且带 err 文本。
        const msg = String(err?.message ?? err)
        console.error(`[contextinjector] fold-attempt-error trigger=${args?.trigger ?? '-'} sid=${args?.sid ?? '-'} err=${msg}`)
        // ★必须-9（协作 r11）：log() 在不配 OUT_FILE 时是空操作，故异常降级必须另落**可审计文件**。
        try {
          const errDir = join(STATE_DIR, '.ctxinjector', 'fold-errors')
          mkdirSync(errDir, { recursive: true })
          appendFileSync(join(errDir, sanitizeSid(String(args?.sid ?? 'unknown').replace(/^session-?/i, '')) + '.jsonl'), JSON.stringify({ t: Date.now(), trigger: args?.trigger ?? null, sid: args?.sid ?? null, step: args?.stepNo ?? null, err: msg }) + '\n', 'utf8')
        } catch { /* ignore */ }
        try { log('fold-attempt-error', { trigger: args?.trigger ?? null, sid: args?.sid ?? null, err: msg }) } catch { /* ignore */ }
        return { folded: false, reason: 'error', error: msg }
      } finally {
        exitFoldInflight(args?.sid) // 成功 / 失败 / 提前 return / 异常：一律在这里熄灭
      }
    }
    // 折叠主体（pre-step 与 turn-stopping 共用，语义与旧 foldAttempt 逐字一致，仅改名以免与上面那层混）
    async function foldBody({ session, surface, sid, ctrl, gate, stepNo, turn, claimed, trigger }) {
  // 仅测试：让 harness 能走一次真实异常路径（验证 ★必须-9 的错误账本确实落盘）
  if (process.env.DSH_CONTEXTINJECTOR_THROW_TEST === '1') throw new Error('harness-injected-fold-error')
      const st = stateOf(sid)
      // v1.10 重启续传：本进程首见该会话且未折叠过 → 尝试从 surface 的自身折叠节点回填状态
      if (gate !== 'off' && st.foldText === '' && st.seedChecked !== true) {
        st.seedChecked = true
        seedFoldState(session, surface, st)
      }
      // 【v1.10.6（协作 r7 §1 纠正）】本次折叠**前**的转录累计行数——必须
      //   ① 在 `st` 取到之后（此前引用 foldText 会落进 TDZ：`let foldText` 在下方几行才声明，
      //      抛 ReferenceError，而 node --check 只查语法、抓不到这类运行时错误；foldAttempt 只有
      //      finally 没有 catch ⇒ 异常冒泡 ⇒ **每一次折叠都会死**，pre-step 与 turn-stopping 全灭）；
      //   ② 在 seedFoldState **之后**（seed 会改写 st.foldText；回填后的值才是本次折叠据以增量的基线，
      //      也才满足"foldText 是每会话单调前缀状态"的语义）；权威来源是 `st.foldText` 而不是局部 `foldText`。
      const cumLinesBeforeEntry = st.foldText === '' ? 0 : st.foldText.split('\n').length
      // handler 局部副本：每次触发从该会话状态载入；折叠成功后写回（多会话不串扰）
      let foldSeq = st.foldSeq, foldText = st.foldText, foldRound = st.foldRound, foldedOnce = st.foldedOnce
      if (TEST_ROUND && foldedOnce) return { folded: false, reason: 'test-once' } // 回归模式单次折叠（实证 P/S 同语义）

      // —— round 边界（或回归模式闭合前缀）：把已闭合前缀折叠为转录消息 ——
      const nodes = [...surface.nodes] // surface.nodes = seq 列表
      const entries = nodes.map((seq) => ({ seq, msg: session.deriveEventMessage(evAt(session, seq)) }))
      // 【v1.10.17】中止一轮会留下"悬空 tool-call"（call 在 surface、结果永不到来）。旧行为把它当未闭合
      //   ⇒ 该轮及其后所有内容都进不了遮蔽集 ⇒ **整个会话的折叠冻结**（真机复现 + abort-turn.test 第 3 例：
      //   用户报"终止过 AI 输出，再发消息，这一轮的大段输出也不压缩了"）。
      //   现按"该轮是否已结束（其后有 turn/end）"判定：已结束 ⇒ 结果确定不会来 ⇒ 允许跨越；
      //   仍在飞 ⇒ 保持保守（结果晚到就成孤儿 tool-result，会 INVALID_REQUEST —— v1.6 的事故）。
      const deadCalls = collectDeadCalls(entries, session)
      let end = closedPrefixEnd(entries.map((e) => e.msg), { deadCalls })
      if (end < 0) return { folded: false, reason: 'no-closed-prefix' } // 尚无闭合前缀（首轮未产生 assistant↔tool 闭合），留给下一轮
      const ki = keepInjectOn(gate, ctrl) // v1.6 注入节点避让：快照始终在场 → 零 policy 补发
      // 遮蔽区间排除末端注入型节点（最新 runtime/policy 快照保留在 surface）——保转录纯度；
      // v1.6（ki）用精确判定（自身转录消息可遮蔽、只剔 DSH 注入）；v1.5 兼容用旧语义（任何 plugin user）
      const injTest = ki ? isDshInjected : isInjectedUser
      while (end >= 0 && injTest(entries[end].msg)) end -= 1
      if (end < 0) return { folded: false, reason: 'tail-injected' }

      let shadowed = entries.slice(0, end + 1).filter((e) => e.msg !== null && !isSystemNode(e.msg))
      // 轮号状态必须在 head 转录**之前**建立：head（首轮 user）先占 [ROUND] 1，增量行随后续号。
      const roundState = { n: foldRound }
      let headRows = []
      let headSeqs = []
      let headEntries = [] // v1.10.13：head 原始节点（多段转录下 head 也要被遮蔽，需要它们的原始字节计量）
      if (ki) {
        // 遮蔽候选截断在"最后一个 DSH 注入节点之后"：注入节点保持原位 seq（永不遮蔽），
        // 只遮蔽其后普通节点（含自身旧转录消息）→ runtime 快照始终在场 → DSH 不补发。
        // 首个 runtime 注入通常紧跟首条 user；修复后 DSH 不再新增注入 → 截断起点跨轮稳定，
        // 遮蔽内容 ≈ 几乎全部历史。
        // 【v1.10.1 修复】被截掉的那段（注入**之前**的普通节点 = 首条 user）过去既不被遮蔽、也不被
        //   转录 ⇒ 转录从第 2 轮起（面板显示 ROUND 1 = 第二条消息）。现按 foldHeadTranscript 的契约
        //   在首次折叠时"只转录不遮蔽"补录一次；注入节点本身仍绝不进 head/tail（keepInject 不变）。
        const ht = foldHeadTranscript(shadowed, foldText !== '', roundState, { structured: ctrl?.toolfoldStructured === true })
        headRows = ht.rows
        headSeqs = ht.head.map((e) => e.seq)
        headEntries = ht.head
        if (ht.hadInject) {
          shadowed = ht.tail
          if (shadowed.length === 0) return { folded: false, reason: 'nothing-after-inject' } // 注入之后无普通节点可折（留给下一轮）
        }
      }
      // 【v1.10.14 · 多段转录（control.segments，默认关）】开关必须在这里就读出来：下面的增量集合算法要分叉。
      const segmentsOn = !!(ctrl && ctrl.segments === true)
      // 增量集合 = "上次折叠之后要转录的节点"：
      //   单段（默认）：按 seq 判（`seq > foldSeq`）—— 旧转录节点的事件 seq 在日志**尾部**，
      //     必然被圈进来；旧行为正需要如此（它会被本次 replace 覆盖成"旧文本+新行"的累加转录）。
      //   多段（segments）：**必须按位置判**（"最后一个自身段节点之后"）。原因（真机实测事故，见下）：
      //     段节点若被圈进增量，本次 replace 就会**把上一段整段吃掉**。
      //     【真机证据 2026-09-10 session-215290cd，包 0.1.9】折叠 1 落两段（head@7 + 段1@9），
      //     段 1 的事件 seq = 74（日志尾部）；折叠 2 的增量 `seq > foldSeq(9)` ⇒ 圈进了 74，
      //     replace 区间 = [74..139] ⇒ 段 1 从 surface 消失 ⇒ 表面只剩 head+段2（760B），
      //     而 foldText = head+段1+段2（1192B）⇒ 漂移守卫连拒四次（fold-errors: ownBytes=760 foldBytes=1192），
      //     该会话折叠停摆。⇒ 判据必须是**位置**，不是 seq。
      let incremental = shadowed.filter((e) => e.seq > foldSeq) // 单调在场：只转录上次折叠后的新节点
      if (segmentsOn) {
        let lastOwnIdx = -1
        for (let i = 0; i < shadowed.length; i++) if (shadowed[i].msg && isOwnTranscript(shadowed[i].msg)) lastOwnIdx = i
        incremental = shadowed.slice(lastOwnIdx + 1) // 只覆盖"最后一个段节点之后"：既有段全部留在表面
      }
      if (shadowed.length === 0 || incremental.length === 0) return { folded: false, reason: 'no-increment' }
      // 【#4 守卫（取自 RCS-0.1.0 返回包）】跨界配对检查：遮蔽集与尾部之间不得切分
      //   tool-call↔tool-result 配对，否则 surface 出现孤儿 tool 消息 → INVALID_REQUEST
      //   （与 §13 同源风险区）。不安全 → 延后本次折叠（下一轮再试），绝不提交切分配对。
      try {
        const tailMsgs = entries.slice(end + 1).map((e) => e.msg).filter(Boolean)
        const split = pairSplitIds(shadowed.map((e) => e.msg), tailMsgs)
        if (split.length > 0) {
          console.log(`[contextinjector] fold-deferred-orphan trigger=${trigger} step=${stepNo} turn=${turn} ids=${split.slice(0, 3).join(',')} n=${split.length} (pair split; defer to next round)`)
          return { folded: false, reason: 'pair-split' }
        }
      } catch { /* 守卫失败不阻断主链 */ }

      const newRows = transcribeIncremental(incremental.map((e) => e.msg), roundState, { structured: ctrl?.toolfoldStructured === true })
      if (newRows.length === 0) return { folded: false, reason: 'no-rows' }
      // condense 档：mode=off|single|double。只对增量内新 [A] 浓缩（[U]/[T]/[ROUND] 不动），
      // 失败回退无损。旧 transcript 绝不回写：condense 只作用于本次增量。
      const mode = condenseMode(gate, ctrl, sid)
      if (mode === null) {
        // v1.9：全局默认档已废止——control 门控会话未设本会话档（sessionModes）⇒ 不折叠。
        // 经 composer 选档（off/single/double）后才会折叠；none = 移出白名单并清档。
        console.log(`[contextinjector] no-mode skip trigger=${trigger} step=${stepNo} turn=${turn} sid=${sid} (whitelisted but no per-session mode; no global default)`)
        return { folded: false, reason: 'no-mode' }
      }
      let stat = null
      let finalRows = newRows
      let condenseRoute = null // v1.8：本次折叠实际使用的浓缩模型路由（记入 last-fold 供核验）
      let condenseErr = null // v1.9：浓缩模型调用失败原因（上浮 last-fold → WebUI 展示；质量性回退不在此列）
      let condenseErrKind = null // #9：对 condenseErr 分型（enum），供 WebUI 如实展示错误类别
      if (mode !== 'off') {
        // 【v1.10.19 · P3 修复】在**最早的时刻**固化 llm 句柄（此刻 ctx 一定还活着：本函数由 turn-stopping
        //   handler 同步起头，handler 返回后作用域才可能被回收）。后台折叠跑到一半时请求作用域可能已被
        //   回收 ⇒ 每次重新 llmOf(ctx) 会越跑越取不到服务（实证：double 每条 [A] 的第 2 次调用 12/12 失败，
        //   而第 1 次成功；调用越慢失败率越高）。固化后随 ioc 一路带下去，不再随作用域回收而丢失。
        const llmFixed = llmOf(ctx)
        // v1.8：浓缩模型路由在折叠点解析（跟随会话当前模型，或 env/control 显式指定）
        const route = await resolveCondenseRoute(ctx, session, ctrl, llmFixed)
        condenseRoute = route ? { provider: route.provider, model: route.model, via: route.via } : null
        if (!condenseRoute) condenseErr = 'no condense route (llm service absent / no session model / empty registry)'
        const ioc = { ctx, route, llm: llmFixed, errs: [], fb: {}, kd: [], aux: { calls: 0, in: 0, cacheRead: 0, out: 0 } } // v1.9 errs / v1.10.19 fb=回退原因分型 / v1.10.21 kd=K 通道归因 / v1.10.23 aux=辅助调用真实用量
        // #7 maxtokens：control.condenseMaxTokens（int）或 env 覆盖；无则内置 LOSSY_MAX_TOKENS(2048)
        //   实际每次调用还会按输入长度自适应收敛（effectiveMaxTokens），此处是**上限**。
        // #7 maxtokens **上限**：control.condenseMaxTokens（int）或 env 覆盖；无则内置 LOSSY_MAX_TOKENS(2048)。
        //   每次调用再按输入长度自适应收敛（effectiveMaxTokens）；此处只定天花板。
        const ctlMT = ctrl && typeof ctrl.condenseMaxTokens === 'number' ? Math.max(64, Math.floor(ctrl.condenseMaxTokens)) : NaN
        ioc.maxTokens = Number.isFinite(ctlMT) ? ctlMT : LOSSY_MAX_TOKENS
        // 【v1.10.20 · 经济性 P0】浓缩调用的推理档位：control.condenseReasoningEffort（string，需为
        //   '' | off | low | high | max）或 env DSH_CONTEXTINJECTOR_LOSSY_EFFORT 覆盖；缺省 'off'。
        //   事故说明见 LOSSY_EFFORT 定义处：不关思维链时，推理 token 吃满整个输出额度 ⇒ 正文 0 字、
        //   finish=max-tokens ⇒ 整条 [A] 判失败并无损回退，输入与输出 token **全额付费却零压缩收益**。
        //   非法值不写入（回落 effortOf 的缺省），避免把控制端的手误变成一次线上行为变更。
        const ctlEff = ctrl && typeof ctrl.condenseReasoningEffort === 'string' ? ctrl.condenseReasoningEffort.trim().toLowerCase() : ''
        if (ctlEff && LOSSY_EFFORTS.has(ctlEff)) ioc.reasoningEffort = ctlEff
        // 硬预算（v1.10.3）：墙钟 + 调用次数。次数上限对 double 是**隐性减半**（每条 [A] 要两次调用），
        //   实证报告 P4 记录在案；这里把生效值记进 ioc，供日志/last-fold 如实展示。
        ioc.maxCalls = Number.isFinite(ctrl?.condenseMaxCallsPerFold) ? Math.max(0, Math.floor(ctrl.condenseMaxCallsPerFold)) : undefined
        ioc.budgetMs = Number.isFinite(ctrl?.condenseBudgetMs) ? Math.max(0, Math.floor(ctrl.condenseBudgetMs)) : undefined
        // 【取自 RCS-0.1.0 返回包】minBytes 热读：control.condenseMinBytes 覆盖内置 240（缺省不变）
        const ctlMB = ctrl && typeof ctrl.condenseMinBytes === 'number' ? Math.max(0, Math.floor(ctrl.condenseMinBytes)) : NaN
        if (Number.isFinite(ctlMB)) ioc.minBytes = ctlMB
        // 【v1.10.23 · 经济性准入】回本视界（回合）：control.condensePaybackTurns 覆盖内置 8；0=关闭回本闸。
        const ctlPB = ctrl && typeof ctrl.condensePaybackTurns === 'number' ? Math.max(0, Math.floor(ctrl.condensePaybackTurns)) : NaN
        ioc.paybackHorizon = Number.isFinite(ctlPB) ? ctlPB : PB_HORIZON
        // 值保真闸：默认关（与 RCS 对齐），control.payloadCheck===true 时恢复严格模式
        if (ctrl && ctrl.payloadCheck === true) ioc.payloadCheck = true
        // #10 自定义提示词：control.prompts.single/keys（null/空=内置默认）
        if (ctrl && ctrl.prompts && typeof ctrl.prompts === 'object') {
          const pp = ctrl.prompts
          if (typeof pp.single === 'string' && pp.single.trim()) ioc.condenseSys = pp.single.trim()
          if (typeof pp.keys === 'string' && pp.keys.trim()) ioc.keysSys = pp.keys.trim()
        }
        const res = await applyCondense(newRows, mode, ioc)
        finalRows = res.rows
        stat = res.stat
        if (!condenseErr && ioc.errs.length) condenseErr = ioc.errs.slice(0, 3).join(' | ')
        condenseErrKind = condenseErr ? classifyCondenseError(condenseErr) : null // #9 分型
        if (stat.a > 0) console.log(`[contextinjector] condense[${mode}] trigger=${trigger} round=${roundState.n}: [A] ${stat.folded}/${stat.a} folded, ${stat.fallback} fallback${Object.keys(stat.fallbackReasons ?? {}).length ? '(' + Object.entries(stat.fallbackReasons).map(([k, v]) => k + '=' + v).join(',') + ')' : ''}, keys=${stat.keys}${stat.keysDiag ? '(' + stat.keysDiag.join('|') + ')' : ''}${stat.salvaged ? ', salvaged=' + stat.salvaged : ''}, calls=${stat.calls}/${ioc.maxCalls ?? '?'} ms=${stat.ms}${stat.budgetHit ? ' BUDGET-HIT' : ''}, ${stat.rawBytes}B->${stat.outBytes}B via=${route ? route.provider + '/' + route.model + '(' + route.via + ')' : 'none'}${condenseErr ? ' err=' + condenseErr : ''}${condenseErrKind ? ' kind=' + condenseErrKind : ''}`)
      }
      // head 行只可能在 foldText === '' 时非空（补录只做一次），且其节点 seq 更早 ⇒ 必须排在增量行**之前**；
      // 之后每次折叠都只是向后追加 ⇒ monotonic 前缀纪律不变（transcript.startsWith(foldText) 仍成立）。
      // 【v1.10.10 · standalone 独立片段（默认关闭，control.standalone === true 才启用）】
      //   背景（取自 RCS-0.1.0 D13）：本会话的"注入节点排在自身旧转录之后"时，旧实现会连注入一起折
      //   → 注入被替换 → DSH 立刻补发 → 自我抵消。standalone 只折**注入之后**的增量、**不带旧前缀**，
      //   让旧转录留在 surface 上（不被本次 replace 覆盖）。
      //   安全前提：上面刚做完的 `foldText` 漂移守卫（v1.10.9）——若 surface 上的旧转录与 foldText 不一致，
      //   本次折叠已被拒绝，不会走到这里。
      //   代价（如实记录）：本段转录不含旧前缀 ⇒ last-fold 的 `monotonic` 记 `'segment'`；
      //   续传语义依赖 `seedFoldState`（它取最后一个自身转录节点），故本项**默认关闭**、需实机 A/B。
      // 【v1.10.13 · 多段转录（control.segments，默认关闭）】
      //   把"转录"从**一个**节点改成**有序段集合**，一举解决两条已知妥协：
      //   ① head 重复：注入节点之前那段（v1.10.1 起"只转录不遮蔽"）过去既在 surface 上、又在转录文本里
      //      ⇒ 请求里出现两遍。本项让 head **独立成段且被遮蔽**（它不含注入节点，遮蔽它不违反 keepInject）
      //      ⇒ 零重复。
      //   ② standalone 的隐蔽风险：旧 standalone 的新段不带旧前缀，而 `seedFoldState` 只取最后一个
      //      自身转录节点 ⇒ 旧段在重启/面板里静默消失。本项下每个段**各自**留在 surface 上，
      //      完整转录 = 全部段按 seq 升序拼接（读取侧见 mergeOwnSegments），故续传不丢段。
      //   承载方式：新段**只装本次增量**（不覆盖既有段节点 —— 替换区间从"最后一个自身段节点之后"起算），
      //      段文本**只有转录行、不含任何机器可读头**（v1.10.16 修正：早期版本在首行插过
      //      `# SC-SEG …`，用户实测它进了注入的上下文 ⇒ 已移除；段信息只落 last-fold / fold-index）。
      //   提交纪律：两段**先算全部、再依次 append**（head 段在前，seq 升序）；任一段失败 ⇒ catch 清空会话
      //      状态、下次折叠重新 seed（从表面真值重建 foldText），绝不留下"状态指向已不存在的文本"。
      //   默认关闭 ⇒ 关闭时下方 transcript 组装与 `monotonic` 逐字不变（需实机 A/B 后再谈默认值）。
      //   ⚠ 开关本体在**增量集合**那段就已读出（segmentsOn）；这里只做段规划。
      let segHeadPlan = null // { text, seqs, startSeq, endSeq }
      let segNewText = ''
      let segMeta = null // last-fold.segments（每段的 segIndex/seq/cumLines/bytes）
      let standaloneSeg = false
      if (!segmentsOn && ctrl && ctrl.standalone === true && foldText !== '') {
        let lastInj = -1
        let lastOwn = -1
        const cand = entries.slice(0, end + 1)
        for (let i = 0; i < cand.length; i++) {
          if (!cand[i].msg) continue
          if (isDshInjected(cand[i].msg)) lastInj = i
          else if (isOwnTranscript(cand[i].msg)) lastOwn = i
        }
        standaloneSeg = lastOwn >= 0 && lastInj > lastOwn
        if (standaloneSeg) console.log(`[contextinjector] standalone 独立片段：注入@${lastInj} 在旧转录@${lastOwn} 之后 ⇒ 本次转录不带旧前缀（旧转录留在表面）`)
      }
      if (segmentsOn) {
        const segBase = Number.isFinite(st.segCount) ? st.segCount : 0
        const headOn = headRows.length > 0 && headSeqs.length > 0
        let baseCum = cumLinesBeforeEntry
        const metas = []
        if (headOn) {
          // 【v1.10.16】段文本不含任何机器可读头（用户实测：头行会进入注入的上下文）
          const headText = segmentText(headRows)
          segHeadPlan = { text: headText, seqs: [...headSeqs], startSeq: headSeqs[0], endSeq: headSeqs[headSeqs.length - 1] }
          metas.push({ segIndex: segBase, kind: 'head', seq: segHeadPlan.startSeq, cumLines: cumLinesBeforeEntry, bytes: headText.length, seqs: [...headSeqs] })
          baseCum = cumLinesBeforeEntry + headText.split('\n').length
        }
        const newIndex = segBase + (headOn ? 1 : 0)
        segNewText = segmentText(finalRows)
        metas.push({ segIndex: newIndex, kind: 'new', seq: incremental[0].seq, cumLines: baseCum, bytes: segNewText.length })
        segMeta = metas
      }
      const transcript = segmentsOn
        ? (foldText === ''
            ? (segHeadPlan ? segHeadPlan.text + '\n' + segNewText : segNewText)
            : foldText + '\n' + segNewText)
        : (foldText === ''
            ? headRows.concat(finalRows).join('\n')
            : (standaloneSeg ? finalRows.join('\n') : foldText + '\n' + finalRows.join('\n')))

      const transcriptMsg = {
        // id 必需：session 持久化校验要求 user/message 携带非空 message id
        // （session.js assertMessageEventShape: "lacks an identified message" ——
        //  此前缺失导致会话重启回放时 SessionPersistenceCorruptionError）
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: segmentsOn ? segNewText : transcript }],
        source: { kind: 'plugin:CONTEXTinjector' }, // 纪律 4：防自转录
      }
      // 【v1.10.13】多段转录：本段只承载"本次增量"，替换区间从"最后一个自身段节点之后"起算
      //   （旧段节点 seq === foldSeq ⇒ 不在增量内 ⇒ 不被覆盖、留在表面）。关闭时 = 旧行为（全部被遮蔽 seq）。
      const shadowedSeqs = segmentsOn ? incremental.map((e) => e.seq) : shadowed.map((e) => e.seq)
      // 多段转录下 head 段也被遮蔽 ⇒ 其原始字节计入遮蔽；旧段节点（seq ≤ foldSeq）不被遮蔽 ⇒ 不计。
      const headShadowBytes = segmentsOn ? headEntries.reduce((a, e) => a + messageBytes(e.msg).length, 0) : 0
      const shadowedBytes = shadowed.reduce((a, e) => a + ((segmentsOn && e.seq <= foldSeq) ? 0 : messageBytes(e.msg).length), 0) + headShadowBytes
      // v1.10.1：head（只转录不遮蔽）单独计量——它不进遮蔽集/不进 surfaceOp，故不计入 shadowedBytes；
      //   单列出来便于核验"补录代价"（这段文本在请求里出现两次）。
      //   【v1.10.13】多段转录开启后 head **已被遮蔽** ⇒ 这段文本不再出现两次，headBytes 改为"该段字节"。
      const headBytes = headRows.length > 0 ? headRows.join('\n').length : 0
      // 【v1.10.9 · standalone 的前置守卫（协作 r10 要求）】提交前对账：我们保留的 `foldText`
      //   必须与 surface 上"最后一个自身转录节点"的实际文本一致（或互为前缀）。
      //   【v1.10.12 收紧（实测事故）】原判定把**任何**非前缀差异都当拒折理由，结果白名单会话
      //   `1c59c181` 的折叠自 v1.10.9 起**每次都被拒**（转录仍在写、折叠零产出，而拒折当时只在 console
      //   留痕 ⇒ 从文件侧完全看不出来）。现改为**只在真丢内容时拒折**：surface 自身转录节点的文本里
      //   连 `foldText` 的**前 200 字**都找不到 ⇒ 旧转录确实被改写/丢失（继续折会静默丢内容）。
      //   其余差异（空白/换行/尾部差异等）记为 advisory `foldtext-drift-minor`，**继续折叠**、不再阻断。
      // 【v1.10.13】多段转录下 surface 上有**多个**自身转录节点 ⇒ 对账对象必须是"全部段按 seq 升序拼接"
      //   （单段会话只有一个文本 ⇒ 与旧版逐字相同）。否则"末段 vs 整份 foldText"的必然差异会被误判成漂移、
      //   把多段会话的折叠直接拒绝掉。
      const ownTexts = []
      for (const e of entries) {
        if (e.msg && isOwnTranscript(e.msg)) {
          const t = blocksOf(e.msg).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
          if (t) ownTexts.push(t)
        }
      }
      const ownNodeText = ownTexts.length > 0 ? ownTexts.join('\n') : null
      const head200 = foldText.slice(0, 200)
      const foldTextDrift = ownNodeText !== null && foldText !== '' &&
        !(ownNodeText === foldText || ownNodeText.startsWith(foldText) || foldText.startsWith(ownNodeText)) &&
        !ownNodeText.includes(head200)
      const foldTextDriftMinor = ownNodeText !== null && foldText !== '' && !foldTextDrift &&
        !(ownNodeText === foldText || ownNodeText.startsWith(foldText) || foldText.startsWith(ownNodeText))
      if (foldTextDriftMinor) {
        try { log('foldtext-drift-minor', { sid, trigger, step: stepNo, ownBytes: ownNodeText.length, foldBytes: foldText.length }) } catch { /* ignore */ }
        try { console.log('[contextinjector] foldtext-drift-minor sid=' + sid + ' own=' + ownNodeText.length + 'B fold=' + foldText.length + 'B (非致命差异：继续折叠)') } catch { /* ignore */ }
      }
      if (foldTextDrift) {
        try { log('foldtext-drift', { sid, trigger, step: stepNo, ownBytes: ownNodeText.length, foldBytes: foldText.length }) } catch { /* ignore */ }
        // 【v1.10.11】拒折也要留痕：否则"漂移拒折"与"该会话根本没在折叠"在文件层面完全一样、无法区分。
        try {
          const dDir = join(STATE_DIR, '.ctxinjector', 'fold-errors')
          mkdirSync(dDir, { recursive: true })
          appendFileSync(join(dDir, sanitizeSid(String(sid ?? 'unknown').replace(/^session-?/i, '')) + '.jsonl'), JSON.stringify({ t: Date.now(), kind: 'foldtext-drift', trigger, step: stepNo, ownBytes: ownNodeText.length, foldBytes: foldText.length }) + '\n', 'utf8')
        } catch { /* ignore */ }
        console.log(`[contextinjector] foldtext-drift sid=${sid} own=${ownNodeText.length}B fold=${foldText.length}B (surface 旧转录与 foldText 不一致 ⇒ 本次不折，避免旧内容静默丢失)`)
        return { folded: false, reason: 'foldtext-drift' }
      }
      const transcriptBytes = transcript.length
      // 【v1.10.25 · 经济性口径】四个"能对外讲的量"（此前只有 shrink，而它在单段模式下**结构上必然≈1**：
      //   被替换集合里含"上一版转录节点本身" ⇒ 等于拿转录比自己。实测 0.998 就是这么来的：
      //   它既不是"折叠只省了 0.2%"，也不是"折叠有效"，它只是**不含信息**）。
      //   liveBytes            提交后**真实请求里**的消息字节合计（真正在上下文里的量）
      //   incrementalRawBytes  本次真正被转写的**新**原料字节（排除自身旧转录节点）
      //   appendedBytes        本次追加进转录的字节（单段模式=全文重写，但新增只有这么多）
      //   foldRatio            appendedBytes / incrementalRawBytes（<1 才是省）
      const prevTranscriptBytes = (foldText === '' || standaloneSeg) ? 0 : foldText.length
      const incrementalRawBytes = incremental.reduce((a, e) => a + (isOwnTranscript(e.msg) ? 0 : messageBytes(e.msg).length), 0)
      const appendedBytes = Math.max(0, transcriptBytes - prevTranscriptBytes)
      const foldRatio = incrementalRawBytes > 0 ? Number((appendedBytes / incrementalRawBytes).toFixed(4)) : null
      log('fold-attempt', {
        trigger, step: stepNo, turn, claimed, end, keepInject: ki ? 1 : 0,
        shadowedCount: shadowedSeqs.length, shadowedSeqs,
        headCount: headSeqs.length, headSeqs, headBytes,
        incrementalCount: incremental.length, shadowedBytes,
        transcriptBytes, shrink: Number((transcriptBytes / Math.max(1, shadowedBytes)).toFixed(4)),
        // v1.10.25 经济性口径（见上方注释）：真实请求体量 / 本次新原料 / 本次新增转录 / 本折压缩比
        prevTranscriptBytes, incrementalRawBytes, appendedBytes, foldRatio,
        transcriptHash: hash256(transcript).slice(0, 16),
        monotonic: standaloneSeg ? 'segment' : (foldSeq >= 0 ? transcript.startsWith(foldText) : 'first'),
        lossy: mode !== 'off' ? 1 : 0, mode, aCount: stat?.a ?? 0, aFolded: stat?.folded ?? 0, aFallback: stat?.fallback ?? 0, aKeys: stat?.keys ?? 0,
        calls: stat?.calls ?? 0, ms: stat?.ms ?? 0, budgetHit: stat?.budgetHit === true, // v1.10.5 预算法统计（r9 ★必须-5：直接入字面量）
        fallbackReasons: stat?.fallbackReasons, maxCallsUsed: stat?.calls ?? 0, // v1.10.19 P5：回退原因分型（只含非零项）
        salvaged: stat?.salvaged, condenseReasoningEffort: stat?.condenseReasoningEffort, // v1.10.20：截断抢救条数 + 生效推理档位（便于事后归因）
        keysDiag: stat?.keysDiag, // v1.10.21：K 通道归因（ok / noValues / callFailed[:原因]）
        // v1.10.23 经济性：辅助调用真实用量 + 预估/实测回本回合 + 因回本不划算而**未发起**的条数
        auxCalls: stat?.auxCalls, auxTokens: stat?.auxTokens, auxBilled: stat?.auxBilled,
        paybackHorizon: stat?.paybackHorizon, paybackEst: stat?.paybackEst, paybackMeasured: stat?.paybackMeasured, paybackSkipped: stat?.paybackSkipped,
      })
      console.log(`[contextinjector] fold-attempt trigger=${trigger} step=${stepNo} turn=${turn} end=${end} shadowed=${shadowedSeqs.length} head=${headSeqs.length}${headSeqs.length ? '(' + headSeqs.join(',') + ')' : ''} +inc=${incremental.length} ${shadowedBytes}B(+head ${headBytes}B)->${transcriptBytes}B shrink=${(transcriptBytes / Math.max(1, shadowedBytes)).toFixed(3)} condense=${mode} monotonic=${foldSeq >= 0 ? transcript.startsWith(foldText) : 'first'}`)
      // 【v1.10.20 · 真机事故】提交前的最后一道让路检查（覆盖**所有**触发路径：pre-step 直折不经 scheduleFold）：
      //   DSH compaction 在飞行中时提交 `surfaceOp replace` 会让它的总结作废
      //   （`compaction: session surface changed during summarization`）⇒ 本轮不折，下一轮再折，内容不丢。
      if (isCompacting(sid)) {
        try { log('fold-skip', { trigger, step: stepNo, turn, sid, reason: 'compacting-at-commit' }) } catch { /* ignore */ }
        console.log(`[contextinjector] fold-skip trigger=${trigger} step=${stepNo} reason=compacting-at-commit（DSH 正在 compaction ⇒ 本次不提交，避免作废它的总结）`)
        return { folded: false, reason: 'compacting' }
      }
      try {
        // 【v1.10.13 多段转录】head 段**先**提交（seq 升序），再提交新段 —— 两段互不覆盖：
        //   head 段的区间只覆盖注入节点之前的节点（不含注入节点 ⇒ keepInject 分毫未动），
        //   新段的区间从"最后一个段节点之后"起算（既有段留在表面 ⇒ 拼起来才是完整转录）。
        //   中间状态必须先写回 st：若第二段失败，catch 会清空状态强制重新 seed（从表面真值重建）。
        if (segHeadPlan) {
          const headMsg = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: segHeadPlan.text }], source: { kind: 'plugin:CONTEXTinjector' } }
          session.append('user/message', headMsg, {
            surfaceOp: replaceOp(segHeadPlan.startSeq, segHeadPlan.endSeq),
            sourceEventSeqs: [...segHeadPlan.seqs],
          })
          foldSeq = segHeadPlan.startSeq
          foldText = segHeadPlan.text
          st.foldSeq = foldSeq; st.foldText = foldText
          st.lastSegSeq = foldSeq
          console.log(`[contextinjector] segments head 段已提交 seq=${segHeadPlan.startSeq}..${segHeadPlan.endSeq} ${segHeadPlan.text.length}B（首轮补录同时遮蔽 ⇒ 该段文本在请求里不再出现两遍）`)
        }
        session.append('user/message', transcriptMsg, {
          // start 必须是真实存在的首个被遮蔽 seq（surface 节点 seq 未必从 0 起）；
          // 区间 [start..endSeq] 连续，sourceEventSeqs 覆盖每个被遮蔽 seq（实证 P1 同款参数）
          surfaceOp: replaceOp(shadowedSeqs[0], shadowedSeqs[shadowedSeqs.length - 1]),
          sourceEventSeqs: [...shadowedSeqs],
        })
        foldSeq = shadowedSeqs[0] // 折叠消息占据 start seq；其后 append 的节点归下次增量
        foldText = transcript
        foldRound = roundState.n
        if (TEST_ROUND) foldedOnce = true
        // 多段转录：段号与"最后一段起点 seq"（段头编号与承接关系据此，重启 seed 也按此恢复）
        if (segmentsOn) {
          st.segCount = (Number.isFinite(st.segCount) ? st.segCount : 0) + (segHeadPlan ? 1 : 0) + 1
          st.lastSegSeq = foldSeq
        }
        // 写回 per-session 状态（同一 web 进程多会话互不串扰）
        st.foldSeq = foldSeq; st.foldText = foldText; st.foldRound = foldRound; st.foldedOnce = foldedOnce
        const after = snapshotOf(session)
        // v1.10.25：liveBytes = 提交后**真实请求**里各条消息的实际字节合计（"上下文里到底有多大"）。
        //   它与"日志里历史事件体的总和"是两个完全不同的量：后者随折叠次数线性累加（每次重写整份转录
        //   都会在追加式日志里留下一份当时全文），把后者当成"重复注入的份数"会得出 ~29× 的假象。
        //   本字段与 tools/measure-prompt-surface.mjs 的不变量判据互为交叉校验。
        const liveBytes = Array.isArray(after) ? after.reduce((a, e) => a + (Number(e.bytes) || 0), 0) : null
        rawAppend(sid, incremental) // raw 权威存证：每次成功折叠把被遮蔽增量原文全量落盘（无论是否 lossy）
        log('fold-committed', { trigger, step: stepNo, after, liveBytes, incrementalRawBytes, appendedBytes, foldRatio })
        console.log(`[contextinjector] fold trigger=${trigger} @step${stepNo}: ${shadowedBytes}->${transcriptBytes} B (${(transcriptBytes / Math.max(1, shadowedBytes)).toFixed(2)}x), round=${foldRound}${mode !== 'off' ? ` condense[${mode}]:[A]${stat?.folded ?? 0}/${stat?.a ?? 0}` : ''}`)
        // 【v1.10.5 ★必须-1】折叠索引（只追加，供 LogCompiler K 做 seq ↔ 转录累计行号双向溯源）
        
try {
          // v1.10.13：多段转录下 head 段同属本次折叠的遮蔽范围 ⇒ 一并记入索引行（headSeqs 为附加字段）；
          //   shadowedSeqs 仍是"本次 replace 覆盖的 seq"（= 增量），cumLines 语义**不变**（全局累计行号）。
          writeFoldIndex({ sid, trigger, foldSeq: shadowedSeqs[0], shadowedSeqs, headSeqs: segmentsOn ? headSeqs : [], cumBefore: cumLinesBeforeEntry, cumAfter: transcript.split('\n').length, shadowedBytes, transcriptBytes, liveBytes, appendedBytes, incrementalRawBytes })
        
} catch (err) { console.error('[contextinjector] fold-index call failed:', err?.message ?? err) }
        persistLastFold({
          t: Date.now(), plugin: PLUGIN_VERSION, sessionId: sid, gate, keepInject: ki ? 1 : 0, mode, trigger, step: stepNo, round: foldRound,
          condenseRoute, // v1.8：实际浓缩模型（provider/model/来源），便于核验"用了谁的模型"
          condenseErr, // v1.9：本次折叠浓缩模型调用失败原因（无则 undefined，JSON 省略）
          condenseErrKind, // #9：condenseErr 的分型 enum（供 WebUI 如实展示错误类别）
          shadowedBytes, transcriptBytes, shrink: Number((transcriptBytes / Math.max(1, shadowedBytes)).toFixed(4)),
          // 【v1.10.25】`shrink` 保留（面板/历史消费方零改动），但它**不是收益指标**：单段模式下
          //   被替换集含上一版转录节点本身 ⇒ 结构上恒 ≈1（实测 0.998）。真正的收益看下面四个量：
          liveBytes, incrementalRawBytes, appendedBytes, foldRatio,
          headSeqs, headBytes, // v1.10.1：本次折叠补录的头部节点；v1.10.13 起多段转录下该段**同时被遮蔽**（不再重复）
          transcriptHash: hash256(transcript).slice(0, 16),
          // v1.10.13 多段转录：新增 `segments`/`segCount`（`full` 仍 = 全部段按序拼接 ⇒ 面板与协作方零改动）
          segments: segMeta ?? undefined, segCount: segMeta ? segMeta.length : undefined,
          monotonic: standaloneSeg ? 'segment' : (foldSeq >= 0 ? transcript.startsWith(foldText) : 'first'),
          lossy: mode !== 'off' ? 1 : 0, aCount: stat?.a ?? 0, aFolded: stat?.folded ?? 0, aFallback: stat?.fallback ?? 0, aKeys: stat?.keys ?? 0,
          calls: stat?.calls ?? 0, ms: stat?.ms ?? 0, budgetHit: stat?.budgetHit === true, // v1.10.7 预算法统计（此处是第二个 persistLastFold 字面量，v1.10.5 的补丁只落在第一个）
          fallbackReasons: stat?.fallbackReasons, // v1.10.19 P5：本折回退原因分型（compact/short/empty/noShrink/llmErr/payloadGate/maxCalls/budgetMs）
          salvaged: stat?.salvaged, condenseReasoningEffort: stat?.condenseReasoningEffort, // v1.10.20：截断抢救条数 + 生效推理档位
          keysDiag: stat?.keysDiag, // v1.10.21：K 通道归因（ok / noValues / callFailed[:原因]）
          // v1.10.23 经济性：与第一个 persist 字面量保持同源（历史上这里漏打过补丁，故两处都写）
          auxCalls: stat?.auxCalls, auxTokens: stat?.auxTokens, auxBilled: stat?.auxBilled,
          paybackHorizon: stat?.paybackHorizon, paybackEst: stat?.paybackEst, paybackMeasured: stat?.paybackMeasured, paybackSkipped: stat?.paybackSkipped,
          preview: transcript.slice(0, 400), // 注入内容预览（前 400 字符，供 WebUI 展示；完整消息在会话 surface 内）
          tailPreview: transcript.slice(-300), // 尾部增量预览：用于确认折叠持续更新到最新轮
          afterNodes: after, // 折叠后请求的消息结构（role/src/bytes/hash）——核验"该看的在、不该看的无"
          full: transcript, // 转录全文（供面板结构化渲染；单条消息量级小）
        })
        // #5 压缩器IO比（2026-09-10 口径重写）：折叠成功后记一笔 inBytes/outBytes/ratio（不再传 S）。
        try {
          ivrRecord(STATE_DIR, sid, {
            n: foldRound, step: stepNo, shadowedBytes, transcriptBytes, ts: Date.now(),
          })
        } catch (err) { console.error('[contextinjector] ivrRecord failed:', err?.message ?? err) }
      } catch (err) {
        log('fold-rejected', { trigger, step: stepNo, error: String(err?.message ?? err) })
        console.error(`[contextinjector] fold-rejected trigger=${trigger} step=${stepNo}: ${String(err?.message ?? err)}`)
        // 【v1.10.13】多段转录一次折叠要提交两段 ⇒ 第一段落面、第二段失败时"状态 vs 表面"不再保证一致。
        //   处理：清空本会话状态并允许重新 seed —— seed 按 seq 拼接**全部**段节点（表面真值）⇒ 下轮自动重建。
        //   绝不留"foldText 指向表面已不存在的文本"这种静默错误状态。
        if (segmentsOn) {
          try { st.foldText = ''; st.foldSeq = -1; st.seedChecked = false; st.segCount = 0; st.lastSegSeq = -1 } catch { /* ignore */ }
          console.log('[contextinjector] segments 提交失败 ⇒ 已清空会话状态，下次折叠重新 seed（从表面真值重建 foldText）')
        }
        return { folded: false, reason: 'append-failed' }
      }
      return { folded: true, mode, trigger, round: foldRound, shadowedBytes, transcriptBytes, stat }
    }

    // ── 在飞折叠登记（【#6】turn-stopping 排队 → pre-step join）【取自 RCS-0.1.0】──────
    // 为什么后台折：agent/turn-stopping 是 serial 派发（DSH 会 await 全部 handler），若在钩子里同步等
    //   浓缩模型（本地 4B 约 7–18s）会拖住"本轮结束"。故这里只登记后台任务，
    //   pre-step 在真正发请求前 join（**带超时**，见 joinFoldInFlight），
    //   保证请求看到的一定是已折叠 surface，且永不被慢模型卡住。
    const foldInFlight = new Map() // sid -> Promise
    // 同一会话已有折叠在飞 → 复用（不重复排队；下一轮/下一轮结束会再试）
    function scheduleFold(args) {
      const sid = args.sid
      const prev = foldInFlight.get(sid)
      if (prev) return prev
      // 【v1.10.20】DSH 正在做 compaction ⇒ 让路（第一道：登记时）。折叠延后到下一轮，内容不丢。
      if (isCompacting(sid)) {
        logFoldSkip(args.trigger, 'compacting', sid)
        return null
      }
      // 【在飞标记】不在这里写/删了（v1.10.2）：改由 foldAttempt 入口写、finally 删 —— 那条路径覆盖
      //   pre-step 直折 / turn-stopping 排队 / 将来任何新触发点，而本函数只覆盖后者（这正是真机 bug）。
      //   本处也不再需要"落定即删"：foldAttempt 的 finally 就是唯一的删除点；而上面 prev 去重分支**不会**
      //   写标记（它复用别人已登记的 Promise，那个折叠自己的 finally 负责删）⇒ 不存在留下"永久压缩中"的路径。
      const p = (async () => {
        try { return await foldAttempt(args) }
        catch (err) { log('handler-error', { trigger: args.trigger, error: String(err?.message ?? err) }); return null }
      })()
      p.then(() => {}, () => {}) // 兜底：绝不让 Promise 拒绝外泄
      p.then(() => { if (foldInFlight.get(sid) === p) foldInFlight.delete(sid) })
      foldInFlight.set(sid, p)
      return p
    }
    // 【安全闸】join 必须**有超时**：下一轮 pre-step 绝不能无限期等一个慢/卡死的浓缩模型。
    //   超时 ⇒ 只记一条 fold-join-timeout 并继续（下一轮请求用当前 surface；该次折叠结果稍后落地，
    //   等价于#6 之前的旧行为）。超时**不**取消后台任务：让它自然跑完，不打断 in-flight 的 session.append。
    async function joinFoldInFlight(sid, timeoutMs, stepNo) {
      const p = foldInFlight.get(sid)
      if (!p || typeof p.then !== 'function') return { joined: false, timedOut: false, waitMs: 0 }
      const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000
      const t0 = Date.now()
      let timer = null
      const timeout = new Promise((resolve) => {
        // 不 unref：该计时器就是 join 的**安全闸**，必须保证它一定会触发
        //（unref 后若事件循环恰好只剩这个计时器，进程会先退出/TLA 报警，超时反而没人兜底）。
        // 正常路径（后台折叠先完成）会 clearTimeout，不会留下悬挂计时器。
        timer = setTimeout(() => resolve({ joined: false, timedOut: true, waitMs: Date.now() - t0 }), ms)
      })
      const settled = Promise.resolve(p).then(() => ({ joined: true, timedOut: false, waitMs: Date.now() - t0 }), () => ({ joined: true, timedOut: false, waitMs: Date.now() - t0 }))
      const out = await Promise.race([settled, timeout])
      if (timer) clearTimeout(timer)
      if (out.timedOut) console.log(`[contextinjector] fold-join-timeout step=${stepNo} sid=${sid} wait=${out.waitMs}ms>=${ms}ms (后台折叠仍在飞；本轮用当前 surface，折叠结果稍后落地)`)
      return out
    }
    // turn-stopping 的廉价预检：surface 上还有"上次折叠之后"的节点才值得排队（否则纯属浪费一次调度）
    function hasFoldCandidate(session, surface, sid) {
      try {
        const st = stateOf(sid)
        const nodes = [...(surface?.nodes ?? [])]
        if (nodes.length === 0) return false
        return st.foldSeq < 0 ? (st.foldText === '') : nodes.some((seq) => seq > st.foldSeq)
      } catch { return false }
    }

    // #6 折叠时机**不缓存生效值**：与本模块其它 control 项（keepInject / condenseMinBytes / prompts）同规矩，
    //   每次触发现读 control.json（改档无需重启）；gate 在时点未知，故此处不对 ON/OFF 作断言。

    // ── 触发点 1：round 边界（原有行为 + 【#6】join 在飞折叠）────────────────────
    ctx.on('agent/pre-step', async ({ agent, messages, turn, step: stepNo, signal }, next) => {
      const claimed = messages?.length ?? 0
      try {
        const session = agent?.session
        const surface = session?.surface
        if (!session || !surface) { logFoldSkip('turn-end', 'no-session-or-surface', session ? sessionIdOf(session) : null); return } next()
        const sid = sessionIdOf(session)
        const ctrl = readControl()
        const gate = gateFor(sid, ctrl, session).gate
        // 轮级诊断（claimed>0 每轮一条）：web 终端可见 —— 用于定位 pre-step 是否到达 / sid 与白名单是否匹配
        if (claimed > 0) console.log(`[contextinjector] round step=${stepNo} turn=${turn} sid=${sid} gate=${gate} enabled=${ctrl?.enabled === true} whitelist=${JSON.stringify(ctrl?.sessions ?? [])}`)
        if (gate === 'off') return next() // 未启用：完全旁路（默认；仅被 WebUI 白名单选中的 session 才会折叠）
        if (TRACE) {
          try { log('trace', { step: stepNo, turn, claimed, transcript: transcriptNodesOf(session.deriveMessages()) }) } catch { /* best-effort */ }
        }
        // 【#6】先 join"上一轮结束即折"的在飞折叠（**带超时**，绝不阻塞本轮）：保证本次请求看到已折叠 surface。
        //   放在 next() 之前：next() 就拿当前 surface 组装请求，join 得越早越好。
        //   关闭 turn-end 折时跳过 join（无在飞任务可言）；超时值每次现读 control（热改生效）。
        if (foldAtTurnEndOn(ctrl)) await joinFoldInFlight(sid, foldJoinTimeoutMs(ctrl), stepNo)
        const decision = await next()
        if (claimed === 0 && !TEST_ROUND) return decision // 纪律 3：round 边界才折；TEST_ROUND 供 headless 回归
        // TEST_ROUND 单次折叠由 foldAttempt 内 `TEST_ROUND && foldedOnce` 守卫（两个触发点共用同一守卫）
        // 注意：这里是**直接调用**（不经 scheduleFold）⇒ 「压缩中」在飞标记已收口在 foldAttempt 内部，
        //   否则本路径（用户实际走的 pre-step 折）在面板上永远没有指示（v1.10.2 修复）。
        await foldAttempt({ session, surface, sid, ctrl, gate, stepNo, turn, claimed, trigger: 'pre-step' })
        return decision
      } catch (err) {
        log('handler-error', { error: String(err?.message ?? err) })
        return next()
      }
    })

    // ── 触发点 2：【#6 压缩时机提前】本轮 AI 输出结束即压（后台）───────────────────
    // 语义：DSH 在"本轮真正结束且无待处理 next-step"时派发 agent/turn-stopping
    //   （payload `{agent, turn, signal}`，dispatch.serial 派发，无 next —— 见本机验证
    //   dsh-agent-loop/lib/index.js:565 + dsh-agent runtime-types.d.ts:301 + dsh-scope/invariant.js:21）。
    //   此刻本轮的 assistant/tool 内容已闭合，可安全折叠；把浓缩模型调用挪到"用户读回复"的间隙，
    //   折叠结果当场落 last-fold.json → 面板与 LOG 立即刷新（用户诉求："压缩完成就先进入 LOG 并渲染在 WEB"），
    //   下一轮 pre-step 几乎零成本（只需 join，且 join 有超时）。
    // 安全性：与 pre-step 完全同一套边界钳制 + pairSplitIds 跨界守卫；且只在"确实有可折内容"时才排队，
    //   避免与紧随其后的 pre-step 重复排队一次无意义的折叠。
    // 【v1.10.4】turn-stopping 的每个静默 return 都改成可诊断（同一 sid+原因只记一次，不刷屏）：
//   实测用户会话最近 8 次折叠全是 pre-step、turn-stopping 0 次，而旧实现 5 处 return 全是静默，
//   无法判断"钩子没被派发"还是"被预检挡下"。现在每次挡下都留一行 turn-stopping-skip reason=…
    const _foldSkipLogged = new Set()
    const logFoldSkip = (where, reason, sid, extra) => {
      try {
        const k = where + '|' + reason + '|' + String(sid ?? '-')
        if (_foldSkipLogged.has(k)) return
        _foldSkipLogged.add(k)
        console.log(`[contextinjector] ${where}-skip reason=${reason} sid=${sid ?? '-'}${extra ? ' ' + extra : ''}`)
      } catch { /* 诊断失败绝不影响折叠 */ }
    }
    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      let sid = null
      try {
        if (signal?.aborted) { logFoldSkip('turn-stopping', 'aborted', sid); return }
        const session = agent?.session
        const surface = session?.surface
        if (!session || !surface) { logFoldSkip('turn-stopping', 'no-session-or-surface', sid); return }
        sid = sessionIdOf(session)
        const ctrl = readControl()
        if (!foldAtTurnEndOn(ctrl)) { logFoldSkip('turn-stopping', 'switch-off', sid); return } // control.foldAtTurnEnd=false 或 env=0
        const gate = gateFor(sid, ctrl, session).gate
        if (!foldGateOpen(ctrl, gate)) { logFoldSkip('turn-stopping', 'gate-' + gate, sid); return } // 子代理(gate=off)/未门控
        if (!hasFoldCandidate(session, surface, sid)) { logFoldSkip('turn-stopping', 'no-candidate', sid); return }
        void scheduleFold({ session, surface, sid, ctrl, gate, stepNo: 0, turn, claimed: 0, trigger: 'turn-stopping' })
      } catch (err) {
        console.error('[contextinjector] turn-stopping schedule failed:', err?.message ?? err)
      }
    })

    // ── 触发点 3：【v1.10.4】turn/end 兜底后台折（不依赖 turn-stopping 是否被派发）──────────
    // agent/turn-stopping 只在"本轮真正结束且 inbox 无待处理 next-step"时由 DSH 派发；实测本机流程
    // （EXTREASON 会往父会话塞 settled/steer，形成 next-step）几乎不触发 ⇒ 压缩全部退回 pre-step 同步等待。
    // turn/end 是**必然发生**的会话事件，这里 debounce 400ms 等 surface 落定后登记后台折叠；
    // 与 turn-stopping 共用同一 scheduleFold / gate / foldAttempt，只是 trigger 名字不同。
    const _turnEndTimers = new Map() // sid -> timer
    // 【v1.10.20 · 真机事故 2026-09-12（session-0cea2d8f，会话被撑到 830K token 后 DSH 触发自带 compaction）】
    //   DSH 的 compaction 会先 snapshot surface、再让模型总结，结束时校验"surface 没变"；而我们的折叠
    //   在同一时间提交了一个 `surfaceOp replace` ⇒ DSH 报
    //   `compaction: session surface changed during summarization` 并**放弃压缩**，下一轮再撞上下文上限、
    //   再触发 compaction、再被我们打断……形成死循环（日志实测连续两轮同样报错）。
    //   对策：跟踪每个会话的 compaction 在飞状态（DSH 会发 `compaction/start` / `compaction/end` 事件），
    //   在折叠**登记时**与**提交前**各查一次 ⇒ 让路给 DSH，等下一轮再折。折叠本身不丢内容，只是延后。
    const _compacting = new Set() // sid：DSH 正在对它会话做 compaction
    ctx.on('session/event', (a, b) => {
      try {
        const ev = (b && typeof b === 'object' && typeof b.type === 'string') ? b
          : (a && typeof a === 'object' && typeof a.type === 'string' ? a : null)
        if (!ev) return
        if (ev.type !== 'compaction/start' && ev.type !== 'compaction/end') return
        const session = (a && (a.id || a.sessionId || a.surface)) ? a : (ev.session ?? a?.session ?? null)
        const sid = sessionIdOf(session) ?? ev?.data?.sessionId ?? null
        if (!sid) return
        if (ev.type === 'compaction/start') {
          _compacting.add(sid)
          console.log(`[contextinjector] DSH compaction 开始（sid=${sid}）⇒ 让路：本次不提交折叠，避免 "surface changed during summarization"`)
        } else {
          _compacting.delete(sid)
          console.log(`[contextinjector] DSH compaction 结束（sid=${sid}${ev?.data?.error ? ' err=' + String(ev.data.error).slice(0, 80) : ''}）`)
        }
      } catch { /* 观测面永不抛 */ }
    })
    // 供 foldBody 在提交前复查（登记时查一次、提交前再查一次，两道）
    const isCompacting = (sid) => !!sid && _compacting.has(sid)
    ctx.on('session/event', (a, b) => {
      try {
        const ev = (b && typeof b === 'object' && typeof b.type === 'string') ? b
          : (a && typeof a === 'object' && typeof a.type === 'string' ? a : null)
        if (!ev || ev.type !== 'turn/end') return
        // 【v1.10.5（协作 r4 O-13）】取参不能要求首参带 surface：否则下一行判 no-session-or-surface 后静默返回，
        //   表现为『既无 turn-end 也无 skip』（对方实测其会话已在白名单、gate=control）。
        const session = (a && (a.id || a.sessionId || a.surface)) ? a : (ev.session ?? a?.session ?? null)
        const surface = session?.surface ?? session?.deriveSurface?.() ?? null
        if (!session || !surface) { logFoldSkip('turn-end', 'no-session-or-surface', session ? sessionIdOf(session) : null); return }
        const sid = sessionIdOf(session)
        const ctrl = readControl()
        if (!foldAtTurnEndOn(ctrl)) { logFoldSkip('turn-end', 'switch-off', sid); return }
        const gate = gateFor(sid, ctrl, session).gate
        if (!foldGateOpen(ctrl, gate)) { logFoldSkip('turn-end', 'gate-' + gate, sid); return }
        if (!hasFoldCandidate(session, surface, sid)) { logFoldSkip('turn-end', 'no-candidate', sid); return }
        const prev = _turnEndTimers.get(sid)
        if (prev) clearTimeout(prev)
        const timer = setTimeout(() => {
          _turnEndTimers.delete(sid)
          try {
            void scheduleFold({ session, surface, sid, ctrl, gate, stepNo: 0, turn: ev?.data?.turn ?? 0, claimed: 0, trigger: 'turn-end' })
          } catch (err) { console.error('[contextinjector] turn-end schedule failed:', err?.message ?? err) }
        }, 400)
        _turnEndTimers.set(sid, timer)
      } catch (err) { console.error('[contextinjector] turn-end hook failed:', err?.message ?? err) }
    })
  },
}
// 测试/诊断句柄（named export 不影响 cordis 按 default 加载插件）
export { condenseMode, perSessionMode, condenseText, extractKeys, applyCondense, guardText, restoreText, verifyAgainstSource, occursWhole, rawAppend, sanitizeSid, llmOf, resolveCondenseRoute, llmText, minBytesOf, keepInjectOn, isDshInjected, isInjectedUser, foldAtTurnEndOn, foldGateOpen, foldJoinTimeoutMs, transcribeIncremental, enterFoldInflight, exitFoldInflight, foldInflightFile, paybackOf, paybackMeasured, messageBytes, blockTextOf }
