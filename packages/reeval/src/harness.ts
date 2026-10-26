// `reeval/harness`: agent harness descriptors. The implementations load lazily in workers.
import { splitModel } from '@reeval/harness-opencode/providers'
import { harnessProblem } from './contract/harness.ts'
import { UsageError } from './errors.ts'
import type {
  AntigravityHarnessDescriptor,
  ClaudeCodeHarnessDescriptor,
  CodexHarnessDescriptor,
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
  FxHarnessDescriptor,
  GatewayDescriptor,
  GatewayName,
  GooseHarnessDescriptor,
  GrokBuildHarnessDescriptor,
  HarnessDescriptor,
  OpenCodeHarnessDescriptor,
  PiHarnessDescriptor,
} from './types.ts'

/** A factory's options: the descriptor's, with `gateway` pinned by name or by its helper. */
type Options<D extends HarnessDescriptor, Omitted extends string = never> = Omit<
  D,
  'kind' | 'gateway' | Omitted
> & { gateway?: GatewayName | GatewayDescriptor }

/** `options` as a descriptor of `kind`, checked; throws its factory's sentence for the first problem. */
function make<D extends HarnessDescriptor>(kind: D['kind'], options: unknown): D {
  const descriptor = { kind, ...(options as object) } as D
  const pin: unknown = descriptor.gateway
  if (typeof pin === 'object' && pin !== null && 'kind' in pin) {
    descriptor.gateway = (pin as GatewayDescriptor).kind
  }
  const problem = harnessProblem(descriptor)
  if (problem) throw new UsageError(problem)
  return descriptor
}

/**
 * Cursor's agent through the Cursor TypeScript SDK, in the sandbox. `model` is required (the SDK
 * has no default for local agents); `params` sets model parameters such as `{ fast: 'false' }`.
 * `effort` maps onto the catalog param `Cursor.models.list()` names for this model, not Fast.
 * `id` names the cell; it defaults to `cursor:<model>`, or `cursor:<model>[effort=<value>]`
 * when `effort` is set.
 */
export const cursor = (options: Options<CursorHarnessDescriptor>): CursorHarnessDescriptor =>
  make('cursor', options)

/**
 * The Claude Code CLI. `model` is required, since the CLI's default changes under you. `effort`
 * is the Agent SDK `/effort` control (`low`, `medium`, `high`, `xhigh`, `max`). `id` names the
 * cell; it defaults to `claude-code:<model>`, or `claude-code:<model>[effort=<value>]` when
 * `effort` is set.
 */
export const claudeCode = (
  options: Options<ClaudeCodeHarnessDescriptor, 'effort'> & { effort?: string },
): ClaudeCodeHarnessDescriptor => make('claude-code', options)

/**
 * The Antigravity CLI, with a Gemini API key. `model` is required, since the CLI's default
 * changes under you. `effort` is `agy --effort` (`low`, `medium`, `high`, `max`). `id` names
 * the cell; it defaults to `antigravity:<model>`, or `antigravity:<model>[effort=<value>]`
 * when `effort` is set.
 */
export const antigravity = (
  options: Options<AntigravityHarnessDescriptor>,
): AntigravityHarnessDescriptor => make('antigravity', options)

/**
 * OpenCode, on the model's provider: `model` is OpenCode's `<provider>/<model>`, such as
 * `google/gemini-3.8-flash` or `anthropic/claude-haiku-4-5`, and only that provider's key is
 * needed and brokered. On `direct()`, a provider whose key reeval can't broker is refused, saying
 * why; on `vercel()` any `<provider>/<model>` Vercel serves runs. `effort` is that provider's
 * thinking option, and isn't taken on `vercel()`. `id` names the cell; it defaults to `opencode:<model>`,
 * the part after the last `/`, or `opencode:<model>[effort=<value>]` when `effort` is set.
 */
export const opencode = (
  options: Options<OpenCodeHarnessDescriptor>,
): OpenCodeHarnessDescriptor => {
  const why = opencodeModelError(options?.model)
  if (why) throw new UsageError(`opencode(): ${why}`)
  return make('opencode', options)
}

/** Why `model` can't run on OpenCode, or undefined when it can. */
export function opencodeModelError(model: unknown): string | undefined {
  if (typeof model !== 'string' || !model) {
    return `needs a model, <provider>/<model>, e.g. opencode({ model: 'google/gemini-3.8-flash' }) (got ${JSON.stringify(model)})`
  }
  for (const gateway of ['vercel', 'openrouter']) {
    if (model.startsWith(`${gateway}/`)) {
      return `${gateway === 'openrouter' ? 'an' : 'a'} ${gateway}/… id would bypass the config's gateway list: write the model as '${model.slice(gateway.length + 1)}' and add ${gateway}() to gateway (got ${JSON.stringify(model)})`
    }
  }
  // The provider table gates direct() only: on a gateway any <provider>/<model> runs.
  return splitModel(model)
    ? undefined
    : `an OpenCode model id names its provider, <provider>/<model>, such as 'google/gemini-3.8-flash' or 'anthropic/claude-haiku-4-5' (got ${JSON.stringify(model)})`
}

/**
 * Goose, with a Gemini API key: `model` is a Gemini model id, which it runs on its `google`
 * provider, or on `vercel()` as `google/<model>` with Vercel's key. `effort` is
 * `GOOSE_THINKING_EFFORT`, and isn't taken on `vercel()`. `id` names the cell; it defaults to
 * `goose:<model>`, or `goose:<model>[effort=<value>]` when `effort` is set.
 */
export const goose = (options: Options<GooseHarnessDescriptor>): GooseHarnessDescriptor =>
  make('goose', options)

/**
 * pi, with a Gemini API key: `model` is a Gemini model id, which it runs on its `google` provider,
 * or as `google/<model>` on `vercel()` (Vercel's Chat Completions API, with Vercel's key) or on
 * `openrouter()` (pi's `openrouter` provider, with OpenRouter's key). `effort` is pi's `--thinking`
 * flag, which reaches a Gemini model as its own thinking level on each. `id` names the cell; it
 * defaults to `pi:<model>`, or `pi:<model>[effort=<value>]` when `effort` is set.
 */
export const pi = (options: Options<PiHarnessDescriptor>): PiHarnessDescriptor =>
  make('pi', options)

/**
 * OpenAI's Codex CLI, with an OpenAI API key: `model` is an OpenAI model id, e.g. `gpt-5.6-luna`,
 * required since the CLI's default changes under you. `effort` is `model_reasoning_effort`. `id`
 * names the cell; it defaults to `codex:<model>`, or `codex:<model>[effort=<value>]` when
 * `effort` is set.
 */
export const codex = (options: Options<CodexHarnessDescriptor>): CodexHarnessDescriptor =>
  make('codex', options)

/**
 * fx, on Vercel AI Gateway, OpenAI's API or OpenRouter: `model` is a gateway id, e.g.
 * `anthropic/claude-sonnet-5`, which needs `vercel()` or `openrouter()` in the config's gateway
 * list, or a bare OpenAI id, e.g. `gpt-5.5`, run with `OPENAI_API_KEY` on `direct()` or as
 * `openai/<id>` on `vercel()` and `openrouter()`. `id` names the cell; it defaults to `fx:<model>`.
 */
export const fx = (options: Options<FxHarnessDescriptor>): FxHarnessDescriptor =>
  make('fx', options)

/**
 * xAI's Grok Build, with an xAI API key: `model` is an xAI model id, e.g. `grok-4.6`, required
 * since the CLI's default changes under you; on `vercel()` it runs as `xai/<model>` with Vercel's
 * key. `effort` is Grok's `default_reasoning_effort`, and isn't taken on `vercel()`. `id`
 * names the cell; it defaults to `grok-build:<model>`, or `grok-build:<model>[effort=<value>]`
 * when `effort` is set.
 */
export const grokBuild = (
  options: Options<GrokBuildHarnessDescriptor>,
): GrokBuildHarnessDescriptor => make('grok-build', options)

/** A fake agent that writes canned files and replies with canned text. For tests and dry runs. */
export const fakeHarness = (options: Options<FakeHarnessDescriptor> = {}): FakeHarnessDescriptor =>
  make('fake', options)

export type {
  AgentHarnessDescriptor,
  AntigravityHarnessDescriptor,
  ClaudeCodeEffort,
  ClaudeCodeHarnessDescriptor,
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
  FakeScriptStep,
  FxHarnessDescriptor,
  GooseHarnessDescriptor,
  GrokBuildHarnessDescriptor,
  HarnessDescriptor,
  OpenCodeHarnessDescriptor,
  PiHarnessDescriptor,
} from './types.ts'
