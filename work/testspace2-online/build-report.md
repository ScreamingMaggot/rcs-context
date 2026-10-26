# Build report — memory online bridge

Timestamp: 2026-10-26T10:15:15+08:00
Node: v24.18.0
Workspace: D:\RCS\src
No commits. No live-profile access. No DSH launch. No Ollama calls.

## Files

- `web/memory-online-bridge.mjs` (new, 578 lines)
- `tests/memory-online-bridge.test.mjs` (new, 551 lines)
- `web/ledger-online.mjs` (new, 220 lines)
- `work/testspace2-online/README.md` (new, 79 lines)
- `work/testspace2-online/build-report.md` (this file)

## TDD evidence (RED)

First run before the bridge existed:

```text
$ node tests/memory-online-bridge.test.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\RCS\src\web\memory-online-bridge.mjs'
imported from D:\RCS\src\tests\memory-online-bridge.test.mjs
    code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///D:/RCS/src/web/memory-online-bridge.mjs'
```

## Focused test (GREEN)

```text
$ node tests/memory-online-bridge.test.mjs
exit=0
PASS count: 44
FAIL count: 0
ALL PASS
```

Covered by the 44 checks: human message archived verbatim; non-human/assistant
text ignored; candidate quote absent from injected text; malformed output and model
timeout leave facts intact; write/read/delete file-fact transitions; duplicate user
event and duplicate tool result idempotence; unpaired tool result archived as nothing;
cross-session same-workspace facts; per-session injection dedupe and re-inject on fact
change; status not-run vs ran-empty vs failed truth and status.json equality; zero
`ledger_proposal_routes` rows and candidate-only proposals; unknown tool does not mutate
current facts; cwd mismatch recorded without changing scope; scope normalization; Qwen
model/digest/schema identity; per-scope/session serialization; `drain()` pending wait.

## Regressions (GREEN)

```text
$ node tests/memory-proposals.test.mjs
exit=0
PASS count: 227
FAIL count: 0
ALL PASS

$ node tests/memory-ledger-store.test.mjs
exit=0
PASS count: 43
FAIL count: 0
ALL PASS
```

## Plugin wiring smoke (no DSH, no Ollama)

Inert with `LEDGER_ONLINE` unset:

```text
$ node --input-type=module -e "import plugin from './web/ledger-online.mjs'; ..."
inert-hooks 0 name LEDGER_ONLINE inject ["tools"]
```

Enabled with a fake host context and a temporary state dir (no model call):

```text
[LEDGER_ONLINE] armed stateDir=...\ledger-online-plugin-LIUML3\state workspaceRoot=C:/tmp/ledger-online-ws scope=ws:c:/tmp/ledger-online-ws model=qwen3:4b-instruct-2507-q4_K_M provider=ollama-local maxTokens=1024 routes=closed (candidates only)
registered true true true
no-facts-unchanged true
[LEDGER_ONLINE] status reason=dispose pending=0 userMessages=0 toolObservations=0 facts=0 proposals=not-run qwenCalls=0
[LEDGER_ONLINE] disposed
disposed true
```

## Boundaries observed

- `ledger_proposal_routes` count asserted 0 after a candidate-producing run.
- `preStep` output asserted to contain the ledger prefix and file facts, and to exclude
  the candidate quote (`8848`).
- Tests use `mkdtemp` SQLite, fixed timestamps, and fake `callModel`; no network.
- `git status --short` shows only untracked `tests/memory-online-bridge.test.mjs` and
  `web/memory-online-bridge.mjs` from this task; nothing was committed.

## Notes

- The tool observation value only carries measurements the event actually reports
  (`exists/size/mtime/sha256`); text-only results derive no invented size or hash.
- Proposal serialization is keyed by `scope + session`; `drain()` waits all queued work.
- Packaging and real DSH launch remain out of scope for this task.

## Final re-run after last validation hardening

```text
2026-10-26T10:15:51+08:00
$ node tests/memory-online-bridge.test.mjs   -> exit=0, PASS=44, FAIL=0, ALL PASS
$ node tests/memory-proposals.test.mjs      -> exit=0, PASS=227, FAIL=0, ALL PASS
$ node tests/memory-ledger-store.test.mjs   -> exit=0, PASS=43, FAIL=0, ALL PASS
```
