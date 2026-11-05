---
name: bump-harness
description: >
  How to bump a harness's pinned agent CLI or AI SDK adapter in reeval: the drift scripts, the
  Claude Code pnpm patch and its hash in the image tag, refreshing replay captures and formats,
  the real contract rows and the telemetry declarations. Use when drift.yml reports a new release,
  or when moving any harness pin.
---

# Bump a harness pin

**One PR per bump.** One CLI or adapter moves per PR, titled `build(<harness>): bump <cli> to
<version>` (or `fix(<harness>): …` when the bump needs adapter changes). A failure in the contract
then names one cause.

## Where the pins live

| What | Pin | Drift check |
|---|---|---|
| agy, Goose, fx | a version and sha256 in the adapter's bootstrap (`*_CLI_VERSION`) | `scripts/drift/versions.mjs` |
| Codex, Grok Build | a version and sha512 of the npm native build | `versions.mjs` |
| `@cursor/sdk` | `CURSOR_SDK_VERSION` in `harness-cursor-sdk/src/cursor-sdk-bootstrap.ts` | `versions.mjs`, `cursor-sdk-shape.mjs` |
| OpenCode | the inline lockfile in `harness-opencode` | `versions.mjs`, `opencode-providers.mjs` |
| pi | the lockfile in `packages/harness-pi/assets/` | `versions.mjs` |
| `@ai-sdk/harness-*` adapters, `ai` | `packages/reeval/package.json`, `HARNESS_PACKAGES` | `versions.mjs`, `claude-code-patch.mjs` |

`versions.mjs`'s `AGENTS` table names each pin's file and constant.

## Steps

1. **See what moved**, key-free:

   ```bash
   node scripts/drift/versions.mjs
   node --experimental-strip-types --no-warnings scripts/drift/claude-code-patch.mjs
   node --experimental-strip-types scripts/drift/opencode-providers.mjs  # OpenCode
   node scripts/drift/cursor-sdk-shape.mjs <sdk dir>                     # Cursor
   ```

   `REEVAL_DRIFT_<CLI>_VERSION` (listed at the top of each script) checks a given version instead
   of the newest. An OpenCode bump that changes the provider table regenerates
   `opencode-provider-table.ts` with `packages/harness-opencode/scripts/probe-providers.ts`.

   Read the release notes for changes to the stream format, usage fields, config keys, side calls
   (titles, search) and on-disk stores.
2. **Move the pin**: the version and its checksum (download the release and hash it; never copy a
   hash from a release page you didn't check). For an `@reeval/harness-*` package, bump its
   `package.json`, `src/version.ts`, the `workspace:` entry in `packages/reeval/package.json` and
   `HARNESS_PACKAGES` in `packages/sandbox-docker/src/image.ts` together, so the image tag changes
   (OpenCode 2.2.5, [#779](https://github.com/invertase/reeval/pull/779), is a complete example). Refresh plan snapshots that
   print the tag: `REEVAL_UPDATE_SNAPSHOTS=1 pnpm test:plan`.
3. **Claude Code's patch.** Bumping `@ai-sdk/harness-claude-code` fails `pnpm install`
   (`ERR_PNPM_UNUSED_PATCH`) until the patch moves. `claude-code-patch.mjs` says which case:
   - Upstream fixed every bug the patch covers: drop the patch and `patch` from `HARNESS_PACKAGES`.
   - Otherwise rebase it: `pnpm patch @ai-sdk/harness-claude-code@<new>`, reapply, then
     `pnpm patch-commit <dir>`. Set `HARNESS_PACKAGES['claude-code'].patch` to the first 8 hex of
     the patch file's sha256 (`sha256sum patches/@ai-sdk__harness-claude-code@<new>.patch | cut -c1-8`);
     `packages/sandbox-docker/test/unit.test.ts` holds it to the file. Update the tag in AGENTS.md
     and the plan snapshots.
   - Bump `ai`, `@ai-sdk/harness`, `@ai-sdk/provider-utils` and `@ai-sdk/provider` together
     (Dependabot skips them on purpose).
4. **Build and replay**, key-free:

   ```bash
   pnpm install && pnpm build && pnpm images <harness>
   cd packages/reeval && pnpm test:replay
   ```

   A replay failure on the old captures is the new adapter mishandling a known stream: fix it
   before going real.
5. **Real contract rows** for that harness (every row of its CLI, e.g. `opencode`,
   `opencode-anthropic`, `opencode-openai`), refreshing captures and formats:

   ```bash
   REEVAL_TEST_REAL=1 REEVAL_CONTRACT_HARNESSES=<row>,<row> \
     REEVAL_UPDATE_CAPTURES=1 REEVAL_UPDATE_FORMATS=1 \
     node --test --test-concurrency=1 --experimental-strip-types --no-warnings \
     test/contract.test.ts test/e2e-real.test.ts
   ```

   Review the diff of `test/replay/<harness>/` and `test/replay/formats/<harness>.json`: a new
   event kind or key is a format change the adapter must handle, not just accept. Without keys
   locally, ask for a `real.yml` dispatch with `-f harnesses=<row>,…`; don't add the
   `real-agents` label yourself.
6. **Re-check the telemetry declarations** in `packages/reeval/test/contract/telemetry.ts`. A
   version can add a usage field, a side call, a new on-disk store or move where output spills.
   Run a [telemetry audit](../telemetry-audit/SKILL.md) on the new version for any signal the
   release notes touch, and update the row's cells (then
   `REEVAL_UPDATE_SNAPSHOTS=1 node --test --experimental-strip-types --no-warnings test/contract-telemetry.test.ts`).
7. **Finish** with AGENTS.md's "Before you finish" block, including `pnpm docs:gen` (the harness
   matrix and versions in generated blocks) and `pnpm docs:check`.

## Traps

- `latest-images.sh` swaps the newest CLI into the pinned image for `contract (latest)`; it
  proves the new CLI runs, not that the pin moved. The PR still changes the pin and checksum.
- The adapter version, not the CLI version, is the image tag. Bumping only the CLI pin inside an
  adapter still needs the adapter version bumped so the image rebuilds.
- A bump that changes what usage means (for example a CLI starting to send cache counts) changes
  every comparison across the bump. Say so in the PR body with a before/after from the wire.
