import {
  canonicalJson, routeEvidenceValid, routeRowValid, sha256Canonical,
} from './memory-ledger-core.mjs'
import { PROPOSAL_PREDICATES } from './memory-proposals.mjs'

// The derived threshold lives in the core so the journal and the ledger's read gate
// cannot drift. Re-exported here because this module remains the journal's public
// surface for route capability.
export { routeEnabled } from './memory-ledger-core.mjs'

const RUN_STATUSES = new Set(['succeeded', 'failed'])
const FAILURE_KINDS = new Set(['transient', 'permanent', 'unknown'])
const ITEM_VERDICTS = new Set(['accepted', 'candidate', 'rejected'])
const APPLICATION_STATUSES = new Set(['applied', 'failed', 'closed'])
const RUN_FIELDS = new Set([
  'runId', 'scope', 'inputHash', 'model', 'modelDigest', 'schemaVersion', 'status',
  'attempt', 'failureKind', 'rawOutput', 'error', 'createdAt', 'evidenceEventKeys', 'items',
])
const ITEM_FIELDS = new Set(['verdict', 'predicate', 'payload', 'errors', 'reason'])
const APPLICATION_FIELDS = new Set([
  'runId', 'scope', 'status', 'assertionCount', 'error', 'updatedAt',
])
const ROUTE_FIELDS = new Set([
  'scope', 'model', 'modelDigest', 'predicate', 'schemaVersion', 'sampleCount', 'precision',
  'safetyFailures', 'evidenceJson', 'updatedAt',
])

// Stable code for a run identity that is bound to a different scope. Callers
// must never receive foreign-scope runs or items as if they were their own.
export const PROPOSAL_SCOPE_MISMATCH = 'PROPOSAL_SCOPE_MISMATCH'

export class ProposalScopeMismatchError extends Error {
  constructor(runId, storedScope, requestedScope) {
    super(`proposal run ${runId} belongs to scope ${storedScope}, not ${requestedScope}`)
    this.name = 'ProposalScopeMismatchError'
    this.code = PROPOSAL_SCOPE_MISMATCH
    this.runId = runId
    this.storedScope = storedScope
    this.requestedScope = requestedScope
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function requireNonEmpty(name, value) {
  if (!nonEmptyString(value)) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function requireFinite(name, value) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`)
  return value
}

function requireCount(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`)
  }
  return value
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejectUnknownFields(fields, allowed, label) {
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${label} field: ${key}`)
  }
}

function normalizeItem(item, index) {
  if (!isPlainObject(item)) throw new TypeError(`proposal item ${index} must be an object`)
  rejectUnknownFields(item, ITEM_FIELDS, 'proposal item')
  if (!ITEM_VERDICTS.has(item.verdict)) {
    throw new TypeError(`proposal item ${index} verdict must be accepted, candidate, or rejected`)
  }
  const predicate = item.predicate ?? null
  if (predicate !== null) {
    requireNonEmpty(`proposal item ${index} predicate`, predicate)
    // A rejected row records what the model actually emitted, which may be outside
    // the proposal vocabulary (the engine discovers that only after parsing). An
    // accepted or candidate row is executable state and must name a proposal
    // predicate.
    if (item.verdict !== 'rejected' && !PROPOSAL_PREDICATES.has(predicate)) {
      throw new TypeError(`proposal item ${index} predicate is not a proposal predicate`)
    }
  }
  const payload = item.payload === undefined ? null : item.payload
  // Canonicalize before the transaction starts: a malformed payload must never
  // leave a run row without its items.
  canonicalJson(payload)
  const errors = item.errors === undefined ? [] : item.errors
  if (!Array.isArray(errors) || errors.some((value) => typeof value !== 'string')) {
    throw new TypeError(`proposal item ${index} errors must be an array of strings`)
  }
  const reason = item.reason ?? null
  if (reason !== null && typeof reason !== 'string') {
    throw new TypeError(`proposal item ${index} reason must be a string or null`)
  }
  return { itemIndex: index, verdict: item.verdict, predicate, payload, errors, reason }
}

function normalizeRun(input) {
  if (!isPlainObject(input)) throw new TypeError('recordRun requires a plain object')
  rejectUnknownFields(input, RUN_FIELDS, 'run')
  const runId = requireNonEmpty('runId', input.runId)
  const scope = requireNonEmpty('scope', input.scope)
  const inputHash = requireNonEmpty('inputHash', input.inputHash)
  const model = requireNonEmpty('model', input.model)
  const modelDigest = requireNonEmpty('modelDigest', input.modelDigest)
  const schemaVersion = requireNonEmpty('schemaVersion', input.schemaVersion)
  if (!RUN_STATUSES.has(input.status)) throw new TypeError('run status must be succeeded or failed')
  const createdAt = requireFinite('createdAt', input.createdAt)

  // Attempts are explicit so retries never overwrite earlier evidence. A replay
  // of the same run ID is still recognised as the same attempt.
  const attempt = input.attempt === undefined ? 1 : input.attempt
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError('attempt must be a positive integer')
  }
  const failureKind = input.failureKind ?? null
  if (failureKind !== null && !FAILURE_KINDS.has(failureKind)) {
    throw new TypeError('failureKind must be transient, permanent, unknown, or null')
  }

  const rawOutput = input.rawOutput ?? null
  if (rawOutput !== null && typeof rawOutput !== 'string') {
    throw new TypeError('rawOutput must be a string or null')
  }
  const error = input.error ?? null
  if (error !== null && !nonEmptyString(error)) {
    throw new TypeError('error must be a non-empty string or null')
  }

  const rawItems = input.items === undefined ? [] : input.items
  if (!Array.isArray(rawItems)) throw new TypeError('run items must be an array')

  if (input.status === 'succeeded') {
    if (typeof rawOutput !== 'string') throw new TypeError('succeeded runs require raw output')
    if (error !== null) throw new TypeError('succeeded runs cannot carry an error')
    if (failureKind !== null) throw new TypeError('succeeded runs cannot carry a failure kind')
  } else {
    if (error === null) throw new TypeError('failed runs require an error')
    if (failureKind === null) throw new TypeError('failed runs require a failure kind')
    // A failed attempt has no validated proposal set; allowing items here would
    // let unvalidated model output masquerade as reviewed verdicts.
    if (rawItems.length > 0) throw new TypeError('failed runs carry no proposal items')
  }

  const items = rawItems.map((item, index) => normalizeItem(item, index))
  // Evidence-set identity is independent of active facts. Persisting it lets the
  // engine reuse a prior proposal for the same archived messages even after the
  // active fact set changes (for example after a retraction).
  const rawEvidenceKeys = input.evidenceEventKeys === undefined ? [] : input.evidenceEventKeys
  if (!Array.isArray(rawEvidenceKeys) ||
      rawEvidenceKeys.some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new TypeError('evidenceEventKeys must be an array of non-empty strings')
  }
  const evidenceEventKeys = [...new Set(rawEvidenceKeys)].sort()
  return {
    runId, scope, inputHash, model, modelDigest, schemaVersion,
    status: input.status, attempt, failureKind, rawOutput, error, createdAt,
    evidenceEventKeys, items,
  }
}

function normalizeApplication(input) {
  if (!isPlainObject(input)) throw new TypeError('recordApplication requires a plain object')
  rejectUnknownFields(input, APPLICATION_FIELDS, 'application')
  const runId = requireNonEmpty('runId', input.runId)
  const scope = requireNonEmpty('scope', input.scope)
  if (!APPLICATION_STATUSES.has(input.status)) {
    throw new TypeError('application status must be applied, failed, or closed')
  }
  const assertionCount = requireCount('assertionCount', input.assertionCount)
  const updatedAt = requireFinite('updatedAt', input.updatedAt)
  const error = input.error ?? null
  if (input.status === 'applied' && error !== null) {
    throw new TypeError('applied applications cannot carry an error')
  }
  if ((input.status === 'failed' || input.status === 'closed') && !nonEmptyString(error)) {
    throw new TypeError(`${input.status} applications require a reason`)
  }
  return { runId, scope, status: input.status, assertionCount, error, updatedAt }
}

function normalizeRoute(input) {
  if (!isPlainObject(input)) throw new TypeError('setRoute requires a plain object')
  rejectUnknownFields(input, ROUTE_FIELDS, 'route')
  const scope = requireNonEmpty('scope', input.scope)
  const model = requireNonEmpty('model', input.model)
  const modelDigest = requireNonEmpty('modelDigest', input.modelDigest)
  const predicate = requireNonEmpty('predicate', input.predicate)
  if (!PROPOSAL_PREDICATES.has(predicate)) {
    throw new TypeError('predicate is not a proposal predicate')
  }
  const schemaVersion = requireNonEmpty('schemaVersion', input.schemaVersion)
  const sampleCount = requireCount('sampleCount', input.sampleCount)
  const precision = requireFinite('precision', input.precision)
  if (precision < 0 || precision > 1) throw new TypeError('precision must be between 0 and 1')
  const safetyFailures = requireCount('safetyFailures', input.safetyFailures)
  const updatedAt = requireFinite('updatedAt', input.updatedAt)

  // Route counters are not caller-entered evidence. They are required to be the
  // exact arithmetic result of an evaluation row that names its corpus, evaluator,
  // and model digest. A hand-entered 20/0.95/0 row without this evidence is refused.
  if (input.evidenceJson === undefined || input.evidenceJson === null) {
    throw new TypeError('setRoute requires evidenceJson counters')
  }
  let evidence
  if (typeof input.evidenceJson === 'string') {
    try {
      evidence = JSON.parse(input.evidenceJson)
    } catch {
      throw new TypeError('evidenceJson must be valid JSON')
    }
  } else {
    evidence = input.evidenceJson
  }
  canonicalJson(evidence)
  if (!routeEvidenceValid(evidence)) {
    throw new TypeError('evidenceJson does not match its evaluation counters')
  }
  if (evidence.modelDigest !== modelDigest) {
    throw new TypeError('evidenceJson modelDigest must match the route digest')
  }
  if (sampleCount !== evidence.positiveLabels) {
    throw new TypeError('sampleCount must equal the evidence positiveLabels')
  }
  if (safetyFailures !== evidence.safetyFailures) {
    throw new TypeError('safetyFailures must equal the evidence safetyFailures')
  }
  if (precision !== evidence.tp / (evidence.tp + evidence.fp)) {
    throw new TypeError('precision must equal tp / (tp + fp) from the evidence')
  }

  return {
    scope, model, modelDigest, predicate, schemaVersion, sampleCount, precision,
    safetyFailures, evidence, updatedAt,
  }
}

function proposalIdFor(run, index) {
  return sha256Canonical({
    runId: run.runId,
    scope: run.scope,
    inputHash: run.inputHash,
    model: run.model,
    modelDigest: run.modelDigest,
    schemaVersion: run.schemaVersion,
    index,
  })
}

function runSignature(run, items) {
  return canonicalJson({
    runId: run.runId,
    scope: run.scope,
    inputHash: run.inputHash,
    model: run.model,
    modelDigest: run.modelDigest,
    schemaVersion: run.schemaVersion,
    status: run.status,
    attempt: run.attempt,
    failureKind: run.failureKind,
    rawOutput: run.rawOutput,
    error: run.error,
    createdAt: run.createdAt,
    evidenceEventKeys: run.evidenceEventKeys ?? [],
    items: items.map((item) => ({
      itemIndex: item.itemIndex,
      verdict: item.verdict,
      predicate: item.predicate,
      payload: item.payload,
      errors: item.errors,
      reason: item.reason,
    })),
  })
}

function decodeRun(row) {
  return {
    runId: row.run_id,
    scope: row.scope,
    inputHash: row.input_hash,
    model: row.model,
    modelDigest: row.model_digest,
    schemaVersion: row.schema_version,
    status: row.status,
    attempt: row.attempt,
    failureKind: row.failure_kind ?? null,
    rawOutput: row.raw_output ?? null,
    error: row.error ?? null,
    createdAt: row.created_at,
    evidenceEventKeys: JSON.parse(row.evidence_keys_json ?? '[]'),
  }
}

function decodeItem(row) {
  return {
    proposalId: row.proposal_id,
    runId: row.run_id,
    scope: row.scope,
    itemIndex: row.item_index,
    verdict: row.verdict,
    predicate: row.predicate ?? null,
    payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
    errors: JSON.parse(row.errors_json),
    reason: row.reason ?? null,
    promotedAt: row.promoted_at ?? null,
    promotedAssertionId: row.promoted_assertion_id ?? null,
  }
}

export class ProposalJournal {
  constructor(db) {
    if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
      throw new TypeError('ProposalJournal requires an open DatabaseSync instance')
    }
    this.db = db
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_proposal_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        scope TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        model_digest TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
        attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
        failure_kind TEXT CHECK (
          failure_kind IS NULL OR failure_kind IN ('transient', 'permanent', 'unknown')
        ),
        raw_output TEXT,
        error TEXT,
        created_at REAL NOT NULL,
        evidence_keys_json TEXT NOT NULL DEFAULT '[]',
        CHECK (status = 'succeeded' OR error IS NOT NULL),
        CHECK ((status = 'succeeded' AND failure_kind IS NULL) OR
               (status = 'failed' AND failure_kind IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS ledger_proposals (
        proposal_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL REFERENCES ledger_proposal_runs(run_id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        item_index INTEGER NOT NULL CHECK (item_index >= 0),
        verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'candidate', 'rejected')),
        predicate TEXT,
        payload_json TEXT,
        errors_json TEXT NOT NULL,
        reason TEXT,
        UNIQUE (run_id, item_index)
      );

      CREATE TABLE IF NOT EXISTS ledger_proposal_routes (
        scope TEXT NOT NULL,
        model TEXT NOT NULL,
        model_digest TEXT NOT NULL,
        predicate TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
        precision REAL NOT NULL,
        safety_failures INTEGER NOT NULL CHECK (safety_failures >= 0),
        evidence_json TEXT,
        updated_at REAL NOT NULL,
        PRIMARY KEY (scope, model, model_digest, predicate, schema_version)
      );

      CREATE TABLE IF NOT EXISTS ledger_proposal_applications (
        run_id TEXT PRIMARY KEY NOT NULL
          REFERENCES ledger_proposal_runs(run_id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('applied', 'failed', 'closed')),
        assertion_count INTEGER NOT NULL CHECK (assertion_count >= 0),
        error TEXT,
        updated_at REAL NOT NULL,
        CHECK (status = 'applied' OR error IS NOT NULL)
      );
    `)

    // Promotion is metadata on the existing candidate row, not a verdict rewrite:
    // audit still sees the candidate, while metrics can tell it was injected.
    const proposalColumns = new Set(
      this.db.prepare("PRAGMA table_info('ledger_proposals')").all()
        .map((column) => column.name),
    )
    if (!proposalColumns.has('promoted_at')) {
      this.db.exec('ALTER TABLE ledger_proposals ADD COLUMN promoted_at REAL')
    }
    if (!proposalColumns.has('promoted_assertion_id')) {
      this.db.exec('ALTER TABLE ledger_proposals ADD COLUMN promoted_assertion_id TEXT')
    }

    // In-place upgrade from the first revision of this journal, which had neither
    // attempt/failure classification nor scope in the successful identity.
    const runColumns = new Set(
      this.db.prepare("PRAGMA table_info('ledger_proposal_runs')").all()
        .map((column) => column.name),
    )
    if (!runColumns.has('attempt')) {
      this.db.exec(
        'ALTER TABLE ledger_proposal_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1)',
      )
    }
    if (!runColumns.has('failure_kind')) {
      this.db.exec(`ALTER TABLE ledger_proposal_runs ADD COLUMN failure_kind TEXT
        CHECK (failure_kind IS NULL OR failure_kind IN ('transient', 'permanent', 'unknown'))`)
    }
    if (!runColumns.has('model_digest')) {
      this.db.exec("ALTER TABLE ledger_proposal_runs ADD COLUMN model_digest TEXT NOT NULL DEFAULT ''")
    }
    if (!runColumns.has('evidence_keys_json')) {
      this.db.exec(
        "ALTER TABLE ledger_proposal_runs ADD COLUMN evidence_keys_json TEXT NOT NULL DEFAULT '[]'",
      )
    }

    // Route identity includes the model digest. A pre-digest table cannot express
    // that key, so it is rebuilt; legacy rows keep an empty digest and can never
    // satisfy the read gate.
    const routeColumns = new Set(
      this.db.prepare("PRAGMA table_info('ledger_proposal_routes')").all()
        .map((column) => column.name),
    )
    if (!routeColumns.has('model_digest')) {
      this.db.exec(`
        ALTER TABLE ledger_proposal_routes RENAME TO ledger_proposal_routes_pre_digest;
        CREATE TABLE ledger_proposal_routes (
          scope TEXT NOT NULL,
          model TEXT NOT NULL,
          model_digest TEXT NOT NULL,
          predicate TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
          precision REAL NOT NULL,
          safety_failures INTEGER NOT NULL CHECK (safety_failures >= 0),
          evidence_json TEXT,
          updated_at REAL NOT NULL,
          PRIMARY KEY (scope, model, model_digest, predicate, schema_version)
        );
        INSERT INTO ledger_proposal_routes (
          scope, model, model_digest, predicate, schema_version, sample_count,
          precision, safety_failures, evidence_json, updated_at
        )
        SELECT scope, model, '', predicate, schema_version, sample_count, precision,
          safety_failures, evidence_json, updated_at
        FROM ledger_proposal_routes_pre_digest;
        DROP TABLE ledger_proposal_routes_pre_digest;
      `)
    }

    // `closed` is a permanent not-injectable outcome, distinct from a retryable
    // application failure. Older tables have a CHECK that rejects it.
    const applicationSql = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ledger_proposal_applications'",
    ).get()?.sql ?? ''
    if (!applicationSql.includes("'closed'")) {
      this.db.exec(`
        ALTER TABLE ledger_proposal_applications RENAME TO ledger_proposal_applications_pre_closed;
        CREATE TABLE ledger_proposal_applications (
          run_id TEXT PRIMARY KEY NOT NULL
            REFERENCES ledger_proposal_runs(run_id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('applied', 'failed', 'closed')),
          assertion_count INTEGER NOT NULL CHECK (assertion_count >= 0),
          error TEXT,
          updated_at REAL NOT NULL,
          CHECK (status = 'applied' OR error IS NOT NULL)
        );
        INSERT INTO ledger_proposal_applications (
          run_id, scope, status, assertion_count, error, updated_at
        )
        SELECT run_id, scope, status, assertion_count, error, updated_at
        FROM ledger_proposal_applications_pre_closed;
        DROP TABLE ledger_proposal_applications_pre_closed;
      `)
    }

    // Scope, model, and model digest are part of the successful identity: identical
    // counters from a different model build or scope are never a replay.
    this.db.exec(`
      DROP INDEX IF EXISTS ledger_proposal_runs_success_identity;
      DROP INDEX IF EXISTS ledger_proposal_runs_success_scope_identity;
      CREATE UNIQUE INDEX IF NOT EXISTS ledger_proposal_runs_success_scope_identity
        ON ledger_proposal_runs(scope, input_hash, model, model_digest, schema_version)
        WHERE status = 'succeeded';
      CREATE INDEX IF NOT EXISTS ledger_proposal_runs_scope_time
        ON ledger_proposal_runs(scope, created_at);
      CREATE INDEX IF NOT EXISTS ledger_proposal_runs_evidence_identity
        ON ledger_proposal_runs(scope, model, model_digest, schema_version, evidence_keys_json)
        WHERE status = 'succeeded';
      CREATE INDEX IF NOT EXISTS ledger_proposals_scope_verdict
        ON ledger_proposals(scope, verdict);
      CREATE INDEX IF NOT EXISTS ledger_proposal_routes_scope
        ON ledger_proposal_routes(scope, predicate);
      CREATE INDEX IF NOT EXISTS ledger_proposal_applications_scope
        ON ledger_proposal_applications(scope, status);
    `)
  }

  _transaction(write) {
    if (this.db.isTransaction) return write()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = write()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  _itemsForRun(runId) {
    return this.db.prepare(
      'SELECT * FROM ledger_proposals WHERE run_id = ? ORDER BY item_index',
    ).all(runId).map(decodeItem)
  }

  _successfulRun(scope, inputHash, model, modelDigest, schemaVersion) {
    const row = this.db.prepare(`
      SELECT * FROM ledger_proposal_runs
      WHERE scope = ? AND input_hash = ? AND model = ? AND model_digest = ?
        AND schema_version = ? AND status = 'succeeded'
      LIMIT 1
    `).get(scope, inputHash, model, modelDigest, schemaVersion) ?? null
    if (!row) return null
    // Defence in depth: even a future query change must not hand a foreign run
    // to the caller.
    if (row.scope !== scope) {
      throw new ProposalScopeMismatchError(row.run_id, row.scope, scope)
    }
    return row
  }

  findRun({ scope, inputHash, model, modelDigest, schemaVersion } = {}) {
    requireNonEmpty('scope', scope)
    requireNonEmpty('inputHash', inputHash)
    requireNonEmpty('model', model)
    requireNonEmpty('modelDigest', modelDigest)
    requireNonEmpty('schemaVersion', schemaVersion)
    // A successful run is the semantic cache entry. Failed attempts are still
    // observable when nothing succeeded, so callers can tell "never ran" from
    // "ran and failed" instead of retrying blindly.
    const row = this.db.prepare(`
      SELECT * FROM ledger_proposal_runs
      WHERE scope = ? AND input_hash = ? AND model = ? AND model_digest = ?
        AND schema_version = ?
      ORDER BY CASE status WHEN 'succeeded' THEN 0 ELSE 1 END, created_at DESC, run_id DESC
      LIMIT 1
    `).get(scope, inputHash, model, modelDigest, schemaVersion)
    if (!row) return null
    return { run: decodeRun(row), items: this._itemsForRun(row.run_id) }
  }

  // Evidence-based replay identity: scope, model, model digest, schema version, and
  // the sorted archived event keys. It deliberately excludes active facts, so an
  // old message cannot be re-analysed into a new fact after a user retraction. The
  // earliest successful run for the set is the canonical answer.
  findRunByEvidence({ scope, model, modelDigest, schemaVersion, evidenceEventKeys } = {}) {
    requireNonEmpty('scope', scope)
    requireNonEmpty('model', model)
    requireNonEmpty('modelDigest', modelDigest)
    requireNonEmpty('schemaVersion', schemaVersion)
    if (!Array.isArray(evidenceEventKeys) ||
        evidenceEventKeys.some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError('findRunByEvidence requires an array of non-empty evidence keys')
    }
    const normalized = [...new Set(evidenceEventKeys)].sort()
    if (normalized.length === 0) return null
    const row = this.db.prepare(`
      SELECT * FROM ledger_proposal_runs
      WHERE scope = ? AND model = ? AND model_digest = ? AND schema_version = ?
        AND status = 'succeeded' AND evidence_keys_json = ?
      ORDER BY created_at, run_id
      LIMIT 1
    `).get(scope, model, modelDigest, schemaVersion, canonicalJson(normalized)) ?? null
    if (!row) return null
    return { run: decodeRun(row), items: this._itemsForRun(row.run_id) }
  }

  recordRun(input) {
    const run = normalizeRun(input)
    return this._transaction(() => {
      // Only a successful attempt is cacheable evidence; failed attempts are
      // always archived so retries and later successes remain observable.
      if (run.status === 'succeeded') {
        const successful = this._successfulRun(
          run.scope, run.inputHash, run.model, run.modelDigest, run.schemaVersion,
        )
        if (successful) {
          const stored = decodeRun(successful)
          if (stored.scope !== run.scope) {
            throw new ProposalScopeMismatchError(stored.runId, stored.scope, run.scope)
          }
          const items = this._itemsForRun(stored.runId)
          if (stored.runId === run.runId &&
              runSignature(stored, items) !== runSignature(run, run.items)) {
            throw new Error(`successful proposal run is immutable: ${run.runId}`)
          }
          // A different run ID over a successful identity is a replay, not new
          // evidence: the stored run wins and no rows are added.
          return { run: stored, items, duplicate: true }
        }
      }

      const sameId = this.db.prepare(
        'SELECT * FROM ledger_proposal_runs WHERE run_id = ?',
      ).get(run.runId)
      if (sameId) {
        const stored = decodeRun(sameId)
        if (stored.scope !== run.scope) {
          throw new ProposalScopeMismatchError(stored.runId, stored.scope, run.scope)
        }
        const items = this._itemsForRun(stored.runId)
        if (runSignature(stored, items) !== runSignature(run, run.items)) {
          throw new Error(`proposal run cannot be mutated: ${run.runId}`)
        }
        return { run: stored, items, duplicate: true }
      }

      try {
        this.db.prepare(`
          INSERT INTO ledger_proposal_runs (
            run_id, scope, input_hash, model, model_digest, schema_version, status,
            attempt, failure_kind, raw_output, error, created_at, evidence_keys_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          run.runId, run.scope, run.inputHash, run.model, run.modelDigest, run.schemaVersion,
          run.status, run.attempt, run.failureKind, run.rawOutput, run.error, run.createdAt,
          canonicalJson(run.evidenceEventKeys),
        )
      } catch (error) {
        // The partial unique index is the real idempotency guard; if another
        // connection won the race, return its successful run unchanged.
        if (run.status === 'succeeded' && /UNIQUE constraint failed/i.test(String(error?.message))) {
          const winner = this._successfulRun(
            run.scope, run.inputHash, run.model, run.modelDigest, run.schemaVersion,
          )
          if (winner) {
            const stored = decodeRun(winner)
            return { run: stored, items: this._itemsForRun(stored.runId), duplicate: true }
          }
        }
        throw error
      }

      const insertItem = this.db.prepare(`
        INSERT INTO ledger_proposals (
          proposal_id, run_id, scope, item_index, verdict, predicate,
          payload_json, errors_json, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const item of run.items) {
        insertItem.run(
          proposalIdFor(run, item.itemIndex), run.runId, run.scope, item.itemIndex,
          item.verdict, item.predicate, canonicalJson(item.payload),
          canonicalJson(item.errors), item.reason,
        )
      }

      return {
        run: {
          runId: run.runId,
          scope: run.scope,
          inputHash: run.inputHash,
          model: run.model,
          modelDigest: run.modelDigest,
          schemaVersion: run.schemaVersion,
          status: run.status,
          attempt: run.attempt,
          failureKind: run.failureKind,
          rawOutput: run.rawOutput,
          error: run.error,
          createdAt: run.createdAt,
          evidenceEventKeys: run.evidenceEventKeys,
        },
        items: run.items.map((item) => ({
          proposalId: proposalIdFor(run, item.itemIndex),
          runId: run.runId,
          scope: run.scope,
          itemIndex: item.itemIndex,
          verdict: item.verdict,
          predicate: item.predicate,
          payload: item.payload,
          errors: item.errors,
          reason: item.reason,
          promotedAt: null,
          promotedAssertionId: null,
        })),
        duplicate: false,
      }
    })
  }

  // The journal is written before accepted assertions reach the ledger. This row is
  // how metrics and audit distinguish "analysed and applied" from "analysed but the
  // append failed", instead of either lying about acceptance or losing the run.
  getApplication(runId) {
    requireNonEmpty('runId', runId)
    const row = this.db.prepare(
      'SELECT * FROM ledger_proposal_applications WHERE run_id = ?',
    ).get(runId)
    if (!row) return null
    return {
      runId: row.run_id,
      scope: row.scope,
      status: row.status,
      assertionCount: row.assertion_count,
      error: row.error ?? null,
      updatedAt: row.updated_at,
    }
  }

  recordApplication(input) {
    const application = normalizeApplication(input)
    return this._transaction(() => {
      const run = this.db.prepare(
        'SELECT scope FROM ledger_proposal_runs WHERE run_id = ?',
      ).get(application.runId)
      if (!run) {
        throw new TypeError(`application requires an archived run: ${application.runId}`)
      }
      if (run.scope !== application.scope) {
        throw new ProposalScopeMismatchError(
          application.runId, run.scope, application.scope,
        )
      }
      const existing = this.getApplication(application.runId)
      if (existing) {
        if (existing.status === application.status &&
            existing.assertionCount === application.assertionCount &&
            existing.error === application.error) {
          return existing
        }
        // `applied` and `closed` are final. A failed attempt wrote no facts, so a
        // later replay may refine its reason or complete it. Closed records never
        // silently reopen: a route restored later does not turn a permanent closure
        // into an injection without a new proposal run.
        if (existing.status !== 'failed') {
          throw new Error(`proposal application is immutable: ${application.runId}`)
        }
        this.db.prepare(`
          UPDATE ledger_proposal_applications
          SET status = ?, assertion_count = ?, error = ?, updated_at = ?
          WHERE run_id = ?
        `).run(
          application.status, application.assertionCount, application.error,
          application.updatedAt, application.runId,
        )
        return this.getApplication(application.runId)
      }
      this.db.prepare(`
        INSERT INTO ledger_proposal_applications (
          run_id, scope, status, assertion_count, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        application.runId, application.scope, application.status,
        application.assertionCount, application.error, application.updatedAt,
      )
      return this.getApplication(application.runId)
    })
  }

  // Promotion is recorded on the candidate row itself. The verdict stays
  // `candidate` for audit, while metrics stop counting an injected fact as an
  // open candidate. COALESCE keeps the first promotion timestamp on idempotent
  // re-promotion.
  markPromoted({ proposalId, scope, promotedAt, promotedAssertionId } = {}) {
    requireNonEmpty('proposalId', proposalId)
    requireNonEmpty('scope', scope)
    requireFinite('promotedAt', promotedAt)
    requireNonEmpty('promotedAssertionId', promotedAssertionId)
    return this._transaction(() => {
      const row = this.db.prepare(
        'SELECT * FROM ledger_proposals WHERE proposal_id = ?',
      ).get(proposalId)
      if (!row) throw new TypeError(`unknown proposal: ${proposalId}`)
      if (row.scope !== scope) {
        throw new ProposalScopeMismatchError(row.run_id, row.scope, scope)
      }
      if (row.verdict !== 'candidate') {
        throw new TypeError('promotion requires a candidate proposal')
      }
      this.db.prepare(`
        UPDATE ledger_proposals
        SET promoted_at = COALESCE(promoted_at, ?),
            promoted_assertion_id = COALESCE(promoted_assertion_id, ?)
        WHERE proposal_id = ? AND scope = ?
      `).run(promotedAt, promotedAssertionId, proposalId, scope)
      return decodeItem(this.db.prepare(
        'SELECT * FROM ledger_proposals WHERE proposal_id = ?',
      ).get(proposalId))
    })
  }

  listProposals(scope, { verdict } = {}) {
    requireNonEmpty('scope', scope)
    if (verdict !== undefined && verdict !== null && !ITEM_VERDICTS.has(verdict)) {
      throw new TypeError('verdict must be accepted, candidate, or rejected')
    }
    const base = `
      SELECT p.* FROM ledger_proposals p
      JOIN ledger_proposal_runs r ON r.run_id = p.run_id
      WHERE p.scope = ?
    `
    const order = ' ORDER BY r.created_at, p.run_id, p.item_index'
    const rows = verdict === undefined || verdict === null
      ? this.db.prepare(`${base}${order}`).all(scope)
      : this.db.prepare(`${base} AND p.verdict = ?${order}`).all(scope, verdict)
    return rows.map(decodeItem)
  }

  metrics(scope) {
    requireNonEmpty('scope', scope)
    const byStatus = { succeeded: 0, failed: 0 }
    for (const row of this.db.prepare(
      'SELECT status, count(*) AS count FROM ledger_proposal_runs WHERE scope = ? GROUP BY status',
    ).all(scope)) {
      if (Object.hasOwn(byStatus, row.status)) byStatus[row.status] = row.count
    }
    const byVerdict = { accepted: 0, candidate: 0, rejected: 0, promoted: 0 }
    for (const row of this.db.prepare(`
      SELECT verdict, (promoted_assertion_id IS NOT NULL) AS promoted, count(*) AS count
      FROM ledger_proposals WHERE scope = ? GROUP BY verdict, promoted
    `).all(scope)) {
      if (row.promoted === 1 && row.verdict === 'candidate') {
        byVerdict.promoted += row.count
      } else if (Object.hasOwn(byVerdict, row.verdict)) {
        byVerdict[row.verdict] = row.count
      }
    }
    const applications = { applied: 0, failed: 0, closed: 0 }
    for (const row of this.db.prepare(`
      SELECT status, count(*) AS count FROM ledger_proposal_applications
      WHERE scope = ? GROUP BY status
    `).all(scope)) {
      if (Object.hasOwn(applications, row.status)) applications[row.status] = row.count
    }

    const modelRollups = new Map()
    const modelEntry = (model) => {
      if (!modelRollups.has(model)) {
        modelRollups.set(model, {
          runs: { total: 0, succeeded: 0, failed: 0 },
          proposals: { total: 0, accepted: 0, candidate: 0, rejected: 0, promoted: 0 },
        })
      }
      return modelRollups.get(model)
    }
    for (const row of this.db.prepare(`
      SELECT model, status, count(*) AS count FROM ledger_proposal_runs
      WHERE scope = ? GROUP BY model, status ORDER BY model, status
    `).all(scope)) {
      const entry = modelEntry(row.model)
      entry.runs.total += row.count
      if (Object.hasOwn(entry.runs, row.status)) entry.runs[row.status] = row.count
    }
    for (const row of this.db.prepare(`
      SELECT r.model AS model, p.verdict AS verdict,
        (p.promoted_assertion_id IS NOT NULL) AS promoted, count(*) AS count
      FROM ledger_proposals p
      JOIN ledger_proposal_runs r ON r.run_id = p.run_id
      WHERE p.scope = ? GROUP BY r.model, p.verdict, promoted ORDER BY r.model, p.verdict
    `).all(scope)) {
      const entry = modelEntry(row.model)
      entry.proposals.total += row.count
      if (row.promoted === 1 && row.verdict === 'candidate') {
        entry.proposals.promoted += row.count
      } else if (Object.hasOwn(entry.proposals, row.verdict)) {
        entry.proposals[row.verdict] = row.count
      }
    }

    // Items may legally carry no predicate; keep that bucket explicit instead of
    // collapsing it into an ordinary predicate name.
    const predicateRollups = new Map()
    for (const row of this.db.prepare(`
      SELECT predicate, verdict, (promoted_assertion_id IS NOT NULL) AS promoted,
        count(*) AS count FROM ledger_proposals
      WHERE scope = ? GROUP BY predicate, verdict, promoted ORDER BY predicate, verdict
    `).all(scope)) {
      const key = row.predicate ?? '(none)'
      if (!predicateRollups.has(key)) {
        predicateRollups.set(key, {
          predicate: row.predicate ?? null,
          proposals: { total: 0, accepted: 0, candidate: 0, rejected: 0, promoted: 0 },
        })
      }
      const entry = predicateRollups.get(key)
      entry.proposals.total += row.count
      if (row.promoted === 1 && row.verdict === 'candidate') {
        entry.proposals.promoted += row.count
      } else if (Object.hasOwn(entry.proposals, row.verdict)) {
        entry.proposals[row.verdict] = row.count
      }
    }

    const rejectionReasons = new Map()
    for (const row of this.db.prepare(`
      SELECT reason, count(*) AS count FROM ledger_proposals
      WHERE scope = ? AND verdict = 'rejected' GROUP BY reason ORDER BY reason
    `).all(scope)) {
      rejectionReasons.set(row.reason ?? '(none)', row.count)
    }

    const runsTotal = byStatus.succeeded + byStatus.failed
    const proposalsTotal = byVerdict.accepted + byVerdict.candidate +
      byVerdict.rejected + byVerdict.promoted
    // Precedence matters: successful evidence outranks failed attempts, an empty
    // successful run is not the same thing as never having run at all, and the
    // latest application outcome decides whether facts are missing. The state is
    // derived, never sticky: a later successful application recovers it even while
    // an older run's failure remains archived.
    let state = byStatus.succeeded > 0
      ? (proposalsTotal > 0 ? 'found' : 'ran-empty')
      : (byStatus.failed > 0 ? 'failed' : 'not-run')
    const latestApplication = this.db.prepare(`
      SELECT status FROM ledger_proposal_applications
      WHERE scope = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get(scope)
    // A permanent closure (closed target or evidence that no longer validates) is
    // not an application failure: it never wrote facts and never will under this
    // run, so the scope state stays derived from the runs instead of sticking at
    // apply-failed. Only a retryable failure, including a temporarily revoked
    // route, changes the state.
    if (latestApplication?.status === 'failed') state = 'apply-failed'

    const last = this.db.prepare(`
      SELECT run_id, status, attempt, failure_kind, created_at FROM ledger_proposal_runs
      WHERE scope = ? ORDER BY created_at DESC, run_id DESC LIMIT 1
    `).get(scope)
    const lastApplication = last
      ? this.db.prepare(
        'SELECT status, error FROM ledger_proposal_applications WHERE run_id = ?',
      ).get(last.run_id)
      : null
    const lastRun = last
      ? {
        runId: last.run_id,
        status: last.status,
        attempt: last.attempt,
        failureKind: last.failure_kind ?? null,
        createdAt: last.created_at,
        proposalCount: this.db.prepare(
          'SELECT count(*) AS count FROM ledger_proposals WHERE run_id = ?',
        ).get(last.run_id).count,
        application: lastApplication
          ? { status: lastApplication.status, error: lastApplication.error ?? null }
          : null,
      }
      : null

    return {
      scope,
      state,
      runs: { total: runsTotal, succeeded: byStatus.succeeded, failed: byStatus.failed },
      applications: {
        applied: applications.applied,
        failed: applications.failed,
        closed: applications.closed,
      },
      proposals: {
        total: proposalsTotal,
        accepted: byVerdict.accepted,
        candidate: byVerdict.candidate,
        rejected: byVerdict.rejected,
        promoted: byVerdict.promoted,
      },
      byModel: Object.fromEntries(modelRollups),
      byPredicate: Object.fromEntries(predicateRollups),
      rejectionReasons: Object.fromEntries(rejectionReasons),
      lastRun,
    }
  }

  // Trusted internal write path: only the offline evaluator may call setRoute.
  // It is never reachable from model output, user input, or request handlers.
  // Evidence counters are validated here, while enablement stays derived on read.
  setRoute(input) {
    const route = normalizeRoute(input)
    this.db.prepare(`
      INSERT INTO ledger_proposal_routes (
        scope, model, model_digest, predicate, schema_version, sample_count, precision,
        safety_failures, evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, model, model_digest, predicate, schema_version) DO UPDATE SET
        sample_count = excluded.sample_count,
        precision = excluded.precision,
        safety_failures = excluded.safety_failures,
        evidence_json = excluded.evidence_json,
        updated_at = excluded.updated_at
    `).run(
      route.scope, route.model, route.modelDigest, route.predicate, route.schemaVersion,
      route.sampleCount, route.precision, route.safetyFailures,
      canonicalJson(route.evidence), route.updatedAt,
    )
    return this.getRoute({
      scope: route.scope,
      model: route.model,
      modelDigest: route.modelDigest,
      predicate: route.predicate,
      schemaVersion: route.schemaVersion,
    })
  }

  getRoute({ scope, model, modelDigest, predicate, schemaVersion } = {}) {
    requireNonEmpty('scope', scope)
    requireNonEmpty('model', model)
    requireNonEmpty('modelDigest', modelDigest)
    requireNonEmpty('predicate', predicate)
    requireNonEmpty('schemaVersion', schemaVersion)
    const row = this.db.prepare(`
      SELECT * FROM ledger_proposal_routes
      WHERE scope = ? AND model = ? AND model_digest = ? AND predicate = ?
        AND schema_version = ?
    `).get(scope, model, modelDigest, predicate, schemaVersion)
    if (!row) return null
    const evidence = row.evidence_json === null ? null : JSON.parse(row.evidence_json)
    // Enablement is derived from a fully validated row. A hand-edited counter set,
    // a mismatched digest, a missing evidence row, or recall below the floor keeps
    // the route closed even if the stored integers look sufficient.
    const enabled = routeRowValid({
      sampleCount: row.sample_count,
      precision: row.precision,
      recall: evidence?.recall,
      safetyFailures: row.safety_failures,
      evidence,
      modelDigest: row.model_digest,
    })
    return {
      scope: row.scope,
      model: row.model,
      modelDigest: row.model_digest,
      predicate: row.predicate,
      schemaVersion: row.schema_version,
      sampleCount: row.sample_count,
      precision: row.precision,
      recall: evidence?.recall ?? null,
      safetyFailures: row.safety_failures,
      evidence,
      updatedAt: row.updated_at,
      enabled,
      status: enabled ? 'enabled' : 'disabled',
    }
  }
}
