# Conformance goldens

The test suite another language's SDK runs to prove it speaks reeval: what its eval files must
declare, and what its runner must send and accept during an attempt. They are data, so any test
runner can read them. `test/conformance.test.ts` holds them to the real TypeScript code.

```text
declare/<case>/case.json       the TypeScript eval file, its plan case and that case's arguments
declare/<case>/expected.json   the declaration tree that file records
context/<case>.ndjson          one attempt, message by message, then its record
runner.ts                      the TypeScript reference runner the context scripts run under
```

## declare/

`expected.json` is the tree `evaluate` and `group` record for the file `case.json` names (a plan
case's eval file under `test/plan/`), checked against `src/contract/declaration.ts`. The test then
replaces that file with one that hands the tree to `declareTree` (from `reeval/testing`), runs
`reeval run --dry-run --json` with the plan case's arguments, and compares the plan with the plan
case's existing snapshot (`case.json`'s `plan`). The plan isn't copied here.

An SDK writes its own eval file for each case, mirroring the TypeScript one, and checks the tree
its runner hands over is `expected.json`. Body ids (`b1`, `b2`, …) are opaque: compare them only
for being distinct, since TypeScript numbers them in the order the bodies are declared.

## context/

Each line is one JSON object:

| Line | What it is |
|---|---|
| `{"case", "about", "options"}` | The header: the eval's name, what it covers and its options |
| `{"reeval": …}` | reeval to the runner: `attempt-start`, `attempt-abort` or a reply (`attempt-reply`) |
| `{"runner": …}` | The runner to reeval: a request (`attempt-request`) or `attempt-done` |
| `{"record": …}` | The attempt's record afterwards: outcome, error, assertions, judgements and checks |

The shapes are in `src/contract/attempt.ts`, with JSON Schemas in `schema/protocol/`. The test runs
every script as one eval of a fake-harness, fake-sandbox project: `runner.ts` makes each request on
the attempt's `c` and writes down what came back. Timestamps are `2026-01-01T00:00:00.000Z` and
durations `0`.

An SDK uses a script as a fake reeval: send each `reeval` line in order, and check that the body
the SDK runs (a tiny eval per case, doing what the `runner` lines ask) sends exactly the `runner`
lines in between. The `record` line is what reeval concludes from those messages.

## Updating

`REEVAL_UPDATE_SNAPSHOTS=1` rewrites `expected.json` and each script's `reeval` and `record`
lines from the code, keeping the header and `runner` lines. Review the diff. A change to matcher
labels, judge options or a reply's shape shows up here and is regenerated the same way.

To add a context case, write a header and `runner` lines in a new `context/<case>.ndjson`, then
run the update. To add a declare case, add `declare/<case>/case.json` naming a plan case's eval
file and arguments; its eval options must be data (no function forms).

```bash
pnpm build
REEVAL_UPDATE_SNAPSHOTS=1 node --test --experimental-strip-types --no-warnings test/conformance.test.ts
```
