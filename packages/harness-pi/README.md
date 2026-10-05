# @reeval/harness-pi

[pi](https://github.com/earendil-works/pi) on a Gemini API key, as an
[AI SDK harness](https://ai-sdk.dev/docs), running inside the sandbox. It's shaped like the
`@ai-sdk/harness-*` packages.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createPi } from '@reeval/harness-pi'

const agent = new HarnessAgent({
  harness: createPi({
    auth: { GEMINI_API_KEY: process.env.GEMINI_API_KEY! },
    mcpServers: { docs: { command: 'npx', args: ['-y', '@acme/docs-mcp@1.0.0'] } },
    requireCredentialBrokering: true,
  }),
  model: 'gemini-3.8-flash',
  permissionMode: 'allow-all',
})
```

## Why not `@ai-sdk/harness-pi`

That adapter (1.0.128) runs pi as a library in the host process (`createAgentSession`): model
calls leave from the host with the real key, MCP servers start on the host, and it patches the
global `fs` module to reach the sandbox's files. This package runs the pi CLI in the sandbox.

## How it works

- **Bootstrap.** Installs `@earendil-works/pi-coding-agent` 1.0.2 from the lockfile in `assets/`,
  with no build scripts (pi doesn't need them).
- **Turns.** Each turn is one `pi --mode json -p --offline --approve --no-extensions --provider
  google --model <model> --session-id <id>` process; every turn uses the session's id, so pi
  continues the conversation. With MCP servers, `-e builtin:mcp` loads pi's built-in MCP
  extension, the only one.
- **Stream.** pi's NDJSON events become harness stream parts: text, provider-executed tool calls
  and results (`read`, `write`, `edit`, `bash`), a `finish-step` per model call with its tokens,
  and a `finish` with their sum. pi's USD `cost` isn't passed on.
- **Brokering.** On a sandbox with `addRequestTransformations`, pi gets a placeholder
  `GEMINI_API_KEY`; the real key is swapped in on `x-goog-api-key` to
  `generativelanguage.googleapis.com` only.
- **Placement.** Skills go to `~/.pi/agent/skills` and instructions to `~/.pi/agent/AGENTS.md`;
  the repo skill directory is `.pi/skills`.
- **MCP.** `mcpServers` (stdio `command`, or streamable HTTP `url`; pi has no SSE transport) go
  in `~/.pi/agent/mcp.json`, each with `"exposure": "direct"`, so the model sees their tools as
  `mcp__<server>__<tool>` rather than only through pi's `codemode` tool. pi expands `$NAME` in
  `env` and header values and runs a value starting with `!` as a command, so the adapter
  escapes them (`$` as `$$`, a leading `!` as `$!`): every value reaches the server as written.
  pi writes each `-` in those names as `_`; the translator puts a server's configured name back
  when no other server sanitizes alike, and leaves the tool part as pi wrote it.
