# The harness contract

Every real harness must pass the same behaviors against a real agent, in Docker. This directory
is one reeval project; `contract.test.ts` runs it once per harness and checks each behavior from
outside, in three ways: its eval passed, its canary failed on its assertion, and the record says
what it should. The rows are in [`../support/harnesses.ts`](../support/harnesses.ts).

| Behavior | The eval checks (in the sandbox) | The canary | The record check (host side) |
|---|---|---|---|
| skill placed where the agent reads it, and used | `skill-proof.txt` holds a code only the skill has | no turn: no proof | the attempt's `context` lists the skill at the harness's path |
| skill a setup step installed, used and counted | `installed-proof.txt` holds a code only the skill has; the environment has no `skills`, and a setup step copies the skill into every agent's workspace skill directory | no turn: no proof | the environment placed no skill, and `reeval query skill_reads` has the skill for the attempt with `source` `skill-dir` and at least one read |
| rules read | `codeword.txt` holds a word only the rules have | no turn: no word | — |
| stdio MCP server started and called | the server logged `tools/call`; the transcript names `mcp__stamp__house_stamp` | no turn: no call | the environment lists the server ; on a harness with no MCP client, the MCP evals (tagged `mcp`) are left out of its run, and `--dry-run` of them exits 2 naming the eval, harness and server, while a `--dry-run` of an eval without MCP plans |
| file edited and command run, both in the transcript | `notes.txt` changed; the transcript has its edit and a tool whose output is `contract-42` | no turn: unchanged | `changedFiles` has `notes.txt` |
| every tool call in the adapter's catalog | — | replay's: agy 1.4.3's captures as the adapter before it reported them (`read_file`, `edit_file`, `write_file` as unknown tools) | every attempt's transcript names only tools in the adapter's `builtinTools` (or `mcp__<server>__<tool>`), and on a CLI whose native events name the tool (Antigravity, Cursor, pi, Goose) every native name is one the adapter maps; the failure names the harness and each unknown tool |
| file edits, reads and commands normalized | — | replay's: the same captures, and a command renamed to an unknown tool | in the edit-and-run, skill and egress attempts, the edit of `notes.txt` and `skill-proof.txt` is a `file-edit` event (or a command naming the file), the skill's read a `readonly` or `bash` tool, the `contract-42` command and the `curl` a `bash` tool, by the catalog's `toolUseKind`; the failure names the harness and the tools that carried it instead |
| tokens recorded where the harness reports them | — | — | every turn has usage (or none, for a harness that reports none) |
| real key never in the container | after a turn, a scan of every process's environment and command line and every file under the writable roots finds no form of the key | the same scan finds a value planted in the environment and a home file | the key isn't in the run directory |
| deny-all plus auto hosts works | under `egress: 'deny-all'` the turn completes, and a `curl` to example.com gets a 403 at CONNECT | no turn: the same `curl` isn't a 200 | `egress`: the harness's automatic hosts allowed, its API contacted, example.com:443 refused and recorded |
| served model recorded | — | — | every attempt's `servedModels` names the model (null for a harness whose requests don't say) |
| effort sent as the model's own setting | the `effort` eval, on a row with an `effort`, passes | — | every answered model call of that attempt that sets reasoning (`requestEffort` in `.reeval/debug`) sets the row's level in the field the model reads, and more than one does; in the same task without `effort`, some call sets none |
| upstream provider and cost recorded | — | — | on a gateway whose responses say them (the `*-openrouter` rows), every attempt's `upstreams` names a provider with its calls and `reportedCostUsd` is above 0; elsewhere both are unset |
| nothing silently unreported | — | — | every turn's `unreported` is empty: no harness fell back to flagging events it couldn't report (the Cursor SDK's web calls, when recovering them fails or finds a stored shape it doesn't know) |
| native stream format unchanged | — | — | every native event in the raw transcripts matches `../replay/formats/<harness>.json`, plus, on an ACP harness, every status, tool kind and stop reason ACP defines (a failed tool call is the model's doing, not a format change), on pi every stop reason its one-shot loop ends a call with and a failed call's `errorMessage`, on Cursor every status, run status and tool status the SDK defines and the runner's `error` and `unreported` lines, on Antigravity agy's `error_message` steps and failed tool and turn (a provider's 4xx or 5xx, or a canceled turn, is not a format change), and on Codex every event, item type, key and status `codex exec`'s `exec_events.rs` defines (a command that exits non-zero, a refused key's retries and failed turn, a reasoning or web item) |
| plugin skill used | `plugin-proof.txt` holds a code only the probe plugin's skill has | no turn: no proof | the attempt's `context` lists the skill at the row's `plugin.skillContext`, and the environment's plugin record lists the skill |
| plugin MCP server called | the plugin's `stamp.mjs` logged `tools/call`; a tool named `mcp__…stamp__house_stamp` is in the transcript | no turn: no call | the plugin record lists `stamp`, and the environment's `mcp` has `probe:stamp` |
| plugin hook ran | the `SessionStart` hook wrote `/tmp/reeval-plugin-hook.txt` | an environment without the plugin: no marker | — |
| plugin subagent available | a successful tool call names `probe-agent` (or `probe:probe-agent`) in a field naming an agent, such as `subagent_type`: a search for the name, or a delegation the agent refuses, doesn't count | the same turn in an environment without the plugin: no such call (Claude Code's is refused, Grok Build spawns a general-purpose subagent) | — |
| plugin rules read | `plugin-codeword.txt` holds the codeword only the probe plugin's rule has | an environment without the plugin: no codeword | — |
| plugin part it can't load refused | — | — | `--dry-run` with the probe's every part (its `rules/` included) exits 2 naming the part and the parts the row loads; a row that loads every part skips |
| plugin hermetic | — | — | the plugin skill attempt's `context` has no other skill and no plugin outside `~/.reeval/plugins/` (or the row's `plugin.copy`), the plugin skill and MCP attempts' transcripts call no other MCP server and name no other plugin's files, under `deny-all` nothing was blocked, and every host contacted is one of the row's automatic hosts |
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
3. A format in [`../support/stream-formats.ts`](../support/stream-formats.ts) (with `tool` when its
   events name the tool they call), then a real run with
   `REEVAL_UPDATE_FORMATS=1 REEVAL_UPDATE_CAPTURES=1` to learn its format and capture its replays.
4. Its secret in `contract.yml`, and its latest version in `scripts/drift/latest-images.sh`.
5. Once the harness loads plugins, its row's `plugin` field (below).
6. Its telemetry declaration (below).

## Telemetry

Each harness declares, for every telemetry signal, what its record captures against ground truth
(the gateway's decrypted wire, the native stream and the sandbox's files), in
[`telemetry.ts`](./telemetry.ts): `captured` (equal to ground truth), `partial` (incomplete or
reshaped), `dropped` (produced but not recorded) or `n/p` (not produced by the CLI or provider).
`?` marks a cell whose ground truth couldn't be read. This is engineering detail, kept out of the
public docs and the harness matrix.

`../contract-telemetry.test.ts` fails when a catalog harness misses a declaration for any signal,
and when this table is stale (`REEVAL_UPDATE_SNAPSHOTS=1` rewrites it). A PR that closes a gap
updates its own cells. The states are what a telemetry-parity check against the wire holds a row
to: a `captured` or `partial` signal must be in the record, and a `dropped` one must not, so a gap
that closes fails until its cell says so.

[//]: # (generated:telemetry)

| Signal | Cursor | Claude Code | Codex | Antigravity | OpenCode | Goose | pi | fx | Grok Build |
|---|---|---|---|---|---|---|---|---|---|
| Main-call tokens per turn | captured? [1] | captured | captured | captured | captured | captured [2] | captured | partial [3] | captured |
| Fresh input vs cache read | captured? [4] | captured | captured | captured | captured | captured | captured | **dropped** [5] | captured |
| Cache write | captured? [4] | captured | captured | n/p | captured [6] | captured | n/p | n/p | n/p |
| Reasoning tokens | n/p | captured | captured | captured | captured | **dropped** [7] | captured | **dropped** [8] | captured |
| Reasoning text | captured | captured | captured [9] | **dropped** [10] | captured [11] | captured | captured | n/p | captured |
| Per-call usage | **dropped** [12] | **dropped** [13] | **dropped** [14] | **dropped** [15] | **dropped** [16] | **dropped** [17] | **dropped** [13] | **dropped** [7] | **dropped** [18] |
| Side-call usage (titles, search) | **dropped**? [19] | **dropped** [20] | n/p [21] | **dropped** [22] | **dropped** [23] | **dropped** [24] | n/p | n/p | **dropped** [25] |
| Served model (gateway) | **dropped**? [26] | **dropped** [27] | captured | captured | captured | captured | captured | captured | captured |
| Provider or CLI cost | n/p | **dropped** [28] | n/p | n/p | **dropped** [29] | **dropped** [30] | n/p | n/p | **dropped** [31] |
| Usage on an aborted turn | **dropped** [32] | captured | **dropped** [33] | partial [34] | **dropped** [35] | **dropped** | captured | **dropped** | **dropped** [36] |
| Transcript of an aborted turn | captured | captured | captured | captured | **dropped** [37] | **dropped** [37] | captured | **dropped** [37] | **dropped** [37] |
| Large shell output | **dropped** [38] | partial [39] | captured [40] | partial [39] | partial [39] | partial [39] | partial [39] | captured [40] | partial [39] |
| Large MCP result | **dropped** [41] | partial [42] | captured | **dropped** [43] | partial [44] | captured | partial [39] | partial [45] | partial [46] |
| Small MCP args and result | captured | captured | captured | captured | partial [47] | partial [48] | partial [49] | partial [50] | captured |
| Context window used and size | n/p | **dropped** | **dropped** [51] | n/p | **dropped** [52] | **dropped** [52] | n/p | n/p | **dropped** |
| System prompt and tool count | **dropped** [53] | **dropped** [53] | **dropped** [53] | **dropped** [53] | **dropped** [53] | **dropped** [53] | **dropped** [53] | **dropped** [53] | **dropped** [53] |
| Retries, 429s, rate-limit headers | **dropped**? [19] | **dropped** [54] | **dropped** [55] | n/p | n/p | n/p | n/p | n/p | n/p |
| Compaction | n/p? [56] | n/p? [56] | n/p? [57] | n/p? [56] | n/p? [56] | n/p? [58] | n/p? [56] | n/p? [56] | n/p? [56] |

1. From the SDK only; reeval totals it, since the raw `totalTokens` counts cache reads twice.
2. The sum of the turn's rows in `sessions.db`'s `usage_ledger`.
3. On Chat Completions, input counts cache reads as fresh.
4. From the SDK only.
5. ACP sends no cache field; the wire's `prompt_tokens_details.cached_tokens`.
6. On Anthropic; Gemini writes none.
7. On the wire only.
8. On Chat Completions, the wire's `completion_tokens_details.reasoning_tokens` only.
9. The summary `model_reasoning_summary = "auto"` asks for.
10. On the wire, none in the transcript.
11. On Gemini; Anthropic returned no visible thinking.
12. The SDK and `agent-store` keep turn totals only.
13. In the raw `finish-step` parts.
14. The rollout JSONL's `token_count` events.
15. Turn totals only.
16. `opencode.db`'s `session_message.data.tokens`.
17. `usage_ledger`, one row per model call.
18. On the wire, and per turn in `usage.json`.
19. The wire is protobuf.
20. `WebSearch` is its own `/v1/messages` call, in `modelUsage` only.
21. Web search is `POST /v1/alpha/search`, which carries no usage.
22. The title and web-search calls on Flash Lite: the model's in `servedModels`, its tokens aren't.
23. The session-title call.
24. The session-naming call, on the wire only (not in `usage_ledger`).
25. `session_title` and the server-side `web_search` call, the larger share of a searching attempt's cost.
26. The gateway can't read the protobuf requests; the record has the SDK's turn model.
27. The gateway doesn't read Anthropic responses; the record has the CLI's turn model.
28. `result.modelUsage[*].costUSD`.
29. ACP `usage_update.cost`, and `opencode.db`.
30. ACP `usage_update.cost`, and `usage_ledger.cost` (estimated).
31. `usage.cost_in_usd_ticks` on every response, and `usage.json`.
32. `usage: null`.
33. `usage: null`; the rollout JSONL has each call's `last_token_usage`.
34. Kept, without the title call's.
35. `usage: null`; `opencode.db` has the calls' tokens.
36. `usage: null`; `sessions/<cwd>/<id>/usage.json` has the turn's.
37. No parts: harness-acp drops what it buffered when it abandons the turn.
38. `""`; the full output is in `~/.cursor/projects/*/agent-tools/*.txt`.
39. The CLI's truncated view, which the model saw; the full output is spilled to disk.
40. More than the model saw: the transcript has the full output.
41. `""`; spilled like the shell output.
42. A "saved to …" notice, which the model saw; the result is in `tool-results/`.
43. `""`; the result is in `brain/<id>/.system_generated/steps/<n>/output.txt`.
44. Cut short with no end marker; the full result is in `tool-output/`.
45. A pointer the model follows with `read_tool_result`.
46. Cut short.
47. The result keeps its `{metadata, output}` wrapper.
48. The result keeps its ACP `content[]` wrapper.
49. The result keeps its `{output, details}` wrapper.
50. The result keeps its `{server, tool, result}` wrapper.
51. The rollout's `model_context_window`.
52. ACP `usage_update.used` and `size`.
53. On the wire; the record keeps no request shape.
54. `anthropic-ratelimit-*` headers on every call.
55. `x-ratelimit-*` headers on every call, and the rollout's rate limits.
56. No contract run compacts context.
57. No contract run compacts context; the rollout would show it.
58. No contract run compacts context; `usage_ledger.is_compaction` would show it.

| Signal | What the record holds when captured |
|---|---|
| Main-call tokens per turn | turn `usage` input and output: the sum of the turn's main model calls |
| Fresh input vs cache read | turn `usage.input` uncached, `usage.cacheRead` apart |
| Cache write | turn `usage.cacheWrite` |
| Reasoning tokens | turn `usage.reasoning` |
| Reasoning text | non-empty `reasoning` events when the wire carries reasoning text |
| Per-call usage | each model call's usage, not only the turn's |
| Side-call usage (titles, search) | usage of calls outside the agent loop (titles, web search), apart from the main calls' |
| Served model (gateway) | the attempt's `servedModels`, from the model calls' responses |
| Provider or CLI cost | the cost the provider or the CLI reports, never reeval's own price table |
| Usage on an aborted turn | a timed-out turn's `usage`, equal to the calls the wire shows |
| Transcript of an aborted turn | a timed-out turn's events: the tool calls whose requests the wire shows |
| Large shell output | a ~300 KB command's output in its tool event: full, or marked truncated or spilled |
| Large MCP result | a ~60 KB MCP result in its tool event: full, or marked truncated or spilled |
| Small MCP args and result | an MCP call's arguments and result text, without the CLI's own wrapper |
| Context window used and size | the context occupancy and window size the CLI reports |
| System prompt and tool count | each model call's system prompt size and tool count |
| Retries, 429s, rate-limit headers | retried calls, 429s and the provider's rate-limit headers |
| Compaction | a compaction event when the CLI compacts context |

[//]: # (/generated:telemetry)

## Plugins

The plugin behaviors run the probe plugin in [`plugins/probe/`](./plugins/probe): a skill with a
code, a subagent (`probe-agent`), a slash command, the `stamp.mjs` MCP server, a `SessionStart`
hook that writes a marker, and a `rules/` file with a codeword that only Cursor and Antigravity load. A row takes part when it
has a `plugin` field; without one, the plugin evals (tagged `plugin`) are left out of its run and
each plugin behavior skips, saying so.

```ts
plugin: {
  parts: ['skills', 'agents', 'commands', 'hooks', 'mcp'], // the catalog's pluginParts
  skillContext: /^~\/\.reeval\/plugins\/probe\/skills\/plugin-probe\/SKILL\.md$/,
},
```

- `parts` is exactly the harness's `pluginParts` in `src/harness/agents.ts`
  (`scripts/harness-matrix.mjs` fails `pnpm docs:gen` when they differ). The run narrows the probe
  to them with `only` (`REEVAL_CONTRACT_PLUGIN_PARTS`), and the part-refused check plans the
  probe whole and expects the refusal of the parts left out. Without `hooks` the hook evals
  (tagged `plugin-hooks`) are left out; without `agents`, the subagent evals (`plugin-agents`);
  without `rules`, the rules evals (`plugin-rules`).
- `skillContext` matches where the attempt's `context` shows the plugin's `SKILL.md`: under
  `~/.reeval/plugins/probe/` for a harness that loads the plugin whole (namespaced), or the
  harness's own skill directory for one that places plugin skills with its own (flat), or the
  agent's own copy for one that installs the plugin itself (Antigravity's `agy plugin install`).
- `copy`, for such an agent, is where its copy lives (`~/.gemini/config/plugins/probe/`): the
  hermetic check allows the plugin items under it.
- The row then runs 25 attempts instead of 15 (fewer if it leaves hooks, agents or rules out): raise
  `REEVAL_REAL_ATTEMPT_BUDGET` in `contract.yml` by the difference.

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
picks rows. Each real row is 15 attempts (14 without an `effort`), 7 of them with one short agent turn, or up to 25 with a
`plugin` field, at `--concurrency 2`; reeval.config.ts's `budget.attempts` is the hard cap, and in CI a ledger caps the whole job
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
| tool catalog, normalized kinds | each tool's name against the adapter's catalog, and its `toolUseKind` | a tool call that merely mentions the file passes a renamed edit tool the adapter doesn't know; a CLI can rename a tool without changing one event's shape, so the stream format can't see it |
| stream format | the event kinds and keys, plus every value the protocol defines (ACP's statuses, tool kinds, stop reasons; pi's stop reasons and a failed call's `errorMessage` and `thinkingLevel`; OpenCode's `session_info_update` while it retries a call; the Cursor SDK's statuses and the runner's failure lines; agy's `error_message` steps; Codex's item types and statuses) | which values a run shows is the model's or the provider's doing: a stray write outside the workspace makes a tool call `failed`, a Gemini 503 makes pi's call `error` and OpenCode retry |
| e2e | exit codes, JSON from `reeval compare`/`reeval query`, files on disk | the CLI's text output changes with the run |

Prompts name the exact action and ask for one short turn. The e2e eval allows a trailing period in
`hello.txt`: its check is that the agent wrote the file, not its punctuation. A flake that still
shows up is a finding: fix the signal or the product, never add a retry.
