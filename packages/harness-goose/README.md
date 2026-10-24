# @reeval/harness-goose

[Goose](https://goose-docs.ai) on a Gemini API key, as an [AI SDK harness](https://ai-sdk.dev/docs):
thin config over `@ai-sdk/harness-acp`, which runs `goose acp` in the sandbox. It's shaped like the
`@ai-sdk/harness-*` packages.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createGoose } from '@reeval/harness-goose'

const agent = new HarnessAgent({
  harness: createGoose({
    auth: { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY! },
    model: 'gemini-3.8-flash',
    requireCredentialBrokering: true,
  }),
  model: 'gemini-3.8-flash',
  permissionMode: 'allow-all',
})
```

## How it works

- **Bootstrap.** Downloads the Goose 1.56.0 release for x86_64 or aarch64 Linux, checks its
  sha256, and puts `goose` in a private home under the bootstrap directory.
- **Model.** `model` is `GOOSE_MODEL`, which Goose needs before `session/new`; each turn's model
  is then set as the ACP session's `model` config option.
- **Quiet.** `GOOSE_QUIET_ENV`: the `google` provider, `auto` mode, no telemetry, no keyring and
  no session-naming model call. A turn contacts only the Gemini API.
- **Brokering.** On a sandbox with `addRequestTransformations`, Goose gets a placeholder
  `GOOGLE_API_KEY`; the real key is swapped in on `x-goog-api-key` to
  `generativelanguage.googleapis.com` only.
- **MCP.** Servers go in Goose's `config.yaml` as enabled extensions (`gooseConfig`): Goose 1.54.0
  leaves servers from ACP `session/new` disabled until the model enables them itself.
- **Tools.** `shell`, `write` and `edit` map to `bash`, `write` and `edit`, and the skills
  extension's `load_skill` is in the catalog under its own name. Any other call is named from
  Goose's `_meta.goose.toolCall`: an MCP server's as `mcp__<server>__<tool>`, Goose's own by its
  name.
- **Usage.** None. Goose's ACP `PromptResponse.usage` is its last model call's, not the turn's
  (a 4-call turn that used 16,253 input tokens reported 4,179), so the `finish` part's usage is
  dropped rather than passed on as an undercount.
