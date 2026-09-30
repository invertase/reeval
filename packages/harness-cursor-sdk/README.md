# @reeval/harness-cursor-sdk

An [AI SDK harness](https://ai-sdk.dev/docs) adapter for Cursor's agent, over the
[Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript) (`@cursor/sdk`) and its local
runtime. It's shaped like the `@ai-sdk/harness-*` packages, so it could move upstream to
`vercel/ai`.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createCursorSdk } from '@reeval/harness-cursor-sdk'

const agent = new HarnessAgent({
  harness: createCursorSdk({
    auth: { CURSOR_API_KEY: process.env.CURSOR_API_KEY! },
    modelParams: { fast: 'false' },
  }),
  model: 'composer-2.5',
  permissionMode: 'allow-all',
})
```

## Why not `@ai-sdk/harness-cursor`

That adapter drives the Cursor CLI's ACP server (`agent acp`), which returns only a stop reason:
no token usage. The SDK reports every turn's tokens (input, output, cache read and write), and
this adapter passes them on as `finish-step` and `finish` usage.

## How it works

- **Turns.** The SDK's local runtime runs the agent loop in a Node process, with tools acting on
  its working directory and inference on Cursor's hosted models. One `node runner.mjs <session
  dir> <turn>` in the sandbox serves the session's turns: the adapter writes each turn's request
  (`turn-<n>.json`, then an empty `turn-<n>.ready`, since a sandbox process has no stdin), and the
  runner sends it to the agent it keeps loaded, so a follow-up turn doesn't pay for Node's start,
  the SDK's import or a resume. The agent's state is in a JSONL store in the session directory:
  if the runner exits, or a turn is aborted (which kills it), the next turn starts a new runner
  that `Agent.resume()`s the agent by id, so the conversation carries over.
- **Stream.** For each turn the runner prints an `init` line (the agent id and its resolved model),
  each `SDKMessage` from `run.stream()` as one NDJSON line, then a `result` line with the run's
  usage, model and ids. `stream-start` carries the resolved model with its parameters, e.g.
  `composer-2.5[fast=false]`. They become harness stream parts: text and
  reasoning deltas, provider-executed tool calls and results under the ACP adapter's names
  (`bash`, `read`, `edit`, `delete`, `glob`, `grep`, `ls`, `webSearch`, `webFetch`; MCP calls as
  `mcp` with `providerIdentifier` and `toolName`), and usage. Tool paths under the workspace are
  reported relative to it, as ACP reports them. The SDK logs to stdout, so the runner keeps
  stdout for its lines and sends the rest to stderr.
- **Bootstrap.** Checks for Node 22.21 or later and installs the pinned `@cursor/sdk` (1.0.34,
  with its platform package: ripgrep and the sandbox helper) next to the runner.
- **Auth and brokering.** A Cursor user or service-account API key (`CURSOR_API_KEY`). On a
  sandbox with `addRequestTransformations`, the runner gets a placeholder. The SDK sends the key
  on one request only, `POST api2.cursor.sh/auth/exchange_user_api_key`, the same one as the CLI,
  and uses session tokens from then on. `cursorSdkEndpoints()` is that allowlist.
  `requireCredentialBrokering: true` refuses sandboxes that can't broker.
- **Egress.** The runner forces HTTP/1.1 for the agent stream: over HTTP/2 the SDK connects
  directly and ignores `HTTPS_PROXY`. With `NODE_USE_ENV_PROXY=1` (Node 22.21+), every request
  then goes through the proxy. The SDK would also call `GET api.cursor.com/v1/models` with the
  key. The adapter fetches that catalog on the host instead and hands it over in
  `CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON`, so the sandbox only ever talks to `api2.cursor.sh`.
- **Placement.** Workspace rules (`AGENTS.md`) and skills (`.cursor/skills/`) load through the
  SDK's `project` setting source. Harness-placed skills go to `~/.agents/skills/` (`user`).
  `instructions` are prepended to the prompt in the ACP adapters' `<session-guidance>` block.
  `mcpServers` go inline, in the SDK's `McpServerConfig` shape, on every turn.
- **Web tools.** SDK 1.0.32 and 1.0.34 report no `tool_call` events for their web search and
  fetch. Cursor's backend sends `webSearchToolCall` and `webFetchToolCall` updates, but the SDK's
  converter maps them to null, so they reach neither `run.stream()` nor `onDelta` / `onStep`, and
  no hook fires for them. They run on Cursor's servers, not in the sandbox. The stored conversation keeps them,
  so after each turn the runner reads `Agent.messages.list()` and reports the calls the stream
  didn't as `tool_call` events (marked `recovered`, with the backend's `started_at_ms` /
  `completed_at_ms`), before the result. The turn's `finish-step` waits for the result line, since
  HarnessAgent refuses content after it. When it can't recover them, the turn's
  `harnessMetadata.cursorSdk.unreportedTools` lists the tools (`CURSOR_SDK_RECOVERED_TOOLS`).
- **Permissions.** The SDK's local agent runs every tool without asking. `sdkSandbox: true` turns
  on its own shell sandbox (bubblewrap), which a container sandbox doesn't need.

Not supported (these throw `HarnessCapabilityUnsupportedError`): host-executed tools, structured
output, non-text prompts, manual compaction, and suspending or continuing a turn. `getUsage()`
(billed cost) isn't called: for local agents it needs an account with the feature enabled.

## Tests

`pnpm test` runs `node:test` over the translator (with NDJSON captured from a real SDK run: shell,
grep, reads, edits, delete, an MCP call, rules and both skill layers, then a resumed turn), the
auth and brokering rules, the bootstrap, and the adapter against an in-memory sandbox. reeval's own
tests run it in Docker against real Cursor.
