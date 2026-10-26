// 提案日志与分谓词路由：成功运行数据库级幂等、失败可区分、范围隔离、派生启用门槛。
// 运行：node tests/memory-proposal-store.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryLedger } from '../web/memory-ledger.mjs'
import { canonicalJson, sha256Canonical } from '../web/memory-ledger-core.mjs'
import {
  PROPOSAL_SCOPE_MISMATCH,
  ProposalJournal,
  routeEnabled,
} from '../web/memory-proposal-store.mjs'

const root = mkdtempSync(join(tmpdir(), 'rcs-proposal-store-'))
const DB_FILE = join(root, 'ledger.sqlite')
const SCOPE = 'workspace:proposal-store'
const EMPTY_SCOPE = 'workspace:empty-run'
const FAIL_SCOPE = 'workspace:failed-run'
const ATOMIC_SCOPE = 'workspace:atomic-run'
const DIRECT_SCOPE = 'workspace:db-direct'
const OTHER_SCOPE = 'workspace:other'
const FOREIGN_SCOPE = 'workspace:foreign-scope'
const CROSS_SCOPE = 'workspace:cross-scope'
const RETRY_SCOPE = 'workspace:transient-retry'
const METRIC_SCOPE = 'workspace:metric-rollup'
const ROLLBACK_SCOPE = 'workspace:rollback-run'
const RAW_SCOPE = 'workspace:raw-predicate'
const PROMOTE_SCOPE = 'workspace:promoted-candidate'
const APPLY_SCOPE = 'workspace:application-recovery'

let fails = 0
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!condition) fails++
}
const throws = (fn) => {
  try { fn(); return false } catch { return true }
}

const HASH1 = 'a'.repeat(64)
const HASH2 = 'b'.repeat(64)
const HASH_CROSS = 'c'.repeat(64)
const HASH4 = 'd'.repeat(64)
const HASH_EMPTY = 'e'.repeat(64)
const HASH_FAIL = 'f'.repeat(64)
const HASH_RETRY = '1'.repeat(64)
const HASH_METRIC = '2'.repeat(64)
const HASH_METRIC_FAIL = '3'.repeat(64)
const HASH_ROLLBACK = '4'.repeat(64)
const HASH_COLLIDE = '5'.repeat(64)
const HASH_RAW = '6'.repeat(64)
const HASH_RAW_ACCEPTED = '7'.repeat(64)
const HASH_RAW_CANDIDATE = '8'.repeat(64)
const HASH_PROMOTE = '9'.repeat(64)
const HASH_APPLY = 'ab'.repeat(32)
const MODEL = 'model-a'
const MODEL_DIGEST = '0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0'

const routeEvidence = (overrides = {}) => {
  const positiveLabels = overrides.positiveLabels ?? 20
  const tp = overrides.tp ?? positiveLabels
  const fp = overrides.fp ?? 0
  const fn = overrides.fn ?? 0
  const safetyFailures = overrides.safetyFailures ?? 0
  return {
    corpusSha256: 'a'.repeat(64),
    evaluatorSha256: 'b'.repeat(64),
    modelDigest: MODEL_DIGEST,
    tp,
    fp,
    fn,
    positiveLabels,
    safetyFailures,
    precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    measuredAt: 1000,
    ...overrides,
  }
}

const runInput = (overrides = {}) => ({
  runId: 'run-1',
  scope: SCOPE,
  inputHash: HASH1,
  model: MODEL,
  modelDigest: MODEL_DIGEST,
  schemaVersion: 'p1',
  status: 'succeeded',
  rawOutput: '{"proposals":[{"op":"assert"}]}',
  error: null,
  createdAt: 1000,
  evidenceEventKeys: [],
  items: [],
  ...overrides,
})
const proposalIdFor = (runId, index, {
  scope = SCOPE, inputHash = HASH1, model = MODEL, modelDigest = MODEL_DIGEST,
  schemaVersion = 'p1',
} = {}) => sha256Canonical({ runId, scope, inputHash, model, modelDigest, schemaVersion, index })
const routeInput = (overrides = {}) => {
  // The route identity is digest-bound and every stored counter must equal the
  // arithmetic result of the evidence row, so callers vary the evidence, not the
  // counters. Explicit counter overrides remain available to prove refusals.
  const { evidence: evidenceOverrides, evidenceModelDigest, ...rest } = overrides
  const evidence = routeEvidence({
    ...(evidenceOverrides ?? {}),
    ...(evidenceModelDigest === undefined ? {} : { modelDigest: evidenceModelDigest }),
  })
  const merged = {
    scope: SCOPE,
    model: MODEL,
    modelDigest: MODEL_DIGEST,
    predicate: 'project.constraint',
    schemaVersion: 'p1',
    sampleCount: evidence.positiveLabels,
    precision: evidence.precision,
    safetyFailures: evidence.safetyFailures,
    evidenceJson: JSON.stringify(evidence),
    updatedAt: 2000,
    ...rest,
  }
  if (overrides.evidenceJson === undefined) merged.evidenceJson = JSON.stringify(evidence)
  return merged
}

const ledger = new MemoryLedger(DB_FILE)
const db = ledger.db
const journal = new ProposalJournal(db)
const count = (sql, ...params) => db.prepare(sql).get(...params).count

try {
  // The proposal journal shares the ledger's connection and file.
  ledger.appendObservation({
    eventKey: 'e1', scope: SCOPE, sid: 's1', seq: 1, validAt: 900, recordedAt: 900,
    op: 'create', outcome: 'success', subjectEntityId: 'C:/p/a.txt',
    value: { size: 1 }, source: { kind: 'observation', authority: 'host' },
  })
  check('journal shares the ledger connection without disturbing the archive',
    count('SELECT count(*) AS count FROM ledger_observations') === 1)
  check('journal creates the proposal run, item, route, and application tables',
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ledger_proposal%'
      ORDER BY name`).all().map((row) => row.name).join(',') ===
    'ledger_proposal_applications,ledger_proposal_routes,ledger_proposal_runs,ledger_proposals')

  const indexNames = new Set(db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'ledger_proposal%'`,
  ).all().map((row) => row.name))
  check('the journal creates its required indexes',
    ['ledger_proposal_runs_success_scope_identity', 'ledger_proposal_runs_scope_time',
      'ledger_proposal_runs_evidence_identity', 'ledger_proposals_scope_verdict',
      'ledger_proposal_routes_scope', 'ledger_proposal_applications_scope']
      .every((name) => indexNames.has(name)))
  const successIndex = db.prepare("PRAGMA index_list('ledger_proposal_runs')").all()
    .find((row) => row.name === 'ledger_proposal_runs_success_scope_identity')
  check('successful idempotency is a scope-aware partial unique index',
    successIndex?.unique === 1 && successIndex?.partial === 1 &&
    db.prepare("PRAGMA index_info('ledger_proposal_runs_success_scope_identity')")
      .all().map((row) => row.name).join(',') === 'scope,input_hash,model,model_digest,schema_version')
  check('the superseded unscoped success identity index is gone',
    !indexNames.has('ledger_proposal_runs_success_identity'))
  check('indexed columns match their declared purpose',
    db.prepare("PRAGMA index_info('ledger_proposal_runs_scope_time')")
      .all().map((row) => row.name).join(',') === 'scope,created_at' &&
    db.prepare("PRAGMA index_info('ledger_proposals_scope_verdict')")
      .all().map((row) => row.name).join(',') === 'scope,verdict' &&
    db.prepare("PRAGMA index_info('ledger_proposal_routes_scope')")
      .all().map((row) => row.name).join(',') === 'scope,predicate')
  const runColumns = db.prepare("PRAGMA table_info('ledger_proposal_runs')").all()
  check('the run schema stores attempt and failure classification',
    runColumns.map((column) => column.name).includes('attempt') &&
    runColumns.map((column) => column.name).includes('failure_kind') &&
    runColumns.find((column) => column.name === 'attempt').dflt_value === '1' &&
    runColumns.find((column) => column.name === 'attempt').notnull === 1)
  check('the run schema is digest-bound and archives its evidence keys',
    runColumns.find((column) => column.name === 'model_digest')?.notnull === 1 &&
    runColumns.find((column) => column.name === 'evidence_keys_json')?.notnull === 1)
  check('the route primary key includes the model digest',
    db.prepare("PRAGMA table_info('ledger_proposal_routes')").all()
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name).join(',') ===
    'scope,model,model_digest,predicate,schema_version' &&
    db.prepare("PRAGMA table_info('ledger_proposal_routes')").all()
      .find((column) => column.name === 'model_digest').notnull === 1)

  // --- Successful run with two items ---------------------------------------
  const first = journal.recordRun(runInput({
    items: [
      {
        verdict: 'accepted',
        predicate: 'project.constraint',
        payload: { op: 'assert', evidence: { eventKey: 'm1', quote: '接口端口固定为 8848' } },
      },
      {
        verdict: 'rejected',
        predicate: 'project.decision',
        payload: { op: 'assert' },
        errors: ['quote-not-found'],
        reason: 'quote-not-found',
      },
    ],
  }))
  check('a successful run is recorded once and not marked duplicate',
    first.duplicate === false && first.run.runId === 'run-1')
  check('the stored run keeps its identity and raw output',
    first.run.scope === SCOPE && first.run.inputHash === HASH1 && first.run.model === MODEL &&
    first.run.schemaVersion === 'p1' && first.run.status === 'succeeded' &&
    first.run.rawOutput === '{"proposals":[{"op":"assert"}]}' &&
    first.run.error === null && first.run.createdAt === 1000 &&
    first.run.attempt === 1 && first.run.failureKind === null)
  check('both items persist with deterministic IDs',
    first.items.length === 2 &&
    first.items[0].proposalId === proposalIdFor('run-1', 0) &&
    first.items[1].proposalId === proposalIdFor('run-1', 1) &&
    first.items[0].itemIndex === 0 && first.items[1].itemIndex === 1 &&
    first.items[0].verdict === 'accepted' && first.items[1].verdict === 'rejected')
  check('rejected items retain their machine-checkable errors and reason',
    first.items[1].errors.length === 1 && first.items[1].errors[0] === 'quote-not-found' &&
    first.items[1].reason === 'quote-not-found')
  check('the run and its items are separate rows',
    count('SELECT count(*) AS count FROM ledger_proposal_runs') === 1 &&
    count('SELECT count(*) AS count FROM ledger_proposals') === 2)
  check('item payloads are stored as canonical JSON',
    db.prepare('SELECT payload_json FROM ledger_proposals WHERE proposal_id = ?')
      .get(first.items[0].proposalId).payload_json ===
      canonicalJson({ op: 'assert', evidence: { eventKey: 'm1', quote: '接口端口固定为 8848' } }))
  check('findRun returns the stored run and its items',
    journal.findRun({ scope: SCOPE, inputHash: HASH1, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1' })
      ?.run.runId === 'run-1' &&
    journal.findRun({ scope: SCOPE, inputHash: HASH1, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1' })
      .items.length === 2)
  check('findRun returns null for an unknown identity',
    journal.findRun({ scope: OTHER_SCOPE, inputHash: HASH1, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1' }) === null)
  check('listProposals returns both items in item order',
    journal.listProposals(SCOPE).length === 2 &&
    journal.listProposals(SCOPE)[0].itemIndex === 0 &&
    journal.listProposals(SCOPE)[1].itemIndex === 1)
  check('listProposals returns the stored payload value',
    journal.listProposals(SCOPE)[0].payload.evidence.quote === '接口端口固定为 8848')

  // --- Successful-run idempotency ------------------------------------------
  const replay = journal.recordRun(runInput({
    runId: 'run-1-replay',
    rawOutput: '{"proposals":[]}',
    createdAt: 1500,
    items: [],
  }))
  check('a duplicate successful identity returns the stored run',
    replay.duplicate === true && replay.run.runId === 'run-1' &&
    replay.items.length === 2 && replay.run.rawOutput === '{"proposals":[{"op":"assert"}]}')
  check('a duplicate successful identity adds no rows',
    count('SELECT count(*) AS count FROM ledger_proposal_runs') === 1 &&
    count('SELECT count(*) AS count FROM ledger_proposals') === 2)
  check('a successful run refuses mutation under the same run ID',
    throws(() => journal.recordRun(runInput({ items: [{ verdict: 'candidate' }] }))) &&
    throws(() => journal.recordRun(runInput({ rawOutput: '{"proposals":[]}' }))) &&
    journal.listProposals(SCOPE).length === 2)
  check('run status and error are mutually constrained',
    throws(() => journal.recordRun(runInput({ status: 'failed', error: null }))) &&
    throws(() => journal.recordRun(runInput({ error: 'boom' }))) &&
    throws(() => journal.recordRun(runInput({ status: 'done' }))) &&
    throws(() => journal.recordRun(runInput({ note: 'extra' }))))
  check('attempt is a positive integer and failure kind is closed',
    throws(() => journal.recordRun(runInput({ attempt: 0 }))) &&
    throws(() => journal.recordRun(runInput({ attempt: 1.5 }))) &&
    throws(() => journal.recordRun(runInput({ attempt: '1' }))) &&
    throws(() => journal.recordRun(runInput({ failureKind: 'transient' }))) &&
    throws(() => journal.recordRun(runInput({
      status: 'failed', rawOutput: null, error: 'timeout',
    }))) &&
    throws(() => journal.recordRun(runInput({
      status: 'failed', rawOutput: null, error: 'timeout', failureKind: 'bogus',
    }))) &&
    throws(() => journal.recordRun(runInput({
      status: 'failed', rawOutput: null, error: 'timeout', failureKind: null,
    }))))
  check('failed runs refuse items',
    throws(() => journal.recordRun(runInput({
      runId: 'run-f-bad', scope: FAIL_SCOPE, inputHash: HASH_FAIL, status: 'failed',
      rawOutput: null, error: 'timeout', failureKind: 'unknown',
      items: [{ verdict: 'candidate' }],
    }))) &&
    journal.findRun({ scope: FAIL_SCOPE, inputHash: HASH_FAIL, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1' }) === null)

  // A single bad item rolls back the run row and every earlier item in it.
  check('one invalid item rolls back the whole run',
    throws(() => journal.recordRun(runInput({
      runId: 'run-atomic', scope: ATOMIC_SCOPE, inputHash: HASH4, createdAt: 1600,
      items: [{ verdict: 'accepted' }, { verdict: 'maybe' }],
    }))) &&
    count('SELECT count(*) AS count FROM ledger_proposal_runs WHERE scope = ?', ATOMIC_SCOPE) === 0 &&
    count('SELECT count(*) AS count FROM ledger_proposals WHERE scope = ?', ATOMIC_SCOPE) === 0 &&
    journal.metrics(ATOMIC_SCOPE).state === 'not-run')

  // --- Raw out-of-schema predicates are journalable when rejected ----------
  // The engine sees model output before it knows the proposal vocabulary, so a
  // rejected row may carry any non-empty raw predicate. Accepted and candidate
  // rows still exist only for proposal predicates.
  const rawRun = (() => {
    try {
      return journal.recordRun(runInput({
        runId: 'run-raw', scope: RAW_SCOPE, inputHash: HASH_RAW, createdAt: 1650,
        items: [
          { verdict: 'accepted', predicate: 'project.constraint', payload: { op: 'assert' } },
          {
            verdict: 'rejected', predicate: 'file.exists',
            payload: { op: 'assert', predicate: 'file.exists' },
            errors: ['unsupported-predicate'], reason: 'unsupported-predicate',
          },
        ],
      }))
    } catch {
      return null
    }
  })()
  check('a rejected item may carry any non-empty raw predicate string',
    rawRun?.items.length === 2 && rawRun.items[1].predicate === 'file.exists' &&
    rawRun.items[1].reason === 'unsupported-predicate' &&
    rawRun.items[1].errors[0] === 'unsupported-predicate')
  check('accepted and candidate items still require a proposal predicate',
    throws(() => journal.recordRun(runInput({
      runId: 'run-raw-accepted', scope: RAW_SCOPE, inputHash: HASH_RAW_ACCEPTED,
      createdAt: 1660,
      items: [{ verdict: 'accepted', predicate: 'file.exists', payload: { op: 'assert' } }],
    }))) &&
    throws(() => journal.recordRun(runInput({
      runId: 'run-raw-candidate', scope: RAW_SCOPE, inputHash: HASH_RAW_CANDIDATE,
      createdAt: 1670,
      items: [{ verdict: 'candidate', predicate: 'project.unknown', payload: { op: 'assert' } }],
    }))) &&
    journal.listProposals(RAW_SCOPE).length === 2)
  check('a rejected item may still omit its predicate',
    journal.recordRun(runInput({
      runId: 'run-raw-nopredicate', scope: RAW_SCOPE, inputHash: HASH_RAW_CANDIDATE,
      createdAt: 1675,
      items: [{ verdict: 'rejected', payload: { op: 'assert' }, errors: ['unsupported-operation'], reason: 'unsupported-operation' }],
    })).items[0].predicate === null)

  // --- Promotion metadata and application outcomes ------------------------
  const promoteRun = journal.recordRun(runInput({
    runId: 'run-promote', scope: PROMOTE_SCOPE, inputHash: HASH_PROMOTE, createdAt: 1680,
    items: [{ verdict: 'candidate', predicate: 'project.preference', payload: { op: 'assert' } }],
  }))
  const promoteItem = promoteRun.items[0]
  check('a candidate row starts without promotion metadata',
    promoteItem.promotedAt === null && promoteItem.promotedAssertionId === null)
  const promotedRow = (() => {
    try {
      return journal.markPromoted({
        proposalId: promoteItem.proposalId,
        scope: PROMOTE_SCOPE,
        promotedAt: 1700,
        promotedAssertionId: `llm:${promoteItem.proposalId}`,
      })
    } catch {
      return null
    }
  })()
  check('promotion writes promotedAt and the promoted assertion on the candidate',
    promotedRow?.promotedAt === 1700 &&
    promotedRow.promotedAssertionId === `llm:${promoteItem.proposalId}` &&
    promotedRow.verdict === 'candidate')
  const promoteMetrics = journal.metrics(PROMOTE_SCOPE)
  check('metrics report promoted rows apart from remaining candidates',
    promoteMetrics.proposals.candidate === 0 && promoteMetrics.proposals.promoted === 1 &&
    promoteMetrics.proposals.total === 1 && promoteMetrics.state === 'found')
  check('promotion remains visible as a candidate row for audit',
    journal.listProposals(PROMOTE_SCOPE, { verdict: 'candidate' }).length === 1)
  check('promotion is idempotent and keeps the first promotedAt',
    (() => {
      try {
        return journal.markPromoted({
          proposalId: promoteItem.proposalId,
          scope: PROMOTE_SCOPE,
          promotedAt: 1800,
          promotedAssertionId: `llm:${promoteItem.proposalId}`,
        }).promotedAt === 1700
      } catch {
        return false
      }
    })())
  check('promotion refuses accepted proposals, foreign scopes, and unknown IDs',
    throws(() => journal.markPromoted({
      proposalId: first.items[0].proposalId, scope: SCOPE,
      promotedAt: 1700, promotedAssertionId: 'llm:x',
    })) &&
    throws(() => journal.markPromoted({
      proposalId: promoteItem.proposalId, scope: OTHER_SCOPE,
      promotedAt: 1700, promotedAssertionId: 'llm:x',
    })) &&
    throws(() => journal.markPromoted({
      proposalId: 'missing-proposal', scope: PROMOTE_SCOPE,
      promotedAt: 1700, promotedAssertionId: 'llm:x',
    })) &&
    throws(() => journal.markPromoted({
      proposalId: promoteItem.proposalId, scope: PROMOTE_SCOPE,
      promotedAt: Number.NaN, promotedAssertionId: 'llm:x',
    })))

  const appliedRun = (() => {
    try {
      return journal.recordApplication({
        runId: 'run-promote', scope: PROMOTE_SCOPE, status: 'applied',
        assertionCount: 1, error: null, updatedAt: 1690,
      })
    } catch {
      return null
    }
  })()
  const applicationLookup = (runId) => {
    try {
      return journal.getApplication(runId)
    } catch {
      return null
    }
  }
  check('application outcomes are recorded per run',
    appliedRun?.status === 'applied' && appliedRun.assertionCount === 1 &&
    applicationLookup('run-promote')?.runId === 'run-promote' &&
    applicationLookup('run-missing') === null)
  check('an application record is immutable once written',
    throws(() => journal.recordApplication({
      runId: 'run-promote', scope: PROMOTE_SCOPE, status: 'failed',
      assertionCount: 0, error: 'late failure', updatedAt: 1695,
    })) &&
    applicationLookup('run-promote')?.status === 'applied')
  check('an application record requires an archived run in its own scope',
    throws(() => journal.recordApplication({
      runId: 'run-missing', scope: PROMOTE_SCOPE, status: 'applied',
      assertionCount: 0, error: null, updatedAt: 1690,
    })) &&
    throws(() => journal.recordApplication({
      runId: 'run-promote', scope: OTHER_SCOPE, status: 'applied',
      assertionCount: 1, error: null, updatedAt: 1690,
    })))

  // A failed append never wrote facts, so the same run may be re-applied later.
  // The record tracks the latest outcome until it becomes applied, which is final.
  journal.recordRun(runInput({
    runId: 'run-apply-recovery',
    scope: APPLY_SCOPE,
    inputHash: HASH_APPLY,
    createdAt: 2500,
    items: [{
      verdict: 'accepted',
      predicate: 'project.constraint',
      payload: {
        op: 'assert', predicate: 'project.constraint', quote: 'q',
        proposalId: 'proposal-apply-recovery',
        assertionId: 'llm:proposal-apply-recovery',
      },
      errors: [],
      reason: null,
    }],
  }))
  const failedApplication = journal.recordApplication({
    runId: 'run-apply-recovery', scope: APPLY_SCOPE, status: 'failed',
    assertionCount: 1, error: 'append exploded', updatedAt: 2600,
  })
  check('a failed application is recorded and drives the apply-failed state',
    failedApplication.status === 'failed' &&
    journal.getApplication('run-apply-recovery')?.error === 'append exploded' &&
    journal.metrics(APPLY_SCOPE).state === 'apply-failed')
  const failedAgainApplication = journal.recordApplication({
    runId: 'run-apply-recovery', scope: APPLY_SCOPE, status: 'failed',
    assertionCount: 0, error: 'not-injectable:route-disabled', updatedAt: 2650,
  })
  check('a retried failure refines the record with the latest outcome',
    failedAgainApplication.status === 'failed' &&
    failedAgainApplication.error === 'not-injectable:route-disabled' &&
    failedAgainApplication.updatedAt === 2650)
  const recoveredApplication = journal.recordApplication({
    runId: 'run-apply-recovery', scope: APPLY_SCOPE, status: 'applied',
    assertionCount: 1, error: null, updatedAt: 2700,
  })
  check('a failed application can be completed as applied on retry',
    recoveredApplication.status === 'applied' &&
    recoveredApplication.error === null &&
    journal.getApplication('run-apply-recovery')?.status === 'applied')
  check('metrics recover from apply-failed once the latest application is applied',
    journal.metrics(APPLY_SCOPE).state === 'found' &&
    journal.metrics(APPLY_SCOPE).applications.failed === 0 &&
    journal.metrics(APPLY_SCOPE).applications.applied === 1)
  check('an applied application record stays immutable after recovery',
    throws(() => journal.recordApplication({
      runId: 'run-apply-recovery', scope: APPLY_SCOPE, status: 'failed',
      assertionCount: 1, error: 'late failure', updatedAt: 2800,
    })) &&
    journal.getApplication('run-apply-recovery')?.status === 'applied')

  // A historical application failure must not mask a later successful application.
  const acceptedItem = {
    verdict: 'accepted',
    predicate: 'project.constraint',
    payload: { op: 'assert', predicate: 'project.constraint', quote: 'q' },
    errors: [],
    reason: null,
  }
  journal.recordRun(runInput({
    runId: 'run-apply-stale-failure', scope: APPLY_SCOPE, inputHash: 'cd'.repeat(32),
    createdAt: 3000, items: [acceptedItem],
  }))
  journal.recordApplication({
    runId: 'run-apply-stale-failure', scope: APPLY_SCOPE, status: 'failed',
    assertionCount: 1, error: 'append exploded', updatedAt: 3000,
  })
  check('a failed application sets the state while it is the latest outcome',
    journal.metrics(APPLY_SCOPE).state === 'apply-failed')
  journal.recordRun(runInput({
    runId: 'run-apply-later', scope: APPLY_SCOPE, inputHash: 'ef'.repeat(32),
    createdAt: 3100, items: [acceptedItem],
  }))
  journal.recordApplication({
    runId: 'run-apply-later', scope: APPLY_SCOPE, status: 'applied',
    assertionCount: 1, error: null, updatedAt: 3200,
  })
  check('metrics state follows the latest application instead of any historical failure',
    journal.metrics(APPLY_SCOPE).applications.failed === 1 &&
    journal.metrics(APPLY_SCOPE).state === 'found')

  // --- Failed run vs successful empty run ----------------------------------
  const failed = journal.recordRun(runInput({
    runId: 'run-f1', scope: FAIL_SCOPE, inputHash: HASH_FAIL, status: 'failed',
    rawOutput: null, error: 'timeout', failureKind: 'transient', attempt: 1, createdAt: 1100,
  }))
  check('a failed run stores its error, kind and no items',
    failed.duplicate === false && failed.run.status === 'failed' &&
    failed.run.error === 'timeout' && failed.run.rawOutput === null &&
    failed.run.attempt === 1 && failed.run.failureKind === 'transient' &&
    failed.items.length === 0)
  const foundFailed = journal.findRun({
    scope: FAIL_SCOPE, inputHash: HASH_FAIL, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
  })
  check('findRun falls back to a failed attempt when nothing succeeded',
    foundFailed?.run.status === 'failed' && foundFailed.run.error === 'timeout' &&
    foundFailed.run.failureKind === 'transient' && foundFailed.items.length === 0)

  journal.recordRun(runInput({
    runId: 'run-e1', scope: EMPTY_SCOPE, inputHash: HASH_EMPTY,
    rawOutput: '{"proposals":[]}', createdAt: 1200,
  }))
  check('metrics separate not-run, failed, ran-empty and found',
    journal.metrics(SCOPE).state === 'found' &&
    journal.metrics(EMPTY_SCOPE).state === 'ran-empty' &&
    journal.metrics(FAIL_SCOPE).state === 'failed' &&
    journal.metrics('workspace:never-run').state === 'not-run')
  check('metrics distinguish succeeded-empty from failed attempts',
    journal.metrics(EMPTY_SCOPE).runs.succeeded === 1 &&
    journal.metrics(EMPTY_SCOPE).runs.failed === 0 &&
    journal.metrics(EMPTY_SCOPE).proposals.total === 0 &&
    journal.metrics(FAIL_SCOPE).runs.succeeded === 0 &&
    journal.metrics(FAIL_SCOPE).runs.failed === 1 &&
    journal.metrics(FAIL_SCOPE).proposals.total === 0)
  check('metrics count proposals by verdict for the scope only',
    journal.metrics(SCOPE).proposals.total === 2 &&
    journal.metrics(SCOPE).proposals.accepted === 1 &&
    journal.metrics(SCOPE).proposals.candidate === 0 &&
    journal.metrics(SCOPE).proposals.rejected === 1 &&
    journal.metrics(EMPTY_SCOPE).proposals.total === 0)
  check('metrics report the latest attempt per scope',
    journal.metrics(SCOPE).lastRun.runId === 'run-1' &&
    journal.metrics(SCOPE).lastRun.status === 'succeeded' &&
    journal.metrics(FAIL_SCOPE).lastRun.runId === 'run-f1' &&
    journal.metrics(FAIL_SCOPE).lastRun.status === 'failed' &&
    journal.metrics('workspace:never-run').lastRun === null)

  const failedReplay = journal.recordRun(runInput({
    runId: 'run-f1', scope: FAIL_SCOPE, inputHash: HASH_FAIL, status: 'failed',
    rawOutput: null, error: 'timeout', failureKind: 'transient', attempt: 1, createdAt: 1100,
  }))
  check('a replayed failed attempt is idempotent',
    failedReplay.duplicate === true && failedReplay.run.attempt === 1 &&
    count('SELECT count(*) AS count FROM ledger_proposal_runs WHERE scope = ?', FAIL_SCOPE) === 1)
  journal.recordRun(runInput({
    runId: 'run-f2', scope: FAIL_SCOPE, inputHash: HASH_FAIL, status: 'failed',
    rawOutput: null, error: 'timeout', failureKind: 'permanent', attempt: 2, createdAt: 1150,
  }))
  check('a later failed attempt for the same identity is archived separately',
    journal.metrics(FAIL_SCOPE).runs.failed === 2 &&
    journal.metrics(FAIL_SCOPE).state === 'failed')
  check('findRun reports the newest failed attempt with its classification',
    journal.findRun({
      scope: FAIL_SCOPE, inputHash: HASH_FAIL, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
    }).run.runId === 'run-f2' &&
    journal.findRun({
      scope: FAIL_SCOPE, inputHash: HASH_FAIL, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
    }).run.attempt === 2 &&
    journal.findRun({
      scope: FAIL_SCOPE, inputHash: HASH_FAIL, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
    }).run.failureKind === 'permanent')

  // --- Retry after a transient failure -------------------------------------
  journal.recordRun(runInput({
    runId: 'run-retry-1', scope: RETRY_SCOPE, inputHash: HASH_RETRY, status: 'failed',
    rawOutput: null, error: 'ECONNRESET', failureKind: 'transient', attempt: 1, createdAt: 1400,
  }))
  const retried = journal.recordRun(runInput({
    runId: 'run-retry-2', scope: RETRY_SCOPE, inputHash: HASH_RETRY, attempt: 2,
    createdAt: 1450, items: [{ verdict: 'accepted', predicate: 'project.constraint', payload: { op: 'assert' } }],
  }))
  check('a transient failure can be retried without violating success idempotency',
    retried.duplicate === false && retried.run.runId === 'run-retry-2' &&
    retried.run.attempt === 2 &&
    journal.metrics(RETRY_SCOPE).state === 'found' &&
    journal.metrics(RETRY_SCOPE).runs.succeeded === 1 &&
    journal.metrics(RETRY_SCOPE).runs.failed === 1 &&
    count(`SELECT count(*) AS count FROM ledger_proposal_runs
      WHERE scope = ? AND failure_kind = 'transient'`, RETRY_SCOPE) === 1)
  const retryReplay = journal.recordRun(runInput({
    runId: 'run-retry-3', scope: RETRY_SCOPE, inputHash: HASH_RETRY, attempt: 3, createdAt: 1500,
    items: [],
  }))
  check('successful retry remains the single success for the identity',
    retryReplay.duplicate === true && retryReplay.run.runId === 'run-retry-2' &&
    retryReplay.run.attempt === 2 &&
    count(`SELECT count(*) AS count FROM ledger_proposal_runs
      WHERE scope = ? AND status = 'succeeded'`, RETRY_SCOPE) === 1)

  // --- Metrics rollups by model, predicate and rejection reason ------------
  journal.recordRun(runInput({
    runId: 'run-m1', scope: METRIC_SCOPE, inputHash: HASH_METRIC, createdAt: 1350,
    items: [
      { verdict: 'accepted', predicate: 'project.constraint', payload: { op: 'assert' } },
      {
        verdict: 'rejected', predicate: 'project.decision', payload: { op: 'assert' },
        reason: 'quote-not-found',
      },
      {
        verdict: 'rejected', predicate: 'project.decision', payload: { op: 'assert' },
        reason: 'predicate-mismatch',
      },
      { verdict: 'candidate', predicate: 'project.preference', payload: { op: 'assert' } },
    ],
  }))
  journal.recordRun(runInput({
    runId: 'run-m-fail', scope: METRIC_SCOPE, inputHash: HASH_METRIC_FAIL, model: 'model-b',
    status: 'failed', rawOutput: null, error: 'timeout', failureKind: 'unknown', createdAt: 1360,
  }))
  const metricMetrics = journal.metrics(METRIC_SCOPE)
  check('metrics roll up runs and proposals by model',
    canonicalJson(metricMetrics.byModel) === canonicalJson({
      [MODEL]: {
        runs: { total: 1, succeeded: 1, failed: 0 },
        proposals: { total: 4, accepted: 1, candidate: 1, rejected: 2, promoted: 0 },
      },
      'model-b': {
        runs: { total: 1, succeeded: 0, failed: 1 },
        proposals: { total: 0, accepted: 0, candidate: 0, rejected: 0, promoted: 0 },
      },
    }))
  check('metrics roll up proposals by predicate',
    canonicalJson(metricMetrics.byPredicate) === canonicalJson({
      'project.constraint': {
        predicate: 'project.constraint',
        proposals: { total: 1, accepted: 1, candidate: 0, rejected: 0, promoted: 0 },
      },
      'project.decision': {
        predicate: 'project.decision',
        proposals: { total: 2, accepted: 0, candidate: 0, rejected: 2, promoted: 0 },
      },
      'project.preference': {
        predicate: 'project.preference',
        proposals: { total: 1, accepted: 0, candidate: 1, rejected: 0, promoted: 0 },
      },
    }))
  check('metrics histogram rejection reasons',
    canonicalJson(metricMetrics.rejectionReasons) ===
    canonicalJson({ 'predicate-mismatch': 1, 'quote-not-found': 1 }))
  check('rollups preserve found, ran-empty and not-run semantics',
    metricMetrics.state === 'found' && metricMetrics.runs.failed === 1 &&
    metricMetrics.proposals.total === 4 &&
    journal.metrics(EMPTY_SCOPE).state === 'ran-empty' &&
    journal.metrics('workspace:never-run').state === 'not-run' &&
    canonicalJson(journal.metrics('workspace:never-run').byModel) === '{}')

  // --- A second successful run in the same scope ---------------------------
  const second = journal.recordRun(runInput({
    runId: 'run-2', inputHash: HASH2, createdAt: 1300,
    rawOutput: '{"proposals":[{"op":"assert"}]}',
    items: [{ verdict: 'candidate', predicate: 'project.preference', payload: { op: 'assert' } }],
  }))
  check('a second identity in one scope is a new run',
    second.duplicate === false && second.run.runId === 'run-2' &&
    second.items[0].proposalId === proposalIdFor('run-2', 0, { inputHash: HASH2 }))
  check('listProposals orders runs by creation time then item index',
    journal.listProposals(SCOPE).map((item) => `${item.runId}:${item.itemIndex}`).join(',') ===
    'run-1:0,run-1:1,run-2:0')
  check('listProposals filters by verdict',
    journal.listProposals(SCOPE, { verdict: 'accepted' }).length === 1 &&
    journal.listProposals(SCOPE, { verdict: 'candidate' }).length === 1 &&
    journal.listProposals(SCOPE, { verdict: 'rejected' }).length === 1)
  check('listProposals refuses an unknown verdict',
    throws(() => journal.listProposals(SCOPE, { verdict: 'maybe' })) &&
    throws(() => journal.listProposals('')))
  check('listProposals returns nothing for an unused scope',
    journal.listProposals(OTHER_SCOPE).length === 0)
  check('metrics count every successful run in the scope',
    journal.metrics(SCOPE).runs.total === 2 &&
    journal.metrics(SCOPE).runs.succeeded === 2 &&
    journal.metrics(SCOPE).proposals.total === 3 &&
    journal.metrics(SCOPE).proposals.candidate === 1)
  check('another scope is unaffected by this scope\'s runs',
    journal.metrics(OTHER_SCOPE).state === 'not-run' &&
    journal.listProposals(OTHER_SCOPE).length === 0)

  // --- Successful identity is scoped ---------------------------------------
  journal.recordRun(runInput({
    runId: 'run-foreign', scope: FOREIGN_SCOPE, inputHash: HASH_CROSS, createdAt: 1700,
    items: [{ verdict: 'candidate', predicate: 'project.preference', payload: { op: 'assert' } }],
  }))
  const foreignAttempt = journal.recordRun(runInput({
    runId: 'run-cross-fail', scope: CROSS_SCOPE, inputHash: HASH_CROSS, status: 'failed',
    rawOutput: null, error: 'timeout', failureKind: 'transient', attempt: 1, createdAt: 1710,
  }))
  check('a foreign success is not returned for the same identity in another scope',
    foreignAttempt.duplicate === false && foreignAttempt.run.scope === CROSS_SCOPE &&
    foreignAttempt.run.runId === 'run-cross-fail' && foreignAttempt.run.status === 'failed' &&
    foreignAttempt.items.length === 0 &&
    journal.findRun({
      scope: CROSS_SCOPE, inputHash: HASH_CROSS, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
    }).run.runId === 'run-cross-fail' &&
    journal.findRun({
      scope: FOREIGN_SCOPE, inputHash: HASH_CROSS, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
    }).run.runId === 'run-foreign')
  const crossSuccess = journal.recordRun(runInput({
    runId: 'run-cross-own', scope: CROSS_SCOPE, inputHash: HASH_CROSS, attempt: 2,
    createdAt: 1720, items: [{ verdict: 'accepted', predicate: 'project.constraint', payload: { op: 'assert' } }],
  }))
  check('another scope archives its own distinct successful attempt',
    crossSuccess.duplicate === false && crossSuccess.run.scope === CROSS_SCOPE &&
    crossSuccess.run.runId === 'run-cross-own' && crossSuccess.run.attempt === 2 &&
    crossSuccess.items.length === 1 &&
    crossSuccess.items[0].proposalId ===
      proposalIdFor('run-cross-own', 0, { scope: CROSS_SCOPE, inputHash: HASH_CROSS }) &&
    journal.listProposals(FOREIGN_SCOPE).length === 1 &&
    journal.listProposals(CROSS_SCOPE).length === 1)
  check('successful idempotency is unique per scope, not globally',
    count(`SELECT count(*) AS count FROM ledger_proposal_runs
      WHERE input_hash = ? AND status = 'succeeded'`, HASH_CROSS) === 2 &&
    count(`SELECT count(*) AS count FROM ledger_proposal_runs
      WHERE input_hash = ? AND status = 'failed'`, HASH_CROSS) === 1)

  // --- Route threshold is derived ------------------------------------------
  check('route enables exactly at 20 samples, 0.95 precision, 0.50 recall, zero safety failures',
    routeEnabled({ sampleCount: 20, precision: 0.95, recall: 0.5, safetyFailures: 0 }) === true &&
    routeEnabled({ sampleCount: 25, precision: 0.96, recall: 0.96, safetyFailures: 0 }) === true)
  check('route threshold rejects 0.949 precision',
    routeEnabled({ sampleCount: 20, precision: 0.949, recall: 0.95, safetyFailures: 0 }) === false)
  check('route threshold rejects 19 samples',
    routeEnabled({ sampleCount: 19, precision: 0.95, recall: 0.95, safetyFailures: 0 }) === false)
  check('route threshold rejects recall below the 0.50 floor',
    routeEnabled({ sampleCount: 20, precision: 0.95, recall: 0.499, safetyFailures: 0 }) === false &&
    routeEnabled({ sampleCount: 20, precision: 0.95, recall: undefined, safetyFailures: 0 }) === false)
  check('route threshold rejects any severe safety failure',
    routeEnabled({ sampleCount: 100, precision: 0.999, recall: 0.999, safetyFailures: 1 }) === false)
  const storedRouteEvidence = routeEvidence()
  const route = journal.setRoute(routeInput())
  check('a qualified route is returned as enabled',
    route.enabled === true && route.status === 'enabled' && route.sampleCount === 20 &&
    route.precision === 1 && route.recall === 1 && route.safetyFailures === 0 &&
    route.modelDigest === MODEL_DIGEST)
  check('route evidence is parsed on read and canonicalized at rest',
    canonicalJson(route.evidence) === canonicalJson(storedRouteEvidence) &&
    db.prepare(`SELECT evidence_json FROM ledger_proposal_routes
      WHERE scope = ? AND model = ? AND model_digest = ? AND predicate = ? AND schema_version = ?`)
      .get(SCOPE, MODEL, MODEL_DIGEST, 'project.constraint', 'p1').evidence_json ===
      canonicalJson(storedRouteEvidence))
  check('getRoute returns the stored route',
    journal.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }).updatedAt === 2000)

  check('precision 0.947 leaves the route disabled',
    journal.setRoute(routeInput({ evidence: { tp: 18, fp: 1, fn: 2 } })).enabled === false &&
    journal.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }).status === 'disabled')
  check('19 samples leave the route disabled',
    journal.setRoute(routeInput({ evidence: { positiveLabels: 19 } })).enabled === false)
  check('one safety failure leaves the route disabled',
    journal.setRoute(routeInput({ evidence: { safetyFailures: 1 } })).enabled === false)
  check('recall 0.40 leaves the route disabled even at perfect precision',
    journal.setRoute(routeInput({ evidence: { tp: 8, fn: 12 } })).enabled === false &&
    journal.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }).recall === 0.4)
  check('the route recovers only when the evidence improves',
    journal.setRoute(routeInput({ evidence: { positiveLabels: 21 } })).enabled === true)
  check('setRoute upserts exactly one row per key',
    count(`SELECT count(*) AS count FROM ledger_proposal_routes
      WHERE scope = ? AND model = ? AND model_digest = ? AND predicate = ? AND schema_version = ?`,
    SCOPE, MODEL, MODEL_DIGEST, 'project.constraint', 'p1') === 1)

  journal.setRoute(routeInput({
    scope: OTHER_SCOPE, evidence: { positiveLabels: 5, tp: 5, fp: 5 },
  }))
  check('routes are scoped',
    journal.getRoute({
      scope: OTHER_SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }).enabled === false &&
    journal.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }).sampleCount === 21)
  journal.setRoute(routeInput({ model: 'model-b', evidence: { positiveLabels: 30 } }))
  check('routes are model-specific',
    journal.getRoute({
      scope: SCOPE, model: 'model-b', modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }).enabled === true &&
    journal.getRoute({
      scope: SCOPE, model: 'model-c', modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }) === null)
  check('routes are model-digest-specific',
    journal.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: 'f'.repeat(64), predicate: 'project.constraint', schemaVersion: 'p1',
    }) === null)
  journal.setRoute(routeInput({ predicate: 'project.decision' }))
  check('routes are predicate-specific',
    journal.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.decision', schemaVersion: 'p1',
    }).enabled === true &&
    journal.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }).sampleCount === 21 &&
    journal.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.preference', schemaVersion: 'p1',
    }) === null)
  check('routes are schema-version-specific',
    journal.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p2',
    }) === null)
  check('setRoute refuses impossible evidence counts',
    throws(() => journal.setRoute(routeInput({ sampleCount: 19.5 }))) &&
    throws(() => journal.setRoute(routeInput({ precision: 1.5 }))) &&
    throws(() => journal.setRoute(routeInput({ safetyFailures: -1 }))) &&
    throws(() => journal.setRoute(routeInput({ updatedAt: Number.NaN }))) &&
    throws(() => journal.setRoute(routeInput({ model: '' }))) &&
    throws(() => journal.setRoute(routeInput({ predicate: 'file.exists' }))) &&
    throws(() => journal.setRoute(routeInput({ evidenceJson: '{not json' }))))
  check('setRoute binds the evidence to the route model digest',
    throws(() => journal.setRoute(routeInput({ evidenceModelDigest: 'f'.repeat(64) }))) &&
    throws(() => journal.setRoute(routeInput({ modelDigest: '' }))))
  check('setRoute refuses counters that do not equal their evidence',
    throws(() => journal.setRoute(routeInput({ sampleCount: 21 }))) &&
    throws(() => journal.setRoute(routeInput({ precision: 0.96 }))) &&
    throws(() => journal.setRoute(routeInput({ evidence: { recall: 0.4 } }))))

  // --- Database-level idempotency and references ---------------------------
  const insertRun = db.prepare(`INSERT INTO ledger_proposal_runs (
    run_id, scope, input_hash, model, model_digest, schema_version, status, raw_output, error,
    created_at, attempt, failure_kind
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  check('the database rejects a second successful run in the same scope',
    throws(() => insertRun.run(
      'run-db-dup', SCOPE, HASH1, MODEL, MODEL_DIGEST, 'p1', 'succeeded', '{}', null, 3000, 1, null,
    )))
  check('the database accepts the same identity as a success in another scope',
    !throws(() => insertRun.run(
      'run-db-other-scope', DIRECT_SCOPE, HASH1, MODEL, MODEL_DIGEST, 'p1', 'succeeded', '{}',
      null, 3000, 1, null,
    )))
  check('the database accepts the same identity for another model digest',
    !throws(() => insertRun.run(
      'run-db-other-digest', DIRECT_SCOPE, HASH1, MODEL, 'a'.repeat(64), 'p1', 'succeeded', '{}',
      null, 3050, 1, null,
    )))
  check('the database allows failed attempts beside a successful identity',
    !throws(() => insertRun.run(
      'run-db-fail', SCOPE, HASH1, MODEL, MODEL_DIGEST, 'p1', 'failed', null, 'timeout',
      3100, 2, 'unknown',
    )))
  check('the database refuses a failed run without a failure kind',
    throws(() => insertRun.run(
      'run-db-no-kind', SCOPE, HASH1, MODEL, MODEL_DIGEST, 'p1', 'failed', null, 'timeout',
      3150, 3, null,
    )))
  check('the database refuses a non-positive attempt',
    throws(() => insertRun.run(
      'run-db-zero-attempt', SCOPE, HASH2, MODEL, MODEL_DIGEST, 'p1', 'succeeded', '{}', null,
      3160, 0, null,
    )))
  check('proposal rows require an archived run',
    throws(() => db.prepare(`INSERT INTO ledger_proposals (
      proposal_id, run_id, scope, item_index, verdict, predicate, payload_json, errors_json, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'p-orphan', 'missing-run', SCOPE, 0, 'accepted', null, null, '[]', null,
    )))

  insertRun.run(
    'run-id-collision', DIRECT_SCOPE, HASH_COLLIDE, MODEL, MODEL_DIGEST, 'p1', 'failed', null,
    'boom', 3200, 1, 'unknown',
  )
  let collisionCode = null
  try {
    journal.recordRun(runInput({
      runId: 'run-id-collision', scope: SCOPE, inputHash: HASH_COLLIDE, createdAt: 3300,
    }))
  } catch (error) {
    collisionCode = error.code
  }
  check('reusing a run ID across scopes fails with a stable scope-mismatch code',
    collisionCode === PROPOSAL_SCOPE_MISMATCH)

  // A real database-level failure on the second item must roll back the run row
  // and the first item together; no test hook in production code is required.
  db.exec(`
    CREATE TRIGGER ledger_proposals_reject_second_item
    BEFORE INSERT ON ledger_proposals
    WHEN NEW.item_index = 1
    BEGIN
      SELECT RAISE(ABORT, 'injected proposal item failure');
    END;
  `)
  let itemFailureThrew = false
  try {
    itemFailureThrew = throws(() => journal.recordRun(runInput({
      runId: 'run-rollback', scope: ROLLBACK_SCOPE, inputHash: HASH_ROLLBACK, createdAt: 1800,
      items: [
        { verdict: 'accepted', predicate: 'project.constraint', payload: { op: 'assert' } },
        { verdict: 'candidate', predicate: 'project.preference', payload: { op: 'assert' } },
      ],
    })))
  } finally {
    db.exec('DROP TRIGGER ledger_proposals_reject_second_item')
  }
  check('a database-level second-item failure rolls back the run and every item',
    itemFailureThrew &&
    count('SELECT count(*) AS count FROM ledger_proposal_runs WHERE scope = ?', ROLLBACK_SCOPE) === 0 &&
    count('SELECT count(*) AS count FROM ledger_proposals WHERE scope = ?', ROLLBACK_SCOPE) === 0 &&
    journal.metrics(ROLLBACK_SCOPE).state === 'not-run' &&
    journal.metrics(ROLLBACK_SCOPE).lastRun === null)

  // --- Process-independent reopen ------------------------------------------
  const metricSnapshot = journal.metrics(METRIC_SCOPE)
  ledger.close()
  const inspector = new DatabaseSync(DB_FILE)
  inspector.exec('PRAGMA foreign_keys = ON')
  const reopened = new ProposalJournal(inspector)
  const reopenedRun = reopened.findRun({
    scope: SCOPE, inputHash: HASH1, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
  })
  check('a reopened journal returns the same run and deterministic item IDs',
    reopenedRun?.run.runId === 'run-1' && reopenedRun.run.attempt === 1 &&
    reopenedRun.run.failureKind === null &&
    reopenedRun.items.length === 2 &&
    reopenedRun.items[0].proposalId === proposalIdFor('run-1', 0) &&
    reopenedRun.items[1].proposalId === proposalIdFor('run-1', 1))
  check('a reopened journal preserves attempt and failure classification',
    reopened.findRun({
      scope: FAIL_SCOPE, inputHash: HASH_FAIL, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
    }).run.attempt === 2 &&
    reopened.findRun({
      scope: FAIL_SCOPE, inputHash: HASH_FAIL, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
    }).run.failureKind === 'permanent')
  check('a reopened journal preserves listings and metrics',
    reopened.listProposals(SCOPE).length === 3 &&
    reopened.metrics(SCOPE).state === 'found' &&
    reopened.metrics(EMPTY_SCOPE).state === 'ran-empty' &&
    reopened.metrics(FAIL_SCOPE).state === 'failed' &&
    reopened.metrics('workspace:never-run').state === 'not-run')
  check('a reopened journal preserves model and predicate rollups',
    canonicalJson(reopened.metrics(METRIC_SCOPE).byModel) ===
      canonicalJson(metricSnapshot.byModel) &&
    canonicalJson(reopened.metrics(METRIC_SCOPE).byPredicate) ===
      canonicalJson(metricSnapshot.byPredicate) &&
    canonicalJson(reopened.metrics(METRIC_SCOPE).rejectionReasons) ===
      canonicalJson(metricSnapshot.rejectionReasons))
  check('a reopened journal preserves scoped successes and failures',
    reopened.findRun({
      scope: FOREIGN_SCOPE, inputHash: HASH_CROSS, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
    }).run.runId === 'run-foreign' &&
    reopened.findRun({
      scope: CROSS_SCOPE, inputHash: HASH_CROSS, model: MODEL, modelDigest: MODEL_DIGEST, schemaVersion: 'p1',
    }).run.runId === 'run-cross-own' &&
    inspector.prepare(`SELECT count(*) AS count FROM ledger_proposal_runs
      WHERE input_hash = ? AND status = 'succeeded'`).get(HASH_CROSS).count === 2 &&
    inspector.prepare(`SELECT count(*) AS count FROM ledger_proposal_runs
      WHERE input_hash = ? AND status = 'failed'`).get(HASH_CROSS).count === 1)
  check('a reopened journal derives the same route enablement',
    reopened.getRoute({
      scope: SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }).enabled === true &&
    reopened.getRoute({
      scope: OTHER_SCOPE, model: MODEL, modelDigest: MODEL_DIGEST, predicate: 'project.constraint', schemaVersion: 'p1',
    }).enabled === false)
  const reopenedReplay = reopened.recordRun(runInput({ runId: 'run-1-replay-2' }))
  check('successful-run idempotency survives reopen',
    reopenedReplay.duplicate === true && reopenedReplay.run.runId === 'run-1' &&
    reopenedReplay.run.attempt === 1 &&
    inspector.prepare(`SELECT count(*) AS count FROM ledger_proposal_runs
      WHERE scope = ? AND status = 'succeeded'`).get(SCOPE).count === 2 &&
    reopened.listProposals(SCOPE).length === 3)
  const reopenedIndexes = new Set(inspector.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'ledger_proposal%'`,
  ).all().map((row) => row.name))
  check('a reopened journal still exposes the scope-aware identity index',
    reopenedIndexes.has('ledger_proposal_runs_success_scope_identity') &&
    inspector.prepare("PRAGMA index_info('ledger_proposal_runs_success_scope_identity')")
      .all().map((row) => row.name).join(',') ===
      'scope,input_hash,model,model_digest,schema_version' &&
    !reopenedIndexes.has('ledger_proposal_runs_success_identity'))
  check('route enablement is derived rather than stored',
    inspector.prepare("PRAGMA table_info('ledger_proposal_routes')").all()
      .map((column) => column.name).every((name) => name !== 'enabled' && name !== 'status'))
  inspector.close()
} finally {
  try { ledger.close() } catch { /* already closed */ }
  rmSync(root, { recursive: true, force: true })
}

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
process.exitCode = fails === 0 ? 0 : 1
