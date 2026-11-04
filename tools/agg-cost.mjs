#!/usr/bin/env node
// agg-cost.mjs — 用真实调用记录标定「一次浓缩调用的计费成本」，为经济性准入闸提供常数。
//   数据源：tools/.probe/p-*.json（每条含 usage: inputTokens/cacheReadTokens/outputTokens）
//   模型：cost_billed(S) = a·S + b   （S = 原文 token 数；b = 被缓存的系统提示词开销）
//        benefit_per_turn(S) = (1-r)·S·D
//        break-even 剩余回合 m*(S) = (a·S + b) / ((1-r)·S·D)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const P = join(import.meta.dirname, '.probe')
const D = Number(process.env.BENCH_D ?? 0.25)
const rows = []
for (const f of readdirSync(P)) {
  if (!f.startsWith('p-') || !f.endsWith('.json')) continue
  let j; try { j = JSON.parse(readFileSync(join(P, f), 'utf8')) } catch { continue }
  for (const r of j.rows ?? []) {
    if (!r.ok || !r.usage) continue
    rows.push({
      chars: r.chars ?? null,
      inTok: r.usage.inputTokens ?? 0,
      cacheTok: r.usage.cacheReadTokens ?? 0,
      outTok: r.usage.outputTokens ?? 0,
      ratio: typeof r.ratio === 'number' ? r.ratio : null,
      variant: r.variant,
      maxTokens: r.maxTokens,
      effort: r.effort,
    })
  }
}
if (!rows.length) { console.error('no probe rows with usage'); process.exit(1) }

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

console.log(`=== 真实调用成本（n=${rows.length} 条带 usage 的探针记录，D=${D}）===`)
console.log('inTok(未缓存)中位'.padStart(18) + 'cacheTok中位'.padStart(13) + 'outTok中位'.padStart(11) + 'cache占比中位'.padStart(14) + 'ratio中位'.padStart(10) + 'costBilled中位'.padStart(15))
const inMed = med(rows.map((r) => r.inTok))
const cacheMed = med(rows.map((r) => r.cacheTok))
const outMed = med(rows.map((r) => r.outTok))
const ratioMed = med(rows.map((r) => r.ratio).filter((x) => x != null))
const costMed = med(rows.map((r) => r.inTok + r.cacheTok * D))
console.log(String(Math.round(inMed)).padStart(18) + String(Math.round(cacheMed)).padStart(13) + String(Math.round(outMed)).padStart(11) +
  (cacheMed / (inMed + cacheMed)).toFixed(3).padStart(14) + ratioMed.toFixed(3).padStart(10) + String(Math.round(costMed)).padStart(15))

// 按原文规模分桶，标定 a（与 S 成正比的部分）与 b（常数：被缓存的系统提示词）
console.log(`\n=== 按原文规模分桶（chars → token 近似 /4）===`)
console.log('chars'.padStart(7) + 'n'.padStart(4) + 'inTok'.padStart(8) + 'cacheTok'.padStart(10) + 'outTok'.padStart(8) + 'costBilled'.padStart(12) + '  收益/回合'.padStart(11) + '  m*'.padStart(7))
const buckets = [...new Set(rows.map((r) => r.chars).filter((x) => x != null))].sort((a, b) => a - b)
const fit = []
for (const c of buckets) {
  const g = rows.filter((r) => r.chars === c)
  const sTok = c / 4
  const i = med(g.map((r) => r.inTok)), cc = med(g.map((r) => r.cacheTok)), o = med(g.map((r) => r.outTok))
  const cost = i + cc * D
  const rr = med(g.map((r) => r.ratio).filter((x) => x != null))
  const ben = (sTok - o) * D
  console.log(String(c).padStart(7) + String(g.length).padStart(4) + String(Math.round(i)).padStart(8) + String(Math.round(cc)).padStart(10) + String(Math.round(o)).padStart(8) + String(Math.round(cost)).padStart(12) + ben.toFixed(1).padStart(11) + (ben > 0 ? (cost / ben).toFixed(1) : 'n/a').padStart(7))
  if (ben > 0) fit.push({ sTok, cost, i, cc })
}

// 最小二乘拟合 cost = a·S + b
if (fit.length >= 2) {
  const n = fit.length
  const sx = fit.reduce((a, r) => a + r.sTok, 0), sy = fit.reduce((a, r) => a + r.cost, 0)
  const sxx = fit.reduce((a, r) => a + r.sTok * r.sTok, 0), sxy = fit.reduce((a, r) => a + r.sTok * r.cost, 0)
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx), b = (sy - a * sx) / n
  console.log(`\n=== 拟合：cost_billed ≈ ${a.toFixed(3)}·S + ${b.toFixed(1)}  （S = 原文 token）===`)
  const rr = ratioMed
  const D2 = D
  const benefit = (S) => (1 - rr) * S * D2
  console.log(`渐进临界回合 = 1/((1-r)·D) = ${(1 / ((1 - rr) * D2)).toFixed(2)}  （r=${rr.toFixed(3)}）`)
  console.log(`\n不同「剩余回合 m」下的最小可折原文规模（字节，chars = 4·S）：`)
  for (const m of [4, 6, 8, 10, 12, 16, 20]) {
    const S = b / (benefit(1) * m - a)
    if (!(S > 0) || !Number.isFinite(S)) { console.log(`  m=${String(m).padStart(2)} → 无解（该 m 下永远不划算）`); continue }
    console.log(`  m=${String(m).padStart(2)} → S ≥ ${Math.round(S).toString().padStart(6)} tok ≈ ${Math.round(S * 4).toString().padStart(6)} 字节`)
  }
}
