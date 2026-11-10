---
name: add-harness
description: >
  End-to-end recipe for adding a new agent harness (a CLI reeval drives in the sandbox) to reeval:
  the catalog entry, the adapter package, the image and pin, the contract row, the telemetry
  declarations, replay captures and the generated harness matrix, plus the telemetry traps every
  harness so far fell into. Use when wiring another coding-agent CLI into reeval.
---

# Add a harness to reeval

Use Grok Build ([#373](https://github.com/reeval-ai/reeval/pull/373)) as the worked reference: it's
the most recent ACP harness and touches every place below. pi and Codex are the references for a
CLI with its own NDJSON stream; Antigravity for one that recovers data from disk after the turn.

## Steps

1. **Adapter package**, `packages/harness-<name>/`, shaped like the `@ai-sdk/harness-*` packages
   and importing nothing from `reeval`:
   - `src/<name>-harness.ts`: the bootstrap (download the pinned build, check its sha256 or
     sha512, give the CLI a private home and a config that turns off telemetry, updates and
     side features you don't broker) and the turn (an ACP harness is thin config over
     `@ai-sdk/harness-acp`; otherwise one process per turn and a stream translator).
   - `src/<name>-stream.ts`: native events to AI SDK stream parts, with usage on `finish`.
   - `src/<name>-tools.ts`: the tool catalog (`builtinTools`, `toolUseKind`).
   - `src/version.ts` (`VERSION`, held to `package.json` by a test), `src/index.ts`, `README.md`,
     `test/unit.test.ts` and `test/stream.test.ts`.
   - `"@reeval/harness-<name>": "workspace:<version>"` in `packages/reeval/package.json`
     `devDependencies` (tsdown inlines it), its runtime deps in `reeval`'s `dependencies`, and a
     `knip.json` entry.
2. **Catalog entry** in `packages/reeval/src/harness/agents.ts`: `credential`, `endpoints` (the
   brokered hosts and paths), `hosts`, `servedModel` or `modelResponses`, `reasoning`,
   `reasoningTokens`, the `Layout` (rules file, skill dirs), `pluginParts`, `mcpServers` and
   `adapter`. Then the `kind` in `src/contract/harness.ts`, the helper in `src/harness.ts`,
   `src/types.ts` and `src/init.ts`. Run `pnpm --filter reeval typecheck` and
   `pnpm --filter reeval schema:check`.
3. **Image and pin.** Add the harness, with its `bootstrap` (its name, the CLI it leaves, a
   `probe` for an adapter that leaves no binary, and the adapter on placeholder auth), to
   `HARNESS_PACKAGES` in `packages/sandbox-docker/src/image.ts`
   (`reeval-sandbox:<harness>-<adapter version>`). Docker's image, Tart's bake and `boat()`'s
   install all run that bootstrap. Then add it to
   `.github/actions/sandbox-images`, and the CLI pin to `scripts/drift/versions.mjs` (`AGENTS`)
   and `scripts/drift/latest-images.sh`. `pnpm images <harness>` builds it.
4. **Contract row** in `packages/reeval/test/support/harnesses.ts`, a case in
   `test/contract/reeval.config.ts` and `test/e2e/reeval.config.ts`, a format in
   `test/support/stream-formats.ts`, its secret in `.github/workflows/contract.yml`, and the row
   in `test:contract`'s default list (`packages/reeval/package.json`) and `contract.yml`'s. See
   `packages/reeval/test/contract/README.md#adding-a-harness`.
5. **Telemetry declarations**: a row in `packages/reeval/test/contract/telemetry.ts`
   ([#836](https://github.com/reeval-ai/reeval/pull/836)) for every signal in `SIGNALS`, each
   `captured`, `partial` (with a `note`), `dropped` (with where the data is) or `not-produced`.
   `AgentKind` keys it, so a missing row fails typecheck. Fill it from a
   [telemetry audit](../telemetry-audit/SKILL.md), not from what the CLI's docs claim. Refresh the
   README table with
   `REEVAL_UPDATE_SNAPSHOTS=1 node --test --experimental-strip-types --no-warnings test/contract-telemetry.test.ts`.
6. **Captures.** One real contract run learns the format and records the replays:

   ```bash
   pnpm build && pnpm images <harness>
   cd packages/reeval
   REEVAL_TEST_REAL=1 REEVAL_CONTRACT_HARNESSES=<row> \
     REEVAL_UPDATE_FORMATS=1 REEVAL_UPDATE_CAPTURES=1 \
     node --test --experimental-strip-types --no-warnings test/contract.test.ts
   pnpm test:replay
   ```

   Commit `test/replay/<harness>/` and `test/replay/formats/<harness>.json`.
7. **Feature fixtures**: the per-harness rows in `test/features.test.ts` (`perHarness`: rules,
   skills, image), a Docker fixture for its image, `inventory.ts` entries, then
   `pnpm features:matrix --write`.
8. **Generated matrix**: `pnpm build && pnpm docs:gen` writes the harness matrix
   (`scripts/harness-matrix.mjs`) from the catalog, the tool catalog and the contract row, and
   fails when they disagree (for example `plugin.parts` against `pluginParts`). Docs beyond the
   generated blocks follow AGENTS.md's docs rule.

## Telemetry traps

Each of these shipped in an earlier harness. Check every one against the wire before declaring a
signal `captured`.

| Trap | Real example | What to do |
|---|---|---|
| ACP `inputTokens` may already exclude cache reads | OpenCode recorded `input: 0` on every cached turn: `tokenUsage` subtracted `cachedReadTokens` a second time ([#837](https://github.com/reeval-ai/reeval/pull/837)) | Check `totalTokens = input + output + thoughts + cacheRead + cacheWrite`. If it holds, set the input `total` to the whole prompt and `noCache` to `inputTokens` |
| Reasoning sits inside output; cache reads inside input | fx on OpenAI Chat Completions folded `cached_tokens` into input and dropped `reasoning_tokens` (6–30× fresh input) ([#839](https://github.com/reeval-ai/reeval/pull/839)) | Know each provider's accounting: OpenAI and Anthropic count reasoning inside output and cache reads inside the prompt. Split them, never add them on top |
| Side model calls are missing from the CLI's summaries | Grok's web search was 52% of an attempt's cost and in no summary; titles (OpenCode, Grok) and session naming (Goose) too ([#831](https://github.com/reeval-ai/reeval/pull/831)) | Count the gateway's model calls per turn and match them to the CLI's steps. Turn off side features you don't need in the CLI's config; declare the rest `sideCallUsage: dropped` |
| Usage only in an on-disk ledger | Goose's ACP reports only the last call; exact per-call usage is in `sessions.db` `usage_ledger` ([#838](https://github.com/reeval-ai/reeval/pull/838)) | Look in the CLI's sqlite, logs and session dirs. Read rows after the turn by row id (timestamps are too coarse) through `node -e` in the sandbox |
| Aborted and timed-out turns lose transcript and usage | Codex, Cursor, OpenCode, Goose, fx and Grok recorded `usage: null`; the four ACP harnesses kept no parts at all ([#840](https://github.com/reeval-ai/reeval/pull/840)) | Implement `stopped()` and `salvage()`, and a catalog `storedUsage` reader that runs before the sandbox is removed |
| Large tool output saved to files | Cursor and Antigravity recorded `""` for a 319 KB shell or 60 KB MCP result; the output was in `agent-tools/*.txt` or `steps/<n>/output.txt` ([#842](https://github.com/reeval-ai/reeval/pull/842)) | Run a 300 KB command and a 60 KB MCP result. Recover spilled files (1 MiB cap), set `outputView`, and declare `fullToolOutput` honestly |
| Reasoning needs config flags | Codex sent no `reasoning.summary`; OpenCode on Gemini lost `includeThoughts`; Claude Code's `thinking_tokens` needed the bridge patch ([#841](https://github.com/reeval-ai/reeval/pull/841)); agy streams no thoughts but stores them on disk ([#833](https://github.com/reeval-ai/reeval/pull/833)) | Compare reasoning tokens and text on the wire with the record, at the effort you plan to run. Set the CLI's flags in its config, or recover from disk |
| The served model | Claude Code and Cursor report their own turn model, and `servedModels` stayed null where the gateway didn't read the response | Declare `servedModel` (request) or `modelResponses` (response body) in the catalog, and check `servedModels` against the wire's response `model` |

## Checklist

- [ ] Every signal in `SIGNALS` is `captured`, or declared `partial`/`dropped`/`not-produced` with a
      note saying why or where the data is.
- [ ] Verified by a [telemetry audit](../telemetry-audit/SKILL.md): the gateway capture
      (`.reeval/debug/<run>/…/requests.ndjson` plus response bodies) summed per turn equals the
      record's `usage` (input, cacheRead, cacheWrite, output, reasoning), exactly.
- [ ] An aborted turn keeps its parts and its usage.
- [ ] The contract row passes on a real key; formats and captures are committed; `pnpm test:replay`
      passes key-free.
- [ ] `pnpm docs:gen && pnpm docs:check`, `pnpm lint`, `typos`, `pnpm typecheck` pass.
