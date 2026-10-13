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
import { patchForJudge } from '../judge/patch.ts'
import type { PlanRow } from '../plan.ts'
import { redactSecrets } from '../redact.ts'
import type {
  BlindPair,
  CompareAnswer,
  CompareCut,
  EvalRecord,
  FakeAnalysisModel,
  FakeVote,
  PairVote,
} from '../types.ts'
import { cutsOf, type Pair, type PairAttempt, pairsOf, ratesOf, slots, voteOf } from './pairs.ts'

export const QUESTION_SYSTEM = `You compare two attempts by coding agents at the same task and answer one question about them.
Each attempt is shown as the changes it made to the project, as a unified diff, labelled A or B. The labels are assigned at random: which attempt comes first says nothing about it.
Judge only by the question, from the changes shown. Answer A or B for the attempt the question favours, or tie when the changes don't separate them on it.`

const voteSchema = z.object({ winner: z.enum(['A', 'B', 'tie']) })

/** Roughly four characters a token: each side gets half of `maxInputTokens`. */
const CHARS_PER_TOKEN = 4

/** A diff as the model sees it: dependency and binary noise dropped, then cut to `chars`. */
function shownDiff(diff: string, chars: number): string {
  const patch = patchForJudge(diff)
  if (!patch.trim()) return '(no changes)'
  if (patch.length <= chars) return patch
  return `${patch.slice(0, chars)}\n[reeval: diff cut at ${chars} of ${patch.length} characters]`
}

/** The task both sides were given, when they were given the same prompts. */
function taskOf(first: PairAttempt, second: PairAttempt): string | null {
  const a = first.prompts ?? []
  const b = second.prompts ?? []
  if (!a.length || a.length !== b.length || a.some((p, i) => p !== b[i])) return null
  return a.join('\n\n')
}

/** What the model is shown for one order of a pair: no harness, arm, run or attempt id. */
export function blindPair(
  question: string,
  pair: Pair,
  swapped: boolean,
  maxInputTokens: number,
): BlindPair {
  const [first, second] = slots(pair, swapped)
  const chars = Math.floor((maxInputTokens * CHARS_PER_TOKEN) / 2)
  const a = shownDiff(first.diff, chars)
  const b = shownDiff(second.diff, chars)
  const task = taskOf(first, second)
  const prompt = [
    `Question: ${question}`,
    ...(task ? ['', 'The task both attempts were given:', '<task>', task, '</task>'] : []),
    '',
    '<attempt label="A">',
    a,
    '</attempt>',
    '',
    '<attempt label="B">',
    b,
    '</attempt>',
  ].join('\n')
  return { question, prompt: redactSecrets(prompt), a, b }
}

export type QuestionModel = string | FakeAnalysisModel

function fakeAnswer(fake: FakeAnalysisModel, pair: BlindPair) {
  const vote = fake.vote ?? 'tie'
  if (typeof vote === 'object') return cannedModel({ error: vote.error })
  const pick: FakeVote = typeof vote === 'function' ? vote(pair) : vote
  return cannedModel({ text: JSON.stringify({ winner: pick }) })
}

type Pick = { pick: FakeVote; resolvedModel: string | null }

async function ask(
  model: QuestionModel,
  pair: BlindPair,
  maxOutputTokens: number,
  signal?: AbortSignal,
): Promise<Pick> {
  const result = await generateText({
    model: isFake(model)
      ? fakeAnswer(model, pair)
      : await providerModel({ name: model, route: judgeRoute(model).kind }),
    system: QUESTION_SYSTEM,
    prompt: pair.prompt,
    output: Output.object({ schema: voteSchema, name: 'vote' }),
    temperature: 0,
    maxOutputTokens,
    maxRetries: 3,
    ...(signal ? { abortSignal: signal } : {}),
  })
  const { winner } = result.output as z.infer<typeof voteSchema>
  return { pick: winner, resolvedModel: isFake(model) ? null : (result.response?.modelId ?? null) }
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
  /** Model calls at once (default 4). */
  concurrency?: number
  signal?: AbortSignal
}

const errorText = (error: unknown) =>
  redactSecrets((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '')

/**
 * Asks one question of every pair, each twice with the order swapped. Votes that came back are
 * kept when a call fails, and the first failure is the answer's `error`.
 */
export async function answerQuestion(options: AnswerOptions): Promise<CompareAnswer> {
  const { question, model, pairs } = options
  const calls = pairs.flatMap((pair) => [false, true].map((swapped) => ({ pair, swapped })))
  const served = new Set<string>()
  let error: string | undefined
  const votes = await pooled(calls, options.concurrency ?? 4, async ({ pair, swapped }) => {
    if (error !== undefined) return null
    const blind = blindPair(question, pair, swapped, options.maxInputTokens)
    try {
      const { pick, resolvedModel } = await ask(
        model,
        blind,
        options.maxOutputTokens,
        options.signal,
      )
      if (resolvedModel) served.add(resolvedModel)
      return voteOf(question, pair, swapped, pick)
    } catch (e) {
      error ??= errorText(e)
      return null
    }
  })
  const kept = votes.filter((v): v is PairVote => v !== null)
  return {
    question,
    model: isFake(model) ? 'fake' : model,
    ...(served.size ? { resolvedModel: [...served].sort().join(', ') } : {}),
    votes: kept,
    rates: ratesOf(kept),
    ...(error !== undefined ? { error } : {}),
  }
}

/** A staged attempt as a pair side: its record's diff and whether its checks held. */
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
    checksPassed,
    control: cell.role === 'control',
    prompts: record?.turns.map((t) => t.prompt) ?? [],
    id: `${cell.key}#${e.attempt?.n ?? 1}`,
  }
}

const readStaged = async (stagingDir: string, key: string): Promise<EvalRecord | null> =>
  JSON.parse(
    await readFile(join(stagingDir, 'evals', recordFileName(key)), 'utf8').catch(() => 'null'),
  )

export type EvalQuestions = {
  row: PlanRow
  /** Each question with the model that answers it, resolved at plan time. */
  questions: Array<{ question: string; model: QuestionModel; cut?: CompareCut }>
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
  const started = new Map<string, Promise<CompareAnswer[]>>()
  const controller = new AbortController()

  const start = (id: string) => {
    const e = byId.get(id)
    if (!e || started.has(id)) return
    const attempts = ended.get(id) ?? []
    const answers = (async () => {
      const sides = await Promise.all(
        attempts.map(async (a) => stagedAttempt(a, await readStaged(options.stagingDir, a.key))),
      )
      // By cell key, not the order attempts happened to end in, so a run's pairs are its own.
      const staged = sides
        .filter((s): s is PairAttempt => s !== null)
        .sort((x, y) => ((x.id ?? '') < (y.id ?? '') ? -1 : 1))
      return Promise.all(
        e.questions.map(async (q) => {
          const answer = await answerQuestion({
            question: q.question,
            model: q.model,
            pairs: pairsOf(staged, cutsOf(q.cut)),
            maxInputTokens: options.maxInputTokens,
            maxOutputTokens: options.maxOutputTokens,
            signal: controller.signal,
          })
          options.onAnswer?.(id, answer)
          return answer
        }),
      )
    })().catch((error: unknown) =>
      e.questions.map((q) => {
        const answer: CompareAnswer = {
          question: q.question,
          model: isFake(q.model) ? 'fake' : q.model,
          votes: [],
          rates: [],
          error: errorText(error),
        }
        options.onAnswer?.(id, answer)
        return answer
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
    async settle(): Promise<Map<string, CompareAnswer[]>> {
      for (const id of byId.keys()) if (ended.has(id)) start(id)
      const out = new Map<string, CompareAnswer[]>()
      for (const [id, answers] of started) out.set(id, await answers)
      return out
    },
  }
}
