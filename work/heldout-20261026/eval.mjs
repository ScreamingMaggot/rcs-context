#!/usr/bin/env node
// Reproduces the held-out #1 confusion matrix from the frozen sample and the two
// independent label files. Read-only.
//
//   node eval.mjs
//   node eval.mjs --strict-neg=h121,h122
//   node eval.mjs --json
//
// A/B agreement means both annotators returned the same `durable` boolean.
// Disagreements are excluded from the matrix and listed separately.
// `--strict-neg` reclassifies the named agreed positives as negatives, which is
// how the strict adjudication of assignment requirements is reported.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { analyzeDurableUtterance, DURABILITY_POLICY_VERSION } from '../../web/memory-durability.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const opt = { dir: here, strictNeg: new Set(), json: false }

for (const arg of process.argv.slice(2)) {
  if (arg === '--json') opt.json = true
  else if (arg.startsWith('--dir=')) opt.dir = path.resolve(arg.slice('--dir='.length))
  else if (arg.startsWith('--strict-neg=')) {
    for (const id of arg.slice('--strict-neg='.length).split(',')) {
      if (id.trim()) opt.strictNeg.add(id.trim())
    }
  } else {
    console.error(`unknown argument: ${arg}`)
    process.exit(2)
  }
}

const fileOf = (name) => path.join(opt.dir, name)

function readJsonl(name) {
  const text = fs.readFileSync(fileOf(name), 'utf8')
  const rows = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`${name}:${i + 1}: ${error.message}`)
    }
  })
  return rows
}

function indexById(rows, name) {
  const map = new Map()
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') throw new Error(`${name}: id missing`)
    if (map.has(row.id)) throw new Error(`${name}: duplicate id ${row.id}`)
    if (typeof row.durable !== 'boolean') throw new Error(`${name}: ${row.id} durable is not boolean`)
    map.set(row.id, row)
  }
  return map
}

function sha256(name) {
  return crypto.createHash('sha256').update(fs.readFileSync(fileOf(name))).digest('hex')
}

function wilson(k, n, z = 1.959963984540054) {
  if (n === 0) return [0, 0]
  const p = k / n
  const den = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

const sample = readJsonl('sample.jsonl')
const labelsA = indexById(readJsonl('labels-a.jsonl'), 'labels-a.jsonl')
const labelsB = indexById(readJsonl('labels-b.jsonl'), 'labels-b.jsonl')

const counts = { TP: 0, FN: 0, FP: 0, TN: 0 }
const fpClassA = {}
const fpClassB = {}
const positives = []
const falseNegatives = []
const disagreements = []
let agreed = 0
let gatePasses = 0

for (const row of sample) {
  const a = labelsA.get(row.id)
  const b = labelsB.get(row.id)
  if (!a || !b) throw new Error(`sample.jsonl: ${row.id} has no label from both annotators`)
  if (typeof row.text !== 'string') throw new Error(`sample.jsonl: ${row.id} text is not a string`)

  const prediction = analyzeDurableUtterance(row.text)
  if (prediction.eligible) gatePasses += 1

  if (a.durable !== b.durable) {
    disagreements.push({
      id: row.id,
      A: a.durable,
      B: b.durable,
      classA: a.negativeClass ?? null,
      classB: b.negativeClass ?? null,
      gate: prediction.eligible,
      text: row.text,
    })
    continue
  }

  agreed += 1
  const gold = opt.strictNeg.has(row.id) ? false : a.durable
  const predicted = prediction.eligible

  if (gold && predicted) counts.TP += 1
  else if (gold && !predicted) {
    counts.FN += 1
    falseNegatives.push({ id: row.id, reason: prediction.reason, text: row.text })
  } else if (!gold && predicted) {
    counts.FP += 1
    const keyA = a.negativeClass ?? 'null'
    const keyB = b.negativeClass ?? 'null'
    fpClassA[keyA] = (fpClassA[keyA] ?? 0) + 1
    fpClassB[keyB] = (fpClassB[keyB] ?? 0) + 1
  } else counts.TN += 1

  if (a.durable) {
    positives.push({ id: row.id, gate: predicted, strictNegative: opt.strictNeg.has(row.id), text: row.text })
  }
}

if (agreed === 0) throw new Error('no agreed labels')
const negatives = counts.FP + counts.TN
const fpRate = counts.FP / negatives
const [fpLow, fpHigh] = wilson(counts.FP, negatives)
const [passLow, passHigh] = wilson(gatePasses, sample.length)

const result = {
  dir: opt.dir,
  policyVersion: DURABILITY_POLICY_VERSION,
  sample: sample.length,
  agreed,
  disagreements: disagreements.length,
  gatePasses,
  gatePassRate: gatePasses / sample.length,
  gatePassRateWilson95: [passLow, passHigh],
  matrix: counts,
  fpRate,
  fpRateWilson95: [fpLow, fpHigh],
  fpClassA,
  fpClassB,
  strictNeg: [...opt.strictNeg],
  positives,
  falseNegatives,
  disagreementsDetail: disagreements,
  hashes: {
    'sample.jsonl': sha256('sample.jsonl'),
    'labels-a.jsonl': sha256('labels-a.jsonl'),
    'labels-b.jsonl': sha256('labels-b.jsonl'),
  },
}

if (opt.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const pct = (x) => `${(x * 100).toFixed(1)}%`
  console.log(`dir            ${result.dir}`)
  console.log(`policy         ${result.policyVersion}`)
  console.log(`sample         ${result.sample}  agreed ${result.agreed}  disagreements ${result.disagreements}`)
  console.log(`gate passes    ${result.gatePasses}/${result.sample} = ${pct(result.gatePassRate)} (Wilson ${pct(passLow)}–${pct(passHigh)})`)
  console.log(`TP/FN/FP/TN    ${counts.TP}/${counts.FN}/${counts.FP}/${counts.TN}`)
  console.log(`FP rate        ${counts.FP}/${negatives} = ${pct(fpRate)} (Wilson ${pct(fpLow)}–${pct(fpHigh)})`)
  console.log(`FP class (A)   ${JSON.stringify(fpClassA)}`)
  console.log(`FP class (B)   ${JSON.stringify(fpClassB)}`)
  if (opt.strictNeg.size) console.log(`strict-neg     ${[...opt.strictNeg].join(',')}`)
  console.log('positives')
  for (const p of positives) {
    console.log(`  ${p.id} gate=${p.gate ? 'pass' : 'MISS'}${p.strictNegative ? ' strict=neg' : ''}  ${p.text.slice(0, 70).replace(/\s+/g, ' ')}`)
  }
  console.log('false negatives')
  for (const p of falseNegatives) console.log(`  ${p.id} reason=${p.reason}  ${p.text.slice(0, 70).replace(/\s+/g, ' ')}`)
  console.log('disagreements')
  for (const d of disagreements) {
    console.log(`  ${d.id} A=${d.A}(${d.classA}) B=${d.B}(${d.classB}) gate=${d.gate ? 'pass' : 'drop'}  ${d.text.slice(0, 60).replace(/\s+/g, ' ')}`)
  }
  console.log('hashes')
  for (const [name, hash] of Object.entries(result.hashes)) console.log(`  ${name} ${hash}`)
}
