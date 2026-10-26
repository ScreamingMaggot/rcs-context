// Offline evidence regression for the Cycle-2 baseline artifacts and audit.
// Reads only files under work/memory-ledger-20261025/; no model, network, SQLite,
// or live-state access. Run: node tests/memory-baseline-artifact.test.mjs
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, 'work', 'memory-ledger-20261025')
const CORPUS = join(WORK, 'proposal-corpus.json')
const BASELINE = join(WORK, 'proposal-baseline.json')
const SMOKE = join(WORK, 'proposal-smoke.json')
const AUDIT = join(WORK, 'audit.json')

let fails = 0
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!condition) fails++
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const hex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

if (![CORPUS, BASELINE, SMOKE].every((file) => existsSync(file))) {
  // These artifacts are committed evidence and every check below is meaningless
  // without them. A skip would make run-all green while verifying nothing.
  console.log('FAIL  baseline artifacts are required for this regression')
  process.exit(1)
}

const corpusBytes = readFileSync(CORPUS)
const corpus = JSON.parse(corpusBytes)
const corpusSha = sha256(corpusBytes)
const baseline = readJson(BASELINE)
const smoke = readJson(SMOKE)

// ---- Baseline and smoke are rebuilds over the original inference ----------
for (const [label, artifact] of [['baseline', baseline], ['smoke', smoke]]) {
  const regeneration = artifact.regeneration ?? {}
  check(`${label}: artifact was rebuilt without inference`,
    regeneration.modelCallsThisInvocation === 0 &&
    regeneration.rebuiltWithoutInference === true &&
    artifact.timing?.thisInvocation?.modelCalls === 0,
    JSON.stringify({
      modelCalls: regeneration.modelCallsThisInvocation,
      rebuilt: regeneration.rebuiltWithoutInference,
    }))
  check(`${label}: every cached answer was rescored without drift`,
    regeneration.rescoredCases === artifact.cases.length &&
    regeneration.rescoreIdentical === artifact.cases.length &&
    Array.isArray(regeneration.rescoreDriftedCaseIds) &&
    regeneration.rescoreDriftedCaseIds.length === 0)
  check(`${label}: raw model output was preserved byte-for-byte`,
    artifact.cases.every((entry) =>
      typeof entry.raw === 'string' && sha256(entry.raw) === entry.rawSha256 &&
      sha256(entry.prompt) === entry.promptSha256))
  check(`${label}: corpus labels and hashes are unchanged`,
    artifact.corpus.sha256 === corpusSha &&
    artifact.identity.corpusSha256 === corpusSha &&
    artifact.corpus.caseCount === corpus.cases.length &&
    artifact.cases.every((entry) => corpus.cases.some((item) => item.id === entry.id)))
  check(`${label}: no route was written or enabled`,
    artifact.routeState?.routesWritten === false &&
    Array.isArray(artifact.routeState?.enabledNow) &&
    artifact.routeState.enabledNow.length === 0 &&
    artifact.summary.routesEnabled.length === 0)
}

// ---- Machine-readable measurement caveats ---------------------------------
const caveats = baseline.measurementCaveats
check('measurement caveats name scorer clause rules for recall',
  caveats?.recall?.measuredUnder === 'scorer-clause-rules' &&
  caveats.recall.productionRule === 'clause-aligned-unique-span' &&
  caveats.recall.upperBoundOnProductionAcceptance === true)
check('measurement caveats mark correction cases as a lower bound',
  caveats?.correctionCases?.degenerateActiveFacts === true &&
  caveats.correctionCases.correctionResultsLowerBound === true &&
  caveats.correctionCases.activeFactTextSource === 'absent-from-corpus' &&
  caveats.correctionCases.syntheticTargetFields?.text === null &&
  caveats.correctionCases.syntheticTargetFields?.validFrom === 500 &&
  caveats.correctionCases.syntheticTargetFields?.seq === 0 &&
  caveats.corpusLabelsModified === false)
check('degraded prompt caveat lists exactly the correction/retraction targets',
  baseline.degradedPrompts?.code === 'active-fact-text-missing' &&
  baseline.degradedPrompts.correctionResultsLowerBound === true &&
  baseline.degradedPrompts.syntheticCorrectionTargetDefaults?.text === null &&
  baseline.degradedPrompts.syntheticCorrectionTargetDefaults?.validFrom === 500 &&
  baseline.degradedPrompts.syntheticCorrectionTargetDefaults?.seq === 0 &&
  baseline.degradedPrompts.activeFactTextMissingCaseIds.length ===
    baseline.degradedPrompts.cases.length &&
  baseline.degradedPrompts.activeFactTextMissingCaseIds.length > 0)

const correctionCases = baseline.cases.filter((entry) =>
  baseline.degradedPrompts.activeFactTextMissingCaseIds.includes(entry.id))
check('each correction target records the synthetic fields actually used',
  correctionCases.length > 0 && correctionCases.every((entry) =>
    entry.syntheticCorrectionTargets.length > 0 &&
    entry.syntheticCorrectionTargets.every((target) =>
      target.synthetic === true &&
      (target.text === null || typeof target.text === 'string')) &&
    entry.syntheticCorrectionTargets.every((target) =>
      target.validFrom === 500 && target.seq === 0 &&
      target.syntheticValidFrom === target.validFrom &&
      target.syntheticSeq === target.seq)))

// ---- Route evidence is digest- and corpus-bound, never bare counters ------
const routeEvidence = baseline.routeState?.routeEvidenceByPredicate ?? {}
const predicates = Object.keys(routeEvidence)
check('route evidence covers every semantic predicate',
  predicates.length === 3 &&
  ['project.decision', 'project.constraint', 'project.preference']
    .every((predicate) => Object.hasOwn(routeEvidence, predicate)))
check('route evidence carries corpus, evaluator and model identities',
  predicates.every((predicate) => {
    const evidence = routeEvidence[predicate]
    return hex64(evidence.corpusSha256) &&
      hex64(evidence.evaluatorSha256) &&
      evidence.corpusSha256 === corpusSha &&
      evidence.evaluatorSha256 === baseline.audit.evaluator.sha256 &&
      typeof evidence.modelDigest === 'string' && evidence.modelDigest.trim() !== '' &&
      evidence.modelDigest === baseline.identity.digest &&
      Number.isFinite(evidence.measuredAt)
  }))
check('route precision and recall are derived from tp/fp/fn',
  predicates.every((predicate) => {
    const evidence = routeEvidence[predicate]
    const precision = evidence.tp / (evidence.tp + evidence.fp)
    const recall = evidence.tp / (evidence.tp + evidence.fn)
    return evidence.tp + evidence.fn === evidence.positiveLabels &&
      evidence.precision === precision &&
      evidence.recall === recall
  }))
check('route evidence mirrors the evaluator counters exactly',
  predicates.every((predicate) => {
    const evidence = routeEvidence[predicate]
    const route = baseline.metrics.routes[predicate]
    const bucket = baseline.metrics.byPredicate[predicate]
    return evidence.tp === bucket.tp && evidence.fp === bucket.fp &&
      evidence.fn === bucket.fn && evidence.recall === route.recall &&
      evidence.precision === route.precision &&
      evidence.safetyFailures === route.safetyFailures
  }))

// ---- Isolated audit evidence ---------------------------------------------
if (!existsSync(AUDIT)) {
  console.log('FAIL  audit.json is required for this regression')
  process.exit(1)
}
const audit = readJson(AUDIT)
check('audit passes its 4 preconditions and 13 measured checks',
  audit.verdict === 'PASS' &&
  audit.checkSummary.preconditionsPassed === 4 &&
  audit.checkSummary.preconditionsTotal === 4 &&
  audit.checkSummary.checksPassed === 13 &&
  audit.checkSummary.checksTotal === 13 &&
  audit.failedChecks.length === 0)
check('audit measured the proposal layer with initialized journal tables',
  audit.proposalLayer.measured === true &&
  audit.proposalLayer.tablesPresent === true &&
  audit.proposalLayer.unmeasuredReason === null &&
  audit.proposalLayer.runs === 0 &&
  audit.proposalLayer.routesEnabled === 0)
check('audit reports no live proposal ingestion or route',
  audit.proposalLayer.liveIngestion === false &&
  audit.proposalLayer.proposals === 0)
check('audit records wal/shm sidecars and an unchanged live database hash',
  audit.isolation.liveSidecars?.before?.wal !== undefined &&
  audit.isolation.liveSidecars?.before?.shm !== undefined &&
  audit.isolation.liveSidecars?.after?.wal !== undefined &&
  audit.isolation.liveSidecars?.after?.shm !== undefined &&
  hex64(audit.evidence.sourceSha256Before) &&
  audit.evidence.sourceSha256Before === audit.evidence.sourceSha256After &&
  audit.isolation.liveDatabase.before.sha256 === audit.isolation.liveDatabase.after.sha256 &&
  audit.evidence.sourceWriteRejected === true)

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
