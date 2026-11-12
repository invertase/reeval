# @reeval/harness-goose

[Goose](https://goose-docs.ai) on a Gemini, Anthropic, OpenAI or xAI API key, as an [AI SDK harness](https://ai-sdk.dev/docs):
thin config over `@ai-sdk/harness-acp`, which runs `goose acp` in the sandbox. It's shaped like the
`@ai-sdk/harness-*` packages.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { ANTHROPIC_PROVIDER, createGoose } from '@reeval/harness-goose'

const agent = new HarnessAgent({
  harness: createGoose({
    auth: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
    provider: ANTHROPIC_PROVIDER,
    model: 'claude-haiku-4-5',
    requireCredentialBrokering: true,
  }),
  model: 'claude-haiku-4-5',
  permissionMode: 'allow-all',
})
```

## How it works

- **Bootstrap.** Downloads the Goose 1.59.0 release for x86_64 or aarch64 Linux, checks its
  sha256, and puts `goose` in a private home under the bootstrap directory.
- **Model.** `model` is `GOOSE_MODEL`, which Goose needs before `session/new`; each turn's model
  is then set as the ACP session's `model` config option.
- **Quiet.** `GOOSE_QUIET_ENV`: `auto` mode, no telemetry, no keyring and no session-naming
  model call. A turn contacts only its provider's API (and `models.dev`, for Goose's catalog).
- **Brokering.** On a sandbox with `addRequestTransformations`, Goose gets a placeholder for its
  provider's key (`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `XAI_API_KEY`); the
  real key is swapped into the provider's header on its host only.
- **MCP.** Servers go in Goose's `config.yaml` as enabled extensions (`gooseConfig`): Goose 1.54.0
  leaves servers from ACP `session/new` disabled until the model enables them itself.
- **Tools.** `shell`, `write` and `edit` map to `bash`, `write` and `edit`, and the skills
  extension's `load_skill`, the summon extension's `load` and the developer extension's `tree`
  are in the catalog under their own names. Any other call is named from
  Goose's `_meta.goose.toolCall`: an MCP server's as `mcp__<server>__<tool>`, Goose's own by its
  name.
- **Usage.** Goose's ACP `PromptResponse.usage` is its last model call's, not the turn's (a
  4-call turn that used 16,253 input tokens reported 4,179), so it's dropped. Instead, the
  session holds the turn's `finish` part until the turn is done, reads the rows the turn added
  to Goose's `usage_ledger` (`~/.local/share/goose/sessions/sessions.db`, one row per model call,
  with one `node -e` on `node:sqlite` in the sandbox, `GooseLedger`) and sends it with their sum:
  `input` the whole prompt, `cacheRead` its cached part, `output` with the thinking tokens in it
  (the ledger doesn't count them apart, so `reasoning` is unknown). The rows go in the usage's
  `raw`. A ledger it can't read leaves the turn's usage unknown.
