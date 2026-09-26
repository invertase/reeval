# @evalsuite/harness-opencode

[OpenCode](https://opencode.ai) on a Gemini API key, as an [AI SDK harness](https://ai-sdk.dev/docs):
thin config over `@ai-sdk/harness-acp`, which runs `opencode acp` in the sandbox. It's shaped like
the `@ai-sdk/harness-*` packages.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createOpenCode } from '@evalsuite/harness-opencode'

const agent = new HarnessAgent({
  harness: createOpenCode({
    auth: { GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY! },
    requireCredentialBrokering: true,
  }),
  model: 'gemini-3.8-flash', // run as google/gemini-3.8-flash
  permissionMode: 'allow-all',
})
```

## Why not `@ai-sdk/harness-opencode`

That adapter (1.0.128) brokers Anthropic, OpenAI, xAI, AI Gateway and a few other keys, but not a
Google one: a `google/…` model falls back to its Anthropic credentials. This package brokers
`GOOGLE_GENERATIVE_AI_API_KEY` instead, on `x-goog-api-key` to
`generativelanguage.googleapis.com` only.

## How it works

- **Bootstrap.** Installs `opencode-ai` 1.18.32 from a pinned lockfile, letting pnpm run only its
  postinstall (which links the platform binary). `OPENCODE_WARM_COMMAND` installs the plugin
  runtime OpenCode otherwise fetches from npm into `~/.config/opencode` on every start; ES runs it
  when it bakes the image.
- **Model.** A Gemini model id, set as the ACP session's `model` config option on OpenCode's
  `google` provider.
- **Quiet.** `OPENCODE_QUIET_ENV` turns off auto-update, share links, the model-catalog fetch, LSP
  downloads, default plugins and the Claude Code and `.agents` compatibility reads.
- **Tools.** `OPENCODE_BUILTIN_TOOLS` maps OpenCode's tools to the common names (`bash`, `read`,
  `write`, `edit`, `glob`, `grep`, `webFetch`, `webSearch`). A call `harness-acp` can't name is
  named from OpenCode's first `tool_call` update, whose title is the tool's name; an MCP tool
  (`<server>_<tool>`) becomes `mcp__<server>__<tool>`.
- **Usage.** None. OpenCode's ACP `PromptResponse.usage` is its last model call's, not the turn's
  (checked with 1.18.32: a 4-call turn that used 33,942 input tokens reported 8,559), so the
  `finish` part's usage is dropped rather than passed on as an undercount.
- **Skills.** Harness-placed skills go to `~/.config/opencode/skills`; OpenCode's repo directory
  is `.opencode/skills`. It reads `AGENTS.md` for rules.
