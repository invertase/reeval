// Compare questions, answered on the host once an eval's attempts have finished: every pair is
// shown to a language model twice, in both orders, under blinded labels, and each pick is mapped
// back to the side's name. A model error is kept on the answer; outcomes never depend on it.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateText, Output } from 'ai'
import { z } from 'zod'
import { cannedModel, isFake, providerModel } from '../analysis/model.ts'
import type { EngineEval } from '../engine/node.ts'
import { recordFileName } from '../ids.ts'
import { judgeRoute } from '../judge/index.ts'
import { judgeDiff } from '../judge/patch.ts'
import { transcriptForJudge } from '../judge/transcript.ts'
import type { PlanRow } from '../plan.ts'
import { redactSecrets } from '../redact.ts'
import type {
  BlindPair,
  BlindSide,
  BlindTurn,
  CompareAnswer,
  EvalRecord,
  FakeAnalysisModel,
  FakeVote,
  PairFactor,
  PairVote,
  QuestionCall,
  QuestionStateOptions,
  ResolvedQuestionStateOptions,
} from '../types.ts'
import {
  acrossOf,
  type Pair,
  type PairAttempt,
  type PairTurn,
  pairsOf,
  ratesOf,
  sideName,
  slots,
  voteOf,
  voteReason,
} from './pairs.ts'
import { DEFAULT_QUESTION_STATE, resolveQuestionState } from './state.ts'

/** What each side of a question shows: the resolved `state`, and the captures it asks for. */
export type QuestionShows = {
  state: ResolvedQuestionStateOptions
  artifacts?: true | string[]
}

const DEFAULT_SHOWS: QuestionShows = { state: DEFAULT_QUESTION_STATE }

const isOn = (value: unknown) => value !== false && !(Array.isArray(value) && !value.length)

/** `a`, `a and b`, `a, b and c`. */
const listed = (parts: string[]) =>
  parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`

/** The system prompt, naming the parts each attempt is shown as. */
export function questionSystem(shows: QuestionShows = DEFAULT_SHOWS, taskEach = false): string {
  const { state } = shows
  const parts = [
    ...(taskEach && state.task ? ['the prompts it was sent'] : []),
    ...(state.output ? ['its final message'] : []),
    ...(isOn(state.transcript) ? ['its transcript'] : []),
    ...(state.files ? ['the files it changed'] : []),
    ...(isOn(state.diff) ? ['the changes it made to the project, as a unified diff'] : []),
    ...(isOn(state.checks)
      ? ['the commands run on its work, with their exit codes and output']
      : []),
    ...(shows.artifacts !== undefined ? ['screenshots of its work'] : []),
  ]
  return `You compare two attempts by coding agents at the same task and answer one question about them.
Each attempt is shown as ${listed(parts)}, labelled A or B. The labels are assigned at random: which attempt comes first says nothing about it.
Judge only by the question, from what is shown. Answer A or B for the attempt the question favours, or tie when what is shown doesn't separate them on it. Give a short reason for the pick.`
}

const voteSchema = z.object({
  winner: z.enum(['A', 'B', 'tie']),
  reason: z.string().optional(),
})

/** Roughly four characters a token: each side gets half of `maxInputTokens`. */
const CHARS_PER_TOKEN = 4

/** The turns a side shows: the last, or every one. */
const shownTurns = (side: PairAttempt, state: ResolvedQuestionStateOptions): PairTurn[] => {
  const turns = side.turns ?? []
  return state.turns === 'all' ? turns : turns.slice(-1)
}

/** The task both sides were given, when they were given the same prompts. */
function sharedTask(first: PairAttempt, second: PairAttempt, state: ResolvedQuestionStateOptions) {
  if (!state.task) return null
  const a = shownTurns(first, state).map((t) => t.prompt)
  const b = shownTurns(second, state).map((t) => t.prompt)
  if (!a.length || a.length !== b.length || a.some((p, i) => p !== b[i])) return null
  return a.join('\n\n')
}

/** A screenshot as the model is shown it: its position on its side, never the capture's name. */
type ShownImage = { label: string; data: Uint8Array | null; side: 'A' | 'B'; name: string }

/** One side as the fake and the prompt see it, with its screenshots and the names they came from. */
type BuiltSide = { side: BlindSide; images: ShownImage[]; sent: string[] }

function buildSide(
  attempt: PairAttempt,
  label: 'A' | 'B',
  shows: QuestionShows,
  taskShared: boolean,
): BuiltSide {
  const { state } = shows
  const turns: BlindTurn[] = shownTurns(attempt, state).map((t) => ({
    ...(state.task && !taskShared ? { task: redactSecrets(t.prompt) } : {}),
    ...(state.output ? { output: redactSecrets(t.text ?? '') } : {}),
    ...(state.transcript
      ? {
          transcript: redactSecrets(
            transcriptForJudge(t.transcript ?? [], state.transcript).join('\n'),
          ),
        }
      : {}),
  }))
  const shown = judgeDiff(
    { patch: attempt.diff, files: attempt.files ?? [] },
    Array.isArray(state.diff) ? { patterns: state.diff } : {},
  )
  const patch = redactSecrets(shown.patch)
  const side: BlindSide = {
    ...(state.turns === 'all'
      ? turns.some((t) => Object.keys(t).length)
        ? { turns }
        : {}
      : (turns[0] ?? {})),
    ...(state.files ? { files: shown.files } : {}),
    ...(state.diff !== false ? { diff: patch.trim() ? patch : '(no changes)' } : {}),
  }
  const checks = checksOf(attempt, state.checks)
  if (checks) side.checks = checks
  const images: ShownImage[] = []
  const sent: string[] = []
  if (shows.artifacts !== undefined) {
    const captures = attempt.captures ?? []
    const names = shows.artifacts === true ? captures.map((c) => c.name) : shows.artifacts
    side.artifacts = names.map((name, i) => {
      const at = `Attempt ${label}, screenshot ${i + 1} of ${names.length}`
      const capture = captures.find((c) => c.name === name)
      if (!capture) {
        images.push({ label: `${at}: not captured`, data: null, side: label, name })
        return { label: at, missing: true as const }
      }
      sent.push(name)
      images.push({ label: at, data: capture.data, side: label, name })
      return { label: at, mediaType: 'image/png' as const, bytes: capture.data.byteLength }
    })
  }
  return { side, images, sent }
}

function checksOf(
  attempt: PairAttempt,
  which: ResolvedQuestionStateOptions['checks'],
): BlindSide['checks'] {
  if (which === false) return undefined
  const ran = attempt.checks ?? []
  const shown = ({ command, exitCode, stdout, stderr }: (typeof ran)[number]) => ({
    command,
    exitCode,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
  })
  if (which === true) return ran.map(shown)
  return which.flatMap((command): NonNullable<BlindSide['checks']> => {
    const runs = ran.filter((r) => r.command === command)
    return runs.length ? runs.map(shown) : [{ command, notRun: true as const }]
  })
}

const tag = (name: string, body: string) => [`<${name}>`, body, `</${name}>`]

/** A side's text in the prompt: each part it shows, in its own tag. */
function sideText(side: BlindSide): string {
  const turnLines = (t: BlindTurn) => [
    ...(t.task !== undefined ? tag('task', t.task) : []),
    ...(t.output !== undefined ? tag('output', t.output) : []),
    ...(t.transcript !== undefined ? tag('transcript', t.transcript) : []),
  ]
  const lines = [
    ...(side.turns
      ? side.turns.flatMap((t, i) => [`<turn n="${i + 1}">`, ...turnLines(t), '</turn>'])
      : turnLines(side)),
    ...(side.files ? tag('files', side.files.join('\n') || '(none)') : []),
    ...(side.diff !== undefined ? tag('diff', side.diff) : []),
    ...(side.checks
      ? tag(
          'checks',
          side.checks
            .map((c) =>
              'notRun' in c
                ? `$ ${c.command} → not run`
                : [
                    `$ ${c.command} → exit ${c.exitCode}`,
                    ...(c.stdout ? [c.stdout.trimEnd()] : []),
                    ...(c.stderr ? [`stderr: ${c.stderr.trimEnd()}`] : []),
                  ].join('\n'),
            )
            .join('\n'),
        )
      : []),
    ...(side.artifacts
      ? tag(
          'screenshots',
          side.artifacts
            .map((a) => ('missing' in a ? `${a.label}: not captured` : a.label))
            .join('\n'),
        )
      : []),
  ]
  return lines.join('\n')
}

/** A side's text, cut to `chars` when it's longer. */
function cut(text: string, chars: number): string {
  if (text.length <= chars) return text
  return `${text.slice(0, chars)}\n[reeval: attempt cut at ${chars} of ${text.length} characters]`
}

/** One order of a pair as the model is asked it: the blinded pair, the system prompt and its screenshots. */
export type BlindInput = {
  blind: BlindPair
  system: string
  images: ShownImage[]
  /** The captures each named side showed, by name: `pair.a`'s, then `pair.b`'s. */
  sent: { a: string[]; b: string[] }
}

/** What the model is shown for one order of a pair: no harness, arm, run, attempt id or capture name. */
export function blindInput(
  question: string,
  pair: Pair,
  swapped: boolean,
  maxInputTokens: number,
  shows: QuestionShows = DEFAULT_SHOWS,
): BlindInput {
  const [first, second] = slots(pair, swapped)
  const chars = Math.floor((maxInputTokens * CHARS_PER_TOKEN) / 2)
  const task = sharedTask(first, second, shows.state)
  const a = buildSide(first, 'A', shows, task !== null)
  const b = buildSide(second, 'B', shows, task !== null)
  const prompt = [
    `Question: ${question}`,
    ...(task ? ['', 'The task both attempts were given:', '<task>', task, '</task>'] : []),
    '',
    '<attempt label="A">',
    cut(sideText(a.side), chars),
    '</attempt>',
    '',
    '<attempt label="B">',
    cut(sideText(b.side), chars),
    '</attempt>',
  ].join('\n')
  const [sentFirst, sentSecond] = swapped ? [b.sent, a.sent] : [a.sent, b.sent]
  return {
    blind: { question, prompt: redactSecrets(prompt), a: a.side, b: b.side },
    system: questionSystem(shows, task === null),
    images: [...a.images, ...b.images],
    sent: { a: sentFirst, b: sentSecond },
  }
}

/** The blinded pair alone: what a fake's `vote` gets. */
export const blindPair = (
  question: string,
  pair: Pair,
  swapped: boolean,
  maxInputTokens: number,
  shows?: QuestionShows,
): BlindPair => blindInput(question, pair, swapped, maxInputTokens, shows).blind

export type QuestionModel = string | FakeAnalysisModel

function fakeAnswer(fake: FakeAnalysisModel, pair: BlindPair) {
  const vote = fake.vote ?? 'tie'
  if (typeof vote === 'object' && 'error' in vote) return cannedModel({ error: vote.error })
  const pick = typeof vote === 'function' ? vote(pair) : vote
  const winner = typeof pick === 'string' ? pick : pick.winner
  const reason = typeof pick === 'string' ? undefined : pick.reason
  return cannedModel({
    text: JSON.stringify({ winner, ...(reason !== undefined ? { reason } : {}) }),
  })
}

type Pick = { pick: FakeVote; reason?: string; resolvedModel: string | null }

/**
 * The model call's system prompt and input: the prompt as text, or, with screenshots, one user
 * message of the prompt then each screenshot's label and image part.
 */
export function questionRequest(input: BlindInput) {
  const { blind, images } = input
  if (!images.length) return { system: input.system, prompt: blind.prompt }
  return {
    system: input.system,
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: blind.prompt },
          ...images.flatMap((image) => [
            { type: 'text' as const, text: image.label },
            ...(image.data
              ? [{ type: 'file' as const, mediaType: 'image/png', data: image.data }]
              : []),
          ]),
        ],
      },
    ],
  }
}

async function ask(
  model: QuestionModel,
  input: BlindInput,
  maxOutputTokens: number,
  signal?: AbortSignal,
): Promise<Pick> {
  const result = await generateText({
    model: isFake(model)
      ? fakeAnswer(model, input.blind)
      : await providerModel({ name: model, route: judgeRoute(model).kind }),
    ...questionRequest(input),
    output: Output.object({ schema: voteSchema, name: 'vote' }),
    maxOutputTokens,
    maxRetries: 3,
    ...(signal ? { abortSignal: signal } : {}),
  })
  const { winner, reason } = result.output as z.infer<typeof voteSchema>
  return {
    pick: winner,
    reason: voteReason(reason),
    resolvedModel: isFake(model) ? null : (result.response?.modelId ?? null),
  }
}

/** Runs `work` over `items`, at most `limit` at once, keeping their order. */
async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i] as T)
    }
  })
  await Promise.all(lanes)
  return out
}

export type AnswerOptions = {
  question: string
  model: QuestionModel
  pairs: Pair[]
  maxInputTokens: number
  maxOutputTokens: number
  /** What each side shows; the question defaults without it. */
  state?: QuestionStateOptions
  /** Each side's own captures, by name, or `true` for all of them. */
  artifacts?: true | string[]
  /** Model calls at once (default 4). */
  concurrency?: number
  signal?: AbortSignal
  /** Given each call it makes, in pair order, failed ones included. */
  calls?: AskedCall[]
}

/** A screenshot as the runner keeps it: by its attempt's id, which the record turns into a path. */
export type AskedScreenshot =
  | { label: string; side: string; name: string; attempt: string }
  | { label: string; missing: true }

/** A call as the runner keeps it, until the record resolves its screenshots' paths. */
export type AskedCall = Omit<QuestionCall, 'screenshots'> & { screenshots?: AskedScreenshot[] }

/** A question's answer, and every call it made. */
export type AskedQuestion = { answer: CompareAnswer; calls: AskedCall[] }

function askedCall(pair: Pair, swapped: boolean, input: BlindInput, error?: string): AskedCall {
  const [first, second] = slots(pair, swapped)
  const shown = { A: first, B: second }
  return {
    cut: pair.cut,
    ...(pair.cut === 'within' ? { harness: pair.harness } : { arm: pair.arm }),
    run: pair.run,
    a: sideName(pair.cut, pair.a),
    b: sideName(pair.cut, pair.b),
    swapped,
    labels: { A: sideName(pair.cut, first), B: sideName(pair.cut, second) },
    system: input.system,
    prompt: input.blind.prompt,
    ...(input.images.length
      ? {
          screenshots: input.images.map((image): AskedScreenshot => {
            const label = image.label.replace(/: not captured$/, '')
            return image.data
              ? {
                  label,
                  side: sideName(pair.cut, shown[image.side]),
                  name: image.name,
                  attempt: shown[image.side].id ?? '',
                }
              : { label, missing: true }
          }),
        }
      : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

const errorText = (error: unknown) =>
  redactSecrets((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '')

/**
 * Why the question can't be asked: a command or capture it names that no paired attempt has, so
 * every side would show it missing. Undefined when each one is on some side.
 */
function missingEverywhere(question: string, shows: QuestionShows, pairs: Pair[]) {
  const sides = [...new Set(pairs.flatMap((p) => [p.a, p.b]))]
  const { checks } = shows.state
  if (Array.isArray(checks)) {
    const command = checks.find((c) => !sides.some((s) => s.checks?.some((r) => r.command === c)))
    if (command !== undefined) {
      return `question "${question}" state.checks names a command no paired attempt ran: ${JSON.stringify(command)}`
    }
  }
  if (Array.isArray(shows.artifacts)) {
    const name = shows.artifacts.find(
      (n) => !sides.some((s) => s.captures?.some((c) => c.name === n)),
    )
    if (name !== undefined) {
      return `question "${question}" artifacts names a capture no paired attempt has: ${JSON.stringify(name)}`
    }
  }
  return undefined
}

/**
 * Asks one question of every pair, each twice with the order swapped. Votes that came back are
 * kept when a call fails, and the first failure is the answer's `error`.
 */
export async function answerQuestion(options: AnswerOptions): Promise<CompareAnswer> {
  const { question, model, pairs } = options
  const shows: QuestionShows = {
    state: resolveQuestionState(options.state),
    ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
  }
  const head = {
    question,
    model: isFake(model) ? 'fake' : model,
  }
  const asked = {
    stateOptions: shows.state,
    ...(shows.artifacts !== undefined ? { artifacts: shows.artifacts } : {}),
  }
  const missing = missingEverywhere(question, shows, pairs)
  if (missing) return { ...head, ...asked, votes: [], rates: [], error: missing }
  const calls = pairs
    .flatMap((pair) => [false, true].map((swapped) => ({ pair, swapped })))
    .map((call, at) => ({ ...call, at }))
  const served = new Set<string>()
  let error: string | undefined
  const made: Array<AskedCall | null> = new Array(calls.length).fill(null)
  const votes = await pooled(calls, options.concurrency ?? 4, async ({ pair, swapped, at }) => {
    if (error !== undefined) return null
    const input = blindInput(question, pair, swapped, options.maxInputTokens, shows)
    try {
      const { pick, reason, resolvedModel } = await ask(
        model,
        input,
        options.maxOutputTokens,
        options.signal,
      )
      made[at] = askedCall(pair, swapped, input)
      if (resolvedModel) served.add(resolvedModel)
      const vote = voteOf(question, pair, swapped, pick, reason)
      return shows.artifacts !== undefined ? { ...vote, artifacts: input.sent } : vote
    } catch (e) {
      const why = errorText(e)
      made[at] = askedCall(pair, swapped, input, why)
      error ??= why
      return null
    }
  })
  options.calls?.push(...made.filter((c): c is AskedCall => c !== null))
  const kept = votes.filter((v): v is PairVote => v !== null)
  return {
    ...head,
    ...(served.size ? { resolvedModel: [...served].sort().join(', ') } : {}),
    ...asked,
    votes: kept,
    rates: ratesOf(kept),
    ...(error !== undefined ? { error } : {}),
  }
}

/** A staged attempt as a pair side: its record's turns, diff and checks, and whether its checks held. */
export function stagedAttempt(e: EngineEval, record: EvalRecord | null): PairAttempt | null {
  const cell = e.attempt?.cell
  if (!cell) return null
  const checksPassed =
    record !== null &&
    (e.state === 'passed' || (e.state === 'failed' && record.error?.kind === 'judge'))
  return {
    harness: cell.harness,
    arm: cell.environment,
    run: e.attempt?.n ?? 1,
    diff: record?.diff?.patch ?? '',
    files: record?.diff?.files ?? [],
    checksPassed,
    control: cell.role === 'control',
    turns:
      record?.turns.map((t) => ({ prompt: t.prompt, text: t.text, transcript: t.transcript })) ??
      [],
    checks:
      record?.checks.map(({ command, exitCode, stdout, stderr }) => ({
        command,
        exitCode,
        stdout,
        stderr,
      })) ?? [],
    id: `${cell.key}#${e.attempt?.n ?? 1}`,
  }
}

const readStaged = async (stagingDir: string, key: string): Promise<EvalRecord | null> =>
  JSON.parse(
    await readFile(join(stagingDir, 'evals', recordFileName(key)), 'utf8').catch(() => 'null'),
  )

/** A staged attempt's captures, read from the PNGs beside its record; a missing file is left out. */
async function stagedCaptures(stagingDir: string, key: string, record: EvalRecord | null) {
  const dir = join(stagingDir, 'evals', recordFileName(key).replace(/\.json$/, '.artifacts'))
  const read = await Promise.all(
    (record?.artifacts ?? []).map(async ({ name }) => {
      const data = await readFile(join(dir, `${name}.png`)).catch(() => null)
      return data ? [{ name, data: new Uint8Array(data) }] : []
    }),
  )
  return read.flat()
}

export type EvalQuestions = {
  row: PlanRow
  /** Each question with the model that answers it, resolved at plan time. */
  questions: Array<{
    question: string
    model: QuestionModel
    across?: PairFactor
    state?: QuestionStateOptions
    artifacts?: true | string[]
  }>
}

export type QuestionRunnerOptions = {
  evals: EvalQuestions[]
  stagingDir: string
  maxInputTokens: number
  maxOutputTokens: number
  /** Told about each answer as it lands, e.g. to warn about an error. */
  onAnswer?: (evalId: string, answer: CompareAnswer) => void
}

/**
 * Starts an eval's questions as soon as its last planned attempt ends, while the rest of the run
 * goes on; `settle` starts any left (an eval a filter or budget cut short) and waits for all.
 */
export function questionRunner(options: QuestionRunnerOptions) {
  const byId = new Map(options.evals.map((e) => [e.row.id, e]))
  const ended = new Map<string, EngineEval[]>()
  const started = new Map<string, Promise<AskedQuestion[]>>()
  const controller = new AbortController()

  const start = (id: string) => {
    const e = byId.get(id)
    if (!e || started.has(id)) return
    const attempts = ended.get(id) ?? []
    const wantsCaptures = e.questions.some((q) => q.artifacts !== undefined)
    const answers = (async () => {
      const sides = await Promise.all(
        attempts.map(async (a) => {
          const record = await readStaged(options.stagingDir, a.key)
          const side = stagedAttempt(a, record)
          if (!side || !wantsCaptures) return side
          return { ...side, captures: await stagedCaptures(options.stagingDir, a.key, record) }
        }),
      )
      // By cell key, not the order attempts happened to end in, so a run's pairs are its own.
      const staged = sides
        .filter((s): s is PairAttempt => s !== null)
        .sort((x, y) => ((x.id ?? '') < (y.id ?? '') ? -1 : 1))
      return Promise.all(
        e.questions.map(async (q): Promise<AskedQuestion> => {
          const calls: AskedCall[] = []
          const answer = await answerQuestion({
            question: q.question,
            model: q.model,
            pairs: pairsOf(staged, acrossOf(q.across)),
            maxInputTokens: options.maxInputTokens,
            maxOutputTokens: options.maxOutputTokens,
            ...(q.state ? { state: q.state } : {}),
            ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
            signal: controller.signal,
            calls,
          })
          options.onAnswer?.(id, answer)
          return { answer, calls }
        }),
      )
    })().catch((error: unknown) =>
      e.questions.map((q): AskedQuestion => {
        const answer: CompareAnswer = {
          question: q.question,
          model: isFake(q.model) ? 'fake' : q.model,
          stateOptions: resolveQuestionState(q.state),
          ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
          votes: [],
          rates: [],
          error: errorText(error),
        }
        options.onAnswer?.(id, answer)
        return { answer, calls: [] }
      }),
    )
    started.set(id, answers)
  }

  return {
    onEvalEnd(result: EngineEval): void {
      const e = byId.get(result.id)
      if (!e) return
      const list = ended.get(result.id) ?? []
      list.push(result)
      ended.set(result.id, list)
      if (list.length >= e.row.plan.attempts) start(result.id)
    },
    /** Stops calls in flight: the run was cancelled, so nothing is answered. */
    cancel(): void {
      controller.abort()
    },
    async settle(): Promise<Map<string, AskedQuestion[]>> {
      for (const id of byId.keys()) if (ended.has(id)) start(id)
      const out = new Map<string, AskedQuestion[]>()
      for (const [id, answers] of started) out.set(id, await answers)
      return out
    },
  }
}
