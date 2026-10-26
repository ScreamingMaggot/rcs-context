import { DatabaseSync } from 'node:sqlite'
import {
  canonicalJson,
  INJECTABLE_VERIFICATIONS,
  projectLedger,
  projectionHash,
  factsAt as selectFactsAt,
  registryEntry,
  renderFacts,
  routeRowValid,
  validateAssertionInput,
} from './memory-ledger-core.mjs'

const REDUCER_VERSION = 'r1'
const DEFAULT_MAX_PROJECTION_EVENTS = 5000
const DEFAULT_MAX_PROJECTION_MS = 30000

function jsonColumn(value) {
  return value === undefined ? null : canonicalJson(value)
}

function decodeRow(row) {
  return JSON.parse(row.fact_json)
}

// Archive reads are read-only by runtime enforcement, not convention: a caller
// holding the DTO cannot reach the archived row through a nested object either.
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export class MemoryLedger {
  constructor(filename, {
    reducer = projectLedger,
    maxProjectionEvents = DEFAULT_MAX_PROJECTION_EVENTS,
    maxProjectionMs = DEFAULT_MAX_PROJECTION_MS,
  } = {}) {
    if (typeof reducer !== 'function') throw new TypeError('reducer must be a function')
    if (!Number.isInteger(maxProjectionEvents) || maxProjectionEvents <= 0) {
      throw new TypeError('maxProjectionEvents must be a positive integer')
    }
    if (!Number.isFinite(maxProjectionMs) || maxProjectionMs <= 0) {
      throw new TypeError('maxProjectionMs must be a positive number')
    }
    this.db = new DatabaseSync(filename)
    this.reducer = reducer
    this.maxProjectionEvents = maxProjectionEvents
    this.maxProjectionMs = maxProjectionMs
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_observations (
        event_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        sid TEXT NOT NULL,
        seq INTEGER NOT NULL,
        valid_at REAL NOT NULL,
        recorded_at REAL NOT NULL,
        op TEXT NOT NULL,
        outcome TEXT NOT NULL,
        subject_entity_id TEXT NOT NULL,
        target_entity_id TEXT,
        value_json TEXT,
        generation_hints_json TEXT,
        raw_ref TEXT,
        raw_payload_json TEXT,
        source_json TEXT,
        extractor_version TEXT,
        projection_state TEXT NOT NULL CHECK (projection_state IN ('pending', 'applied', 'dead')),
        projection_error TEXT,
        full_input_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_observations_scope
        ON ledger_observations(scope, valid_at, sid, seq, event_key);

      CREATE TABLE IF NOT EXISTS ledger_assertions (
        assertion_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        subject_entity_id TEXT NOT NULL,
        sid TEXT NOT NULL,
        seq INTEGER NOT NULL,
        op TEXT NOT NULL,
        target_assertion_id TEXT,
        predicate TEXT NOT NULL,
        value_json TEXT,
        qualifiers_json TEXT,
        valid_at REAL NOT NULL,
        recorded_at REAL NOT NULL,
        source_kind TEXT NOT NULL,
        source_authority TEXT,
        evidence_json TEXT,
        verification TEXT NOT NULL,
        reducer_version TEXT NOT NULL,
        projection_state TEXT NOT NULL CHECK (projection_state IN ('pending', 'applied', 'dead')),
        projection_error TEXT,
        full_input_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_assertions_scope
        ON ledger_assertions(scope, valid_at, sid, seq, assertion_id);

      CREATE TABLE IF NOT EXISTS ledger_entities (
        scope TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        presence INTEGER NOT NULL,
        opened_by_json TEXT,
        closed_by_json TEXT,
        last_valid_at REAL,
        last_recorded_at REAL,
        PRIMARY KEY (scope, entity_id)
      );

      CREATE TABLE IF NOT EXISTS ledger_fact_versions (
        fact_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        subject_entity_id TEXT NOT NULL,
        subject_display TEXT,
        generation INTEGER,
        predicate TEXT NOT NULL,
        value_json TEXT,
        qualifiers_json TEXT,
        assertion_id TEXT NOT NULL,
        evidence_json TEXT,
        causal_order TEXT NOT NULL,
        valid_from REAL NOT NULL,
        valid_to REAL,
        recorded_at REAL NOT NULL,
        retired_at REAL,
        status TEXT NOT NULL,
        verification TEXT,
        conflict_json TEXT,
        op TEXT,
        target_assertion_id TEXT,
        sid TEXT,
        seq INTEGER,
        reducer_version TEXT,
        source_kind TEXT,
        source_authority TEXT,
        fact_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_fact_versions_current
        ON ledger_fact_versions(scope, subject_entity_id, generation, retired_at, valid_to, status);
      CREATE INDEX IF NOT EXISTS ledger_fact_versions_history
        ON ledger_fact_versions(scope, valid_from, valid_to, recorded_at, retired_at);

      CREATE TABLE IF NOT EXISTS ledger_observation_placements (
        event_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        role TEXT NOT NULL,
        generation INTEGER,
        unplaced INTEGER NOT NULL,
        reason TEXT,
        causal_order TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_observation_placements_scope
        ON ledger_observation_placements(scope, event_key);

      CREATE TABLE IF NOT EXISTS ledger_assertion_placements (
        assertion_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        generation INTEGER,
        unplaced INTEGER NOT NULL,
        reason TEXT,
        causal_order TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_assertion_placements_scope
        ON ledger_assertion_placements(scope, assertion_id);

      CREATE TABLE IF NOT EXISTS ledger_meta (
        scope TEXT PRIMARY KEY,
        reducer_version TEXT NOT NULL,
        projection_hash TEXT,
        status TEXT NOT NULL DEFAULT 'applied',
        projection_error TEXT,
        failing_record TEXT
      );
    `)
    this._ensureMetaColumns()
  }

  _ensureMetaColumns() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(ledger_meta)').all()
      .map((column) => column.name))
    for (const [name, definition] of [
      ['status', "TEXT NOT NULL DEFAULT 'applied'"],
      ['projection_error', 'TEXT'],
      ['failing_record', 'TEXT'],
    ]) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE ledger_meta ADD COLUMN ${name} ${definition}`)
      }
    }
  }

  _transaction(write) {
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

  _storedHash(scope) {
    const hash = this.db.prepare(
      'SELECT projection_hash FROM ledger_meta WHERE scope = ?',
    ).get(scope)?.projection_hash ?? null
    return hash === '' ? null : hash
  }

  appendObservation(input) {
    const hashes = this._appendBatch({ observations: [input] })
    return hashes[input?.scope] ?? null
  }

  appendAssertion(input) {
    const hashes = this._appendBatch({ assertions: [input] })
    return hashes[input?.scope] ?? null
  }

  // Batch archive (one transaction) followed by exactly one projection per affected
  // scope. This is the audit path: 158 individual rebuilds collapsed to one pass.
  appendObservations(inputs) {
    return this._appendBatch({ observations: inputs })
  }

  appendAssertions(inputs) {
    return this._appendBatch({ assertions: inputs })
  }

  // Mixed batch used when a proposal run needs to open its project entity and
  // append its accepted assertions under exactly one projection.
  appendEvents({ observations = [], assertions = [] } = {}) {
    if (!Array.isArray(observations) || !Array.isArray(assertions)) {
      throw new TypeError('appendEvents requires observation and assertion arrays')
    }
    return this._appendBatch({ observations, assertions })
  }

  // Read-only archive lookup. Each call re-parses the canonical archive row into a
  // frozen copy, so a caller mutating the returned object can never change what was
  // archived. An optional `scope` turns a foreign record into the same `null` a
  // missing record yields: callers cannot probe other scopes.
  getObservation(eventKey, { scope } = {}) {
    if (typeof eventKey !== 'string' || eventKey.trim() === '') {
      throw new TypeError('getObservation requires a non-empty event key')
    }
    if (scope !== undefined && !nonEmptyString(scope)) {
      throw new TypeError('getObservation scope must be a non-empty string when provided')
    }
    const row = this.db.prepare(
      'SELECT full_input_json, projection_state, projection_error FROM ledger_observations WHERE event_key = ?',
    ).get(eventKey)
    if (!row) return null
    const archived = JSON.parse(row.full_input_json)
    if (scope !== undefined && archived.scope !== scope) return null
    return deepFreeze({
      ...archived,
      eventKey,
      projectionState: row.projection_state,
      projectionError: row.projection_error ?? null,
    })
  }

  // Read-only assertion lookup, used by application replay to decide whether an
  // accepted proposal really reached the archive. Like getObservation, a foreign
  // record is indistinguishable from a missing one when a scope is supplied.
  getAssertion(assertionId, { scope } = {}) {
    if (typeof assertionId !== 'string' || assertionId.trim() === '') {
      throw new TypeError('getAssertion requires a non-empty assertion id')
    }
    if (scope !== undefined && !nonEmptyString(scope)) {
      throw new TypeError('getAssertion scope must be a non-empty string when provided')
    }
    const row = this.db.prepare(
      'SELECT full_input_json, projection_state, projection_error FROM ledger_assertions WHERE assertion_id = ?',
    ).get(assertionId)
    if (!row) return null
    const archived = JSON.parse(row.full_input_json)
    if (scope !== undefined && archived.scope !== scope) return null
    return deepFreeze({
      ...archived,
      assertionId,
      projectionState: row.projection_state,
      projectionError: row.projection_error ?? null,
    })
  }

  _insertObservation(input, fullInput) {
    this.db.prepare(`
      INSERT INTO ledger_observations (
        event_key, scope, sid, seq, valid_at, recorded_at, op, outcome,
        subject_entity_id, target_entity_id, value_json, generation_hints_json,
        raw_ref, raw_payload_json, source_json, extractor_version,
        projection_state, projection_error, full_input_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)
    `).run(
      input.eventKey, input.scope, input.sid, input.seq, input.validAt, input.recordedAt,
      input.op, input.outcome, input.subjectEntityId, input.targetEntityId ?? null,
      jsonColumn(input.value), jsonColumn(input.generationHints), input.rawRef ?? null,
      jsonColumn(input.rawPayload), jsonColumn(input.source), input.extractorVersion ?? null,
      fullInput,
    )
  }

  _insertAssertion(input, fullInput) {
    this.db.prepare(`
      INSERT INTO ledger_assertions (
        assertion_id, scope, subject_entity_id, sid, seq, op, target_assertion_id,
        predicate, value_json, qualifiers_json, valid_at, recorded_at,
        source_kind, source_authority, evidence_json, verification, reducer_version,
        projection_state, projection_error, full_input_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)
    `).run(
      input.assertionId, input.scope, input.subjectEntityId, input.sid, input.seq,
      input.op, input.targetAssertionId ?? null, input.predicate, jsonColumn(input.value),
      jsonColumn(input.qualifiers), input.validAt, input.recordedAt, input.sourceKind,
      input.sourceAuthority ?? null, jsonColumn(input.evidence), input.verification,
      REDUCER_VERSION, fullInput,
    )
  }

  _appendBatch({ observations = [], assertions = [] } = {}) {
    if (!Array.isArray(observations) || !Array.isArray(assertions)) {
      throw new TypeError('batch append requires arrays')
    }
    const scopes = new Set()
    const newScopes = new Set()
    const pendingObservations = []
    const pendingAssertions = []
    const seenObservations = new Map()
    const seenAssertions = new Map()

    for (const input of observations) {
      if (typeof input?.eventKey !== 'string' || input.eventKey === '' ||
          typeof input?.scope !== 'string' || input.scope === '') {
        throw new TypeError('observation requires a non-empty eventKey and scope')
      }
      const fullInput = canonicalJson(input)
      if (seenObservations.has(input.eventKey)) {
        if (seenObservations.get(input.eventKey) !== fullInput) {
          throw new Error(`eventKey appears twice with different input: ${input.eventKey}`)
        }
        continue
      }
      seenObservations.set(input.eventKey, fullInput)
      const existing = this.db.prepare(
        'SELECT scope, full_input_json FROM ledger_observations WHERE event_key = ?',
      ).get(input.eventKey)
      if (existing) {
        if (existing.full_input_json !== fullInput) {
          throw new Error(`eventKey already archived with different input: ${input.eventKey}`)
        }
        scopes.add(existing.scope)
        continue
      }
      pendingObservations.push({ input, fullInput })
      scopes.add(input.scope)
      newScopes.add(input.scope)
    }

    for (const input of assertions) {
      const validation = validateAssertionInput(input)
      if (!validation.valid) {
        throw new TypeError(
          `invalid Assertion input (${input?.assertionId ?? 'unknown'}): ${validation.errors.join(',')}`,
        )
      }
      const fullInput = canonicalJson(input)
      if (seenAssertions.has(input.assertionId)) {
        if (seenAssertions.get(input.assertionId) !== fullInput) {
          throw new Error(`assertionId appears twice with different input: ${input.assertionId}`)
        }
        continue
      }
      seenAssertions.set(input.assertionId, fullInput)
      const existing = this.db.prepare(
        'SELECT scope, full_input_json FROM ledger_assertions WHERE assertion_id = ?',
      ).get(input.assertionId)
      if (existing) {
        if (existing.full_input_json !== fullInput) {
          throw new Error(`assertionId already archived with different input: ${input.assertionId}`)
        }
        scopes.add(existing.scope)
        continue
      }
      pendingAssertions.push({ input, fullInput })
      scopes.add(input.scope)
      newScopes.add(input.scope)
    }

    if (pendingObservations.length > 0 || pendingAssertions.length > 0) {
      this._transaction(() => {
        for (const entry of pendingObservations) {
          this._insertObservation(entry.input, entry.fullInput)
        }
        for (const entry of pendingAssertions) {
          this._insertAssertion(entry.input, entry.fullInput)
        }
      })
    }

    const hashes = {}
    for (const scope of scopes) hashes[scope] = this._storedHash(scope)
    for (const scope of newScopes) hashes[scope] = this.rebuild(scope)
    return hashes
  }

  _archive(scope) {
    const observations = this.db.prepare(`
      SELECT full_input_json FROM ledger_observations WHERE scope = ?
      ORDER BY valid_at, sid, seq, event_key
    `).all(scope).map((row) => JSON.parse(row.full_input_json))
    const assertions = this.db.prepare(`
      SELECT full_input_json FROM ledger_assertions WHERE scope = ?
      ORDER BY valid_at, sid, seq, assertion_id
    `).all(scope).map((row) => JSON.parse(row.full_input_json))
    return { observations, assertions }
  }

  _clearDerived(scope) {
    this.db.prepare('DELETE FROM ledger_fact_versions WHERE scope = ?').run(scope)
    this.db.prepare('DELETE FROM ledger_observation_placements WHERE scope = ?').run(scope)
    this.db.prepare('DELETE FROM ledger_assertion_placements WHERE scope = ?').run(scope)
    this.db.prepare('DELETE FROM ledger_entities WHERE scope = ?').run(scope)
    this.db.prepare('DELETE FROM ledger_meta WHERE scope = ?').run(scope)
  }

  _projectionFailed(scope, error) {
    const text = String(error?.stack ?? error?.message ?? error)
    this._transaction(() => {
      const pendingObservation = this.db.prepare(`
        SELECT event_key FROM ledger_observations
        WHERE scope = ? AND projection_state = 'pending'
        ORDER BY recorded_at, event_key LIMIT 1
      `).get(scope)
      const pendingAssertion = this.db.prepare(`
        SELECT assertion_id FROM ledger_assertions
        WHERE scope = ? AND projection_state = 'pending'
        ORDER BY recorded_at, assertion_id LIMIT 1
      `).get(scope)
      const latestObservation = this.db.prepare(`
        SELECT event_key FROM ledger_observations
        WHERE scope = ? ORDER BY recorded_at DESC, event_key DESC LIMIT 1
      `).get(scope)
      const latestAssertion = this.db.prepare(`
        SELECT assertion_id FROM ledger_assertions
        WHERE scope = ? ORDER BY recorded_at DESC, assertion_id DESC LIMIT 1
      `).get(scope)
      const failingRecord = pendingObservation?.event_key ?? pendingAssertion?.assertion_id ??
        latestObservation?.event_key ?? latestAssertion?.assertion_id ?? null

      // Only unprojected input becomes dead. Every previously derived row, fact
      // version, and the last good projection hash stay intact so a single poison
      // record can never blank an otherwise valid scope.
      this.db.prepare(`
        UPDATE ledger_observations SET projection_state = 'dead', projection_error = ?
        WHERE scope = ? AND projection_state = 'pending'
      `).run(text, scope)
      this.db.prepare(`
        UPDATE ledger_assertions SET projection_state = 'dead', projection_error = ?
        WHERE scope = ? AND projection_state = 'pending'
      `).run(text, scope)

      this.db.prepare(`
        INSERT INTO ledger_meta (
          scope, reducer_version, projection_hash, status, projection_error, failing_record
        ) VALUES (?, ?, ?, 'failed', ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          reducer_version = excluded.reducer_version,
          status = 'failed',
          projection_error = excluded.projection_error,
          failing_record = excluded.failing_record
      `).run(scope, REDUCER_VERSION, this._storedHash(scope) ?? '', text, failingRecord)
    })
    return null
  }

  projectionStatus(scope) {
    const row = this.db.prepare(`
      SELECT reducer_version, projection_hash, status, projection_error, failing_record
      FROM ledger_meta WHERE scope = ?
    `).get(scope)
    if (!row) {
      return {
        status: 'empty', reducerVersion: null, projectionHash: null,
        reason: null, failingRecord: null,
      }
    }
    return {
      status: row.status ?? 'applied',
      reducerVersion: row.reducer_version,
      projectionHash: row.projection_hash === '' ? null : (row.projection_hash ?? null),
      reason: row.projection_error ?? null,
      failingRecord: row.failing_record ?? null,
    }
  }

  rebuild(scope) {
    const { observations, assertions } = this._archive(scope)
    const eventCount = observations.length + assertions.length
    if (eventCount > this.maxProjectionEvents) {
      return this._projectionFailed(scope, new Error(
        `projection-event-limit-exceeded: ${eventCount} > ${this.maxProjectionEvents}`,
      ))
    }
    const started = process.hrtime.bigint()
    let projection
    let hash
    let prepared
    try {
      // Reduction and canonical serialization are pure and happen before BEGIN IMMEDIATE.
      projection = this.reducer({ observations, assertions, reducerVersion: REDUCER_VERSION })
      hash = projectionHash(projection)
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
      if (elapsedMs > this.maxProjectionMs) {
        throw new Error(
          `projection-time-limit-exceeded: ${elapsedMs.toFixed(0)}ms > ${this.maxProjectionMs}ms`,
        )
      }
      prepared = {
        entities: projection.entities.map((entity) => [
          entity.scope, entity.entityId, entity.generation, entity.presence ? 1 : 0,
          jsonColumn(entity.openedBy), jsonColumn(entity.closedBy),
          entity.lastValidAt, entity.lastRecordedAt,
        ]),
        observationPlacements: projection.observationPlacements.map((placement) => [
          placement.eventKey, placement.scope, placement.entityId, placement.role,
          placement.generation, placement.unplaced ? 1 : 0, placement.reason,
          canonicalJson(placement.causalOrder),
        ]),
        assertionPlacements: projection.assertionPlacements.map((placement) => [
          placement.assertionId, placement.scope, placement.entityId, placement.generation,
          placement.unplaced ? 1 : 0, placement.reason, canonicalJson(placement.causalOrder),
        ]),
        facts: projection.factVersions.map((fact) => [
          fact.factKey, fact.scope, fact.subjectEntityId, fact.subjectDisplay ?? null,
          fact.generation, fact.predicate, jsonColumn(fact.value), jsonColumn(fact.qualifiers),
          fact.assertionId, jsonColumn(fact.evidence), canonicalJson(fact.causalOrder),
          fact.validFrom, fact.validTo, fact.recordedAt, fact.retiredAt, fact.status,
          fact.verification ?? null, jsonColumn(fact.conflict), fact.op ?? null,
          fact.targetAssertionId ?? null, fact.sid ?? null, fact.seq ?? null,
          fact.reducerVersion ?? null, fact.sourceKind ?? null, fact.sourceAuthority ?? null,
          canonicalJson(fact),
        ]),
      }
    } catch (error) {
      return this._projectionFailed(scope, error)
    }

    return this._transaction(() => {
      this._clearDerived(scope)
      const insertEntity = this.db.prepare(`
        INSERT INTO ledger_entities (
          scope, entity_id, generation, presence, opened_by_json, closed_by_json,
          last_valid_at, last_recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const values of prepared.entities) insertEntity.run(...values)

      const insertObservationPlacement = this.db.prepare(`
        INSERT INTO ledger_observation_placements (
          event_key, scope, entity_id, role, generation, unplaced, reason, causal_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const values of prepared.observationPlacements) insertObservationPlacement.run(...values)

      const insertAssertionPlacement = this.db.prepare(`
        INSERT INTO ledger_assertion_placements (
          assertion_id, scope, entity_id, generation, unplaced, reason, causal_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (const values of prepared.assertionPlacements) insertAssertionPlacement.run(...values)

      const insertFact = this.db.prepare(`
        INSERT INTO ledger_fact_versions (
          fact_key, scope, subject_entity_id, subject_display, generation, predicate,
          value_json, qualifiers_json, assertion_id, evidence_json, causal_order,
          valid_from, valid_to, recorded_at, retired_at, status, verification,
          conflict_json, op, target_assertion_id, sid, seq, reducer_version,
          source_kind, source_authority, fact_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const values of prepared.facts) insertFact.run(...values)

      this.db.prepare(`
        INSERT INTO ledger_meta (
          scope, reducer_version, projection_hash, status, projection_error, failing_record
        ) VALUES (?, ?, ?, 'applied', NULL, NULL)
        ON CONFLICT(scope) DO UPDATE SET
          reducer_version = excluded.reducer_version,
          projection_hash = excluded.projection_hash,
          status = 'applied',
          projection_error = NULL,
          failing_record = NULL
      `).run(scope, REDUCER_VERSION, hash)
      this.db.prepare(`
        UPDATE ledger_observations SET projection_state = 'applied', projection_error = NULL WHERE scope = ?
      `).run(scope)
      this.db.prepare(`
        UPDATE ledger_assertions SET projection_state = 'applied', projection_error = NULL WHERE scope = ?
      `).run(scope)
      const markDead = this.db.prepare(`
        UPDATE ledger_assertions SET projection_state = 'dead', projection_error = ? WHERE assertion_id = ?
      `)
      for (const entry of projection.dead) markDead.run(entry.reason, entry.assertionId)
      return hash
    })
  }

  // Injection is re-gated on every read, so revoking a route immediately stops an
  // already accepted LLM fact from rendering. A missing route table (the journal was
  // never opened) is the default-closed state, not an error. The stored counters are
  // re-validated against their evaluation evidence; a hand-edited row cannot open.
  _llmRouteEnabled(fact) {
    if (fact.sourceKind !== 'llm') return true
    const evidence = fact.evidence
    const model = evidence?.model
    const modelDigest = evidence?.modelDigest
    const schemaVersion = evidence?.schemaVersion
    if (!nonEmptyString(model) || !nonEmptyString(modelDigest) ||
        !nonEmptyString(schemaVersion) ||
        !nonEmptyString(fact.predicate) || !nonEmptyString(fact.scope)) {
      return false
    }
    let row
    try {
      row = this.db.prepare(`
        SELECT sample_count, precision, safety_failures, evidence_json, model_digest
        FROM ledger_proposal_routes
        WHERE scope = ? AND model = ? AND model_digest = ? AND predicate = ?
          AND schema_version = ?
      `).get(fact.scope, model, modelDigest, fact.predicate, schemaVersion)
    } catch {
      return false
    }
    if (!row || row.model_digest !== modelDigest) return false
    let routeEvidence
    try {
      routeEvidence = row.evidence_json === null ? null : JSON.parse(row.evidence_json)
    } catch {
      return false
    }
    return routeRowValid({
      sampleCount: row.sample_count,
      precision: row.precision,
      recall: routeEvidence?.recall,
      safetyFailures: row.safety_failures,
      evidence: routeEvidence,
      modelDigest: row.model_digest,
    })
  }

  // Read-time proposal/span resolution. An LLM fact renders only when:
  //   - its proposalId resolves to the same scope as an accepted proposal whose
  //     payload names this assertion, or to a candidate promoted to this assertion;
  //   - the run identity matches the evidence model/digest/schema version;
  //   - the quoted span still resolves exactly against the archived observation's
  //     rawPayload.text.
  // A missing proposal table, row, run, or span suppresses the fact. Hand-written
  // `sourceKind:'llm'` facts therefore remain audit-only even with an open route.
  _llmProposalResolved(fact) {
    if (fact.sourceKind !== 'llm') return true
    const evidence = fact.evidence
    if (!evidence || typeof evidence !== 'object') return false
    const proposalId = evidence.proposalId
    const eventKey = evidence.eventKey
    const quote = evidence.quote
    if (!nonEmptyString(proposalId) || !nonEmptyString(eventKey) ||
        !nonEmptyString(quote) || !nonEmptyString(fact.assertionId) ||
        !nonEmptyString(fact.scope)) {
      return false
    }
    if (!Number.isInteger(evidence.start) || !Number.isInteger(evidence.end) ||
        evidence.start < 0 || evidence.end <= evidence.start) {
      return false
    }
    let proposal
    try {
      proposal = this.db.prepare(`
        SELECT p.verdict, p.promoted_assertion_id, p.payload_json,
          r.status AS run_status, r.model AS run_model,
          r.model_digest AS run_digest, r.schema_version AS run_schema
        FROM ledger_proposals AS p
        JOIN ledger_proposal_runs AS r ON r.run_id = p.run_id
        WHERE p.proposal_id = ? AND p.scope = ? AND r.scope = ?
      `).get(proposalId, fact.scope, fact.scope)
    } catch {
      return false
    }
    if (!proposal || proposal.run_status !== 'succeeded' ||
        proposal.run_model !== evidence.model ||
        proposal.run_digest !== evidence.modelDigest ||
        proposal.run_schema !== evidence.schemaVersion) {
      return false
    }
    if (proposal.verdict === 'accepted') {
      let payload
      try {
        payload = proposal.payload_json === null ? null : JSON.parse(proposal.payload_json)
      } catch {
        return false
      }
      if (!payload || payload.assertionId !== fact.assertionId) return false
    } else if (proposal.verdict === 'candidate') {
      if (proposal.promoted_assertion_id !== fact.assertionId) return false
    } else {
      return false
    }
    let observation
    try {
      observation = this.db.prepare(
        'SELECT full_input_json FROM ledger_observations WHERE event_key = ?',
      ).get(eventKey)
    } catch {
      return false
    }
    if (!observation) return false
    const archived = JSON.parse(observation.full_input_json)
    if (archived.scope !== fact.scope || archived.op !== 'user_message' ||
        archived.source?.kind !== 'user') {
      return false
    }
    const text = archived.rawPayload?.text
    if (typeof text !== 'string' || text === '') return false
    return text.slice(evidence.start, evidence.end) === quote
  }

  currentFacts(scope, { injectableOnly = false } = {}) {
    const rows = this.db.prepare(`
      SELECT f.fact_json
      FROM ledger_fact_versions AS f
      JOIN ledger_entities AS e
        ON e.scope = f.scope AND e.entity_id = f.subject_entity_id AND e.generation = f.generation
      WHERE f.scope = ? AND f.valid_to IS NULL AND f.retired_at IS NULL
        AND f.status IN ('active', 'conflicted')
      ORDER BY f.fact_key, f.assertion_id
    `).all(scope).map(decodeRow)
    if (!injectableOnly) return rows
    // `llm` is no longer suppressed by source kind: the verification gate admits
    // only quote-derived evidence, the route gate re-checks the model build's
    // current capability, and every LLM fact must resolve to its journaled proposal
    // and archived span at read time.
    return rows.filter((fact) => {
      const predicate = registryEntry(fact.predicate)
      return fact.status === 'active' && fact.conflict == null &&
        predicate?.injectable === true &&
        fact.sourceKind !== 'legacy' &&
        INJECTABLE_VERIFICATIONS.has(fact.verification) &&
        this._llmRouteEnabled(fact) &&
        this._llmProposalResolved(fact)
    })
  }

  factsAt(scope, query) {
    if (!query || !Number.isFinite(query.validAt) || !Number.isFinite(query.recordedAt)) {
      throw new TypeError('factsAt requires finite validAt and recordedAt')
    }
    const factVersions = this.db.prepare(`
      SELECT fact_json FROM ledger_fact_versions WHERE scope = ?
      ORDER BY valid_from, recorded_at, fact_key, assertion_id
    `).all(scope).map(decodeRow)
    return selectFactsAt({ factVersions }, { validAt: query.validAt, recordedAt: query.recordedAt })
  }

  renderCurrent(scope, budget) {
    return renderFacts(this.currentFacts(scope, { injectableOnly: true }), budget)
  }

  _withProjectionState(scope, state) {
    const observations = this.db.prepare(`
      SELECT full_input_json, projection_state, projection_error
      FROM ledger_observations WHERE scope = ? AND projection_state = ?
    `).all(scope, state)
    const assertions = this.db.prepare(`
      SELECT full_input_json, projection_state, projection_error
      FROM ledger_assertions WHERE scope = ? AND projection_state = ?
    `).all(scope, state)
    return [...observations, ...assertions].map((row) => ({
      ...JSON.parse(row.full_input_json),
      projectionState: row.projection_state,
      projectionError: row.projection_error,
      reason: row.projection_error,
    })).sort((a, b) => {
      const left = a.eventKey ?? a.assertionId
      const right = b.eventKey ?? b.assertionId
      return left < right ? -1 : left > right ? 1 : 0
    })
  }

  pending(scope) {
    return this._withProjectionState(scope, 'pending')
  }

  dead(scope) {
    return this._withProjectionState(scope, 'dead')
  }

  retryDead(eventKey) {
    const observation = this.db.prepare(
      'SELECT scope, projection_state FROM ledger_observations WHERE event_key = ?',
    ).get(eventKey)
    if (observation) {
      if (observation.projection_state !== 'dead') return this._storedHash(observation.scope)
      this.db.prepare(`
        UPDATE ledger_observations SET projection_state = 'pending', projection_error = NULL WHERE event_key = ?
      `).run(eventKey)
      return this.rebuild(observation.scope)
    }

    const assertion = this.db.prepare(
      'SELECT scope, projection_state FROM ledger_assertions WHERE assertion_id = ?',
    ).get(eventKey)
    if (!assertion) throw new Error(`unknown archived event or assertion: ${eventKey}`)
    if (assertion.projection_state !== 'dead') return this._storedHash(assertion.scope)
    this.db.prepare(`
      UPDATE ledger_assertions SET projection_state = 'pending', projection_error = NULL WHERE assertion_id = ?
    `).run(eventKey)
    return this.rebuild(assertion.scope)
  }

  close() {
    this.db.close()
  }
}
