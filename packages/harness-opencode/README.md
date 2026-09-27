# @evalsuite/harness-opencode

[OpenCode](https://opencode.ai) 2 on a Gemini API key, as an [AI SDK harness](https://ai-sdk.dev/docs):
thin config over `@ai-sdk/harness-acp`, which runs `opencode acp` in the sandbox. It's shaped like
the `@ai-sdk/harness-*` packages.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createOpenCode } from '@evalsuite/harness-opencode'

const agent = new HarnessAgent({
  harness: createOpenCode({
    auth: { GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY! },
    model: 'gemini-3.8-flash', // session titles
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

- **Bootstrap.** Installs `@opencode/cli` 2.0.18 from a pinned lockfile, letting pnpm run only its
  postinstall (which links the platform binary). The musl builds are left out: the package marks
  none with a libc, so pnpm would otherwise install all four Linux builds.
- **Model.** A Gemini model id, set as the ACP session's `model` config option on OpenCode's
  `google` provider each turn: OpenCode 2 ignores its config's `model` over ACP. Pass `model` to
  `createOpenCode` too, so session titles use it rather than `gemini-flash-lite-latest`.
- **Config.** `openCodeEnv()` passes `openCodeConfig()` as `OPENCODE_CONFIG_CONTENT` (2.0.18 no
  longer reads the `OPENCODE_DISABLE_*` variables for these): no self-update or share links, every
  tool allowed but `websearch` (it needs a search integration), `question` (it waits for a person)
  and the browser tools. It also sets `OPENCODE_DISABLE_AUTOUPDATE` and
  `OPENCODE_DISABLE_MODELS_FETCH`.
- **Tools.** `OPENCODE_BUILTIN_TOOLS` maps OpenCode's tools (`shell` becomes the common `bash`;
  `read`, `write` and `edit` take `path`). A tool's output is rebuilt as `{ output, metadata }`
  from the ACP `content`, since OpenCode 2's `rawOutput` has no text. A call `harness-acp` can't
  name is named from OpenCode's first `tool_call` update, whose title is the tool's name.
- **MCP.** OpenCode 2 offers MCP servers' tools only through Code Mode, its `execute` tool, which
  runs JavaScript. Each MCP call an `execute` call reports in `metadata.toolCalls` follows it as
  `mcp__<server>__<tool>`, with its status. It has no SSE transport.
- **Usage.** None. OpenCode's ACP `PromptResponse.usage` is its last model call's, not the turn's
  (still so in 2.0.18), so the `finish` part's usage is dropped rather than passed on as an
  undercount. `usage_update` doesn't help: its `used` is the last call's context and its `cost`
  the session's.
- **Skills.** Harness-placed skills go to `~/.config/opencode/skills`; OpenCode's repo directory
  is `.opencode/skills`. It also reads `.claude/skills` and `.agents/skills`, in the repo and the
  home directory, and nothing turns that off. It reads `AGENTS.md` for rules.
