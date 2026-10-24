# @reeval/harness-grok-build

xAI's [Grok Build](https://x.ai/cli) on an xAI API key, as an [AI SDK harness](https://ai-sdk.dev/docs):
thin config over `@ai-sdk/harness-acp`, which runs `grok agent stdio` in the sandbox. It's shaped
like the `@ai-sdk/harness-*` packages.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createGrokBuild } from '@reeval/harness-grok-build'

const agent = new HarnessAgent({
  harness: createGrokBuild({
    auth: { XAI_API_KEY: process.env.XAI_API_KEY! },
    model: 'grok-4.6',
    requireCredentialBrokering: true,
  }),
  model: 'grok-4.6',
  permissionMode: 'allow-all',
})
```

## How it works

- **Bootstrap.** Downloads `@xai-official/grok-linux-<arch>` 1.0.70 (x64 or arm64) from npm,
  checks its sha512, and unpacks its brotli-compressed binary to `grok` in a private home under
  the bootstrap directory, as the npm package's postinstall does.
- **Config.** `grokConfig` writes `~/.grok/config.toml` in that home: the run's model as the
  session's and the title model's (`session_summary`), so every call is on it, the effort as
  `default_reasoning_effort`, and telemetry, feedback, remote config, campaigns, auto-update and
  the post-turn summary, recap and title-refresh calls off.
- **Trust.** `GROK_FOLDER_TRUST=false`: Grok reads a workspace's `AGENTS.md` and skills only in
  a trusted folder, and nothing else marks the sandbox's workspace trusted.
- **Brokering.** On a sandbox with `addRequestTransformations`, Grok gets a placeholder
  `XAI_API_KEY`; the real key is swapped in on `Authorization: Bearer` to `api.x.ai` only.
- **MCP.** Servers go in ACP's `session/new` (stdio, HTTP and SSE). Grok defers MCP tools behind
  `search_tool` and `use_tool`; a `use_tool` call of a run's server is named
  `mcp__<server>__<tool>`, with the tool's own input.
- **Tools.** `run_terminal_command`, `write`, `search_replace`, `grep` and `web_search` map to
  `bash`, `write`, `edit`, `grep` and `webSearch`. Any other call is named from Grok's
  `_meta['x.ai/tool'].name`.
- **Usage.** The turn's, from the prompt response's `_meta.usage` (the sum over its model calls,
  cached input counted in `inputTokens`): Grok sends no ACP `usage`.
