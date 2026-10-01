# The harness contract

Every real harness must pass the same behaviours against a real agent, in Docker. This directory
is one reeval project; `contract.test.ts` runs it once per harness and checks each behaviour from
outside, in three ways: its eval passed, its canary failed on its assertion, and the record says
what it should. The rows are in [`../support/harnesses.ts`](../support/harnesses.ts).

| Behaviour | The eval checks (in the sandbox) | The canary | The record check (host side) |
|---|---|---|---|
| skill placed where the agent reads it, and used | `skill-proof.txt` holds a code only the skill has | no turn: no proof | the attempt's `context` lists the skill at the harness's path |
| rules read | `codeword.txt` holds a word only the rules have | no turn: no word | — |
| stdio MCP server started and called | the server logged `tools/call`; the transcript names `mcp__stamp__house_stamp` | no turn: no call | the environment lists the server ; on a harness with no MCP client, the MCP evals (tagged `mcp`) are left out of its run, and `--dry-run` of them exits 2 naming the eval, harness and server, while a `--dry-run` of an eval without MCP plans |
| file edited and command run, both in the transcript | `notes.txt` changed; the transcript has its edit and a tool whose output is `contract-42` | no turn: unchanged | `changedFiles` has `notes.txt` |
| tokens recorded where the harness reports them | — | — | every turn has usage (or none, for a harness that reports none) |
| real key never in the container | after a turn, a scan of every process's environment and command line and every file under the writable roots finds no form of the key | the same scan finds a value planted in the environment and a home file | the key isn't in the run directory |
| deny-all plus auto hosts works | under `egress: 'deny-all'` the turn completes, and a `curl` to example.com gets a 403 at CONNECT | no turn: the same `curl` isn't a 200 | `egress`: the harness's automatic hosts allowed, its API contacted, example.com:443 refused and recorded |
| served model recorded | — | — | every attempt's `servedModels` names the model (null for a harness whose requests don't say) |
| nothing silently unreported | — | — | every turn's `unreported` is empty: no harness fell back to flagging events it couldn't report (the Cursor SDK's web calls, when recovering them fails or finds a stored shape it doesn't know) |
| native stream format unchanged | — | — | every native event in the raw transcripts matches `../replay/formats/<harness>.json`, plus, on an ACP harness, every status, tool kind and stop reason ACP defines (a failed tool call is the model's doing, not a format change), on pi every stop reason its one-shot loop ends a call with and a failed call's `errorMessage`, on Cursor every status, run status and tool status the SDK defines and the runner's `error` and `unreported` lines, on Antigravity agy's `error_message` steps and failed tool and turn (a provider's 4xx or 5xx, or a cancelled turn, is not a format change), and on Codex every event, item type, key and status `codex exec`'s `exec_events.rs` defines (a command that exits non-zero, a refused key's retries and failed turn, a reasoning or web item) |
| clean teardown | — | — | the run is `complete` and no container with its label is left |

The key scanner ([`scan.mjs`](./scan.mjs)) is given only the sha256, length and a rolling hash of
the key's raw and base64 forms, so the check never puts the key where it looks for it.

The `fake` row runs the same suite with a scripted agent (Cursor's layout) in every PR's Docker
job, key-free: it proves the suite's own checks, canaries and oracle before a real row spends
anything.

## Adding a harness

1. A row in [`../support/harnesses.ts`](../support/harnesses.ts): its key, the cheapest model,
   its image, where its skills show up in `context`, its automatic egress hosts, the host it
   reaches every turn, whether it reports tokens and what its served model looks like.
2. A case in [`reeval.config.ts`](./reeval.config.ts) (and `../e2e/reeval.config.ts`).
3. A format in [`../support/stream-formats.ts`](../support/stream-formats.ts), then a real run with
   `REEVAL_UPDATE_FORMATS=1 REEVAL_UPDATE_CAPTURES=1` to learn its format and capture its replays.
4. Its secret in `contract.yml`, and its latest version in `scripts/drift/latest-images.sh`.

## Running it

```bash
pnpm build
cd packages/reeval
REEVAL_CONTRACT_HARNESSES=fake node --test --experimental-strip-types --no-warnings test/contract.test.ts
pnpm test:contract          # the real rows, and the e2e CLI suite (CURSOR_API_KEY, GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY)
pnpm test:replay            # the captured streams, key-free
```

Without `REEVAL_TEST_REAL=1` the real rows skip. With it, a row without its key fails before it starts
anything, naming the variable it needs: narrow the run with `REEVAL_CONTRACT_HARNESSES=cursor`, which
picks rows. Each real row is 12 attempts, 6 of them with one short agent turn, at `--concurrency
2`; reeval.config.ts's `budget.attempts` is the hard cap, and in CI a ledger caps the whole job
(`REEVAL_REAL_ATTEMPT_BUDGET`). `REEVAL_UPDATE_CAPTURES=1` refreshes `../replay/<harness>/` from the run,
and `REEVAL_UPDATE_FORMATS=1` accepts the formats it saw.

## Flake policy

Real agents are nondeterministic. The suite never retries (`runs: 1`, the default gate, no
retry in CI), so a failure is always reported. Instead each check reads a signal a model can't
fake or phrase differently:

| Check | Robust signal | Why not the obvious one |
|---|---|---|
| skill, rules | a file whose content only the skill or rules know | the reply's wording varies; a file is either right or not |
| MCP | the server's own log, then the transcript's tool name | the reply may paraphrase the tool's result |
| edit | the file's content, then an edit event **or** a tool call naming the file | agents edit with their edit tool or from the shell; both are the agent editing |
| command | a tool output containing `contract-42` | only running `echo contract-$((6*7))` prints it; the command text alone could be echoed back |
| key | a hash scan of the container, after a real turn | a grep for the key would need the key in the container |
| egress | the CONNECT status the `curl` wrote, and the gateway's record | the agent's account of what happened |
| tokens, served model | the record's numbers and ids, by shape (> 0, a pattern) | exact counts change every run |
| stream format | the event kinds and keys, plus every value the protocol defines (ACP's statuses, tool kinds, stop reasons; pi's stop reasons and a failed call's `errorMessage` and `thinkingLevel`; OpenCode's `session_info_update` while it retries a call; the Cursor SDK's statuses and the runner's failure lines; agy's `error_message` steps; Codex's item types and statuses) | which values a run shows is the model's or the provider's doing: a stray write outside the workspace makes a tool call `failed`, a Gemini 503 makes pi's call `error` and OpenCode retry |
| e2e | exit codes, JSON from `reeval compare`/`reeval query`, files on disk | the CLI's text output changes with the run |

Prompts name the exact action and ask for one short turn. The e2e eval allows a trailing period in
`hello.txt`: its check is that the agent wrote the file, not its punctuation. A flake that still
shows up is a finding: fix the signal or the product, never add a retry.
