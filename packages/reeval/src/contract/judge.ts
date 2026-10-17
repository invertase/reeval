// The judge's `state` option as plain data: what the judge is given beside the question, the same
// shape in a config object, a declaration tree or another language. The rest of the judge options
// (a model object, provider options) aren't plain data, so src/judge/state-options.ts checks them.
import { z } from 'zod'
import type { JudgeStateOptions } from '../types.ts'
import { type Assert, nonEmpty, type Same } from './shared.ts'

export const judgeStateSchema = z
  .strictObject({
    task: z.boolean().optional().describe("The graded turn's prompt. Default true."),
    output: z
      .boolean()
      .optional()
      .describe("The graded turn's final message, or `on`'s value. Default true."),
    files: z
      .boolean()
      .optional()
      .describe(
        "`status path` lines for the changed files, under `diff`'s patterns. Default true.",
      ),
    diff: z
      .union([z.boolean(), z.array(nonEmpty()).min(1)])
      .optional()
      .describe(
        'The diff since the eval started. A list is gitignore-style patterns over workspace paths: the last matching pattern wins and `!` excludes. Default true.',
      ),
    contents: z
      .array(nonEmpty())
      .optional()
      .describe(
        "Workspace files shown whole, as they are now, changed or not: exact paths or gitignore-style patterns (`'**'`, `'src/**'`; the last match wins, `!` excludes) over the files git sees in the workspace. A missing exact path is `null`; a pattern that matches nothing adds nothing. These files leave the diff. Default none.",
      ),
    transcript: z
      .union([z.boolean(), z.enum(['tools', 'full'])])
      .optional()
      .describe(
        "The graded turn's transcript as text lines: `true` is messages and tool calls with tool output clipped, `'tools'` tool calls only, `'full'` adds reasoning and whole tool output. Default false.",
      ),
    turns: z
      .enum(['last', 'all'])
      .optional()
      .describe(
        "`'all'`: every turn up to the graded one under `turns`, each with its task, output and (with `transcript`) transcript. Default `'last'`.",
      ),
    checks: z
      .union([z.boolean(), z.array(nonEmpty())])
      .optional()
      .describe(
        '`c.exec` results so far; a list shows only those commands, as passed to `c.exec`. Default false.',
      ),
  })
  .describe(
    'What the judge is given: each key is a key of the state in `judge-input.json`. An unset key keeps its default, which is what the judge gets with no `state` option at all.',
  )

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof judgeStateSchema>, JudgeStateOptions>>,
  Assert<Same<keyof z.infer<typeof judgeStateSchema>, keyof JudgeStateOptions>>,
]
