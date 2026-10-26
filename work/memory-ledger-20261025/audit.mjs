// Task 6: isolated TESTSPACE shadow-ledger audit.
//
// SHADOW-ONLY. The live state-compiler database is opened read-only exactly once,
// copied with SQLite VACUUM INTO, and closed before any migration or probing. Every
// subsequent read/write happens on the copy or on a brand-new shadow ledger.
// Nothing here changes live DSH state, the live profile, or live injection.
//
// The verdict is computed from measured evidence only. Literal "it is true because
// we said so" claims are separated into `assertions`, labelled `measured: false`,
// and excluded from the PASS count. Hard preconditions reject a vacuous PASS:
// migrated rows must exist, probe outcomes must partition them exactly, every
// migrated path must be probed exactly once, and at least one present path must
// carry a byte-derived force hash.
//
// Usage (both arguments are mandatory; there is no implicit live default):
//   node work/memory-ledger-20261025/audit.mjs \
//     --source C:\Users\Administrator\.dsh\state-compiler\memory\memory.sqlite \
//     --out D:\RCS\src\work\memory-ledger-20261025

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { readFile, realpath as realpathAsync, stat as statAsync } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fileEntityRef,
  observationFromLegacy,
  observationFromProbe,
} from '../../web/memory-observations.mjs'
import { renderFacts, routeRowValid } from '../../web/memory-ledger-core.mjs'
import { MemoryLedger } from '../../web/memory-ledger.mjs'
import { ProposalJournal } from '../../web/memory-proposal-store.mjs'

const DEFAULT_SCOPE = 'ws:c:/users/administrator/desktop/testspace'
const DEFAULT_WORKSPACE_ROOT = 'C:\\Users\\Administrator\\Desktop\\TESTSPACE'
const DEFAULT_BUDGET = 4000
const OUTPUT_NAMES = ['source-copy.sqlite', 'shadow-ledger.sqlite']
// Guards against a silently emptied check list: a PASS requires this many measured
// checks plus the four hard preconditions.
const REQUIRED_CHECK_COUNT = 13

export class UsageError extends Error {}

function usage() {
  return [
    'usage: node work/memory-ledger-20261025/audit.mjs --source <memory.sqlite> --out <directory>',
    '       [--scope <workspace scope>] [--workspace-root <path>] [--budget <chars>]',
    '',
    'Required: --source and --out. The live database is never opened writable and',
    'there is no implicit default source path. --out must stay outside the source',
    "database's parent state directory (realpath-resolved).",
  ].join('\n')
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`)
    const equals = token.indexOf('=')
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
    const value = equals === -1 ? argv[++index] : token.slice(equals + 1)
    if (!['source', 'out', 'scope', 'workspace-root', 'budget'].includes(name)) {
      throw new UsageError(`unknown option: --${name}`)
    }
    if (value === undefined || value === '') throw new UsageError(`--${name} requires a value`)
    values[name] = value
  }
  if (!values.source) throw new UsageError('--source is required (no implicit live default)')
  if (!values.out) throw new UsageError('--out is required (no implicit output default)')
  const budget = values.budget === undefined ? DEFAULT_BUDGET : Number(values.budget)
  if (!Number.isFinite(budget) || budget <= 0) throw new UsageError('--budget must be a positive number')
  return {
    source: values.source,
    out: values.out,
    scope: values.scope ?? DEFAULT_SCOPE,
    workspaceRoot: values['workspace-root'] ?? DEFAULT_WORKSPACE_ROOT,
    budget,
  }
}

// ---------------------------------------------------------------------------
// Path identity guards (realpath-based, alias-proof).
// ---------------------------------------------------------------------------

export function pathRelation(child, parent) {
  const normalize = (value) => {
    let text = resolve(value).replace(/\\/g, '/')
    if (process.platform === 'win32') text = text.toLowerCase()
    if (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
    return text
  }
  const left = normalize(child)
  const right = normalize(parent)
  if (left === right) return 'equal'
  return left.startsWith(right.endsWith('/') ? right : `${right}/`) ? 'inside' : 'outside'
}

// Resolves a path that may not exist yet by realpath-ing the nearest existing
// ancestor and re-appending the missing segments. Junction/symlink aliases in the
// existing portion are therefore resolved before any comparison.
export function canonicalProspectivePath(target) {
  const absolute = resolve(target)
  const missing = []
  let current = absolute
  for (;;) {
    if (existsSync(current)) return resolve(realpathSync.native(current), ...missing)
    const parent = dirname(current)
    if (parent === current) return absolute
    missing.unshift(basename(current))
    current = parent
  }
}

export function assertAuditPaths({ source, out, outputNames = OUTPUT_NAMES }) {
  const sourceGiven = resolve(source)
  let sourceStat
  try {
    sourceStat = statSync(sourceGiven)
  } catch {
    throw new UsageError(`--source does not exist or is unreadable: ${sourceGiven}`)
  }
  if (!sourceStat.isFile()) throw new UsageError(`--source is not a file: ${sourceGiven}`)

  const sourceReal = realpathSync.native(sourceGiven)
  const stateDirectoryReal = realpathSync.native(dirname(sourceGiven))
  const outReal = canonicalProspectivePath(out)

  const outRelation = pathRelation(outReal, stateDirectoryReal)
  if (outRelation !== 'outside') {
    throw new UsageError(
      `refusing to run: output directory ${outReal} is ` +
      `${outRelation === 'equal' ? 'the' : 'inside the'} source database state directory ` +
      `${stateDirectoryReal}`,
    )
  }

  const outputs = outputNames.map((name) => {
    const target = join(outReal, name)
    return { name, path: resolve(target), real: canonicalProspectivePath(target) }
  })
  for (const output of outputs) {
    if (pathRelation(output.real, sourceReal) === 'equal') {
      throw new UsageError(
        `refusing to run: the source database resolves to audit output path ${output.real}`,
      )
    }
  }

  return {
    source: sourceGiven,
    sourceReal,
    stateDirectoryReal,
    out: outReal,
    outputs,
  }
}

// ---------------------------------------------------------------------------
// Verdict: every check is measured; every precondition must be non-vacuous.
// ---------------------------------------------------------------------------

export function computeAuditChecks(evidence) {
  const value = evidence
  const preconditions = [
    {
      name: 'migrated-rows-present',
      kind: 'precondition',
      required: 'migrated legacy file_state rows > 0',
      observed: { migratedRows: value.migratedRows },
      ok: Number.isInteger(value.migratedRows) && value.migratedRows > 0,
    },
    {
      name: 'probe-outcomes-partition-migrated',
      kind: 'precondition',
      required: 'probesAttempted === migratedRows and present + missing + errors === migratedRows',
      observed: {
        migratedRows: value.migratedRows,
        probesAttempted: value.probesAttempted,
        present: value.present,
        missing: value.missing,
        errors: value.errors,
        outcomeSum: value.present + value.missing + value.errors,
      },
      ok: value.probesAttempted === value.migratedRows &&
        value.present + value.missing + value.errors === value.migratedRows,
    },
    {
      name: 'unique-probed-paths-equal-migrated',
      kind: 'precondition',
      required: 'unique probed paths === migratedRows (not path group count)',
      observed: {
        uniqueProbedPaths: value.uniqueProbedPaths,
        migratedRows: value.migratedRows,
      },
      ok: value.uniqueProbedPaths === value.migratedRows,
    },
    {
      name: 'present-paths-force-hashed',
      kind: 'precondition',
      required: 'present > 0 and present force-hash count === present',
      observed: { present: value.present, presentHashed: value.presentHashed },
      ok: value.present > 0 && value.presentHashed === value.present,
    },
  ]

  const checks = [
    {
      name: 'missing-content-facts-not-current',
      kind: 'content',
      ok: value.missingContentFacts === 0,
      observed: {
        missingContentFacts: value.missingContentFacts,
        missingPaths: value.missing,
        missingPathFactsInLedger: value.missingPathFactsInLedger,
      },
    },
    {
      name: 'probe-errors-do-not-leak-content',
      kind: 'content',
      ok: value.productionErrorLeaks === 0,
      observed: {
        errorContentFacts: value.errorContentFacts,
        productionErrorLeaks: value.productionErrorLeaks,
      },
    },
    {
      name: 'production-render-no-absence-markers',
      kind: 'render',
      ok: value.absenceMarkersInText === 0,
      observed: {
        absenceMarkerFactsInLedger: value.absenceMarkerFactsInLedger,
        absenceMarkersInText: value.absenceMarkersInText,
      },
    },
    {
      name: 'production-render-no-missing-path-leakage',
      kind: 'render',
      ok: value.productionMissingLeaks === 0,
      observed: {
        missingPaths: value.missing,
        missingPathFactsInLedger: value.missingPathFactsInLedger,
        productionMissingLeaks: value.productionMissingLeaks,
      },
    },
    {
      name: 'production-render-verified-facts-only',
      kind: 'render',
      ok: value.productionUnverified === 0,
      observed: { productionUnverified: value.productionUnverified },
    },
    {
      name: 'production-render-nonempty',
      kind: 'render',
      ok: value.candidateFacts > 0 && value.productionSelected > 0 &&
        value.productionTextLength > 0,
      observed: {
        candidateFacts: value.candidateFacts,
        productionSelected: value.productionSelected,
        productionTextLength: value.productionTextLength,
      },
    },
    {
      name: 'insights-not-inserted-as-assertions',
      kind: 'content',
      ok: value.archiveAssertions === 0 && value.rejectedInsights === value.sourceInsightRows &&
        value.insightsWithContentReasons === value.sourceInsightRows &&
        value.insightRowIdsMatch === true,
      observed: {
        sourceInsightRows: value.sourceInsightRows,
        rejectedInsights: value.rejectedInsights,
        insightsWithContentReasons: value.insightsWithContentReasons,
        archiveAssertions: value.archiveAssertions,
        insightRowIdsMatch: value.insightRowIdsMatch,
      },
    },
    {
      name: 'legacy-snapshots-derive-no-current-facts',
      kind: 'content',
      ok: value.legacyCurrentFacts === 0 && value.unplacedLegacy === value.migratedRows,
      observed: {
        legacyCurrentFacts: value.legacyCurrentFacts,
        unplacedLegacy: value.unplacedLegacy,
        migratedRows: value.migratedRows,
      },
    },
    {
      name: 'source-file-bytes-unchanged',
      kind: 'isolation',
      ok: value.sourceFileBytesUnchanged === true,
      observed: {
        sha256Before: value.sourceSha256Before,
        sha256After: value.sourceSha256After,
        sizeBefore: value.sourceSizeBefore,
        sizeAfter: value.sourceSizeAfter,
      },
    },
    {
      name: 'source-connection-rejects-write',
      kind: 'isolation',
      ok: value.sourceWriteRejected === true,
      observed: value.sourceWriteProbe,
    },
    {
      name: 'source-closed-before-migration',
      kind: 'isolation',
      ok: value.sourceClosedRejectsQueries === true && value.migrationStartedAfterClose === true,
      observed: {
        sourceClosedRejectsQueries: value.sourceClosedRejectsQueries,
        migrationStartedAfterClose: value.migrationStartedAfterClose,
      },
    },
    {
      name: 'output-databases-distinct-from-source',
      kind: 'isolation',
      ok: value.outputsDistinctFromSource === true,
      observed: { outputsDistinctFromSource: value.outputsDistinctFromSource },
    },
    {
      name: 'same-size-same-mtime-content-change-detected',
      kind: 'reconciliation',
      ok: value.syntheticSameSize === true && value.syntheticSameMtime === true &&
        value.syntheticHashesDiffer === true && value.syntheticForceHashPassed === true,
      observed: {
        syntheticSameSize: value.syntheticSameSize,
        syntheticSameMtime: value.syntheticSameMtime,
        syntheticHashesDiffer: value.syntheticHashesDiffer,
        syntheticForceHashPassed: value.syntheticForceHashPassed,
        syntheticSha256Before: value.syntheticSha256Before,
        syntheticSha256After: value.syntheticSha256After,
      },
    },
  ]

  const failedChecks = [...preconditions, ...checks]
    .filter((check) => !check.ok)
    .map((check) => check.name)
  const verdict = preconditions.length === 4 && checks.length === REQUIRED_CHECK_COUNT &&
    failedChecks.length === 0 ? 'PASS' : 'FAIL'
  return { verdict, preconditions, checks, failedChecks }
}

// ---------------------------------------------------------------------------
// Proposal-layer status (SHADOW-ONLY, read from the isolated shadow ledger).
// ---------------------------------------------------------------------------

const EMPTY_PROPOSAL_LAYER = Object.freeze({
  measured: true,
  tablesPresent: false,
  source: 'shadow-ledger',
  unmeasuredReason: null,
  runs: 0,
  proposals: 0,
  accepted: 0,
  candidate: 0,
  rejected: 0,
  routesEnabled: 0,
  liveIngestion: false,
})

// The proposal journal was never opened against the live database by this audit or
// by the offline baseline (which writes no SQLite at all). Counts are read from the
// isolated shadow ledger after its journal tables are initialized, so a zero is a
// measured zero rather than a missing-table guess. Absence of tables remains
// distinguishable (`tablesPresent:false`) from an unreadable layer
// (`measured:false` + `unmeasuredReason`). Route enablement is re-derived from the
// evidence-bound counters and the stored model digest, never trusted from a flag.
export function readProposalLayer(db, scope) {
  const result = { ...EMPTY_PROPOSAL_LAYER }
  try {
    const tables = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => row.name))
    result.tablesPresent = tables.has('ledger_proposal_runs') &&
      tables.has('ledger_proposals') && tables.has('ledger_proposal_routes')
    if (tables.has('ledger_proposal_runs')) {
      result.runs = db.prepare(
        'SELECT COUNT(*) AS count FROM ledger_proposal_runs WHERE scope = ?',
      ).get(scope).count
    }
    if (tables.has('ledger_proposals')) {
      for (const row of db.prepare(`
        SELECT verdict, COUNT(*) AS count FROM ledger_proposals
        WHERE scope = ? GROUP BY verdict
      `).all(scope)) {
        if (Object.hasOwn(result, row.verdict)) result[row.verdict] = row.count
      }
      result.proposals = result.accepted + result.candidate + result.rejected
    }
    if (tables.has('ledger_proposal_routes')) {
      for (const row of db.prepare(`
        SELECT model_digest, sample_count, precision, safety_failures, evidence_json
        FROM ledger_proposal_routes WHERE scope = ?
      `).all(scope)) {
        let evidence = null
        try {
          evidence = row.evidence_json === null ? null : JSON.parse(row.evidence_json)
        } catch {
          continue
        }
        if (routeRowValid({
          sampleCount: row.sample_count,
          precision: row.precision,
          recall: evidence?.recall,
          safetyFailures: row.safety_failures,
          evidence,
          modelDigest: row.model_digest ?? '',
        })) {
          result.routesEnabled += 1
        }
      }
    }
  } catch (error) {
    // A missing or malformed proposal layer must never fail the deterministic
    // audit, but it also must not masquerade as a measured zero.
    return {
      ...EMPTY_PROPOSAL_LAYER,
      measured: false,
      unmeasuredReason: String(error?.message ?? error),
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Legacy insight content inspection.
// ---------------------------------------------------------------------------

const INSIGHT_ENTITY_FIELDS = [
  'entity', 'entityId', 'entity_id', 'subjectEntityId', 'subject', 'path', 'file', 'filePath',
]
const INSIGHT_PREDICATE_FIELDS = ['predicate', 'fact', 'assertion']

export function inspectLegacyInsight(value) {
  const inspected = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const inspectedFields = Object.keys(inspected).sort()
  const entityFieldsPresent = INSIGHT_ENTITY_FIELDS.filter((field) => Object.hasOwn(inspected, field))
  const predicateFieldsPresent = INSIGHT_PREDICATE_FIELDS
    .filter((field) => Object.hasOwn(inspected, field))
  const evidence = inspected.evidence
  const structuredEvidence = Array.isArray(evidence) && evidence.length > 0 &&
    evidence.every((item) => item !== null && typeof item === 'object' &&
      !Array.isArray(item) &&
      (item.eventKey !== undefined || item.rawRef !== undefined || item.assertionId !== undefined))
  const evidenceType = Array.isArray(evidence) ? `array(${evidence.length})` : typeof evidence

  const missingParts = []
  if (entityFieldsPresent.length === 0) missingParts.push('entity-reference')
  if (predicateFieldsPresent.length === 0) missingParts.push('predicate')
  if (!structuredEvidence) missingParts.push('structured-evidence')

  return {
    inspectedFields,
    entityFieldsPresent,
    predicateFieldsPresent,
    evidenceType,
    structuredEvidence,
    missingParts,
    reason: missingParts.length > 0
      ? `legacy-insight-content-unverifiable:${missingParts.join('+')}`
      : null,
  }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function samePath(a, b) {
  return pathRelation(a, b) === 'equal'
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Sidecar evidence. SQLite may create or touch `-shm` even for a read-only open,
// and `-wal` can change while another process is active, so these values are
// recorded as observation only. Only the main database is claimed unchanged.
function snapshotFile(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { exists: false, path }
    return {
      exists: true,
      path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: sha256File(path),
    }
  } catch {
    return { exists: false, path }
  }
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function jsonOrEmpty(value, fallback) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function newestLegacyState(rows) {
  const sorted = [...rows].sort((a, b) => (a.updated_ts - b.updated_ts) || (a.rowid - b.rowid))
  return sorted[sorted.length - 1]
}

function countBy(values) {
  const counts = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function sqliteQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function removeOwnedOutputs(paths) {
  for (const path of paths) {
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  }
}

// Isolated counterexample required by the spec: equal size, equal mtime, different
// bytes. It runs only in a fresh owned directory under the audit output, never in the
// user workspace, and is removed afterwards. Both hashes are emitted so the evidence
// can be checked without trusting a boolean.
async function runSyntheticContentProof({ outDir, scope, workspaceRoot, auditTime }) {
  const syntheticScope = `${scope}:synthetic-proof`
  const result = {
    syntheticSameSize: false,
    syntheticSameMtime: false,
    syntheticHashesDiffer: false,
    syntheticForceHashPassed: false,
    syntheticSha256Before: null,
    syntheticSha256After: null,
    syntheticSize: null,
    syntheticMtime: null,
    syntheticError: null,
  }
  let directory = null
  try {
    directory = mkdtempSync(join(outDir, 'synthetic-probe-'))
    const syntheticPath = join(directory, 'same-size-same-mtime.bin')
    const fixedMtime = new Date('2026-01-01T00:00:00.000Z')
    const io = {
      async realpath(path) { return realpathAsync(path) },
      async stat(path) { return statAsync(path) },
      async readFile(path) { return readFile(path) },
    }
    const probeAt = async (probeId, at) => observationFromProbe({
      path: syntheticPath,
      cwd: workspaceRoot,
      scope: syntheticScope,
      probeId,
      validAt: at,
      recordedAt: at,
      io,
    })

    writeFileSync(syntheticPath, Buffer.from('aaaa'))
    utimesSync(syntheticPath, fixedMtime, fixedMtime)
    const first = await probeAt('audit-synthetic-before', auditTime)
    writeFileSync(syntheticPath, Buffer.from('bbbb'))
    utimesSync(syntheticPath, fixedMtime, fixedMtime)
    const second = await probeAt('audit-synthetic-after', auditTime + 1)

    const ledger = new MemoryLedger(join(directory, 'synthetic-ledger.sqlite'))
    let currentHash = null
    let currentSize = null
    try {
      ledger.appendObservations([first, second])
      const facts = ledger.currentFacts(syntheticScope)
      currentHash = facts.find((fact) => fact.predicate === 'file.sha256')?.value ?? null
      currentSize = facts.find((fact) => fact.predicate === 'file.size')?.value ?? null
    } finally {
      ledger.close()
    }

    const firstHash = first.value?.sha256 ?? null
    const secondHash = second.value?.sha256 ?? null
    result.syntheticSha256Before = firstHash
    result.syntheticSha256After = secondHash
    result.syntheticSize = first.value?.size ?? null
    result.syntheticMtime = first.value?.mtime ?? null
    result.syntheticSameSize = first.value?.size === second.value?.size &&
      first.value?.size === currentSize
    result.syntheticSameMtime = first.value?.mtime === second.value?.mtime &&
      Number.isFinite(first.value?.mtime)
    result.syntheticHashesDiffer = typeof firstHash === 'string' &&
      typeof secondHash === 'string' && firstHash !== secondHash
    result.syntheticForceHashPassed = /^[0-9a-f]{64}$/.test(firstHash ?? '') &&
      /^[0-9a-f]{64}$/.test(secondHash ?? '') && currentHash === secondHash
  } catch (error) {
    result.syntheticError = String(error?.stack ?? error?.message ?? error)
  } finally {
    if (directory !== null) rmSync(directory, { recursive: true, force: true })
  }
  return result
}

// ---------------------------------------------------------------------------
// Audit.
// ---------------------------------------------------------------------------

async function run() {
  const options = parseArgs(process.argv.slice(2))
  // Guard before any output deletion: aliases and inside-state outputs are refused
  // using realpath for the source, its state directory, and the prospective targets.
  const guard = assertAuditPaths({ source: options.source, out: options.out })
  const source = guard.source
  const outDir = guard.out
  const sourceCopy = guard.outputs[0].path
  const shadowPath = guard.outputs[1].path
  const auditJsonPath = join(outDir, 'audit.json')
  const workspaceRoot = resolve(options.workspaceRoot)

  const sourceBytesBefore = sha256File(source)
  const sourceStatBefore = statSync(source)
  const sourceSidecarsBefore = {
    wal: snapshotFile(`${source}-wal`),
    shm: snapshotFile(`${source}-shm`),
  }

  mkdirSync(outDir, { recursive: true })
  removeOwnedOutputs([sourceCopy, shadowPath])

  const paths = {
    source: guard.sourceReal,
    sourceAsGiven: source,
    sourceStateDirectory: guard.stateDirectoryReal,
    sourceCopy,
    shadowLedger: shadowPath,
    auditJson: auditJsonPath,
    outputDirectory: outDir,
    workspaceRoot,
    workspaceScope: options.scope,
  }
  console.log('SHADOW-ONLY TESTSPACE LEDGER AUDIT (live injection unchanged)')
  console.log(`  source (live, read-only): ${paths.source}`)
  console.log(`  source copy (VACUUM INTO): ${paths.sourceCopy}`)
  console.log(`  shadow ledger (new): ${paths.shadowLedger}`)
  console.log(`  audit json: ${paths.auditJson}`)
  console.log(`  workspace root (cwd for adapters): ${paths.workspaceRoot}`)
  console.log(`  workspace scope: ${paths.workspaceScope}`)
  console.log(`  render budget: ${options.budget}`)

  const auditTime = Date.now()
  const syntheticProof = await runSyntheticContentProof({
    outDir, scope: options.scope, workspaceRoot, auditTime,
  })
  console.log(`  synthetic same-size/same-mtime probe: ` +
    `${syntheticProof.syntheticSha256Before} -> ${syntheticProof.syntheticSha256After} ` +
    `(size=${syntheticProof.syntheticSize}, mtime=${syntheticProof.syntheticMtime}, ` +
    `PASS=${syntheticProof.syntheticSameSize && syntheticProof.syntheticSameMtime &&
      syntheticProof.syntheticHashesDiffer && syntheticProof.syntheticForceHashPassed})`)
  // The write probe runs inside a transaction that is always rolled back. If the
  // readOnly flag were ignored, the CREATE would still not persist.
  let sourceWriteProbe = {
    attempted: true,
    rejected: false,
    stage: 'begin',
    code: null,
    message: null,
  }
  const sourceDb = new DatabaseSync(source, { readOnly: true })
  try {
    try {
      sourceDb.exec('BEGIN IMMEDIATE')
      try {
        sourceDb.exec('CREATE TABLE __rcs_audit_readonly_probe (value INTEGER)')
        sourceWriteProbe = {
          attempted: true, rejected: false, stage: 'create', code: null,
          message: 'write unexpectedly succeeded; transaction rolled back',
        }
      } catch (error) {
        sourceWriteProbe = {
          attempted: true,
          rejected: true,
          stage: 'create',
          code: error?.code ?? error?.errcode ?? null,
          message: String(error?.message ?? error),
        }
      } finally {
        try { sourceDb.exec('ROLLBACK') } catch { /* already rejected or no transaction */ }
      }
    } catch (error) {
      sourceWriteProbe = {
        attempted: true,
        rejected: true,
        stage: 'begin',
        code: error?.code ?? error?.errcode ?? null,
        message: String(error?.message ?? error),
      }
    }
    sourceDb.exec(`VACUUM INTO ${sqliteQuote(sourceCopy)}`)
  } finally {
    sourceDb.close()
  }
  const sourceBytesAfter = sha256File(source)
  const sourceStatAfter = statSync(source)
  const sourceSidecarsAfter = {
    wal: snapshotFile(`${source}-wal`),
    shm: snapshotFile(`${source}-shm`),
  }
  let sourceClosedRejectsQueries = false
  try {
    sourceDb.prepare('SELECT 1')
  } catch {
    sourceClosedRejectsQueries = true
  }
  const copyStat = statSync(sourceCopy)

  const copyDb = new DatabaseSync(sourceCopy, { readOnly: true })
  let fileStateRows
  let insightRows
  let injectedSessions
  let copyRecordCount
  try {
    copyRecordCount = copyDb.prepare('SELECT COUNT(*) AS count FROM records').get().count
    fileStateRows = copyDb.prepare(`
      SELECT rowid, sid, key, value, source, status, updated_ts
      FROM records WHERE scope = ? AND kind = 'file_state'
      ORDER BY updated_ts, rowid
    `).all(options.scope).map((row) => ({
      ...row,
      parsedValue: jsonOrEmpty(row.value, {}),
      parsedSource: jsonOrEmpty(row.source, {}),
    }))
    insightRows = copyDb.prepare(`
      SELECT rowid, sid, key, value, source, status, updated_ts
      FROM records WHERE scope = ? AND kind = 'insight'
      ORDER BY status, updated_ts, rowid
    `).all(options.scope).map((row) => ({
      ...row,
      parsedValue: jsonOrEmpty(row.value, {}),
    }))
    injectedSessions = copyDb.prepare(`
      SELECT key, value FROM meta WHERE key LIKE 'injected:%'
    `).all()
  } finally {
    copyDb.close()
  }

  // Migration starts only after the live source connection was closed.
  const ledger = new MemoryLedger(shadowPath)
  // Initialize the proposal journal on the shadow database before any count, so a
  // zero is a measured zero and not an absent table. Failure here is reported as
  // unmeasured and never changes the deterministic audit verdict.
  let proposalJournalError = null
  try {
    // eslint-disable-next-line no-new
    new ProposalJournal(ledger.db)
  } catch (error) {
    proposalJournalError = String(error?.message ?? error)
  }
  const migrated = []
  const pathGroups = new Map()
  const legacyObservations = []
  const probeObservations = []
  try {
    for (const row of fileStateRows) {
      const record = {
        rowid: row.rowid,
        sid: row.sid,
        seq: row.parsedSource.seq ?? null,
        kind: 'file_state',
        key: row.key,
        value: row.parsedValue,
        source: row.parsedSource,
        status: row.status,
        updated_ts: row.updated_ts,
      }
      const observation = observationFromLegacy({ record, scope: options.scope, rawRecord: record })
      legacyObservations.push(observation)
      migrated.push(observation)

      const displayPath = typeof record.value.path === 'string' && record.value.path.trim() !== ''
        ? record.value.path
        : (row.key.startsWith('file:') ? row.key.slice(5) : null)
      const reference = fileEntityRef(displayPath, { cwd: workspaceRoot, platform: process.platform })
      const entityId = reference?.entityId ?? `legacy:${row.rowid}`
      if (!pathGroups.has(entityId)) {
        pathGroups.set(entityId, { entityId, displayPath, rows: [] })
      }
      pathGroups.get(entityId).rows.push({ row, record })
    }

    const io = {
      async realpath(path) { return realpathAsync(path) },
      async stat(path) { return statAsync(path) },
      async readFile(path) { return readFile(path) },
    }

    const probeResults = []
    const probedEntityIds = new Set()
    let probeIndex = 0
    for (const group of pathGroups.values()) {
      probeIndex++
      probedEntityIds.add(group.entityId)
      const previous = newestLegacyState(group.rows.map((item) => item.row))
      const legacyValue = previous.parsedValue ?? {}
      const probeId = `shadow-probe:${probeIndex}:${sha256Text(group.entityId).slice(0, 12)}`
      let observation
      try {
        // cwd is supplied even though legacy paths are absolute: it makes the probe
        // identity independent of the audit process cwd and prevents relative aliases.
        observation = await observationFromProbe({
          path: group.displayPath,
          cwd: workspaceRoot,
          scope: options.scope,
          probeId,
          validAt: auditTime,
          recordedAt: auditTime,
          io,
        })
      } catch (error) {
        probeResults.push({
          entityId: group.entityId,
          displayPath: group.displayPath,
          outcome: 'error',
          code: error?.code ?? 'PROBE_CRASH',
          message: String(error?.message ?? error),
        })
        continue
      }
      probeObservations.push(observation)

      const base = {
        entityId: group.entityId,
        displayPath: group.displayPath,
        legacyStatus: previous.status,
        legacySha8: typeof legacyValue.sha8 === 'string' ? legacyValue.sha8.toLowerCase() : null,
        legacySize: Number.isFinite(legacyValue.size) ? legacyValue.size : null,
        probeId,
      }
      if (observation.op === 'probe' && observation.value?.exists === false) {
        probeResults.push({ ...base, outcome: 'missing' })
      } else if (observation.op === 'error' || observation.outcome !== 'observed') {
        probeResults.push({
          ...base,
          outcome: 'error',
          code: observation.rawPayload?.error?.code ?? 'PROBE_ERROR',
          message: observation.rawPayload?.error?.message ?? 'probe failed',
        })
      } else {
        const hash = observation.value.sha256
        const changedHash = base.legacySha8 === null ? null : hash.slice(0, 8) !== base.legacySha8
        const changedSize = base.legacySize !== null && base.legacySize !== observation.value.size
        probeResults.push({
          ...base,
          outcome: 'present',
          size: observation.value.size,
          sha256: hash,
          changedHash,
          changedSize,
        })
      }
    }

    // One archive transaction and one projection pass for the whole snapshot.
    ledger.appendObservations([...legacyObservations, ...probeObservations])

    const currentFacts = ledger.currentFacts(options.scope)
    const missingResults = probeResults.filter((result) => result.outcome === 'missing')
    const errorResults = probeResults.filter((result) => result.outcome === 'error')
    const presentResults = probeResults.filter((result) => result.outcome === 'present')
    const presentIds = new Set(presentResults.map((result) => result.entityId))
    const missingIds = new Set(missingResults.map((result) => result.entityId))
    const errorIds = new Set(errorResults.map((result) => result.entityId))

    // PRODUCTION RENDERING: exactly what MemoryLedger.renderCurrent injects. The
    // absence-marker suppression lives in the core renderer (file.exists=false), not
    // in an audit-side present-only filter, so leakage is measured on production text.
    const production = ledger.renderCurrent(options.scope, options.budget)
    const injectableFacts = ledger.currentFacts(options.scope, { injectableOnly: true })
    const absenceMarkersInText = (production.text.match(/当前不存在/g) ?? []).length
    const missingMarkerText = [...missingIds].filter((entityId) =>
      production.text.includes(`文件路径为 ${entityId}，当前不存在`)).length
    const productionMissingLeaks = production.selected
      .filter((fact) => missingIds.has(fact.subjectEntityId)).length + missingMarkerText
    const productionErrorLeaks = production.selected
      .filter((fact) => errorIds.has(fact.subjectEntityId)).length
    const productionUnverified = production.selected.filter((fact) =>
      fact.verification !== 'observed' || fact.sourceKind !== 'probe').length

    // Content-fact leakage is measured over the ledger's own current facts, not over
    // an audit-filtered subset. `file.exists=false` remains a legitimate current fact.
    const missingContentFacts = currentFacts.filter((fact) =>
      missingIds.has(fact.subjectEntityId) && fact.predicate !== 'file.exists')
    const errorContentFacts = currentFacts.filter((fact) =>
      errorIds.has(fact.subjectEntityId) && fact.predicate !== 'file.exists')
    const missingPathFactsInLedger = currentFacts
      .filter((fact) => missingIds.has(fact.subjectEntityId)).length
    const absenceMarkerFactsInLedger = currentFacts.filter((fact) =>
      fact.predicate === 'file.exists' && fact.value === false).length

    const legacyFacts = currentFacts.filter((fact) => fact.sourceKind === 'legacy')
    const nonProbeFacts = currentFacts.filter((fact) => fact.sourceKind !== 'probe')
    const legacyUnplaced = ledger.db.prepare(`
      SELECT COUNT(*) AS count FROM ledger_observation_placements
      WHERE scope = ? AND event_key LIKE 'legacy:%' AND unplaced = 1
    `).get(options.scope).count
    const archiveObservations = ledger.db.prepare(
      'SELECT COUNT(*) AS count FROM ledger_observations WHERE scope = ?',
    ).get(options.scope).count
    const archiveAssertions = ledger.db.prepare(
      'SELECT COUNT(*) AS count FROM ledger_assertions WHERE scope = ?',
    ).get(options.scope).count
    const meta = ledger.db.prepare(
      'SELECT reducer_version, projection_hash FROM ledger_meta WHERE scope = ?',
    ).get(options.scope)
    if (!meta) throw new Error('shadow ledger did not persist a projection hash')

    // Counterfactual only: what an audit-side present-only filter would have
    // selected. Equality with production text proves the filter is no longer
    // load-bearing for PASS.
    const auditPresentOnly = currentFacts.filter((fact) =>
      presentIds.has(fact.subjectEntityId) && fact.verification === 'observed' &&
      fact.conflict === null && fact.status === 'active')
    const counterfactual = renderFacts(auditPresentOnly, options.budget)

    const rejectedInsights = insightRows.map((row) => {
      const inspection = inspectLegacyInsight(row.parsedValue)
      return {
        rowid: row.rowid,
        key: row.key,
        status: row.status,
        sid: row.sid,
        updatedAt: row.updated_ts,
        summary: typeof row.parsedValue.summary === 'string'
          ? row.parsedValue.summary
          : '(no summary field)',
        evidenceCount: Array.isArray(row.parsedValue.evidence)
          ? row.parsedValue.evidence.length
          : 0,
        inspectedFields: inspection.inspectedFields,
        inspected: {
          entityFieldsPresent: inspection.entityFieldsPresent,
          predicateFieldsPresent: inspection.predicateFieldsPresent,
          evidenceType: inspection.evidenceType,
          structuredEvidence: inspection.structuredEvidence,
        },
        missingFields: inspection.missingParts,
        contentReason: inspection.reason ?? 'legacy-insight-content-mapped-without-adapter',
        reason: inspection.reason ?? 'legacy-insight-content-mapped-without-adapter',
        statusEligible: row.status === 'active',
        insertedAsAssertion: false,
      }
    })
    const sourceInsightRowIds = insightRows.map((row) => row.rowid)
    const rejectedInsightRowIds = rejectedInsights.map((entry) => entry.rowid)
    const insightRowIdsMatch = sourceInsightRowIds.length === rejectedInsightRowIds.length &&
      sourceInsightRowIds.every((rowid, index) => rowid === rejectedInsightRowIds[index])
    const insightsWithContentReasons = rejectedInsights.filter((entry) =>
      typeof entry.contentReason === 'string' &&
      entry.contentReason.startsWith('legacy-insight-content-') &&
      entry.inspectedFields.length > 0).length

    const fileStateCounts = countBy(fileStateRows.map((row) => row.status))
    const insightCounts = countBy(insightRows.map((row) => row.status))
    const changedHashes = presentResults.filter((result) => result.changedHash === true).length
    const unchangedHashes = presentResults.filter((result) => result.changedHash === false).length
    const unverifiableHashes = presentResults.filter((result) => result.changedHash === null).length
    const presentHashed = presentResults.filter((result) =>
      typeof result.sha256 === 'string' && /^[0-9a-f]{64}$/.test(result.sha256)).length
    const renderedTextSha256 = sha256Text(production.text)
    const sourceFileBytesUnchanged = sourceBytesBefore === sourceBytesAfter &&
      sourceStatBefore.size === sourceStatAfter.size
    const outputsDistinctFromSource = guard.outputs.every((output) =>
      !samePath(output.real, guard.sourceReal))

    const evidence = {
      migratedRows: migrated.length,
      probesAttempted: probeResults.length,
      uniqueProbedPaths: probedEntityIds.size,
      present: presentResults.length,
      presentHashed,
      missing: missingResults.length,
      errors: errorResults.length,
      missingContentFacts: missingContentFacts.length,
      errorContentFacts: errorContentFacts.length,
      candidateFacts: injectableFacts.length,
      productionSelected: production.selected.length,
      productionTextLength: production.text.length,
      absenceMarkersInText,
      productionMissingLeaks,
      productionErrorLeaks,
      productionUnverified,
      missingPathFactsInLedger,
      absenceMarkerFactsInLedger,
      sourceInsightRows: insightRows.length,
      rejectedInsights: rejectedInsights.length,
      insightsWithContentReasons,
      insightRowIdsMatch,
      archiveAssertions,
      legacyCurrentFacts: legacyFacts.length,
      unplacedLegacy: legacyUnplaced,
      sourceFileBytesUnchanged,
      sourceSha256Before: sourceBytesBefore,
      sourceSha256After: sourceBytesAfter,
      sourceSizeBefore: sourceStatBefore.size,
      sourceSizeAfter: sourceStatAfter.size,
      sourceWriteRejected: sourceWriteProbe.rejected,
      sourceWriteProbe,
      sourceClosedRejectsQueries,
      migrationStartedAfterClose: sourceClosedRejectsQueries && archiveObservations > 0,
      outputsDistinctFromSource,
      syntheticSameSize: syntheticProof.syntheticSameSize,
      syntheticSameMtime: syntheticProof.syntheticSameMtime,
      syntheticHashesDiffer: syntheticProof.syntheticHashesDiffer,
      syntheticForceHashPassed: syntheticProof.syntheticForceHashPassed,
      syntheticSha256Before: syntheticProof.syntheticSha256Before,
      syntheticSha256After: syntheticProof.syntheticSha256After,
    }
    const verdictResult = computeAuditChecks(evidence)
    // Shadow-only proposal status. This is deliberately not part of the 13
    // deterministic checks: it is reported evidence, not a PASS/FAIL threshold.
    const proposalLayerBase = readProposalLayer(ledger.db, options.scope)
    const proposalLayer = proposalJournalError === null
      ? proposalLayerBase
      : {
        ...proposalLayerBase,
        measured: false,
        unmeasuredReason: `journal-init-failed: ${proposalJournalError}`,
      }
    const { verdict, preconditions, checks } = verdictResult
    const assertions = [
      {
        name: 'live-profile-unchanged',
        measured: false,
        includedInVerdict: false,
        statement: 'No profile file is read or written here. The measured proxy is the live ' +
          'database SHA-256 before/after.',
      },
      {
        name: 'no-live-injection-call',
        measured: false,
        includedInVerdict: false,
        statement: 'Production rendering is invoked on the shadow ledger only; no live ' +
          'injection path is called.',
      },
    ]

    const result = {
      audit: 'task-6-testspace-shadow-audit',
      label: 'SHADOW-ONLY: results describe the isolated copy and shadow ledger; live injection is unchanged',
      generatedAt: new Date(auditTime).toISOString(),
      verdict,
      failedChecks: verdictResult.failedChecks,
      paths,
      isolation: {
        liveDatabaseOpenedReadOnly: true,
        liveConnectionMode: 'DatabaseSync(source, { readOnly: true })',
        liveWritableConnections: 0,
        sourceWriteProbe,
        copyMethod: 'SQLite VACUUM INTO',
        migrationSource: 'isolated copy only',
        sourceClosedBeforeMigration: sourceClosedRejectsQueries && archiveObservations > 0,
        sourceFileBefore: {
          size: sourceStatBefore.size,
          mtimeMs: sourceStatBefore.mtimeMs,
          sha256: sourceBytesBefore,
        },
        sourceFileAfter: {
          size: sourceStatAfter.size,
          mtimeMs: sourceStatAfter.mtimeMs,
          sha256: sourceBytesAfter,
        },
        sourceFileBytesUnchanged,
        liveDatabase: {
          path: source,
          before: {
            size: sourceStatBefore.size,
            mtimeMs: sourceStatBefore.mtimeMs,
            sha256: sourceBytesBefore,
          },
          after: {
            size: sourceStatAfter.size,
            mtimeMs: sourceStatAfter.mtimeMs,
            sha256: sourceBytesAfter,
          },
          bytesUnchanged: sourceFileBytesUnchanged,
        },
        liveSidecars: {
          before: sourceSidecarsBefore,
          after: sourceSidecarsAfter,
          readOnlyOpenMayCreateOrTouchShm: true,
          sidecarsClaimedUnchanged: false,
          note: 'SQLite can create or touch the -shm file even for a read-only open, and ' +
            '-wal may be changed by another live process. Sidecars are recorded as observed ' +
            'evidence only; no claim is made that they are unchanged. Only the main database ' +
            'hash is asserted unchanged.',
        },
        copyFile: { size: copyStat.size },
        assertions,
      },
      counts: {
        oldLiveInjection: {
          label: 'OLD LIVE INJECTION (read-only counts from the isolated copy; unchanged)',
          copyRecords: copyRecordCount,
          fileState: fileStateRows.length,
          fileStateByStatus: fileStateCounts,
          insights: insightRows.length,
          insightsByStatus: insightCounts,
          injectedSessions: injectedSessions.length,
        },
        shadow: {
          label: 'SHADOW LEDGER (new; shadow-only)',
          archivedObservations: archiveObservations,
          migratedLegacySnapshots: migrated.length,
          probeObservations: probeResults.length,
          archivedAssertions: archiveAssertions,
          unplacedLegacySnapshots: legacyUnplaced,
          currentFacts: currentFacts.length,
          currentEntities: ledger.db.prepare(
            'SELECT COUNT(*) AS count FROM ledger_entities WHERE scope = ?',
          ).get(options.scope).count,
          legacyDerivedCurrentFacts: legacyFacts.length,
          nonProbeCurrentFacts: nonProbeFacts.length,
          reducerVersion: meta.reducer_version,
          projectionHash: meta.projection_hash,
          projectionHashKind: 'snapshot-fingerprint',
          projectionHashNote: 'Includes audit-time probe recordedAt values; a per-snapshot ' +
            'fingerprint, not a cross-run reproducibility constant. The deterministic replay ' +
            'gate lives in tests/memory-ledger-eval.test.mjs with fixed times.',
        },
      },
      proposalLayer: {
        ...proposalLayer,
        label: 'SHADOW-ONLY proposal journal status measured from the isolated shadow ' +
          'ledger after journal initialization; no live proposal ingestion and no live ' +
          'read-path switch',
      },
      reconciliation: {
        uniqueMigratedPaths: pathGroups.size,
        probesAttempted: probeResults.length,
        uniqueProbedPaths: probedEntityIds.size,
        present: presentResults.length,
        presentHashed,
        missing: missingResults.length,
        errors: errorResults.length,
        forcedHashCount: presentHashed,
        changedHash: changedHashes,
        unchangedHash: unchangedHashes,
        unverifiableLegacyHash: unverifiableHashes,
        changedSize: presentResults.filter((result) => result.changedSize).length,
        missingPaths: missingResults.map((result) => result.displayPath),
        errorPaths: errorResults.map((result) => ({
          path: result.displayPath,
          code: result.code,
          message: result.message,
        })),
        probeResults,
      },
      rejectedLegacyInsights: {
        total: rejectedInsights.length,
        byStatus: insightCounts,
        reasons: [...new Set(rejectedInsights.map((entry) => entry.reason))],
        contentInspected: insightsWithContentReasons,
        rowIdsMatch: insightRowIdsMatch,
        sourceRowIds: sourceInsightRowIds,
        entries: rejectedInsights,
      },
      shadowRendering: {
        label: 'SHADOW-ONLY production renderCurrent over the shadow ledger; never injected live',
        policy: 'core renderer suppresses file.exists=false; legacy snapshots and non-probe ' +
          'facts are not current; conflicted facts are not injectable',
        budget: options.budget,
        candidateFacts: injectableFacts.length,
        renderedFacts: production.selected.length,
        renderedLines: production.text === '' ? 0 : production.text.split('\n').length,
        renderedChars: production.text.length,
        renderedTextSha256,
        overflowCount: production.overflowCount,
        suppressedCount: production.suppressedCount,
        absenceMarkersInText,
        missingPathLeakage: productionMissingLeaks,
        missingPathTextLeakage: missingMarkerText,
        probeErrorLeakage: productionErrorLeaks,
        unverifiedInsightRows: productionUnverified,
        insightFactsInLedger: 0,
        legacyFactsInLedger: legacyFacts.length,
        missingContentFacts: missingContentFacts.length,
        errorContentFacts: errorContentFacts.length,
        missingPathFactsInLedger,
        absenceMarkerFactsInLedger,
        counterfactualAuditPresentOnlyFilter: {
          selectedFacts: counterfactual.selected.length,
          textSha256: sha256Text(counterfactual.text),
          identicalToProduction: counterfactual.text === production.text,
        },
        text: production.text,
      },
      syntheticContentProof: {
        label: 'isolated owned-directory counterexample; removed after measurement',
        sameSize: syntheticProof.syntheticSameSize,
        sameMtime: syntheticProof.syntheticSameMtime,
        hashesDiffer: syntheticProof.syntheticHashesDiffer,
        forceHashCurrentFactUpdated: syntheticProof.syntheticForceHashPassed,
        sha256Before: syntheticProof.syntheticSha256Before,
        sha256After: syntheticProof.syntheticSha256After,
        size: syntheticProof.syntheticSize,
        mtime: syntheticProof.syntheticMtime,
        error: syntheticProof.syntheticError,
      },
      evidence,
      preconditions,
      checks,
      assertions,
      checkSummary: {
        preconditionsPassed: preconditions.filter((check) => check.ok).length,
        preconditionsTotal: preconditions.length,
        checksPassed: checks.filter((check) => check.ok).length,
        checksTotal: checks.length,
        assertionsExcludedFromVerdict: assertions.length,
      },
    }

    writeFileSync(auditJsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

    console.log('')
    console.log(`  copy records: ${copyRecordCount}`)
    console.log(`  legacy file_state: ${fileStateRows.length} ` +
      `(${fileStateCounts.active ?? 0} active, ${fileStateCounts.stale ?? 0} stale) -> ` +
      `${migrated.length} legacy observations`)
    console.log(`  forced-hash probes: ${probeResults.length} attempted over ` +
      `${probedEntityIds.size} unique paths, ${presentResults.length} present+hashed ` +
      `(${presentHashed} force hashes), ${missingResults.length} missing, ` +
      `${errorResults.length} error`)
    console.log(`  hash drift: ${changedHashes} changed, ${unchangedHashes} unchanged, ` +
      `${unverifiableHashes} legacy hash unavailable`)
    console.log(`  rejected legacy insights: ${rejectedInsights.length} ` +
      `(${insightCounts.active ?? 0} active, ${insightCounts.stale ?? 0} stale), ` +
      `${insightsWithContentReasons} with inspected content reasons, ` +
      `${archiveAssertions} inserted as assertions`)
    console.log(`  shadow current facts: ${currentFacts.length}; production render ` +
      `${production.selected.length} facts / ${result.shadowRendering.renderedLines} lines; ` +
      `overflow ${production.overflowCount}, suppressed ${production.suppressedCount}`)
    console.log(`  production leakage: missing ${productionMissingLeaks}, absence markers ` +
      `${absenceMarkersInText}, error ${productionErrorLeaks}, unverified ${productionUnverified}`)
    console.log(`  proposal layer (SHADOW-ONLY, measured ${proposalLayer.measured}, ` +
      `tables ${proposalLayer.tablesPresent}, live ingestion ${proposalLayer.liveIngestion}): ` +
      `runs ${proposalLayer.runs}, proposals ${proposalLayer.proposals} ` +
      `(accepted ${proposalLayer.accepted}, candidate ${proposalLayer.candidate}, ` +
      `rejected ${proposalLayer.rejected}), routesEnabled ${proposalLayer.routesEnabled}`)
    console.log(`  source sha256 before/after: ${sourceBytesBefore}`)
    console.log(`                               ${sourceBytesAfter} ` +
      `(unchanged=${sourceFileBytesUnchanged})`)
    console.log(`  read-only write probe: rejected=${sourceWriteProbe.rejected} ` +
      `stage=${sourceWriteProbe.stage}`)
    console.log(`  projectionHash (snapshot fingerprint): ${meta.projection_hash}`)
    console.log(`  preconditions: ${result.checkSummary.preconditionsPassed}/${preconditions.length}; ` +
      `checks: ${result.checkSummary.checksPassed}/${checks.length}; ` +
      `${assertions.length} unmeasured assertions excluded`)
    if (verdictResult.failedChecks.length) {
      console.log(`  failed: ${verdictResult.failedChecks.join(', ')}`)
    }
    console.log(`  audit json: ${auditJsonPath}`)
    console.log(`  verdict: ${verdict}`)
    if (verdict !== 'PASS') process.exitCode = 1
  } finally {
    ledger.close()
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false
  try {
    return realpathSync.native(process.argv[1]) ===
      realpathSync.native(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  run().catch((error) => {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`)
      console.error(usage())
      process.exitCode = 2
      return
    }
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  })
}
