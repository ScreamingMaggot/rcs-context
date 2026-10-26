// Analyze the repeated attribution matrix and decide whether more repetitions
// materially narrow uncertain rates.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = path.dirname(fileURLToPath(import.meta.url))
const input = process.argv[2] ?? path.join(BASE, 'semantic-attribution-result.json')
const output = process.argv[3] ?? path.join(BASE, 'semantic-attribution-analysis.json')
const data = JSON.parse(fs.readFileSync(input, 'utf8'))
const raw = data.raw ?? []

function wilson(successes, total, z = 1.96) {
  if (total === 0) return { rate: null, low: null, high: null, halfWidth: null }
  const p = successes / total
  const denom = 1 + z * z / total
  const center = (p + z * z / (2 * total)) / denom
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denom
  return { rate: p, low: Math.max(0, center - margin), high: Math.min(1, center + margin), halfWidth: margin }
}

function contentHit(row, mode) {
  const accepted = row[mode].accepted ?? []
  if (!row.item.expected.length) return accepted.length === 0
  return row.item.expected.every((expected) =>
    accepted.some((proposal) =>
      String(proposal.quote).replace(/\s+/g, ' ').includes(
        String(expected.phrase).replace(/\s+/g, ' '),
      )))
}

function summarizeModel(model, reps) {
  const rows = raw.filter((row) => row.model === model)
  const positive = rows.filter((row) => row.item.expected.length > 0)
  const negative = rows.filter((row) => row.item.expected.length === 0)
  const classes = {}
  for (const cls of [...new Set(rows.map((row) => row.item.class))]) {
    const subset = rows.filter((row) => row.item.class === cls)
    const ok = subset.filter((row) => row.strict.hit).length
    const contentStrict = subset.filter((row) => contentHit(row, 'strict')).length
    const contentRelaxed = subset.filter((row) => contentHit(row, 'relaxed')).length
    classes[cls] = {
      samples: subset.length,
      success: ok,
      contentSuccessStrict: contentStrict,
      contentRateStrict: contentStrict / subset.length,
      contentSuccessRelaxed: contentRelaxed,
      contentRateRelaxed: contentRelaxed / subset.length,
      ...wilson(ok, subset.length),
      falsePositiveCases: subset.filter((row) => row.strict.falsePositive > 0).length,
    }
  }
  const strictPositive = positive.filter((row) => row.strict.hit).length
  const relaxedPositive = positive.filter((row) => row.relaxed.hit).length
  const strictContentPositive = positive.filter((row) => contentHit(row, 'strict')).length
  const relaxedContentPositive = positive.filter((row) => contentHit(row, 'relaxed')).length
  const strictNegativeOk = negative.filter((row) => row.strict.hit).length
  const relaxedNegativeOk = negative.filter((row) => row.relaxed.hit).length
  const wrongPredicateStrict = positive.filter((row) =>
    contentHit(row, 'strict') && !row.strict.hit).length
  const wrongPredicateRelaxed = positive.filter((row) =>
    contentHit(row, 'relaxed') && !row.relaxed.hit).length
  const strictAccepted = rows.reduce((n, row) => n + row.strict.accepted.length, 0)
  const strictCorrect = rows.reduce((n, row) => n + row.strict.correct, 0)
  const relaxedAccepted = rows.reduce((n, row) => n + row.relaxed.accepted.length, 0)
  const relaxedCorrect = rows.reduce((n, row) => n + row.relaxed.correct, 0)
  const perCase = {}
  for (const id of [...new Set(rows.map((row) => row.item.id))]) {
    const subset = rows.filter((row) => row.item.id === id)
    perCase[id] = {
      class: subset[0].item.class,
      reps: subset.length,
      strictHits: subset.filter((row) => row.strict.hit).length,
      relaxedHits: subset.filter((row) => row.relaxed.hit).length,
      strictContentHits: subset.filter((row) => contentHit(row, 'strict')).length,
      relaxedContentHits: subset.filter((row) => contentHit(row, 'relaxed')).length,
      boundaryRescues: subset.filter((row) => row.boundaryRescue).length,
      strictFalsePositiveSamples: subset.filter((row) => row.strict.falsePositive > 0).length,
      mixed: (() => {
        const hits = subset.filter((row) => row.strict.hit).length
        return hits > 0 && hits < subset.length
      })(),
    }
  }
  const mixedCases = Object.values(perCase).filter((row) => row.mixed).length
  const recallStrict = wilson(strictPositive, positive.length)
  const recallRelaxed = wilson(relaxedPositive, positive.length)
  const fpStrict = wilson(negative.length - strictNegativeOk, negative.length)
  const fpRelaxed = wilson(negative.length - relaxedNegativeOk, negative.length)
  const overallStrict = wilson(strictPositive + strictNegativeOk, rows.length)
  const overallRelaxed = wilson(relaxedPositive + relaxedNegativeOk, rows.length)
  return {
    model,
    reps,
    samples: rows.length,
    classes,
    positive: {
      samples: positive.length,
      strictRecall: recallStrict,
      relaxedRecall: recallRelaxed,
      strictContentRecall: wilson(strictContentPositive, positive.length),
      relaxedContentRecall: wilson(relaxedContentPositive, positive.length),
      wrongPredicateSamplesStrict: wrongPredicateStrict,
      wrongPredicateSamplesRelaxed: wrongPredicateRelaxed,
    },
    negative: {
      samples: negative.length,
      strictFalsePositiveRate: fpStrict,
      relaxedFalsePositiveRate: fpRelaxed,
    },
    overall: {
      strictAccuracy: overallStrict,
      relaxedAccuracy: overallRelaxed,
    },
    precision: {
      strict: strictAccepted ? strictCorrect / strictAccepted : null,
      relaxed: relaxedAccepted ? relaxedCorrect / relaxedAccepted : null,
    },
    boundaryRescueSamples: rows.filter((row) => row.boundaryRescue).length,
    parseFailures: rows.filter((row) => row.parseError).length,
    mixedCases,
    perCase,
  }
}

const models = [...new Set(raw.map((row) => row.model))]
const result = {
  input,
  updatedAt: data.updatedAt,
  models: {},
  decisions: {},
}
for (const model of models) {
  const reps = Math.max(...raw.filter((row) => row.model === model).map((row) => row.rep))
  const summary = summarizeModel(model, reps)
  result.models[model] = summary
  const uncertain = [
    summary.positive.strictRecall.halfWidth,
    summary.negative.strictFalsePositiveRate.halfWidth,
    summary.overall.strictAccuracy.halfWidth,
  ].filter((value) => value !== null)
  const maxHalfWidth = Math.max(...uncertain)
  const unstableButMeasured = summary.reps >= 24 && summary.mixedCases > 0
  const stableEnough = summary.mixedCases === 0 && maxHalfWidth <= 0.10
  const moreRepsRecommended = !stableEnough && !unstableButMeasured
  result.decisions[model] = {
    maxWilsonHalfWidth: maxHalfWidth,
    mixedCaseCount: summary.mixedCases,
    moreRepsRecommended,
    reason: stableEnough
      ? 'All cases were outcome-stable across repetitions and the 95% Wilson intervals are within ±0.10.'
      : unstableButMeasured
        ? 'Intervals are narrow at 24 repetitions; remaining per-case variation is measured model stochasticity, not sampling uncertainty.'
        : 'Outcomes vary across repetitions; extend sampling to at least 24 before treating rates as stable.',
  }
}

fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', 'utf8')
const printable = {
  models: Object.fromEntries(Object.entries(result.models).map(([model, summary]) => [model, {
    reps: summary.reps,
    strictRecall: summary.positive.strictRecall,
    relaxedRecall: summary.positive.relaxedRecall,
    strictContentRecall: summary.positive.strictContentRecall,
    relaxedContentRecall: summary.positive.relaxedContentRecall,
    wrongPredicateSamplesStrict: summary.positive.wrongPredicateSamplesStrict,
    wrongPredicateSamplesRelaxed: summary.positive.wrongPredicateSamplesRelaxed,
    strictFPRate: summary.negative.strictFalsePositiveRate,
    relaxedFPRate: summary.negative.relaxedFalsePositiveRate,
    precision: summary.precision,
    classes: Object.fromEntries(Object.entries(summary.classes).map(([cls, value]) => [cls, {
      samples: value.samples, success: value.success, rate: value.rate, low: value.low, high: value.high,
      contentRateStrict: value.contentRateStrict, contentRateRelaxed: value.contentRateRelaxed,
    }])),
    boundaryRescueSamples: summary.boundaryRescueSamples,
    parseFailures: summary.parseFailures,
    mixedCases: summary.mixedCases,
  }])),
  decisions: result.decisions,
}
console.log(JSON.stringify(printable, null, 2))
