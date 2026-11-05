---
name: telemetry-audit
description: >
  The ground-truth method for checking what reeval records about a harness against what actually
  happened: run a real attempt, collect the gateway traffic, the CLI's on-disk state and its native
  stream, diff all three against the run record and transcript signal by signal, and file a gap
  for each mismatch. Use when adding or bumping a harness, filling its telemetry declarations, or
  when a token, cost or transcript number looks wrong.
---

# Audit a harness's telemetry

The record is the CLI's self-report, normalized. The audit compares it with three independent
sources: the **wire** (every decrypted request and response through the egress gateway), the
**disk** (what the CLI wrote in the sandbox) and the **stream** (the CLI's native events). Trust
the wire first, then disk, then the stream.

## 1. Build the audit project

A throwaway reeval project outside the repo (never commit it), on the harness's Docker image and a
reasoning-capable model at an explicit `effort`. Two evals:

- **`audit`**, one attempt that exercises every signal in `SIGNALS`
  (`packages/reeval/test/contract/telemetry.ts`):
  - turn 1: use a skill, edit a file, run a command that prints ~300 KB (`seq 1 30000`-style),
    call a stdio MCP server's `echo` and a `bulk` tool that returns ~60 KB ending in a unique
    marker;
  - turn 2: a web search, so side calls show up;
  - last, in the eval body: `c.exec` a `find` and `tar` of everything the CLI wrote under its home,
    `/tmp` and `/root` since the attempt started, and copy it out.
- **`aborted`**: a long write cut off by a short `timeout` (45 s), for the aborted-turn signals.

## 2. Capture the three sources

```bash
pnpm build && pnpm images <harness>
cd <audit project>
REEVAL_RAW_TRANSCRIPT=1 node <repo>/packages/reeval/dist/cli.js run -vv --tag audit > cli.log 2>&1
```

| Source | Where |
|---|---|
| Record | `.reeval/runs/<run>.json` and `.reeval/runs/<run>/<eval>/<cell>/<n>/transcript.jsonl` |
| Stream | the same directory's `transcript.raw.jsonl` (`REEVAL_RAW_TRANSCRIPT=1`) |
| Wire, metadata | `.reeval/debug/<run>/<eval>/<cell>/<n>/requests.ndjson`: method, host, path, status, the served model, effort and cost the gateway read |
| Wire, bodies | a local tap: patch `packages/sandbox-docker/src/egress/proxy.ts` to write each decrypted request and response body to a directory, and drop the patch after. Don't audit with reeval's own usage reader (`model-call` events): it is one of the things under test |
| Disk | the `tar` from the `audit` eval. Look for sqlite databases (read them with `node:sqlite`), JSONL logs, session directories and spilled tool-output files |

Keep the captures out of the repo; they hold prompts and paths.

## 3. Diff per signal

For each turn and each signal, put the record's value next to each source's. Sum the turn's wire
calls in the provider's own format:

| Provider | Usage on the wire |
|---|---|
| Anthropic SSE | `message_start` and `message_delta` `usage`: `input_tokens` (uncached), `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens` (thinking inside), `output_tokens_details.thinking_tokens` |
| OpenAI Responses | `response.completed` `usage`: `input_tokens` (cache inside), `input_tokens_details.cached_tokens`, `output_tokens` (reasoning inside), `output_tokens_details.reasoning_tokens` |
| OpenAI Chat Completions | the last chunk's `usage`: `prompt_tokens` (cache inside), `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` |
| Gemini | `usageMetadata`: `promptTokenCount` (cache inside), `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount` (beside output) |
| xAI | the top-level `usage` object only; `usage.context_details` repeats the field names with other values |

Then, per signal:

- **Tokens**: the turn's main calls summed equal the record's `input`, `cacheRead`, `cacheWrite`,
  `output` and `reasoning` exactly. Tokens are integers: no tolerance.
- **Side calls**: classify every wire call as main (its usage matches a step the CLI reported) or
  side (titles, naming, web search, a smaller model). List each side call's tokens.
- **Served model**: the response's model against `servedModels`.
- **Cost**: any cost the provider or the CLI reports (response body, the CLI's ledger).
- **Aborted turn**: the wire's calls and tool requests against the aborted turn's `usage` and
  events.
- **Large output**: does the transcript hold the 300 KB output and the 60 KB result's marker, the
  model's truncated view, a pointer, or `""`? Where is the full text on disk?
- **MCP shape, context window, system prompt, rate limits, compaction**: present in the record,
  or only in a source?

## 4. Classify and file

- Give each cell a state as `telemetry.ts` defines them: `captured`, `partial` (say how),
  `dropped` (say where the data is) or `not-produced`; `unverified` when no source could be
  read (an opaque protobuf wire, a path no run reached).
- File **one gap per mismatch**: harness, signal, the record's value, the truth and which source
  holds it, and the smallest fix (adapter, disk reader, gateway reader or CLI config). Each fix
  lands as its own PR with a replay fixture cut from the capture, and updates its own cells in
  `telemetry.ts`.
- Update the declarations and regenerate the README table:
  `REEVAL_UPDATE_SNAPSHOTS=1 node --test --experimental-strip-types --no-warnings test/contract-telemetry.test.ts`.

## Traps

- No 429, 5xx or retry in a run means retries are **unverified**, not captured.
- A short task never compacts context; mark compaction `unverified` until a long-context run
  triggers it.
- A CLI's own ledger can miss its side calls as well, so a disk reader alone can't prove
  side-call usage. Only the wire can.
- An errored turn in an eval with no checks still passes. Give the audit evals checks, so a broken
  turn doesn't read as clean telemetry.
- Load from the tap itself can time out a CLI's proxy tunnel; rerun before calling it a harness bug.
