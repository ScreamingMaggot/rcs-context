// Read-only inspector for the live ledger-online state. It never writes and never
// calls a model. Run after sending a test message in a session rooted at D:\RCS\src:
//
//   node work/semantic-opt-20261026/live-status.mjs
//
// Override the state directory with LEDGER_ONLINE_STATE_DIR when needed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const stateDir = process.env.LEDGER_ONLINE_STATE_DIR ??
  path.join(os.homedir(), '.dsh', 'state-compiler', 'ledger-online-live')
const statusPath = path.join(stateDir, 'status.json')
const dbPath = path.join(stateDir, 'ledger.sqlite')

console.log(`stateDir=${stateDir}`)
if (!fs.existsSync(dbPath)) {
  console.log('ledger.sqlite missing: no live event has been archived yet')
  process.exit(0)
}

if (fs.existsSync(statusPath)) {
  try {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
    console.log(JSON.stringify({
      scope: status.scope,
      archived: status.archived,
      facts: status.facts,
      proposals: {
        state: status.proposals?.state,
        runs: status.proposals?.runs,
        accepted: status.proposals?.accepted,
        candidates: status.proposals?.candidates,
        rejected: status.proposals?.rejections,
        lastRun: status.proposals?.lastRun,
      },
      qwen: {
        calls: status.qwen?.calls,
        succeeded: status.qwen?.succeeded,
        failed: status.qwen?.failed,
        skipped: status.qwen?.skipped,
        last: status.qwen?.last,
        lastError: status.qwen?.lastError,
      },
      cwdMismatches: status.cwdMismatches,
      lastCwdMismatch: status.lastCwdMismatch,
      injection: status.injection,
    }, null, 2))
  } catch (error) {
    console.log(`status.json unreadable: ${error.message}`)
  }
} else {
  console.log('status.json missing: send one message to create it')
}

const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  const runs = db.prepare(`
    SELECT run_id, status, model, schema_version, error, evidence_keys_json, created_at
    FROM ledger_proposal_runs ORDER BY created_at DESC, run_id DESC LIMIT 5
  `).all()
  console.log('\nlatest runs:')
  for (const run of runs) {
    console.log(JSON.stringify({
      runId: run.run_id,
      status: run.status,
      model: run.model,
      schemaVersion: run.schema_version,
      error: run.error,
      evidence: run.evidence_keys_json,
      createdAt: run.created_at,
    }))
  }

  const proposals = db.prepare(`
    SELECT proposal_id, run_id, predicate, verdict, reason, errors_json, payload_json
    FROM ledger_proposals ORDER BY rowid DESC LIMIT 10
  `).all()
  console.log('\nlatest proposals:')
  for (const row of proposals) {
    let payload = {}
    try { payload = JSON.parse(row.payload_json ?? '{}') } catch { /* keep empty */ }
    console.log(JSON.stringify({
      proposalId: row.proposal_id,
      runId: row.run_id,
      predicate: row.predicate,
      verdict: row.verdict,
      reason: row.reason,
      errors: row.errors_json,
      op: payload.op,
      quote: payload.quote,
      modelPredicate: payload.modelPredicate ?? null,
      predicateRule: payload.predicateRule ?? null,
    }))
  }

  const observations = db.prepare(`
    SELECT event_key, op, source_json, recorded_at
    FROM ledger_observations ORDER BY recorded_at DESC, event_key DESC LIMIT 5
  `).all()
  console.log('\nlatest observations:')
  for (const row of observations) {
    let source = {}
    try { source = JSON.parse(row.source_json ?? '{}') } catch { /* keep empty */ }
    console.log(JSON.stringify({
      eventKey: row.event_key,
      op: row.op,
      sourceKind: source.kind ?? null,
      recordedAt: row.recorded_at,
    }))
  }
} finally {
  db.close()
}
