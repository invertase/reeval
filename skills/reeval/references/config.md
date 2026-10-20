# reeval.config.ts, harnesses and options

## Contents

- reeval.yaml
- Path rule and where the sandbox comes from
- Harnesses, keys and effort
- Judge models and imports
- Options and the cascade

## reeval.yaml

A project without TypeScript can write `reeval.yaml` (or `.yml`) instead, with no callbacks:

```yaml
harness: { kind: cursor, model: composer-2.5 }
judge: { model: typesafe-ai/jev-1.14.0 }   # or { kind: fake-judge, score: 0.9 }
env:
  NPM_TOKEN: { kind: secret, hosts: [registry.npmjs.org] }
environment:
  kind: environment
  name: base
  layers: [{ name: base, spec: { setup: [npm ci] } }]
```

A `reeval.yaml` beside a `reeval.config.*` is an error.

## Path rule and where the sandbox comes from

One path rule for both: a relative host path resolves against the directory of the file it's
written in (the config's, an eval file's, or the module calling `defineEnvironment` or a helper),
whether it comes from a helper (`file()`, `skill.local()`, `skill.npm()`, `git()`,
`docker({ dockerfile })`, `fakeSandbox({ dir })`) or its data form (`{ kind: file, path }`,
`{ kind: fake, dir }`, …). Absolute paths stay as written.

| Where the sandbox comes from | When |
|---|---|
| The environment's `sandbox` | It sets one; `extendEnvironment` keeps the parent's when the child omits it |
| The cascaded `sandbox` option (`defineConfig({ sandbox })`) | The resolved environment omits it; it's the default machine, not an environment |
| Implicit Docker (reeval's image: Node 22, git, pnpm, the agent CLI) | Neither is set |

A named env is a total override: no skills, files or sandbox inherit from the config
environment. A fake profile or config puts `sandbox: fakeSandbox()` on `defaults` or
`defineConfig` so `plain` and skill variants run without Docker; that's for trying configs, not
for validating checks (an environment's own `docker()` still wins). Don't put `fakeSandbox()`
on `plain` itself: real Cursor runs need Docker. An oracle or canary profile sets only
`defaults.harness`, so each eval keeps its sandbox: see
[evals.md](evals.md#trustworthy-evals).

## Harnesses, keys and effort

Harnesses (`reeval/harness`), each with a required `model`; a list runs each as its own cell:

| Factory | Key | Notes |
|---|---|---|
| `cursor({ model, params?, effort? })` | `CURSOR_API_KEY` | Cursor's agent through the Cursor SDK. `params` such as `{ fast: 'true' }` pick the variant; `effort` maps onto the parameter `Cursor.models.list()` names for that model |
| `claudeCode({ model, effort? })` | `ANTHROPIC_API_KEY` | `effort` is the Agent SDK's `/effort` |
| `antigravity({ model, effort? })` | `GEMINI_API_KEY` (a Gemini API key) | e.g. `gemini-3.8-flash-medium`; `effort` is `agy --effort` |
| `opencode({ model, effort? })` | That provider's key, e.g. `ANTHROPIC_API_KEY` | OpenCode 2; the model is `<provider>/<model>`, e.g. `google/gemini-3.8-flash`. `amazon-bedrock/…` takes `AWS_BEARER_TOKEN_BEDROCK` and an optional `AWS_REGION`; Vertex, Azure, Copilot and local providers are refused at plan time. Web search via Exa, whose host it allows; it also reads `.claude/skills` and `.agents/skills` |
| `goose({ model, effort? })` | `GOOGLE_GENERATIVE_AI_API_KEY` | A Gemini model id, e.g. `gemini-3.8-flash`; `effort` is `GOOSE_THINKING_EFFORT`. Records no tokens: its ACP usage is the last model call only |
| `pi({ model, effort? })` | `GOOGLE_GENERATIVE_AI_API_KEY` | A Gemini model id; `effort` is `--thinking` |
| `codex({ model, effort? })` | `OPENAI_API_KEY` | An OpenAI model id, e.g. `gpt-5.6-luna`; `effort` is `model_reasoning_effort` |
| `fx({ model })` | `AI_GATEWAY_API_KEY`, or `OPENAI_API_KEY` for a bare id | Vercel's fx over ACP: a gateway id (`anthropic/claude-sonnet-5`) runs on AI Gateway, a bare non-reasoning OpenAI id (`gpt-4.1`) on OpenAI. No `effort`. Its own web tools bypass the egress gateway, so `deny-all` blocks them |
| `grokBuild({ model, effort? })` | `XAI_API_KEY` | xAI's Grok Build CLI; an xAI model id, e.g. `grok-4.6`; `effort` is `default_reasoning_effort`. It finds MCP tools with its `search_tool` before calling them |
| `fakeHarness(…)` | None | See the fake trio in SKILL.md |

OpenCode, Goose, pi and Codex refuse `mcp.sse`. Unset Cursor params take Cursor's default, which
the record shows (`composer-2.5[fast=true]`), so pin them for reproducible evals.

`effort` is the same field on every factory but `fx()`, with whatever values that CLI takes (no shared
enum); Fast is not effort. The default harness id includes `[effort=<value>]` when it's set, and
the record stores the requested effort as `effort` and the served one as `servedEffort`.

In `reeval query` those are `reasoning_effort` (`cells`, `attempts`) and
`served_reasoning_effort` (`attempts`). **effort** on its own (`reeval query effort`, the
summary's `effort:` line) is always the measured tool-call, time and token metric.

Keys never enter the sandbox: the agent sees a placeholder that reeval's gateway swaps on the
harness's own endpoints. Every harness but Goose reports tokens, which reeval records per turn,
attempt and run (no prices).

## Judge models and imports

- Judge models: `'typesafe-ai/jev-1.14.0'` (`TYPESAFE_AI_API_KEY`, recommended),
  `'google/gemini-3.8-flash'` (`GOOGLE_GENERATIVE_AI_API_KEY`), any other `provider/model` via
  the Vercel AI Gateway (`AI_GATEWAY_API_KEY`). Always a provider prefix.
- Imports: `reeval` (`defineConfig`, `defineEnvironment`, `group`, `evaluate`,
  `expect`, `DEFAULT_EGRESS_ALLOW`, `DEFAULT_SKILL_EXCLUDE`, types), `/harness`, `/sandbox`
  (`docker`, `fakeSandbox`), `/judge` (`fakeJudge`, `RECOMMENDED_JUDGE_MODEL`,
  `DEFAULT_THRESHOLD`). There is no `test`, `describe`, `baseline`, `secret` or `skill` export.

## Options and the cascade

`defineConfig`, `group` and `evaluate` take the same options, and inner levels win:

| Option | Cascades as |
|---|---|
| `harness` | One or a list, or an edit of the inherited list: `{ add: h }`, `{ only: 'cursor:composer-2.5' }` or a function |
| `sandbox` | The default machine when the resolved env omits one |
| `environment` | One; a named env is a total override of the config environment |
| `env` | Merged by name |
| `judge` | Merged by field |
| `capture` | Shallow-merged camera defaults (`viewport`, `timeout`, `browser`, `model`, the vision model); `viewport` replaces the value, and the port is not an option |
| `runs`, `gate`, `egress`, `timeout` | Replaced |
| `tags`, `pin` | Unioned |
| `compare` | Groups and evals only |

Options are plain objects, never functions. Unknown keys are errors with a hint (`repeat` → "Did
you mean runs?").
