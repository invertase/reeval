# @reeval/harness-opencode

[OpenCode](https://opencode.ai) 2 on any provider whose key a gateway can broker, as an
[AI SDK harness](https://ai-sdk.dev/docs): thin config over `@ai-sdk/harness-acp`, which runs
`opencode acp` in the sandbox. It's shaped like the `@ai-sdk/harness-*` packages.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createOpenCode } from '@reeval/harness-opencode'

const agent = new HarnessAgent({
  harness: createOpenCode({
    auth: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
    model: 'anthropic/claude-haiku-4-5', // picks the provider, and titles the session
    requireCredentialBrokering: true,
  }),
  model: 'anthropic/claude-haiku-4-5',
  permissionMode: 'allow-all',
})
```

## Why not `@ai-sdk/harness-opencode`

That adapter (1.0.128) targets OpenCode 1 and brokers Anthropic, OpenAI, xAI, AI Gateway and a
few other keys, but not a Google one: a `google/…` model falls back to its Anthropic credentials.
This package brokers the key of whichever provider the model names, for any of the providers in
its table.

## Providers

`opencode-provider-table.ts` lists every provider OpenCode 2.0.24 knows: the ones whose key it
sends in a header on known hosts, each with the variable it reads, the headers and the requests it
sends the key on, and the others with the reason a gateway can't broker them (per-account hosts,
SigV4, service accounts, subscriptions, local servers, provider packages it installs from npm).
A provider can also take variables that aren't secret: Bedrock's hosts are built from
`AWS_REGION`, so its table entry has `{AWS_REGION}` in them, a default (`us-east-1`) and the
pattern a value must match (`scripts/provider-vars.ts`; the probe runs with a recognisable region).
`resolveOpenCodeProvider(model, env)` gives a model's provider, with its hosts filled in and the
variables' values (which `createOpenCode`'s `vars` passes into the sandbox), or that reason, and
`@reeval/harness-opencode/providers` exports the table and its helpers without the harness.

The table is generated, not written: `scripts/probe-providers.ts` runs the pinned `opencode run`
through a local MITM proxy that answers every request itself (nothing leaves the host), once per
provider and per model API (a provider's models can use several), with this package's config and
a distinct placeholder in each of the provider's variables, and records where each placeholder
went. It takes each provider's models from models.dev's catalog, newest first, while OpenCode
runs on the catalog built into its release; when that knows none of them (models.dev renamed the
provider's models since the release), the newest runs with `OPENCODE_MODELS_PATH` on the same
catalog, so a rename never reads as a refused provider. `scripts/provider-table.ts` turns that
into the table. On an OpenCode bump:

```bash
curl -so /tmp/catalog.json https://models.opencode.ai/api.json   # a model id per provider
node --experimental-strip-types scripts/probe-providers.ts <opencode> /tmp/catalog.json /tmp/probe.json
node --experimental-strip-types scripts/provider-table.ts /tmp/probe.json /tmp/catalog.json
```

The nightly drift leg runs the probe against the newest `@opencode/cli`
(`scripts/drift/opencode-providers.mjs` at the repo root) and fails, with a diff, when the table it
would generate differs from this one.

## How it works

- **Bootstrap.** Installs `@opencode/cli` 2.0.24 from a pinned lockfile, letting pnpm run only its
  postinstall (which links the platform binary). The musl builds are left out: the package marks
  none with a libc, so pnpm would otherwise install all four Linux builds.
- **Model.** `<provider>/<model>`, set as the ACP session's `model` config option each turn:
  OpenCode 2 ignores its config's `model` over ACP. `createOpenCode`'s `model` picks the provider
  whose key is used and brokered (only that variable, holding a placeholder, enters the sandbox),
  and titles the session, rather than a second, small model. A turn on another provider throws.
- **Brokering.** On each of the provider's hosts, the key goes in each header the table lists
  (`Authorization: Bearer`, `x-api-key` or `x-goog-api-key`), and `openCodeEndpoints(model)` are
  the requests a gateway should allow it on.
- **Config.** `openCodeEnv()` passes `openCodeConfig()` as `OPENCODE_CONFIG_CONTENT` (2.0.18 no
  longer reads the `OPENCODE_DISABLE_*` variables for these): no self-update or share links,
  `question` (it waits for a person) and the browser tools denied, web search on Exa, the
  provider's model calls over HTTP (`transport: 'http'`: OpenCode's default for OpenAI and xAI is
  a Responses WebSocket, whose frames a gateway can't read the served model from), and the MCP
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
  name is named from OpenCode's first `tool_call` update, whose title is the tool's name; `patch`,
  the edit tool OpenCode gives GPT models, is an `edit`.
- **MCP.** `mcpServers` go in the config's `mcp.servers` with `codemode: false`, so the model
  calls their tools directly (`<server>_<tool>`, named `mcp__<server>__<tool>`), with input and
  output. Over ACP `session/new`, OpenCode 2 offers them only through Code Mode, its `execute`
  tool. It has no SSE transport.
- **Gate.** OpenCode connects config MCP servers in the background after `session/new`, and a
  prompt sent before they connect runs its first step without their tools. `harness-acp` runs
  `reeval-opencode-gate` (`OPENCODE_GATE`, written beside OpenCode's bin at start), which runs
  `opencode acp` with its info logs on and holds the first `session/prompt` until each server has
  logged `mcp connected` or `mcp connect failed`, at most 30 seconds.
- **Usage.** `@ai-sdk/harness-acp` maps ACP `PromptResponse.usage` onto the `finish` part.
  OpenCode #52467 reports the whole turn (thought and cache tokens when the model reports them).
  `usage_update` is unused: its `used` is still the last step's context and `cost` the session's.
- **Skills.** Harness-placed skills go to `~/.config/opencode/skills`; OpenCode's repo directory
  is `.opencode/skills`. It also reads `.claude/skills` and `.agents/skills`, in the repo and the
  home directory, and nothing turns that off. It reads `AGENTS.md` for rules.
