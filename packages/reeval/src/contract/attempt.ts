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
  CaptureInstruction,
  CaptureWait,
  Cell,
  CellRole,
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
  Wait,
  WebEventType,
} from '../types.ts'
import { captureWindowSchema } from './config.ts'
import { gatewayNameSchema } from './gateway.ts'
import {
  fakeJudgeDataSchema,
  judgeFields,
  judgeModelNameSchema,
  judgeStateSchema,
} from './judge.ts'
import { type Assert, dataProblem, durationSchema, jsonValueSchema, type Same } from './shared.ts'

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
      stalled: z
        .boolean()
        .optional()
        .describe('True when a shell-like tool or edit ran at least two minutes.'),
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
      stalled: z
        .boolean()
        .optional()
        .describe('True when a shell-like tool or edit ran at least two minutes.'),
    }),
    z.strictObject({
      ...at,
      type: z.literal('web-fetch'),
      toolCallId: z.string(),
      url: z.string(),
      ok: z.boolean(),
      durationMs: nullableNumber,
      stalled: z
        .boolean()
        .optional()
        .describe('True when a shell-like tool or edit ran at least two minutes.'),
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
      stalled: z
        .boolean()
        .optional()
        .describe('True when a shell-like tool or edit ran at least two minutes.'),
    }),
    z.strictObject({ ...at, type: z.literal('error'), message: z.string() }),
    z.strictObject({ ...at, type: z.literal('retry'), message: z.string() }),
  ])
  .describe(
    "Normalised agent events. Each tool call is one event, merged with its result; `durationMs` is wall time until the result arrived (Cursor's own `completed_at_ms` can be earlier). Null when the harness never reported the end. Long shell or edit calls set `stalled: true`.",
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
  exitCode: z.number().int(),
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

const turnIndex = z
  .number()
  .int('must be a turn index, from 0')
  .min(0, 'must be a turn index, from 0')
  .describe("The turn's index, from 0.")

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
  gateway: gatewayNameSchema
    .optional()
    .describe(
      "The gateway from the config's `gateway` list the call went through; unset without one.",
    ),
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
  Assert<Same<z.infer<typeof captureWaitSchema>, CaptureWait>>,
  Assert<Same<z.infer<typeof waitSchema>, Wait>>,
  Assert<Same<z.infer<typeof captureInstructionSchema>, CaptureInstruction>>,
  Assert<Same<z.infer<typeof cellSchema>, Cell>>,
  Assert<Same<z.infer<typeof cellRoleSchema>, CellRole>>,
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
      .regex(/^[dgimsuvy]*$/, 'must use only the flags d, g, i, m, s, u, v and y')
      .optional()
      .describe('Its flags, e.g. `i`.'),
  })
  .describe('A regular expression, where a matcher takes a string or a `RegExp`.')

/** A pattern in the runner's own language, which reeval never compiles. */
function hasAnsweredPattern(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAnsweredPattern)
  if (typeof value !== 'object' || value === null) return false
  return 'matchedBy' in value || Object.values(value).some(hasAnsweredPattern)
}

export const answeredPatternSchema = z
  .strictObject({
    matchedBy: z
      .string()
      .regex(/\S/)
      .describe("The pattern as the runner's language writes it, e.g. `re.compile('npm t')`."),
    answers: z
      .record(z.string(), z.boolean())
      .describe('Whether it matches each string the runner has been asked about.'),
  })
  .describe(
    'A pattern the runner matches in its own language. reeval runs the matcher with it, and when the matcher tests a string not in `answers` replies with those strings (`untested`) instead of a record; the runner matches them and makes the call again with them in `answers`.',
  )

const isPatternLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'regexp' in value

// Any object is a JSON value, so an object with `regexp` is held to the pattern's shape here.
export const matcherArgSchema = z
  .union([patternSchema, answeredPatternSchema, jsonValueSchema])
  .superRefine((value, ctx) => {
    if (!isPatternLike(value)) return
    for (const issue of patternSchema.safeParse(value).error?.issues ?? []) {
      ctx.addIssue(issue as never)
    }
  })
  .describe(
    "One argument to a matcher: a JSON value, a regular expression as `{ regexp, flags? }`, or a pattern in the runner's own language as `{ matchedBy, answers }`.",
  )

export const matcherSubjectSchema = z
  .union([
    z.strictObject({ turn: turnIndex }),
    z.strictObject({ attempt: z.literal(true).describe('The attempt itself, `c`.') }),
    z.strictObject({ value: jsonValueSchema.describe('A value the eval passes as it is.') }),
    z.strictObject({
      exec: z
        .string()
        .regex(/\S/)
        .describe('A command reeval runs, for its `ExecResult`; again on each try when polled.'),
      result: execResultSchema
        .optional()
        .describe(
          "The command's `ExecResult` when the runner already ran it: reeval checks that instead of running it again, and the check is still named by the command.",
        ),
    }),
    z.strictObject({
      readFile: z
        .string()
        .regex(/\S/)
        .describe("A file reeval reads, for its contents (null when there's none)."),
    }),
  ])
  .describe(
    'What `expect` was given: a turn `c.send` returned, the attempt (for its files and latest turn), a value, such as an `ExecResult`, or a command or file reeval reads for it.',
  )

const nonEmpty = z.string().regex(/\S/, 'must not be empty')

const portSchema = z
  .number()
  .int()
  .min(1, 'a port from 1 to 65535')
  .max(65535, 'a port from 1 to 65535')
const millisSchema = z.number().positive('more than zero milliseconds')

export const captureWaitSchema = z
  .enum(['load', 'idle'])
  .describe(
    "Chromium look-ready events. `'load'` is `window` load (`Page.loadEventFired`). `'idle'` is `Page.lifecycleEvent` `networkAlmostIdle`.",
  )

export const waitSchema = z
  .union([captureWaitSchema, z.strictObject({ ms: millisSchema })])
  .describe('Same shape at top-level `wait` and `{ wait }` between instructions.')

export const captureInstructionSchema = z.union([nonEmpty, z.strictObject({ wait: waitSchema })])

export const captureCallDataSchema = z
  .strictObject({
    name: nonEmpty.optional(),
    path: z.string().optional(),
    viewport: z.union([captureWindowSchema, z.literal('full-page')]).optional(),
    timeout: durationSchema.optional(),
    wait: waitSchema
      .optional()
      .describe("Look-ready once, before the first model shot or the saved PNG. Default `'load'`."),
    instructions: z
      .array(captureInstructionSchema)
      .optional()
      .describe('Journey: goal strings and `{ wait }` beats, run by the vision model.'),
    model: z.string().optional().describe('Overrides cascaded `capture.model` for this call.'),
  })
  .describe(
    "`c.capture()`'s camera and path as data. Default `path` is `/`; default `name` is derived from the path. A test's `fakeInstructions` journey is TypeScript-only.",
  )

const handleId = nonEmpty.describe('A background process, as an exec or serve reply named it.')

const judgeOnSchema = z.union([
  z.strictObject({ turn: turnIndex }),
  z.strictObject({ value: jsonValueSchema.describe('Graded as the output.') }),
])

export const judgeCallDataSchema = z
  .strictObject({
    model: z
      .union([judgeModelNameSchema, fakeJudgeDataSchema])
      .optional()
      .describe("`'provider/model'`, or a fake judge with a numeric score."),
    ...judgeFields,
    on: judgeOnSchema
      .optional()
      .describe('What to grade instead of the latest turn: an earlier turn, or a value.'),
    artifacts: z
      .union([z.literal(true), z.array(z.union([nonEmpty, captureSchema]))])
      .optional()
      .describe(
        'Captures this call sends the judge as image file parts: a capture `c.capture` returned, or its name, or `true` for every capture so far. The provider that cannot take files fails the call.',
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
        background: z
          .boolean()
          .optional()
          .describe('Leave it running and reply with its handle, not its output.'),
      })
      .describe(
        '`c.exec(command, { background? })`: a command in the sandbox. Replies with its exit code and output, or with a handle when it runs in the background.',
      ),
    z
      .strictObject({
        op: z.literal('serve'),
        command: nonEmpty.describe('A shell command; `PORT` is set to the port.'),
        port: portSchema
          .optional()
          .describe('The container port. Omit it and reeval allocates one.'),
      })
      .describe('`c.serve(command, port?)`: a background process and its port.'),
    z
      .strictObject({ op: z.literal('kill'), handle: handleId })
      .describe("`handle.kill()`: stops a background process. Killing one that's gone is fine."),
    z
      .strictObject({
        op: z.literal('capture'),
        target: z
          .union([z.strictObject({ port: portSchema }), z.strictObject({ handle: handleId })])
          .describe('A container port, or a serve handle by its id.'),
        options: captureCallDataSchema.optional(),
      })
      .describe(
        '`c.capture(target, options)`: screenshots a path on a tunneled sandbox port and writes `artifacts/<name>.png`. Replies with the capture.',
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
            'must be a matcher name such as toHaveFile, without "not." (set not: true instead)',
          )
          .describe("The matcher's name, e.g. `toHaveFile` or `toBe`, without `not.`."),
        args: z.array(matcherArgSchema).describe("The matcher's arguments."),
        not: z.boolean().describe('Called as `expect(…).not`.'),
        soft: z
          .boolean()
          .describe('Called as `expect.soft`: a failure fails the attempt at its end.'),
        label: z.string().optional().describe("`expect`'s second argument."),
        poll: z
          .strictObject({
            interval: millisSchema.optional().describe('Milliseconds between tries. Default 50.'),
            timeout: millisSchema
              .optional()
              .describe('Milliseconds before it fails with the last error. Default 1000.'),
          })
          .optional()
          .describe(
            '`expect.poll`: reeval re-reads the subject and retries the matcher until it passes, recording only the final outcome. The subject must be one reeval can re-read: the attempt, a command or a file.',
          ),
      })
      .superRefine((call, ctx) => {
        if (call.poll && 'value' in call.subject) {
          ctx.addIssue({
            code: 'custom',
            path: ['subject'],
            message:
              "can't be polled: reeval can't re-read a value. Poll the attempt, an exec or a readFile",
          })
        }
        if (call.poll && 'exec' in call.subject && call.subject.result) {
          ctx.addIssue({
            code: 'custom',
            path: ['subject', 'result'],
            message: "can't be polled: drop result so reeval runs the command on each try",
          })
        }
        if (call.poll && call.args.some(hasAnsweredPattern)) {
          ctx.addIssue({
            code: 'custom',
            path: ['args'],
            message:
              "can't be polled with a { matchedBy } pattern, whose answers can't follow the subject from try to try: poll with a string, or check once",
          })
        }
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
  ])
  .describe(
    "One call an eval's body makes on its attempt. The sandbox and the agent session start on the first call that needs them; there's no call to start them.",
  )

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
      z.strictObject({
        id,
        ok: z.literal(true),
        op: z.literal('exec'),
        result: z.union([
          execResultSchema,
          z.strictObject({ handle: handleId }).describe('A background process, still running.'),
        ]),
      }),
      z.strictObject({
        id,
        ok: z.literal(true),
        op: z.literal('serve'),
        handle: handleId,
        port: z.number().describe('The container port it was given.'),
      }),
      z.strictObject({ id, ok: z.literal(true), op: z.literal('kill') }),
      z.strictObject({ id, ok: z.literal(true), op: z.literal('capture'), capture: captureSchema }),
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
    ]),
    z.strictObject({
      id,
      ok: z.literal(true),
      op: z.literal('expect'),
      untested: z
        .record(z.string(), z.array(z.string()))
        .describe(
          'The strings the matcher tested that a `{ matchedBy, answers }` argument has no answer for, by its `matchedBy`. Nothing was recorded: answer them and make the call again.',
        ),
    }),
    z.strictObject({
      id,
      ok: z.literal(false),
      op: z.enum([
        'send',
        'exec',
        'readFile',
        'writeFile',
        'expect',
        'judge',
        'serve',
        'kill',
        'capture',
      ]),
      error: attemptErrorSchema,
    }),
  ])
  .describe(
    "reeval's reply to a call: its result, or the error it threw. A failed matcher is a result (its record says `fail`), not an error, unless the matcher couldn't run.",
  )

export const cellRoleSchema = z.enum(['control', 'variant'])

export const cellSchema = z
  .strictObject({
    key: z.string(),
    harness: z.string(),
    environment: z
      .string()
      .describe(
        "The environment's own name, also on a variant cell (`with-house-greeting`, with no prefix).",
      ),
    sandbox: z.string(),
    role: cellRoleSchema,
    variant: z.string().optional().describe("The variant's name, for variant cells."),
  })
  .describe(
    "One cell of an eval: a harness, an environment (`-` when none is set) and that environment's image (`sandbox` id: tag, dockerfile and install). With `compare`, the control is `baseline` (or the cascaded environment, or an empty `baseline`) and each variant is that environment on its own, including its sandbox.",
  )

export const attemptStartSchema = z
  .strictObject({
    type: z.literal('start'),
    attempt: z
      .strictObject({
        id: nonEmpty,
        cell: cellSchema,
        n: z.number().int().min(1, 'a run number, from 1').describe('The run number, from 1.'),
      })
      .describe('`c.attempt`: which cell of the matrix this attempt is, and its run number.'),
    file: nonEmpty.describe('The eval file, relative to the project.'),
    body: nonEmpty.describe("The eval's `body`, as its declaration named it."),
  })
  .describe(
    "reeval to the runner: run this eval's body for this attempt. Nothing has started yet: the sandbox and the agent session start on the body's first call that needs them, so its own code runs first. The runner sends its calls, then `done`.",
  )

export const attemptAbortSchema = z
  .strictObject({
    type: z.literal('abort'),
    reason: z
      .enum(['timeout', 'cancelled'])
      .describe("`timeout`: the eval's `timeout` ran out. `cancelled`: the run was stopped."),
    message: z.string().describe("reeval's sentence, e.g. `Eval timed out after 600s`."),
  })
  .describe(
    'reeval to the runner: the attempt was aborted, as `c.signal` aborts. Calls in flight reply with errors; the runner should stop the body and send `done`.',
  )

export const attemptDoneSchema = z
  .strictObject({
    type: z.literal('done'),
    error: attemptErrorSchema
      .optional()
      .describe('What the body threw, if it threw. A failed `expect` (not soft) is one.'),
  })
  .describe(
    "The runner to reeval: the eval's body has finished. The attempt's checks and record follow.",
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
  'matchedBy',
  'answers',
  ...Object.keys(judgeCallDataSchema.shape),
  ...Object.keys(judgeStateSchema.shape),
  ...Object.keys(captureSchema.shape),
  ...Object.keys(captureCallDataSchema.shape),
  'port',
  'handle',
  'exec',
  'result',
  'readFile',
  'interval',
  'timeout',
  'ms',
]

/** What's wrong with an attempt request a runner sent, by the field's path, or undefined. */
export const attemptRequestProblem = (value: unknown): string | undefined =>
  dataProblem(attemptRequestSchema, value, 'The attempt request', (object) =>
    typeof object.op === 'string' ? (CALL_KEYS[object.op] ?? []) : OTHER_KEYS,
  )

const LIFECYCLE_KEYS = ['type', 'attempt', 'file', 'body', 'reason', 'message', 'error', 'name']

/** What's wrong with a lifecycle message, by the field's path, or undefined. */
export const attemptStartProblem = (value: unknown): string | undefined =>
  dataProblem(attemptStartSchema, value, 'The attempt start', (object) =>
    'role' in object ? Object.keys(cellSchema.shape) : ['id', 'cell', 'n', ...LIFECYCLE_KEYS],
  )
export const attemptAbortProblem = (value: unknown): string | undefined =>
  dataProblem(attemptAbortSchema, value, 'The attempt abort', () => LIFECYCLE_KEYS)
export const attemptDoneProblem = (value: unknown): string | undefined =>
  dataProblem(attemptDoneSchema, value, 'The attempt done', () => LIFECYCLE_KEYS)

export type AttemptCall = z.infer<typeof attemptCallSchema>
/** `c.judge()`'s `on` as data: a turn by its index, or a value graded as the output. */
export type JudgeOn = z.infer<typeof judgeOnSchema>
export type AttemptStart = z.infer<typeof attemptStartSchema>
export type AttemptAbort = z.infer<typeof attemptAbortSchema>
export type AttemptDone = z.infer<typeof attemptDoneSchema>
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
  AnsweredPattern: answeredPatternSchema,
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
  AttemptStart: attemptStartSchema,
  AttemptAbort: attemptAbortSchema,
  AttemptDone: attemptDoneSchema,
  Cell: cellSchema,
  CellRole: cellRoleSchema,
  CaptureCallData: captureCallDataSchema,
  CaptureInstruction: captureInstructionSchema,
  CaptureWait: captureWaitSchema,
  Wait: waitSchema,
  Duration: durationSchema,
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
  'Cell',
  'CellRole',
  'CaptureWait',
] as const
