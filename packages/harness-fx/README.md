# @reeval/harness-fx

[fx](https://fx.sh) on Vercel AI Gateway or OpenAI's API, as an [AI SDK harness](https://ai-sdk.dev/docs):
thin config over `@ai-sdk/harness-acp`, which runs `fx acp` in the sandbox. It's shaped like the
`@ai-sdk/harness-*` packages. `@ai-sdk/harness-fx` runs fx's loop on the host through `libfx`, with
its own tools, so it isn't the fx CLI reeval evaluates.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createFx } from '@reeval/harness-fx'

const agent = new HarnessAgent({
  harness: createFx({
    auth: { AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY! },
    model: 'anthropic/claude-sonnet-5',
    requireCredentialBrokering: true,
  }),
  model: 'anthropic/claude-sonnet-5',
  permissionMode: 'allow-all',
})
```

## How it works

- **Bootstrap.** Downloads the fx 0.0.14 release for x86_64 or aarch64 Linux, checks its sha256,
  and puts `fx` in a private home under the bootstrap directory.
- **Model.** A gateway id (`anthropic/claude-sonnet-5`) runs on fx's `gateway` provider with
  `AI_GATEWAY_API_KEY`. A bare OpenAI id (`gpt-4.1`) runs on an fx configured provider,
  `openai`, over OpenAI's Chat Completions API with `OPENAI_API_KEY`. fx sends `max_tokens`, which
  OpenAI's reasoning models refuse, so that route takes the non-reasoning ones.
- **Quiet.** `FX_QUIET_ENV`: no self-upgrade, no sounds and no colour.
- **Permissions.** `allow-all` is fx's `full-access` session mode: its `auto` mode would run a
  reviewer model on each action.
- **Brokering.** On a sandbox with `addRequestTransformations`, fx gets a placeholder, and the
  real key replaces it in the `Authorization` header on the provider's host only.
- **Tools.** fx names its ACP tool calls; `shell`, `write_file`, `edit_file`, `read_file`,
  `glob_files`, `grep_files`, `web_search` and `web_fetch` get the AI SDK's common names, and MCP
  calls are renamed from `mcp_<server>_<tool>` to `mcp__<server>__<tool>`.
- **Usage.** fx's ACP `PromptResponse.usage` is the turn's summed input and output tokens.
