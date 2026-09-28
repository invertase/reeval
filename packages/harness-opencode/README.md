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
  longer reads the `OPENCODE_DISABLE_*` variables for these): no self-update or share links,
  `question` (it waits for a person) and the browser tools denied, web search on Exa, and the MCP
  servers. It loads after an eval's own `opencode.json(c)`: a key both set is this config's,
  objects merge, and permission rules append (the last match wins), so it only denies. It also
  sets `OPENCODE_DISABLE_AUTOUPDATE` and `OPENCODE_DISABLE_MODELS_FETCH`.
- **Web search.** `websearch` needs a provider, or it asks the user to pick one.
  `OPENCODE_WEB_SEARCH` is Exa's hosted MCP server (`mcp.exa.ai`), keyless: OpenCode sends an Exa
  key as a URL parameter, which a gateway can't swap in. A search's result lists its
  `references`.
- **Tools.** `OPENCODE_BUILTIN_TOOLS` maps OpenCode's tools (`shell` becomes the common `bash`;
  `read`, `write` and `edit` take `path`). A tool's output is rebuilt as `{ output, metadata }`
  from the ACP `content`, since OpenCode 2's `rawOutput` has no text. A call `harness-acp` can't
  name is named from OpenCode's first `tool_call` update, whose title is the tool's name.
- **MCP.** `mcpServers` go in the config's `mcp.servers` with `codemode: false`, so the model
  calls their tools directly (`<server>_<tool>`, named `mcp__<server>__<tool>`), with input and
  output. Over ACP `session/new`, OpenCode 2 offers them only through Code Mode, its `execute`
  tool. It has no SSE transport.
- **Gate.** OpenCode connects config MCP servers in the background after `session/new`, and a
  prompt sent before they connect runs its first step without their tools. `harness-acp` runs
  `es-opencode-gate` (`OPENCODE_GATE`, written beside OpenCode's bin at start), which runs
  `opencode acp` with its info logs on and holds the first `session/prompt` until each server has
  logged `mcp connected` or `mcp connect failed`, at most 30 seconds.
- **Usage.** None. OpenCode's ACP `PromptResponse.usage` is its last model call's, not the turn's
  (still so in 2.0.18), so the `finish` part's usage is dropped rather than passed on as an
  undercount. `usage_update` doesn't help: its `used` is the last call's context and its `cost`
  the session's.
- **Skills.** Harness-placed skills go to `~/.config/opencode/skills`; OpenCode's repo directory
  is `.opencode/skills`. It also reads `.claude/skills` and `.agents/skills`, in the repo and the
  home directory, and nothing turns that off. It reads `AGENTS.md` for rules.
