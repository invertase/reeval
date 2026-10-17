// The attempt protocol's contract: the calls an eval's body makes on its attempt (`c.send`,
// `c.exec`, `c.readFile`, `c.writeFile` and each matcher), as a runner in another language would
// send them to reeval, and reeval's replies. Today an eval's body runs in reeval's own worker, so
// no call crosses a process boundary yet; the schemas are the spec such a runner codes against,
// with their JSON Schema in schema/protocol/. Results reuse the attempt's own types (`TurnData`,
// `ExecResult`, `AssertionRecord`), held to them at compile time and by their TSDoc.
import { z } from 'zod'
import type {
  AssertionRecord,
  Capture,
  CaptureWindow,
  Diff,
  ExecResult,
  FileChange,
  JudgeArtifactRef,
  JudgeFailure,
  TokenUsage,
  TranscriptEvent,
  TurnData,
  TurnStatus,
  Verdict,
  WebEventType,
} from '../types.ts'
import {
  fakeJudgeDataSchema,
  judgeFields,
  judgeModelNameSchema,
  judgeStateSchema,
} from './judge.ts'
import { type Assert, dataProblem, jsonValueSchema, type Same } from './shared.ts'

const nullableNumber = z.number().nullable()

export const tokenUsageSchema = z
  .strictObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    reasoning: nullableNumber,
  })
  .describe(
    'The tokens one turn used, as its harness reported them. `input` excludes cache reads and writes (so the prompt was `input + cacheRead + cacheWrite`); `reasoning` is part of `output`.',
  )

export const fileChangeSchema = z.strictObject({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
})

export const diffSchema = z.strictObject({
  patch: z.string(),
  files: z.array(fileChangeSchema),
})

export const turnStatusSchema = z.enum(['completed', 'aborted', 'error'])

export const webEventTypeSchema = z
  .enum(['web-search', 'web-fetch'])
  .describe('The transcript events a harness may be unable to report.')

const at = { ts: z.string(), atMs: z.number() }

export const transcriptEventSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...at,
      type: z.enum(['text', 'reasoning']),
      text: z.string(),
      durationMs: nullableNumber,
    }),
    z.strictObject({
      ...at,
      type: z.literal('file-edit'),
      toolCallId: z.string(),
      path: z.string(),
      kind: z.enum(['create', 'modify', 'delete']),
      added: nullableNumber.describe(
        "Line counts, or null when the harness didn't send the content (e.g. deletes).",
      ),
      removed: nullableNumber,
      durationMs: nullableNumber,
    }),
    z.strictObject({
      ...at,
      type: z.literal('web-search'),
      toolCallId: z.string(),
      query: z.string(),
      references: nullableNumber.describe(
        'How many sources the harness says it used; Cursor sends no URLs or titles.',
      ),
      ok: z.boolean().optional().describe('Whether the search succeeded. Absent means it did.'),
      durationMs: nullableNumber,
    }),
    z.strictObject({
      ...at,
      type: z.literal('web-fetch'),
      toolCallId: z.string(),
      url: z.string(),
      ok: z.boolean(),
      durationMs: nullableNumber,
    }),
    z.strictObject({
      ...at,
      type: z.literal('tool'),
      toolCallId: z.string(),
      tool: z.string(),
      input: z.unknown(),
      output: z.unknown(),
      ok: z.boolean(),
      durationMs: nullableNumber,
    }),
    z.strictObject({ ...at, type: z.literal('error'), message: z.string() }),
    z.strictObject({ ...at, type: z.literal('retry'), message: z.string() }),
  ])
  .describe(
    'Normalised agent events. Each tool call is one event, merged with its result; `durationMs` is null when the harness never reported the end.',
  )

export const turnDataSchema = z
  .strictObject({
    prompt: z.string(),
    text: z.string().describe("The agent's final message for this turn."),
    status: turnStatusSchema,
    startedAt: z.string(),
    durationMs: z.number(),
    transcript: z.array(transcriptEventSchema),
    usage: tokenUsageSchema
      .nullable()
      .describe('Tokens the turn used; null when the harness reports none.'),
    model: z
      .string()
      .nullable()
      .describe(
        'The model the harness says served the turn, e.g. `composer-2.5[fast=false]`; null when it reports none. It can differ from the requested one (an alias, or parameters it filled in).',
      ),
    unreported: z
      .array(webEventTypeSchema)
      .describe(
        "Event types the harness couldn't report for this turn: the agent may have searched or fetched with no event in `transcript`. `toHaveSearched()` and `toHaveFetched()` refuse such a turn. Usually `[]`; a Cursor turn whose web calls the adapter couldn't recover (its SDK drops them from the stream) is `['web-search', 'web-fetch']`.",
      ),
    diff: diffSchema.describe(
      'Workspace changes since the eval started, as of the end of this turn.',
    ),
  })
  .describe(
    "A turn as data, as a record or another language's runner carries it: `Turn` without its methods.",
  )

export const execResultSchema = z.strictObject({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
})

export const assertionRecordSchema = z
  .strictObject({
    label: z
      .string()
      .describe(
        "`expect`'s second argument, or `<matcher> <first argument>` (or the command `c.exec` ran, or the judge's question), cut at 60 characters; ` #2`, ` #3` on repeats within the attempt.",
      ),
    labelled: z.boolean().describe('The eval gave the label.'),
    matcher: z.string().describe('`toHaveFile`, `not.toBe`, `resolves.toBe`, `poll.toBe`.'),
    status: z
      .enum(['pass', 'fail', 'error'])
      .describe(
        "`error`: the matcher couldn't answer (a subject it can't read, an event the harness doesn't report).",
      ),
    soft: z.boolean(),
    message: z.string().optional().describe("Why it failed or couldn't answer, cut at 1 KB."),
    durationMs: z
      .number()
      .optional()
      .describe('Async matchers only (`toHaveFile`, `toSucceed`, `.resolves`, `expect.poll`).'),
  })
  .describe('One `expect` or `expect.soft` matcher call an attempt made.')

export const captureWindowSchema = z
  .strictObject({
    width: z.number().describe('In CSS pixels.'),
    height: z.number().describe('In CSS pixels.'),
  })
  .describe(
    'Live tab size for `c.capture()`. Default 1280×720 when the call and cascade omit `viewport`.',
  )

export const captureSchema = z
  .strictObject({
    name: z.string(),
    port: z.number().describe('Container port that was tunneled.'),
    path: z.string().describe('Path on the app, as passed in.'),
    viewport: z
      .union([captureWindowSchema, z.literal('full-page')])
      .describe("What the author asked, including `'full-page'`."),
    file: z
      .strictObject({ path: z.string(), sha256: z.string(), bytes: z.number() })
      .describe('`artifacts/<name>.png` under the attempt directory.'),
  })
  .describe('What `c.capture()` returns: the PNG is also in the attempt record under `artifacts/`.')

export const judgeArtifactRefSchema = z
  .strictObject({
    name: z.string(),
    path: z.string().describe('`artifacts/<name>.png` under the attempt directory.'),
    sha256: z.string(),
    bytes: z.number(),
    mediaType: z.literal('image/png'),
  })
  .describe('A capture this judge call sent as a file part. Bytes live in `artifacts/<name>.png`.')

const verdictFields = {
  threshold: z.number(),
  question: z.string(),
  model: z.string(),
  artifacts: z
    .array(judgeArtifactRefSchema)
    .optional()
    .describe('Captures this call sent the judge as file parts, when any.'),
}

export const verdictSchema = z.strictObject({
  verdict: z.enum(['pass', 'fail']),
  score: z.number().describe("The judge's probability that the answer is yes, from 0 to 1."),
  ...verdictFields,
  resolvedModel: z
    .string()
    .optional()
    .describe('The model id the provider says served the call, when it reports one.'),
})

export const judgeFailureSchema = z
  .strictObject({
    verdict: z.literal('error'),
    score: z.null(),
    ...verdictFields,
    error: z.string(),
  })
  .describe(
    "What `c.judge()` returns when the call failed (the provider's error, after any retries): the attempt fails as a judge error once the eval's body has finished, so the judges and checks after it still run.",
  )

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof captureWindowSchema>, CaptureWindow>>,
  Assert<Same<z.infer<typeof captureSchema>, Capture>>,
  Assert<Same<z.infer<typeof judgeArtifactRefSchema>, JudgeArtifactRef>>,
  Assert<Same<z.infer<typeof verdictSchema>, Verdict>>,
  Assert<Same<z.infer<typeof judgeFailureSchema>, JudgeFailure>>,
  Assert<Same<z.infer<typeof tokenUsageSchema>, TokenUsage>>,
  Assert<Same<z.infer<typeof fileChangeSchema>, FileChange>>,
  Assert<Same<z.infer<typeof diffSchema>, Diff>>,
  Assert<Same<z.infer<typeof turnStatusSchema>, TurnStatus>>,
  Assert<Same<z.infer<typeof webEventTypeSchema>, WebEventType>>,
  Assert<Same<z.infer<typeof transcriptEventSchema>, TranscriptEvent>>,
  Assert<Same<z.infer<typeof turnDataSchema>, TurnData>>,
  Assert<Same<z.infer<typeof execResultSchema>, ExecResult>>,
  Assert<Same<z.infer<typeof assertionRecordSchema>, AssertionRecord>>,
]

/** A pattern, for the matchers that take a string or a `RegExp`. */
export const patternSchema = z
  .strictObject({
    regexp: z.string().describe("The pattern's source, as `RegExp.prototype.source` gives it."),
    flags: z
      .string()
      .regex(/^[dgimsuvy]*$/, 'only the flags d, g, i, m, s, u, v and y')
      .optional()
      .describe('Its flags, e.g. `i`.'),
  })
  .describe('A regular expression, where a matcher takes a string or a `RegExp`.')

const isPatternLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'regexp' in value

// Any object is a JSON value, so an object with `regexp` is held to the pattern's shape here.
export const matcherArgSchema = z
  .union([patternSchema, jsonValueSchema])
  .superRefine((value, ctx) => {
    if (!isPatternLike(value)) return
    for (const issue of patternSchema.safeParse(value).error?.issues ?? []) {
      ctx.addIssue(issue as never)
    }
  })
  .describe(
    'One argument to a matcher: a JSON value, or a regular expression as `{ regexp, flags? }`.',
  )

export const matcherSubjectSchema = z
  .union([
    z.strictObject({ turn: z.number().int().min(0).describe("The turn's index, from 0.") }),
    z.strictObject({ attempt: z.literal(true).describe('The attempt itself, `c`.') }),
    z.strictObject({ value: jsonValueSchema.describe('A value the eval passes as it is.') }),
  ])
  .describe(
    'What `expect` was given: a turn `c.send` returned, the attempt (for its files and latest turn), or a value, such as an `ExecResult`.',
  )

const nonEmpty = z.string().regex(/\S/, 'must not be empty')

export const judgeCallDataSchema = z
  .strictObject({
    model: z
      .union([judgeModelNameSchema, fakeJudgeDataSchema])
      .optional()
      .describe("`'provider/model'`, or a fake judge with a numeric score."),
    ...judgeFields,
    on: z
      .union([
        z.strictObject({ turn: z.number().int().min(0).describe("The turn's index, from 0.") }),
        z.strictObject({ value: jsonValueSchema.describe('Graded as the output.') }),
      ])
      .optional()
      .describe('What to grade instead of the latest turn: an earlier turn, or a value.'),
    artifacts: z
      .array(z.union([nonEmpty, captureSchema]))
      .optional()
      .describe(
        'Captures this call sends the judge as image file parts: a capture `c.capture` returned, or its name. The provider that cannot take files fails the call.',
      ),
  })
  .describe(
    "`c.judge()`'s options as data: the judge options, with the model by name or a fake judge's numeric score, plus the call-only `on` and `artifacts`.",
  )

export const attemptCallSchema = z
  .discriminatedUnion('op', [
    z
      .strictObject({ op: z.literal('send'), prompt: z.string().describe("The turn's prompt.") })
      .describe('`c.send(prompt)`: the next turn of the agent session. Replies with a turn.'),
    z
      .strictObject({
        op: z.literal('exec'),
        command: nonEmpty.describe('A shell command, run in the workspace.'),
      })
      .describe(
        '`c.exec(command)`: a command in the sandbox. Replies with its exit code and output.',
      ),
    z
      .strictObject({
        op: z.literal('readFile'),
        path: nonEmpty.describe('Workspace-relative, or `~/` for the home directory.'),
      })
      .describe(
        '`c.readFile(path)`. Replies with its contents, or null when there is no such file.',
      ),
    z
      .strictObject({
        op: z.literal('writeFile'),
        path: nonEmpty.describe('Workspace-relative, or `~/` for the home directory.'),
        contents: z.string().describe("The file's contents, in `encoding`."),
        encoding: z
          .enum(['utf8', 'base64'])
          .optional()
          .describe('How `contents` is encoded; base64 carries bytes. Default `utf8`.'),
      })
      .describe('`c.writeFile(path, contents)`, creating its directories.'),
    z
      .strictObject({
        op: z.literal('expect'),
        subject: matcherSubjectSchema,
        matcher: z
          .string()
          .regex(
            /^[a-z][A-Za-z]*$/,
            'a matcher name such as toHaveFile, without "not." (set not: true instead)',
          )
          .describe("The matcher's name, e.g. `toHaveFile` or `toBe`, without `not.`."),
        args: z.array(matcherArgSchema).describe("The matcher's arguments."),
        not: z.boolean().describe('Called as `expect(…).not`.'),
        soft: z
          .boolean()
          .describe('Called as `expect.soft`: a failure fails the attempt at its end.'),
        label: z.string().optional().describe("`expect`'s second argument."),
      })
      .describe(
        'A matcher call: `expect(subject, label).not?.matcher(...args)`. Replies with its record.',
      ),
    z
      .strictObject({
        op: z.literal('judge'),
        question: nonEmpty.describe('A yes/no question about the graded turn or value.'),
        options: judgeCallDataSchema.optional(),
      })
      .describe(
        '`c.judge(question, options)`. Replies with its verdict, or a judge failure when the provider failed.',
      ),
    z
      .strictObject({ op: z.literal('sandbox') })
      .describe('`c.sandbox()`: starts the sandbox and the agent session without a turn.'),
  ])
  .describe("One call an eval's body makes on its attempt.")

export const attemptErrorSchema = z
  .looseObject({
    name: z.string().describe("The error's class, e.g. `UsageError` or `AssertionError`."),
    message: z.string(),
  })
  .describe("Why a call failed, in reeval's words.")

const id = nonEmpty.describe('Pairs a reply with its request.')

export const attemptRequestSchema = z
  .strictObject({ id, call: attemptCallSchema })
  .describe('A call, numbered so its reply can find it.')

export const attemptReplySchema = z
  .union([
    z.discriminatedUnion('op', [
      z.strictObject({ id, ok: z.literal(true), op: z.literal('send'), turn: turnDataSchema }),
      z.strictObject({ id, ok: z.literal(true), op: z.literal('exec'), result: execResultSchema }),
      z.strictObject({
        id,
        ok: z.literal(true),
        op: z.literal('readFile'),
        contents: z.string().nullable().describe('Null when there is no such file.'),
      }),
      z.strictObject({ id, ok: z.literal(true), op: z.literal('writeFile') }),
      z.strictObject({
        id,
        ok: z.literal(true),
        op: z.literal('expect'),
        assertion: assertionRecordSchema,
      }),
      z.strictObject({
        id,
        ok: z.literal(true),
        op: z.literal('judge'),
        verdict: z.union([verdictSchema, judgeFailureSchema]),
      }),
      z.strictObject({ id, ok: z.literal(true), op: z.literal('sandbox') }),
    ]),
    z.strictObject({
      id,
      ok: z.literal(false),
      op: z.enum(['send', 'exec', 'readFile', 'writeFile', 'expect', 'judge', 'sandbox']),
      error: attemptErrorSchema,
    }),
  ])
  .describe(
    "reeval's reply to a call: its result, or the error it threw. A failed matcher is a result (its record says `fail`), not an error, unless the matcher couldn't run.",
  )

const CALL_KEYS = Object.fromEntries(
  attemptCallSchema.options.map((o) => [o.shape.op.value, Object.keys(o.shape)]),
)
const OTHER_KEYS = [
  'id',
  'call',
  'turn',
  'attempt',
  'value',
  'regexp',
  'flags',
  ...Object.keys(judgeCallDataSchema.shape),
  ...Object.keys(judgeStateSchema.shape),
  ...Object.keys(captureSchema.shape),
]

/** What's wrong with an attempt request a runner sent, by the field's path, or undefined. */
export const attemptRequestProblem = (value: unknown): string | undefined =>
  dataProblem(attemptRequestSchema, value, 'The attempt request', (object) =>
    typeof object.op === 'string' ? (CALL_KEYS[object.op] ?? []) : OTHER_KEYS,
  )

export type AttemptCall = z.infer<typeof attemptCallSchema>
export type AttemptRequest = z.infer<typeof attemptRequestSchema>
export type AttemptReply = z.infer<typeof attemptReplySchema>

/** The protocol's named schemas, by their `$def` name in schema/protocol/. */
export const ATTEMPT_SCHEMAS: Record<string, z.ZodType> = {
  AttemptRequest: attemptRequestSchema,
  AttemptCall: attemptCallSchema,
  AttemptReply: attemptReplySchema,
  AttemptError: attemptErrorSchema,
  MatcherSubject: matcherSubjectSchema,
  MatcherArg: matcherArgSchema,
  Pattern: patternSchema,
  JSONValue: jsonValueSchema,
  TurnData: turnDataSchema,
  TurnStatus: turnStatusSchema,
  TranscriptEvent: transcriptEventSchema,
  TokenUsage: tokenUsageSchema,
  WebEventType: webEventTypeSchema,
  Diff: diffSchema,
  FileChange: fileChangeSchema,
  ExecResult: execResultSchema,
  AssertionRecord: assertionRecordSchema,
  JudgeCallData: judgeCallDataSchema,
  JudgeStateOptions: judgeStateSchema,
  FakeJudgeData: fakeJudgeDataSchema,
  Verdict: verdictSchema,
  JudgeFailure: judgeFailureSchema,
  JudgeArtifactRef: judgeArtifactRefSchema,
  Capture: captureSchema,
  CaptureWindow: captureWindowSchema,
}

/** The schemas `ATTEMPT_SCHEMAS` shares with a hand-written type in src/types.ts, by its name. */
export const ATTEMPT_TYPES = [
  'TurnData',
  'TurnStatus',
  'TranscriptEvent',
  'TokenUsage',
  'WebEventType',
  'Diff',
  'FileChange',
  'ExecResult',
  'AssertionRecord',
  'JudgeStateOptions',
  'FakeJudgeData',
  'Verdict',
  'JudgeFailure',
  'JudgeArtifactRef',
  'Capture',
  'CaptureWindow',
] as const
