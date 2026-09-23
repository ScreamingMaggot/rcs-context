// Copyright (c) 2026 ScreamingMaggot. This source code is licensed under the MIT License.
// ivr.mjs — 「压缩器IO比」口径计量 + 错误时间线（§2 / §6.4）
//   纯簿记模块，依赖 node:fs，不依赖 DSH 运行时；与 contextinjector.mjs 同目录。
//   读法：ratio = inBytes / outBytes（输入 ÷ 输出）
//     ratio ≈ 1 属正常 = 主流程已无冗余可压；> 1 = 压掉的量更大；< 1 = 输出比输入还大。
//   只作**回归哨兵**：比值明显变大=冗余回流，< 1=有内容被重复注入。
// 设计依据：docs/v2-优化设计.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 文件名用"裸 sid"（去 session- 前缀），与 contextinjector per-sid 落盘 & host /status 读取一致
const normSid = (s) => String(s ?? 'unknown').replace(/^session-?/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)

// ============ 压缩器IO比（§2） ============
// 【2026-09-09（用户定名："压缩器IO比"）】
//   每轮记两个数，再给一个比值，不掺 S（系统提示字节）、不叫折扣：
//     inBytes  = 本轮喂进压缩器的原始内容 = shadowedBytes − 上一轮转录字节
//     outBytes = 本轮压缩器产出的转录增量 = transcriptBytes − 上一轮转录字节
//     ratio    = inBytes / outBytes   （输入/输出：值越大=压掉的量越大；≈1=没冗余可压；<1=输出比输入还大）
//   累计：cumIn/cumOut/cumRatio = cumIn / cumOut
//   读法：RCS 架构下主流程已无冗余可压（reasoning 外置、工具结果折成 [T] 行、DSH 管线噪音被清），
//   ratio≈1 属正常，只作**回归哨兵**（比值明显变大=冗余回流；<1=有内容被重复注入）。

export function ivrLoad(stateDir, sid) {
  try {
    const fp = join(stateDir, 'ivr', normSid(sid) + '.json')
    if (!existsSync(fp)) return null
    return JSON.parse(readFileSync(fp, 'utf8'))
  } catch { return null }
}

export function ivrEnsure(stateDir, sid, S) {
  mkdirSync(join(stateDir, 'ivr'), { recursive: true })
  const fp = join(stateDir, 'ivr', normSid(sid) + '.json')
  let st = null
  try { st = existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : null } catch { st = null }
  // 口径标记：旧文件（v1-role / v2-source）不与新口径混算 —— 旧轮次数据**整体重建丢弃**。
  //   ⚠ 破坏性行为（用户已知并接受）：旧 rounds 会被清空，老会话的历史 IO 数据不再保留、也不可比。
  if (!st || st.roundSemantics !== 'io') st = { sessionId: sid, lastTranscriptBytes: 0, rounds: [], roundSemantics: 'io' }
  if (!Array.isArray(st.rounds)) st.rounds = []
  void S // S（系统提示字节）在新口径中不再参与计算，仅为兼容旧调用签名而保留
  writeFileSync(fp, JSON.stringify(st, null, 2), 'utf8')
  return st
}

export function ivrRecord(stateDir, sid, fold) {
  const st = ivrEnsure(stateDir, sid)
  const prev = st.lastTranscriptBytes || 0
  const inBytes = Math.max(0, fold.shadowedBytes - prev)
  const outBytes = Math.max(0, fold.transcriptBytes - prev)
  const last = st.rounds[st.rounds.length - 1] || { cumIn: 0, cumOut: 0 }
  const cumIn = last.cumIn + inBytes
  const cumOut = last.cumOut + outBytes
  const ratio = outBytes > 0 ? inBytes / outBytes : 1
  const cumRatio = cumOut > 0 ? cumIn / cumOut : 1
  const round = {
    n: fold.n, step: fold.step, ts: fold.ts ?? Date.now(),
    inBytes, outBytes,
    ratio: Number(ratio.toFixed(4)),
    cumIn, cumOut,
    cumRatio: Number(cumRatio.toFixed(4)),
    shadowedBytes: fold.shadowedBytes, transcriptBytes: fold.transcriptBytes,
    stageAnchor: fold.stageAnchor === true, // §8 里程碑锚点
  }
  st.rounds.push(round)
  st.lastTranscriptBytes = fold.transcriptBytes
  st.cumRatio = round.cumRatio
  writeFileSync(join(stateDir, 'ivr', normSid(sid) + '.json'), JSON.stringify(st, null, 2), 'utf8')
  return round
}

export function ivrSeries(stateDir, sid) {
  const st = ivrLoad(stateDir, sid)
  return st ? st.rounds : []
}

export function ivrExport(stateDir, sid, format = 'csv') {
  const st = ivrLoad(stateDir, sid)
  if (!st) return ''
  if (format === 'json') return JSON.stringify(st, null, 2)
  const head = 'n,step,inBytes,outBytes,ratio,cumIn,cumOut,cumRatio,ts'
  const rows = st.rounds.map((r) => [r.n, r.step, r.inBytes, r.outBytes, r.ratio, r.cumIn, r.cumOut, r.cumRatio, r.ts].join(','))
  return [head, ...rows].join('\n')
}

// ============ 错误时间线（§6.4，append-only，对称 IVR） ============
// $STATE_DIR/errors/<sid>.jsonl —— 与 IVR 共用同一 session 时间线（同 sid、同轮号）
export function errAppend(stateDir, sid, entry) {
  try {
    mkdirSync(join(stateDir, 'errors'), { recursive: true })
    const fp = join(stateDir, 'errors', normSid(sid) + '.jsonl')
    appendFileSync(fp, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8')
  } catch { /* best-effort */ }
}