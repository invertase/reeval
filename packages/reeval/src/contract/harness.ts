// The harness descriptors' plain-data contract: what `cursor()`, `claudeCode()` and the other
// factories in `reeval/harness` return, and what a declaration tree from any language carries.
// One schema per kind, joined on `kind`; the types in types.ts are held to them by
// `_SameAsSchema`.
import { z } from 'zod'
import type {
  AntigravityHarnessDescriptor,
  ClaudeCodeHarnessDescriptor,
  CodexHarnessDescriptor,
  CursorHarnessDescriptor,
  FakeHarnessDescriptor,
  FakeScriptStep,
  FxHarnessDescriptor,
  GooseHarnessDescriptor,
  GrokBuildHarnessDescriptor,
  HarnessDescriptor,
  OpenCodeHarnessDescriptor,
  PiHarnessDescriptor,
} from '../types.ts'
import {
  type Assert,
  closest,
  durationSchema,
  genericProblem,
  got,
  type Issue,
  nonEmpty,
  refusal,
  type Same,
} from './shared.ts'

const START_TIMEOUT =
  "How long the harness's session may take to become ready (its bootstrap and first session) before the attempt is an infra error, after one retry; default 90s."
const effort = (description: string) => nonEmpty().optional().describe(description)
const id = (kind: string) =>
  nonEmpty()
    .optional()
    .describe(
      `Cell id; defaults to \`${kind}:<model>\`, or \`${kind}:<model>[effort=<value>]\` when \`effort\` is set.`,
    )
const maxConcurrent = (description: string) => z.number().optional().describe(description)
const startTimeout = () => durationSchema.optional().describe(START_TIMEOUT)
/** A model id with no provider prefix. */
const BARE_MODEL = /^[\w.-]+$/

export const cursorHarnessSchema = z
  .strictObject({
    kind: z.literal('cursor'),
    model: z
      .string()
      .min(1)
      .describe('A model id `Cursor.models.list()` returns for the key, e.g. `composer-2.5`.'),
    params: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Model parameters, e.g. `{ fast: 'false' }`. Unset ones take the default variant in Cursor's model catalog (`fast=true` for `composer-2.5`), sent explicitly; pass the ones that change cost.",
      ),
    effort: effort(
      'Reasoning effort, mapped onto the catalog param `Cursor.models.list()` names for this model (`reasoning_effort`, `effort`, …). Not Fast: that stays `params.fast`.',
    ),
    id: id('cursor'),
    maxConcurrent: maxConcurrent(
      "The most Cursor attempts at once, across the run, e.g. for the account's rate limits.",
    ),
    startTimeout: startTimeout(),
  })
  .describe(
    "Cursor's agent through the Cursor TypeScript SDK's local runtime (`@reeval/harness-cursor-sdk`), made by `cursor()`. It reports each turn's tokens.",
  )

export const CLAUDE_CODE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const claudeCodeEffortSchema = z
  .enum(CLAUDE_CODE_EFFORTS)
  .describe('Reasoning effort the Claude Code Agent SDK `/effort` control takes.')

export const claudeCodeHarnessSchema = z
  .strictObject({
    kind: z.literal('claude-code'),
    model: z
      .string()
      .min(1)
      .describe(
        'A model id or alias the `claude` CLI accepts, e.g. `claude-sonnet-5` or `sonnet`.',
      ),
    effort: claudeCodeEffortSchema
      .optional()
      .describe(
        'Reasoning effort the Agent SDK `/effort` control takes: `low`, `medium`, `high`, `xhigh` (Extra in the UI) or `max`.',
      ),
    id: id('claude-code'),
    maxConcurrent: maxConcurrent(
      "The most Claude Code attempts at once, across the run, e.g. for the account's rate limits.",
    ),
    startTimeout: startTimeout(),
  })
  .describe('Claude Code through `@ai-sdk/harness-claude-code`, made by `claudeCode()`.')

export const antigravityHarnessSchema = z
  .strictObject({
    kind: z.literal('antigravity'),
    model: z
      .string()
      .min(1)
      .describe(
        'A model slug `agy models` lists for a Gemini API key, e.g. `gemini-3.8-flash-medium`.',
      ),
    effort: effort(
      "Reasoning effort passed as `agy --effort`, e.g. `low`, `medium`, `high` or `max`. The slug's `-low`/`-medium`/`-high` suffix is the same knob baked into `model`.",
    ),
    id: id('antigravity'),
    maxConcurrent: maxConcurrent(
      "The most Antigravity attempts at once, across the run, e.g. for the key's rate limits.",
    ),
    startTimeout: startTimeout(),
  })
  .describe('The Antigravity CLI through `@reeval/harness-antigravity`, made by `antigravity()`.')

export const opencodeHarnessSchema = z
  .strictObject({
    kind: z.literal('opencode'),
    model: z
      .string()
      .min(1)
      .describe(
        "OpenCode's model id, `<provider>/<model>`, e.g. `google/gemini-3.8-flash` or `anthropic/claude-haiku-4-5`; the provider picks the key.",
      ),
    effort: effort(
      'Reasoning effort for that provider: `options.reasoningEffort` (OpenAI) or `options.thinking` (Anthropic). Values are whatever that provider takes.',
    ),
    id: id('opencode'),
    maxConcurrent: maxConcurrent(
      "The most OpenCode attempts at once, across the run, e.g. for the key's rate limits.",
    ),
    startTimeout: startTimeout(),
  })
  .describe(
    "OpenCode through `@reeval/harness-opencode` (`opencode acp`), made by `opencode()`. It runs on any provider whose key OpenCode sends in a header on known hosts, with that provider's key, and reports no usage (its ACP server counts one call).",
  )

export const gooseHarnessSchema = z
  .strictObject({
    kind: z.literal('goose'),
    model: z
      .string()
      .regex(BARE_MODEL)
      .describe("A Gemini model id, run on Goose's `google` provider, e.g. `gemini-3.8-flash`."),
    effort: effort(
      'Reasoning effort as `GOOSE_THINKING_EFFORT`, e.g. `off`, `low`, `medium`, `high` or `max`.',
    ),
    id: id('goose'),
    maxConcurrent: maxConcurrent(
      "The most Goose attempts at once, across the run, e.g. for the key's rate limits.",
    ),
    startTimeout: startTimeout(),
  })
  .describe(
    'Goose through `@reeval/harness-goose` (`goose acp`), made by `goose()`. It runs Google models on a Gemini API key, and reports no usage (its ACP server counts one call).',
  )

export const fxHarnessSchema = z
  .strictObject({
    kind: z.literal('fx'),
    model: z
      .string()
      .min(1)
      .describe(
        "A Vercel AI Gateway model id, `<provider>/<model>`, run on fx's `gateway` provider with `AI_GATEWAY_API_KEY`, e.g. `anthropic/claude-sonnet-5`; or a bare OpenAI model id, run on OpenAI's Chat Completions API with `OPENAI_API_KEY`, e.g. `gpt-4.1`.",
      ),
    id: nonEmpty().optional().describe('Cell id; defaults to `fx:<model>`.'),
    maxConcurrent: maxConcurrent(
      "The most fx attempts at once, across the run, e.g. for the key's rate limits.",
    ),
    startTimeout: startTimeout(),
  })
  .describe(
    "fx through `@reeval/harness-fx` (`fx acp`), made by `fx()`. It runs on Vercel AI Gateway or OpenAI's API by the model id, and reports each turn's tokens.",
  )

export const piHarnessSchema = z
  .strictObject({
    kind: z.literal('pi'),
    model: z
      .string()
      .regex(BARE_MODEL)
      .describe("A Gemini model id, run on pi's `google` provider, e.g. `gemini-3.8-flash`."),
    effort: effort(
      "Reasoning effort, passed as pi's `--thinking` (the CLI's name). Values are whatever that flag takes, e.g. `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.",
    ),
    id: id('pi'),
    maxConcurrent: maxConcurrent(
      "The most pi attempts at once, across the run, e.g. for the key's rate limits.",
    ),
    startTimeout: startTimeout(),
  })
  .describe(
    "pi through `@reeval/harness-pi` (`pi --mode json` in the sandbox), made by `pi()`. It runs Google models on a Gemini API key and reports each model call's tokens. It takes stdio and HTTP MCP servers, not SSE ones.",
  )

export const codexHarnessSchema = z
  .strictObject({
    kind: z.literal('codex'),
    model: z
      .string()
      .regex(BARE_MODEL)
      .describe('An OpenAI model id Codex runs on the Responses API, e.g. `gpt-5.6-luna`.'),
    effort: effort(
      "Reasoning effort as Codex's `model_reasoning_effort`, e.g. `low`, `medium`, `high`, `xhigh`, `max` or `ultra`.",
    ),
    id: id('codex'),
    maxConcurrent: maxConcurrent(
      "The most Codex attempts at once, across the run, e.g. for the key's rate limits.",
    ),
    startTimeout: startTimeout(),
  })
  .describe(
    "OpenAI's Codex CLI through `@reeval/harness-codex` (`codex exec --json`), made by `codex()`. It runs OpenAI models on an OpenAI API key and reports each turn's tokens, reasoning included.",
  )

export const grokBuildHarnessSchema = z
  .strictObject({
    kind: z.literal('grok-build'),
    model: z
      .string()
      .regex(BARE_MODEL)
      .describe('An xAI model id Grok Build runs on the xAI API, e.g. `grok-4.6`.'),
    effort: effort(
      "Reasoning effort as Grok's `default_reasoning_effort`, e.g. `low`, `medium` or `high`, for a model that takes one.",
    ),
    id: id('grok-build'),
    maxConcurrent: maxConcurrent(
      "The most Grok Build attempts at once, across the run, e.g. for the key's rate limits.",
    ),
    startTimeout: startTimeout(),
  })
  .describe(
    "xAI's Grok Build through `@reeval/harness-grok-build` (`grok agent stdio`), made by `grokBuild()`. It runs xAI models on an xAI API key and reports each turn's tokens.",
  )

export const fakeScriptStepSchema = z
  .union([
    z.strictObject({ exec: z.string() }),
    z.strictObject({ write: z.record(z.string(), z.string()) }),
    z.strictObject({ reply: z.string() }),
    z.strictObject({ mcp: z.string().regex(/^[^/]+\/[^/]+$/) }),
    z.strictObject({ error: z.string() }),
  ])
  .describe(
    "One action of a scripted fake agent. `exec` is reported as a `shell` tool call whose output is the command's stdout, `write` as file edits, and `reply` is the turn's final message. `mcp` (`'<server>/<tool>'`) starts the environment's stdio MCP server in the sandbox, as an agent would, and calls the tool with no arguments; it's reported as `mcp__<server>__<tool>`. `error` ends the turn there with status `error` and that message, as a provider error would.",
  )

export const FAKE_LAYOUTS = [
  'cursor',
  'claude-code',
  'antigravity',
  'opencode',
  'goose',
  'pi',
  'codex',
  'fx',
  'grok-build',
] as const

export const fakeHarnessSchema = z
  .strictObject({
    kind: z.literal('fake'),
    id: nonEmpty().optional().describe('Cell id; defaults to `fake`.'),
    files: z
      .record(z.string(), z.string())
      .optional()
      .describe('Files the fake agent writes into the sandbox on every turn.'),
    text: z
      .string()
      .optional()
      .describe("The fake agent's final message on every turn; default `Done.`."),
    delayMs: z.number().optional().describe('Simulated turn length, honours the abort signal.'),
    ignoreAbort: z
      .boolean()
      .optional()
      .describe(
        "Sits out `delayMs` even after an abort, like an agent that doesn't stop when it's told to.",
      ),
    failWith: z
      .string()
      .optional()
      .describe('Throw before the first turn starts, to simulate an infra failure.'),
    startHangs: z
      .union([z.number(), z.literal(true)])
      .optional()
      .describe(
        'The first this many session starts of an attempt never become ready, even when aborted (`true`: every one).',
      ),
    reasoning: z.string().optional().describe('A reasoning block at the start of every turn.'),
    servedModel: z
      .string()
      .optional()
      .describe(
        'The model the fake agent says served each turn, as a real harness reports its resolved model and variant (`composer-2.5[fast=true]`); unset, it reports none.',
      ),
    effort: effort(
      'Requested reasoning effort, recorded as `effort` on the cell. Use `servedModel` for what the turn reports (`fake-1[effort=medium]`). Fast is not this.',
    ),
    tools: z
      .array(
        z.strictObject({
          tool: z.string(),
          input: z.unknown(),
          output: z.unknown(),
          ok: z.boolean().optional(),
        }),
      )
      .optional()
      .describe('Tool calls the fake agent reports on every turn, before writing files.'),
    withSkill: z
      .strictObject({
        files: z.record(z.string(), z.string()).optional(),
        text: z.string().optional(),
      })
      .optional()
      .describe('Files and message used instead when the environment gives the agent a skill.'),
    flakeRate: z
      .number()
      .optional()
      .describe('Chance (0–1) that an attempt writes no files and says so, for flaky pass rates.'),
    script: z
      .array(z.array(fakeScriptStepSchema))
      .optional()
      .describe(
        "Real sandbox actions, one list per `c.send` (the last list repeats), run in order before `files`. `exec` runs as the agent: with the sandbox's own variables, none of the checks'.",
      ),
    maxConcurrent: maxConcurrent('The most attempts on this harness kind at once, across the run.'),
    startTimeout: startTimeout(),
    layout: z
      .enum(FAKE_LAYOUTS)
      .optional()
      .describe(
        "Behave like this agent: its image, and where it reads rules and skills (`CLAUDE.md` and `.claude/skills` for `claude-code`, `~/.gemini/config/skills` for `antigravity`, `~/.config/opencode/skills` for `opencode`, Goose's private home for `goose`, `~/.pi/agent/skills` for `pi`, `~/.agents/skills` for `codex`, fx's private home for `fx`, Grok's private home for `grok-build`). Defaults to the fake's own (`AGENTS.md`, `.agents/skills`) in Cursor's image.",
      ),
  })
  .describe('A canned agent for tests and dry runs, made by `fakeHarness()` in `reeval/harness`.')

const SCHEMAS = {
  fake: fakeHarnessSchema,
  cursor: cursorHarnessSchema,
  'claude-code': claudeCodeHarnessSchema,
  antigravity: antigravityHarnessSchema,
  opencode: opencodeHarnessSchema,
  goose: gooseHarnessSchema,
  pi: piHarnessSchema,
  codex: codexHarnessSchema,
  fx: fxHarnessSchema,
  'grok-build': grokBuildHarnessSchema,
} as const

export const harnessDescriptorSchema = z
  .discriminatedUnion('kind', [
    fakeHarnessSchema,
    cursorHarnessSchema,
    claudeCodeHarnessSchema,
    antigravityHarnessSchema,
    opencodeHarnessSchema,
    gooseHarnessSchema,
    piHarnessSchema,
    codexHarnessSchema,
    fxHarnessSchema,
    grokBuildHarnessSchema,
  ])
  .describe('The agent an attempt runs: a real harness, or the fake one.')

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof cursorHarnessSchema>, CursorHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof cursorHarnessSchema>, keyof CursorHarnessDescriptor>>,
  Assert<Same<z.infer<typeof claudeCodeHarnessSchema>, ClaudeCodeHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof claudeCodeHarnessSchema>, keyof ClaudeCodeHarnessDescriptor>>,
  Assert<Same<z.infer<typeof antigravityHarnessSchema>, AntigravityHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof antigravityHarnessSchema>, keyof AntigravityHarnessDescriptor>>,
  Assert<Same<z.infer<typeof opencodeHarnessSchema>, OpenCodeHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof opencodeHarnessSchema>, keyof OpenCodeHarnessDescriptor>>,
  Assert<Same<z.infer<typeof gooseHarnessSchema>, GooseHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof gooseHarnessSchema>, keyof GooseHarnessDescriptor>>,
  Assert<Same<z.infer<typeof piHarnessSchema>, PiHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof piHarnessSchema>, keyof PiHarnessDescriptor>>,
  Assert<Same<z.infer<typeof codexHarnessSchema>, CodexHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof codexHarnessSchema>, keyof CodexHarnessDescriptor>>,
  Assert<Same<z.infer<typeof fxHarnessSchema>, FxHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof fxHarnessSchema>, keyof FxHarnessDescriptor>>,
  Assert<Same<z.infer<typeof grokBuildHarnessSchema>, GrokBuildHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof grokBuildHarnessSchema>, keyof GrokBuildHarnessDescriptor>>,
  Assert<Same<z.infer<typeof fakeHarnessSchema>, FakeHarnessDescriptor>>,
  Assert<Same<keyof z.infer<typeof fakeHarnessSchema>, keyof FakeHarnessDescriptor>>,
  Assert<Same<z.infer<typeof fakeScriptStepSchema>, FakeScriptStep>>,
  Assert<Same<z.infer<typeof harnessDescriptorSchema>, HarnessDescriptor>>,
]

/** The factory in `reeval/harness` that makes each kind, as messages name it. */
export const FACTORY: Record<HarnessDescriptor['kind'], string> = {
  fake: 'fakeHarness',
  cursor: 'cursor',
  'claude-code': 'claudeCode',
  antigravity: 'antigravity',
  opencode: 'opencode',
  goose: 'goose',
  pi: 'pi',
  codex: 'codex',
  fx: 'fx',
  'grok-build': 'grokBuild',
}

const MODEL: Partial<Record<HarnessDescriptor['kind'], (v: unknown) => string>> = {
  cursor: () => "cursor() needs a model, e.g. cursor({ model: 'composer-2.5' })",
  'claude-code': () => "claudeCode() needs a model, e.g. claudeCode({ model: 'claude-sonnet-5' })",
  antigravity: () =>
    "antigravity() needs a model, e.g. antigravity({ model: 'gemini-3.8-flash-medium' })",
  opencode: (v) =>
    `opencode(): needs a model, <provider>/<model>, e.g. opencode({ model: 'google/gemini-3.8-flash' }) (got ${got(v)})`,
  goose: (v) =>
    `goose() needs a Gemini model id, without a provider, since it runs on a Gemini API key, e.g. goose({ model: 'gemini-3.8-flash' }) (got ${got(v)})`,
  pi: (v) =>
    `pi() needs a Gemini model id, without a provider, since it runs on a Gemini API key, e.g. pi({ model: 'gemini-3.8-flash' }) (got ${got(v)})`,
  codex: (v) =>
    `codex() needs an OpenAI model id, without a provider, since it runs on an OpenAI API key, e.g. codex({ model: 'gpt-5.6-luna' }) (got ${got(v)})`,
  fx: (v) =>
    `fx() needs a model: a Vercel AI Gateway id, e.g. fx({ model: 'anthropic/claude-sonnet-5' }), or a bare OpenAI id, e.g. fx({ model: 'gpt-4.1' }) (got ${got(v)})`,
  'grok-build': (v) =>
    `grokBuild() needs an xAI model id, without a provider, since it runs on an xAI API key, e.g. grokBuild({ model: 'grok-4.6' }) (got ${got(v)})`,
}

const SCRIPT_EXAMPLE = "script: [[{ exec: 'cat notes.txt' }, { reply: 'done' }]]"

/** The order the factories have always checked in, so the first refusal stays the same. */
const ORDER = ['kind', 'model', 'params', 'effort', 'script', 'layout']

function explain(kind: HarnessDescriptor['kind']) {
  const factory = FACTORY[kind]
  return (issue: Issue, value: unknown): string => {
    const options = value as Record<string, unknown>
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
      const key = issue.keys[0] as string
      const near = closest(key, Object.keys(SCHEMAS[kind].shape))
      return `Unknown ${factory}() option "${key}".${near ? ` Did you mean "${near}"?` : ''}`
    }
    const [key, turn, step] = issue.path as [string, number?, number?]
    const v = options[key]
    if (key === 'model') return (MODEL[kind] as (v: unknown) => string)(v)
    if (key === 'effort') {
      if (kind === 'claude-code' && typeof v === 'string' && v.trim()) {
        return `claudeCode({ effort }) must be low, medium, high, xhigh or max (got ${got(v)})`
      }
      return `${factory}({ effort }) is the value that CLI takes, e.g. ${factory}({ effort: 'high' }) (got ${got(v)})`
    }
    if (key === 'params') {
      return `cursor({ params }) maps parameter ids to string values, e.g. { fast: 'false' } (got ${got(v)})`
    }
    if (key === 'script') {
      if (step === undefined) {
        return `fakeHarness({ script }) takes one list of steps per turn, e.g. ${SCRIPT_EXAMPLE} (got ${got(v)})`
      }
      const at = (v as unknown[][])[turn as number]?.[step]
      return `fakeHarness({ script }) steps are { exec: string }, { write: { path: content } }, { reply: string }, { mcp: '<server>/<tool>' } or { error: string } (got ${got(at)})`
    }
    if (key === 'layout') {
      return `fakeHarness({ layout }) is one of ${FAKE_LAYOUTS.map((l) => `'${l}'`).join(', ')} (got ${got(v)})`
    }
    if (key === 'id') return `${factory}({ id }) must be a non-empty string (got ${got(v)})`
    return genericProblem(factory, issue, value)
  }
}

/**
 * What's wrong with a harness descriptor of a known kind, in the words its factory uses, or
 * undefined. `maxConcurrent` and `startTimeout` are left to the check that names where they were
 * set.
 */
export function harnessProblem(value: HarnessDescriptor): string | undefined {
  return refusal(SCHEMAS[value.kind], value, explain(value.kind), {
    order: ORDER,
    skip: ['maxConcurrent', 'startTimeout'],
  })
}
