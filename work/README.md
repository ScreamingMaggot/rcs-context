# work/ — evidence and experiment records

This directory keeps test evidence, frozen corpora and experiment notes. The source
plugins live in `web/`; `work/` is not a runtime dependency except where an explicit
path is documented.

## Layout

| Path | Tracked | Local-only |
|---|---|---|
| `heldout-20261026/` | `eval.mjs`, `RUBRIC-v2.md`, `CONSTRUCT-SPEC.md`, `GATE-FREEZE.md`, `LIVE-AUDIT-20261026.md` | raw `sample/dev/clean` JSONL, `labels-*`, `ref/` constructed set, `RESULTS.md`, `DEV-RESULTS.md` |
| `memory-ledger-20261025/` | corpus, baseline/smoke/audit JSON, `audit.mjs`, `proposal-baseline.mjs` | `*.checkpoint.json` |
| `testspace2-online/` | `README.md`, `RESULTS*.md`, `build-report.md`, `SEMANTIC-ATTRIBUTION.md`, attribution fixtures | `*-harness.mjs`, `probe-followup.mjs`, `*-result.json`, `attribution-smoke.json`, `logs/` |
| `semantic-opt-20261026/` | `RESULTS.md`, `replay-production.mjs`, `fresh-qwen.mjs`, `fresh-spark.mjs`, `dryrun.mjs`, attribution fixtures | `fresh-testspace3.json`, `testspace3-replay.json`, `replay-testspace3.mjs` |
| `references/` | external reference documents | — |
| `janitor-20261025/`, `phase-prep-20261025/`, ... | contracts, results and scripts where committed | local logs/screenshots/results |

## Rules

- Raw user messages, held-out labels, constructed held-out sets, SQLite databases,
  logs, screenshots and keys stay local and are ignored by `.gitignore`.
- Tests use only tracked fixtures; a clean clone must pass `node tests/run-all.mjs`
  without the local-only files.
- The held-out #1 sample and the constructed held-out set are frozen; do not tune on
  them. `LIVE-AUDIT-20261026.md` lists the sessions already inspected during the
  fold/memory audit; they are excluded from the held-out #2 natural arm.
