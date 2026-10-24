// Questions, answered on the host. A pairwise question (one with `across`) waits for its eval's
// attempts: every pair is shown to a language model twice, in both orders, under blinded labels,
// and each pick is mapped back to the side's name. Any other question is asked of each attempt
// on its own as soon as it ends. A model error is kept on the answer; outcomes never depend on it.
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
import { clip } from '../text.ts'
import type {
  AttemptAnswer,
  BlindAttempt,
  BlindPair,
  BlindSide,
  BlindTurn,
  CompareAnswer,
  EvalRecord,
  FakeAnalysisModel,
  FakeAnswer,
  FakeVote,
  GatewayName,
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
  pairFactors,
  pairsOf,
  ratesOf,
  sideName,
  slots,
  voteOf,
  voteReason,
} from './pairs.ts'
import { DEFAULT_QUESTION_STATE, resolveQuestionState, STOPPED_FIRST } from './state.ts'

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

/** The parts an attempt is shown as, for the system prompt. */
function shownParts(shows: QuestionShows, taskEach: boolean): string[] {
  const { state } = shows
  return [
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
}

/** The system prompt, naming the parts each attempt is shown as. */
export function questionSystem(shows: QuestionShows = DEFAULT_SHOWS, taskEach = false): string {
  const parts = shownParts(shows, taskEach)
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

/** What a screenshot is labelled: its place on its side of a pair, or on the one attempt shown. */
const screenshotLabel = (side: 'A' | 'B' | null, i: number, of: number) =>
  side ? `Attempt ${side}, screenshot ${i} of ${of}` : `Screenshot ${i} of ${of}`

/** One side as the fake and the prompt see it, with its screenshots and the names they came from. */
type BuiltSide = { side: BlindSide; images: ShownImage[]; sent: string[] }

function buildSide(
  attempt: PairAttempt,
  label: 'A' | 'B' | null,
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
      const at = screenshotLabel(label, i + 1, names.length)
      const capture = captures.find((c) => c.name === name)
      const side = label ?? 'A'
      if (!capture) {
        images.push({ label: `${at}: not captured`, data: null, side, name })
        return { label: at, missing: true as const }
      }
      sent.push(name)
      images.push({ label: at, data: capture.data, side, name })
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
export function questionRequest(input: {
  system: string
  images: ShownImage[]
  blind: { prompt: string }
}) {
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
  gateway: GatewayName | undefined,
  input: BlindInput,
  maxOutputTokens: number,
  signal?: AbortSignal,
): Promise<Pick> {
  const result = await generateText({
    model: isFake(model)
      ? fakeAnswer(model, input.blind)
      : await providerModel({
          name: model,
          route: judgeRoute(model, process.env, 'question model', gateway).kind,
        }),
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
  /** The gateway a model string goes through; direct when unset. */
  gateway?: GatewayName
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

/** A pairwise question's place in the eval's questions, its answer, and every call it made. */
export type AskedQuestion = { n: number; answer: CompareAnswer; calls: AskedCall[] }

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
 * Why the question can't be asked: a command or capture it names that none of `sides` has, so
 * each would show it missing. Undefined when each one is on some side.
 */
function missingEverywhere(
  question: string,
  shows: QuestionShows,
  sides: PairAttempt[],
  who = 'paired attempt',
) {
  const { checks } = shows.state
  if (Array.isArray(checks)) {
    const command = checks.find((c) => !sides.some((s) => s.checks?.some((r) => r.command === c)))
    if (command !== undefined) {
      return `question "${question}" state.checks names a command no ${who} ran: ${JSON.stringify(command)}`
    }
  }
  if (Array.isArray(shows.artifacts)) {
    const name = shows.artifacts.find(
      (n) => !sides.some((s) => s.captures?.some((c) => c.name === n)),
    )
    if (name !== undefined) {
      return `question "${question}" artifacts names a capture no ${who} has: ${JSON.stringify(name)}`
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
    state: resolveQuestionState(options.state, true),
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
  const missing = missingEverywhere(question, shows, [...new Set(pairs.flatMap((p) => [p.a, p.b]))])
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
        options.gateway,
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

/** Stored answers to a question asked of one attempt are at most this long. */
export const ANSWER_TEXT_CAP = 1000

/** The system prompt for a question asked of one attempt, naming the parts it's shown as. */
export function attemptQuestionSystem(shows: QuestionShows, choices?: string[]): string {
  const how = choices
    ? 'Pick the one of the choices that answers it, and give a short reason for the pick.'
    : 'Answer it in a few sentences.'
  return `You answer one question about an attempt by a coding agent at a task.
The attempt is shown as ${listed(shownParts(shows, true))}.
Answer only from what is shown. ${how}`
}

/** What the model is shown for a question asked of one attempt: no harness, arm, run, attempt id or capture name. */
export type AttemptInput = {
  blind: BlindAttempt
  system: string
  images: ShownImage[]
  /** The captures it showed, by name. */
  sent: string[]
}

export function attemptInput(
  question: string,
  attempt: PairAttempt,
  maxInputTokens: number,
  shows: QuestionShows,
  choices?: string[],
): AttemptInput {
  const built = buildSide(attempt, null, shows, false)
  const prompt = [
    `Question: ${question}`,
    ...(choices ? ['', 'Choices:', ...choices.map((c) => `- ${c}`)] : []),
    '',
    '<attempt>',
    cut(sideText(built.side), maxInputTokens * CHARS_PER_TOKEN),
    '</attempt>',
  ].join('\n')
  return {
    blind: {
      question,
      prompt: redactSecrets(prompt),
      ...(choices ? { choices } : {}),
      attempt: built.side,
    },
    system: attemptQuestionSystem(shows, choices),
    images: built.images,
    sent: built.sent,
  }
}

function fakeAttemptAnswer(fake: FakeAnalysisModel, attempt: BlindAttempt) {
  const answer = fake.answer
  if (answer && typeof answer === 'object' && 'error' in answer) {
    return cannedModel({ error: answer.error })
  }
  const given: FakeAnswer =
    answer === undefined ? {} : typeof answer === 'function' ? answer(attempt) : answer
  const { choice, text } = typeof given === 'string' ? { text: given, choice: undefined } : given
  return cannedModel({
    text: JSON.stringify({
      ...(attempt.choices ? { choice: choice ?? attempt.choices[0] } : {}),
      answer: text ?? 'fake answer',
    }),
  })
}

const answerSchema = (choices?: string[]) =>
  choices
    ? z.object({ choice: z.enum(choices as [string, ...string[]]), answer: z.string() })
    : z.object({ answer: z.string() })

/** A per-attempt question's call as the runner keeps it, until the record resolves its screenshots' paths. */
export type AskedAttemptCall = {
  system: string
  prompt: string
  screenshots?: AskedScreenshot[]
  error?: string
}

/** A question asked of one attempt: its place in the eval's questions, the answer and the call. */
export type AskedAttemptAnswer = { n: number; answer: AttemptAnswer; call?: AskedAttemptCall }

export type AttemptAnswerOptions = {
  question: string
  model: QuestionModel
  gateway?: GatewayName
  attempt: PairAttempt
  maxInputTokens: number
  maxOutputTokens: number
  state?: QuestionStateOptions
  artifacts?: true | string[]
  choices?: string[]
  signal?: AbortSignal
}

/** Asks one question of one attempt. A failed call is the answer's `error`, with empty `text`. */
export async function answerAttempt(
  options: AttemptAnswerOptions,
): Promise<Omit<AskedAttemptAnswer, 'n'>> {
  const { question, model, attempt, choices } = options
  const shows: QuestionShows = {
    state: resolveQuestionState(options.state, false),
    ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
  }
  const head = {
    question,
    model: isFake(model) ? 'fake' : model,
    stateOptions: shows.state,
    ...(shows.artifacts !== undefined ? { artifacts: shows.artifacts } : {}),
    ...(choices ? { choices } : {}),
  }
  let input: ReturnType<typeof attemptInput> | undefined
  try {
    input = attemptInput(question, attempt, options.maxInputTokens, shows, choices)
    const result = await generateText({
      model: isFake(model)
        ? fakeAttemptAnswer(model, input.blind)
        : await providerModel({
            name: model,
            route: judgeRoute(model, process.env, 'question model', options.gateway).kind,
          }),
      ...questionRequest(input),
      output: Output.object({ schema: answerSchema(choices), name: 'answer' }),
      maxOutputTokens: options.maxOutputTokens,
      maxRetries: 3,
      ...(options.signal ? { abortSignal: options.signal } : {}),
    })
    const out = result.output as { choice?: string; answer: string }
    const served = isFake(model) ? null : (result.response?.modelId ?? null)
    return {
      answer: {
        ...head,
        ...(served ? { resolvedModel: served } : {}),
        ...(out.choice !== undefined ? { choice: out.choice } : {}),
        text: clip(redactSecrets(out.answer.trim()), ANSWER_TEXT_CAP),
      },
      call: attemptCall(input, attempt),
    }
  } catch (e) {
    const why = errorText(e)
    return {
      answer: { ...head, text: '', error: why },
      ...(input ? { call: attemptCall(input, attempt, why) } : {}),
    }
  }
}

/** The call a question asked of one attempt made, as its `questions/<n>.json` keeps it. */
const attemptCall = (
  input: ReturnType<typeof attemptInput>,
  attempt: PairAttempt,
  error?: string,
): AskedAttemptCall => ({
  system: input.system,
  prompt: input.blind.prompt,
  ...(input.images.length
    ? {
        screenshots: input.images.map((image): AskedScreenshot => {
          const label = image.label.replace(/: not captured$/, '')
          return image.data
            ? { label, side: 'attempt', name: image.name, attempt: attempt.id ?? '' }
            : { label, missing: true }
        }),
      }
    : {}),
  ...(error !== undefined ? { error } : {}),
})

/** Ran to a pass or a fail: what a question asked of one attempt is asked of. */
const answerable = (e: EngineEval, record: EvalRecord | null) =>
  record !== null &&
  (e.state === 'passed' ||
    (e.state === 'failed' && record.error?.kind !== 'infra' && record.error?.kind !== 'aborted'))

/** Runs `work` at most `limit` at a time, in the order it was asked. */
function limiter(limit: number) {
  let running = 0
  const waiting: Array<() => void> = []
  return async <T>(work: () => Promise<T>): Promise<T> => {
    // A finished call hands its slot to the next waiter, so a newcomer can't take it between.
    if (running >= limit) await new Promise<void>((go) => waiting.push(go))
    else running++
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
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
    /** Its place in the eval's `questions`, from 1: the `<n>` of its `questions/<n>.json`. */
    n: number
    question: string
    model: QuestionModel
    gateway?: GatewayName
    /** Set on a pairwise question; without it, the question is asked of each attempt. */
    across?: PairFactor | PairFactor[]
    choices?: string[]
    state?: QuestionStateOptions
    artifacts?: true | string[]
  }>
}

export type QuestionRunnerOptions = {
  evals: EvalQuestions[]
  stagingDir: string
  maxInputTokens: number
  maxOutputTokens: number
  /** Per-attempt model calls at once, over the whole run (default 4). */
  concurrency?: number
  /** Told about each pairwise answer as it lands, e.g. to warn about an error. */
  onAnswer?: (evalId: string, answer: CompareAnswer) => void
  /** Told about each per-attempt answer as it lands, with the attempt's id. */
  onAttemptAnswer?: (evalId: string, attempt: string, answer: AttemptAnswer) => void
  /** Told once per per-attempt question that names a check or capture none of its attempts has. */
  onUnshown?: (evalId: string, error: string) => void
}

/** What `settle` hands the record: each eval's pairwise answers, and each attempt's own, by key. */
export type SettledQuestions = {
  evals: Map<string, AskedQuestion[]>
  attempts: Map<string, AskedAttemptAnswer[]>
}

type RunnerQuestion = EvalQuestions['questions'][number]

/** A per-attempt question's answer when no model answered it. */
const unanswered = (q: RunnerQuestion, error: string): AskedAttemptAnswer => ({
  n: q.n,
  answer: {
    question: q.question,
    model: isFake(q.model) ? 'fake' : q.model,
    stateOptions: resolveQuestionState(q.state, false),
    ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
    ...(q.choices ? { choices: q.choices } : {}),
    text: '',
    error,
  },
})

/**
 * Asks each attempt its eval's per-attempt questions as soon as it ends, and an eval's pairwise
 * questions as soon as its last planned attempt ends, while the rest of the run goes on; `settle`
 * starts any pairwise ones left (an eval a filter or budget cut short) and waits for all.
 */
export function questionRunner(options: QuestionRunnerOptions) {
  const byId = new Map(options.evals.map((e) => [e.row.id, e]))
  const ended = new Map<string, EngineEval[]>()
  const started = new Map<string, Promise<AskedQuestion[]>>()
  const perAttempt = new Map<string, Promise<AskedAttemptAnswer[]>>()
  // Each attempt's answers once all came back, before any cancel: what a stopped run keeps.
  const done = new Map<string, AskedAttemptAnswer[]>()
  const shown = new Map<string, PairAttempt>()
  // The questions each attempt was being asked: one a cancel cuts short records them unanswered.
  const asking = new Map<string, RunnerQuestion[]>()
  const controller = new AbortController()
  const live = () => !controller.signal.aborted
  const limit = limiter(options.concurrency ?? 4)
  const pairwiseOf = (e: EvalQuestions) => e.questions.filter((q) => q.across !== undefined)
  const eachOf = (e: EvalQuestions) => e.questions.filter((q) => q.across === undefined)

  const side = async (a: EngineEval, record: EvalRecord | null, captures: boolean) => {
    const found = stagedAttempt(a, record)
    if (!found || !captures) return found
    return { ...found, captures: await stagedCaptures(options.stagingDir, a.key, record) }
  }

  const askEach = (id: string, e: EvalQuestions, result: EngineEval) => {
    const questions = eachOf(e)
    if (!questions.length || perAttempt.has(result.key) || !live()) return
    const asked = (async () => {
      const record = await readStaged(options.stagingDir, result.key)
      if (!answerable(result, record)) return []
      const attempt = await side(
        result,
        record,
        questions.some((q) => q.artifacts !== undefined),
      )
      if (!attempt) return []
      shown.set(result.key, attempt)
      asking.set(result.key, questions)
      return Promise.all(
        questions.map(async (q): Promise<AskedAttemptAnswer> => {
          const got = await limit(() =>
            answerAttempt({
              question: q.question,
              model: q.model,
              ...(q.gateway ? { gateway: q.gateway } : {}),
              attempt,
              maxInputTokens: options.maxInputTokens,
              maxOutputTokens: options.maxOutputTokens,
              ...(q.state ? { state: q.state } : {}),
              ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
              ...(q.choices ? { choices: q.choices } : {}),
              signal: controller.signal,
            }),
          )
          if (live()) options.onAttemptAnswer?.(id, attempt.id ?? result.key, got.answer)
          return { n: q.n, ...got }
        }),
      )
    })().catch((error: unknown) =>
      questions.map((q): AskedAttemptAnswer => {
        const asked = unanswered(q, errorText(error))
        if (live()) options.onAttemptAnswer?.(id, result.key, asked.answer)
        return asked
      }),
    )
    perAttempt.set(result.key, asked)
    void asked.then((got) => {
      if (live() && got.length) done.set(result.key, got)
    })
  }

  // A command or capture a question names that no attempt it was asked of has is a typo, not a
  // finding: each of its answers becomes that error, as a pairwise question's does.
  const unshown = (e: EvalQuestions, results: EngineEval[]) => {
    const sides = results.flatMap((r) => shown.get(r.key) ?? [])
    for (const q of eachOf(e)) {
      const shows: QuestionShows = {
        state: resolveQuestionState(q.state, false),
        ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
      }
      const missing = sides.length && missingEverywhere(q.question, shows, sides, 'attempt')
      if (!missing) continue
      options.onUnshown?.(e.row.id, missing)
      for (const r of results) {
        const got = done.get(r.key)
        if (!got) continue
        done.set(
          r.key,
          got.map((x) => {
            if (x.n !== q.n) return x
            const { choice: _, resolvedModel: __, ...head } = x.answer
            return { ...x, answer: { ...head, text: '', error: missing } }
          }),
        )
      }
    }
  }

  const start = (id: string) => {
    const e = byId.get(id)
    if (!e || started.has(id)) return
    const questions = pairwiseOf(e)
    if (!questions.length) return
    const attempts = ended.get(id) ?? []
    const wantsCaptures = questions.some((q) => q.artifacts !== undefined)
    const answers = (async () => {
      const sides = await Promise.all(
        attempts.map(async (a) =>
          side(a, await readStaged(options.stagingDir, a.key), wantsCaptures),
        ),
      )
      // By cell key, not the order attempts happened to end in, so a run's pairs are its own.
      const staged = sides
        .filter((s): s is PairAttempt => s !== null)
        .sort((x, y) => ((x.id ?? '') < (y.id ?? '') ? -1 : 1))
      return Promise.all(
        questions.map(async (q): Promise<AskedQuestion> => {
          const calls: AskedCall[] = []
          const answer = await answerQuestion({
            question: q.question,
            model: q.model,
            ...(q.gateway ? { gateway: q.gateway } : {}),
            pairs: pairsOf(staged, acrossOf(pairFactors(q.across))),
            maxInputTokens: options.maxInputTokens,
            maxOutputTokens: options.maxOutputTokens,
            ...(q.state ? { state: q.state } : {}),
            ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
            signal: controller.signal,
            calls,
          })
          if (live()) options.onAnswer?.(id, answer)
          return { n: q.n, answer, calls }
        }),
      )
    })().catch((error: unknown) =>
      questions.map((q): AskedQuestion => {
        const answer: CompareAnswer = {
          question: q.question,
          model: isFake(q.model) ? 'fake' : q.model,
          stateOptions: resolveQuestionState(q.state, true),
          ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
          votes: [],
          rates: [],
          error: errorText(error),
        }
        if (live()) options.onAnswer?.(id, answer)
        return { n: q.n, answer, calls: [] }
      }),
    )
    started.set(id, answers)
  }

  return {
    onEvalEnd(result: EngineEval): void {
      const e = byId.get(result.id)
      if (!e) return
      askEach(result.id, e, result)
      const list = ended.get(result.id) ?? []
      list.push(result)
      ended.set(result.id, list)
      if (list.length >= e.row.plan.attempts) start(result.id)
    },
    /** Stops calls in flight and asks nothing more: the run was cancelled. */
    cancel(): void {
      controller.abort()
    },
    /**
     * What a cancelled run keeps: each attempt whose answers all came back before the cancel,
     * and, for an attempt the cancel cut short, each question as an error, so the record shows
     * it went unanswered. Waits for the aborted calls to unwind.
     */
    async answered(): Promise<SettledQuestions> {
      await Promise.all(perAttempt.values())
      const attempts = new Map(done)
      for (const [key, questions] of asking) {
        if (!attempts.has(key))
          attempts.set(
            key,
            questions.map((q) => unanswered(q, STOPPED_FIRST)),
          )
      }
      return { evals: new Map(), attempts }
    },
    async settle(): Promise<SettledQuestions> {
      for (const id of byId.keys()) if (ended.has(id)) start(id)
      const evals = new Map<string, AskedQuestion[]>()
      for (const [id, answers] of started) evals.set(id, await answers)
      for (const answers of perAttempt.values()) await answers
      for (const [id, e] of byId) unshown(e, ended.get(id) ?? [])
      return { evals, attempts: new Map(done) }
    },
  }
}
