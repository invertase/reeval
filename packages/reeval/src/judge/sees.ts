import { z } from 'zod'
import type { JudgeOptions, JudgeSees, ResolvedJudgeSees } from '../types.ts'

const pattern = z.string().refine((s) => s.trim().length > 0)

/** `JudgeSees` as data: the same shape for a config object, a declaration tree or another language. */
export const judgeSeesSchema = z.strictObject({
  task: z.boolean().optional().describe("The graded turn's prompt. Default true."),
  output: z
    .boolean()
    .optional()
    .describe("The graded turn's final message, or `on`'s value. Default true."),
  files: z
    .boolean()
    .optional()
    .describe('`status path` lines for the changed files. Default true.'),
  diff: z
    .union([z.boolean(), z.array(pattern).min(1)])
    .optional()
    .describe(
      'The diff since the eval started, or gitignore-style patterns over it. Default true.',
    ),
  contents: z
    .array(pattern)
    .optional()
    .describe(
      'Workspace files shown whole: exact paths or gitignore-style patterns. Default none.',
    ),
  transcript: z
    .union([z.boolean(), z.enum(['tools', 'full'])])
    .optional()
    .describe("The graded turn's transcript: true, 'tools' or 'full'. Default false."),
  turns: z
    .enum(['last', 'all'])
    .optional()
    .describe("'all': every turn up to the graded one. Default 'last'."),
  checks: z
    .union([z.boolean(), z.array(pattern)])
    .optional()
    .describe('`c.exec` results so far, or only the commands listed. Default false.'),
})

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type _SameAsSchema = [
  Assert<Same<z.infer<typeof judgeSeesSchema>, JudgeSees>>,
  Assert<Same<keyof z.infer<typeof judgeSeesSchema>, keyof JudgeSees>>,
]

export const SEES_KEYS = Object.keys(judgeSeesSchema.shape) as Array<keyof JudgeSees>

export const DEFAULT_SEES: ResolvedJudgeSees = {
  task: true,
  output: true,
  files: true,
  diff: true,
  contents: [],
  transcript: false,
  turns: 'last',
  checks: false,
}

/** Every key set, in `SEES_KEYS` order, so equal selections serialise the same. */
export function resolveSees(sees: JudgeSees | undefined): ResolvedJudgeSees {
  const out = {} as Record<keyof JudgeSees, unknown>
  for (const key of SEES_KEYS) out[key] = sees?.[key] ?? DEFAULT_SEES[key]
  return out as ResolvedJudgeSees
}

/** `inner` over `outer`, field by field, and `sees` key by key. */
export function mergeJudge<T extends JudgeOptions>(outer: T, inner: Partial<T> | undefined): T {
  if (!inner) return outer
  const out = { ...outer, ...inner }
  if (outer.sees || inner.sees) out.sees = { ...outer.sees, ...inner.sees }
  return out
}

const JUDGE_KEYS = ['model', 'threshold', 'providerOptions', 'maxConcurrent', 'sees']
const CALL_KEYS = [...JUDGE_KEYS, 'on', 'artifacts']

const JUDGE_HINTS: Record<string, string> = {
  include: 'sees.diff',
  exclude: 'sees.diff',
  files: 'sees.contents',
  contents: 'sees.contents',
  transcript: 'sees.transcript',
  see: 'sees',
  shows: 'sees',
  show: 'sees',
  input: 'sees',
}

const VALUES: Record<keyof JudgeSees, string> = {
  task: 'true or false',
  output: 'true or false',
  files: 'true or false',
  diff: 'true, false or a non-empty list of patterns',
  contents: 'a list of paths or patterns',
  transcript: "true, false, 'tools' or 'full'",
  turns: "'last' or 'all'",
  checks: 'true, false or a list of commands',
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const here = row[j] ?? 0
      row[j] = Math.min(here + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = here
    }
  }
  return row[b.length] ?? 0
}

const nearest = (key: string, keys: readonly string[]) =>
  keys.find((k) => distance(key.toLowerCase(), k.toLowerCase()) <= 2)

const shown = (value: unknown) => JSON.stringify(value) ?? String(value)

/**
 * The first problem with a judge options object's own keys and its `sees`, as a sentence ending
 * in `loc` (e.g. ` in evals/a.eval.ts › lands`), or undefined. `call` allows `on` and `artifacts`.
 */
export function judgeProblem(judge: object, loc: string, call = false): string | undefined {
  const allowed = call ? CALL_KEYS : JUDGE_KEYS
  for (const key of Object.keys(judge)) {
    if (allowed.includes(key)) continue
    const hint = JUDGE_HINTS[key] ?? nearest(key, allowed)
    const why =
      !call && (key === 'on' || key === 'artifacts')
        ? ` ${key} is per call: c.judge(question, { ${key} }).`
        : hint
          ? ` Did you mean "${hint}"?`
          : ''
    return `Unknown judge option "${key}"${loc}.${why}`
  }
  const { sees } = judge as JudgeOptions
  if (sees === undefined) return undefined
  if (typeof sees !== 'object' || sees === null || Array.isArray(sees)) {
    return `judge.sees must be an object such as { transcript: 'tools' } (got ${shown(sees)})${loc}`
  }
  const parsed = judgeSeesSchema.safeParse(sees)
  if (parsed.success) return undefined
  const issue = parsed.error.issues[0]
  if (issue?.code === 'unrecognized_keys') {
    const key = issue.keys[0] ?? ''
    const hint = nearest(key, SEES_KEYS)
    return `Unknown judge.sees key "${key}"${loc}.${hint ? ` Did you mean "${hint}"?` : ''}`
  }
  const key = issue?.path[0] as keyof JudgeSees
  return `judge.sees.${key} must be ${VALUES[key]} (got ${shown((sees as JudgeSees)[key])})${loc}`
}
