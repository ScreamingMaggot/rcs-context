# testspace2-online — run configuration

Isolated online ledger test instance. `web/ledger-online.mjs` is a thin DSH plugin over
`web/memory-online-bridge.mjs`; it archives real session events into `ledger.sqlite`,
runs Qwen proposals with every route closed, and injects only verified current facts.
The working isolated instance lives at `<TESTSPACE2>/online-20261026`;
its results are recorded in `RESULTS.md`.

## Requirements

- Node.js 24 with built-in `node:sqlite` (the ledger opens SQLite directly).
- A DSH host that provides `ctx.on('session/event')`, `ctx.on('agent/pre-step')`, and
  `ctx.get('llm')` / `ctx.llm`.
- An Ollama provider registered in that DSH host as `ollama-local`.

## Enable the plugin

The plugin is inert unless explicitly enabled:

```text
LEDGER_ONLINE=1
```

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `LEDGER_ONLINE` | unset (off) | `1` arms `session/event` and `agent/pre-step`; any other value leaves the plugin inert. |
| `LEDGER_ONLINE_STATE_DIR` | `$DSH_HOME/state-compiler/ledger-online` | Directory for `ledger.sqlite` and `status.json`. |
| `DSH_HOME` | `$HOME/.dsh` | Used only when `LEDGER_ONLINE_STATE_DIR` is unset. |
| `LEDGER_ONLINE_WORKSPACE` | `<TESTworkspace>` | Fixed workspace root. Session cwd never overrides it. The ledger scope is `ws:` + this path, lowercased with `/` separators and no trailing slash. |
| `LEDGER_ONLINE_QWEN_MODEL` | `qwen3:4b-instruct-2507-q4_K_M` | Model name passed to the local Ollama chat API. |
| `LEDGER_ONLINE_QWEN_DIGEST` | `0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0` | Digest bound into every proposal run and candidate evidence. |
| `LEDGER_ONLINE_REQUIRE_CWD` | unset (off) | `1` rejects sessions whose reported cwd differs from the fixed workspace: no archive, no proposal, no injection. Live uses `1` so one project's facts never leak into another project's session. |

State directory contents after the first event:

```text
<stateDir>/ledger.sqlite   append-only observations, assertions, proposal runs, candidates
<stateDir>/status.json     last measured status written by LedgerOnlineBridge.status()
```

The plugin never writes `ledger_proposal_routes`; proposals stay candidates and are not
injectable. `status.json` distinguishes `not-run` from `ran-empty` and reports pending
proposal work, Qwen calls/errors, archived user messages, tool observations, and the last
injected text hash and character count.

## Qwen channel

Each proposal call uses the same direct localhost shape as the recorded offline
baseline (`http://127.0.0.1:11434/api/chat`, no remote endpoint):

```text
stream:     false
format:     json
think:      false
temperature: 0
seed:       42
num_predict: 1024
model:      LEDGER_ONLINE_QWEN_MODEL
```

Proposal runs are serialized per scope and session. Before a call, a deterministic
durability gate drops task instructions, questions, plans, temporary operations, file
observations, and prompt injections; a message with no eligible evidence returns
`status: "skipped"` without a model call (`qwen.skipped` in status). A Qwen error,
timeout, malformed output, or non-`stop` finish is archived as a failed proposal run;
deterministic facts are not modified. `agent/pre-step` calls `next()`, then appends at
most one message with
`source.kind = 'plugin:LEDGER_ONLINE'` and the prefix
`[LEDGER MEMORY — verified current facts]`. Subagent sessions
(`meta.origin === 'subagent'` or `delegationDepth > 0`) are skipped.

## Tests (no DSH, no Ollama)

Run from `D:\RCS\src`:

```text
node tests/memory-online-bridge.test.mjs
node tests/memory-proposals.test.mjs
node tests/memory-ledger-store.test.mjs
```

The bridge test uses a temporary SQLite file, fixed timestamps, and a fake `callModel`;
it performs no model calls and never opens a live profile.

## Isolated launch

Copy `web/ledger-online.mjs`, `web/memory-online-*.mjs`, `web/memory-durability.mjs`,
ledger modules, and `condense/chunk.mjs` into the isolated profile, register
`ledger-online.mjs` in its
`cordis.patch.yml`, set the environment above, run with cwd
`<TESTworkspace>`, and start:

```text
dsh --profile web --port 18083 --no-open
```

`TESTSPACE2/online-20261026/logs/web.out` contains the tokenized local URL and the
`[LEDGER_ONLINE]` evidence lines. Never point `DSH_HOME` at the live profile.
