# @reeval/harness-antigravity

An [AI SDK harness](https://ai-sdk.dev/docs) adapter for Google's
[Antigravity CLI](https://antigravity.google/product/antigravity-cli/) (`agy`). It's shaped like
the `@ai-sdk/harness-*` packages, so it could move upstream to `vercel/ai`.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createAntigravity } from '@reeval/harness-antigravity'

const agent = new HarnessAgent({
  harness: createAntigravity({ auth: { GEMINI_API_KEY: process.env.GEMINI_API_KEY! } }),
  model: 'gemini-3.8-flash-medium',
  permissionMode: 'allow-all',
})
```

## How it works

The CLI has no ACP mode, so this isn't config over `@ai-sdk/harness-acp`.

- **Turns.** Each turn runs one headless process,
  `agy --output-format stream-json --add-dir <workDir> -p "$(cat prompt)"`. Later turns resume
  it with `--conversation <id>`.
- **Stream.** The CLI's NDJSON events (`init`, `step_update`, `result`) become harness stream
  parts: text, provider-executed tool calls and results under common names (`bash`, `read`,
  `write`, `edit`, `grep`, `glob`, `webSearch`), per-step `finish-step` and a `finish` with
  token usage. The CLI reports usage; Cursor doesn't.
- **Bootstrap.** Downloads the pinned CLI release (1.3.3) for x64 or arm64 Linux and checks its
  sha256. The binary needs glibc.
- **Auth.** A Gemini API key only (`GEMINI_API_KEY`), with `modelProvider: "gemini"` pinned in
  the CLI's settings. Google-account sign-in is never used: automating it from other tools
  risks the account under Google's terms.
- **Brokering.** On a sandbox with `addRequestTransformations`, the CLI gets a placeholder key.
  The real key is swapped in on `x-goog-api-key` to `generativelanguage.googleapis.com` (or the
  host of `GOOGLE_GEMINI_BASE_URL`). `antigravityEndpoints()` is the only endpoint the key is
  needed on, `POST /v1beta/models/<model>:streamGenerateContent`, as an allowlist for gateways
  that enforce one. `requireCredentialBrokering: true` refuses sandboxes that can't broker.
- **Placement.** Skills go to `~/.gemini/config/skills/` (the path CLI 1.3.3 reads, not the
  documented `~/.gemini/antigravity-cli/skills/`) and instructions to `~/.gemini/GEMINI.md`.
  `mcpServers` are written to `~/.gemini/config/mcp_config.json`, in the CLI's shape (remote
  servers take `serverUrl`). Workspace rules (`AGENTS.md`) and skills (`.agents/skills/`) are
  read from the workspace.
- **Permissions.** `allow-all` maps to `--dangerously-skip-permissions`, `allow-edits` to
  `--mode accept-edits` and `allow-reads` to `--mode plan`. Print mode can't ask, so there are no
  approval requests.

Not supported (these throw `HarnessCapabilityUnsupportedError`): host-executed tools, non-text
prompts, a JSON response format whose schema's root isn't `"type": "object"` (the CLI's
`--json-schema` refuses one since 1.2.14), manual compaction, and suspending or continuing a
turn. A prompt travels as one
command-line argument, so on Linux it must stay under 128 KiB; a longer one fails the turn with
the shell's "Argument list too long".

## Tests

`pnpm test` runs `node:test` over the translator (with NDJSON captured from real CLI runs), the
auth and brokering rules, the command line, the bootstrap, and the adapter against an in-memory
sandbox. reeval's own tests run it in Docker and against the real CLI.
