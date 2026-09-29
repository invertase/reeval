// One `analysis.agent` note: a model with tools over one eval's attempts on one harness. It reads
// outcomes first, then opens failed attempts beside passing ones; it never gets a whole transcript.
// Tool output stops at `analysis.maxInputTokens` (4 characters a token, as the digest counts).
import { generateText, type LanguageModel, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import type { FakeAnalysisModel, FakeNoteInput } from '../../types.ts'
import type { AnalysisNote } from '../../view/analysis.ts'
import { providerModel, type ResolvedAnalysisModel } from '../model.ts'
import {
  type AttemptView,
  attemptSummary,
  divergence,
  type FailedPair,
  listOutcomes,
} from './tools.ts'

/** Model calls per note: listing, opening and comparing, then the note itself. */
export const NOTE_STEPS = 8
/** Pairs the fake compares, as a careful model would: a few, not all of them. */
const FAKE_PAIRS = 3

export const NOTE_PROMPT = `You write a short note on how one coding agent (the harness) did on one eval of a reeval run. You can't see transcripts; read the attempts with the tools.

1. Call list_attempts first.
2. If any attempt failed, call compare_attempts on its suggested pairs (at most three). Say where the failed attempt's steps diverged from the passing one's, and whether the miss looks like the text the agent was given (a skill, docs, rules), the eval itself (its prompt or checks), or the harness (errors, retries, tool failures). Open an attempt with open_attempt only when the comparison isn't enough.
3. If nothing failed, say so in one line, and name anything unusual (step counts, files, verdicts close to the threshold).

Plain text, at most 150 words, no headings. Name attempts by their id, e.g. cursor:composer-2.5/with-skill/docker#2. Say what the attempts show, not what you guess.`

export type NoteInput = {
  model: ResolvedAnalysisModel
  runId: string
  evalId: string
  harness: string
  attempts: AttemptView[]
  maxInputTokens: number
  maxOutputTokens: number
  instructions?: string
  signal?: AbortSignal
}

/** The tools over `attempts`, with every result counted against `maxChars`. */
export function noteTools(attempts: AttemptView[], maxChars: number) {
  let left = maxChars
  const spend = <T>(value: T): T | { error: string } => {
    const size = JSON.stringify(value).length
    if (size > left) {
      return {
        error:
          'The input budget (analysis.maxInputTokens) is spent: write the note from what you have.',
      }
    }
    left -= size
    return value
  }
  const byId = (id: string) => attempts.find((a) => a.id === id)
  const unknown = (id: string) => ({
    error: `No attempt ${id}. The attempts are ${attempts.map((a) => a.id).join(', ')}.`,
  })
  return {
    list_attempts: tool({
      description:
        "Every attempt's outcome, error, failed checks and verdicts in a line, and failed-vs-passed pairs to compare.",
      inputSchema: z.object({}),
      execute: async () => spend(listOutcomes(attempts)),
    }),
    open_attempt: tool({
      description:
        "One attempt: each turn's prompt, steps (tool calls, edits, errors) and final message, its checks, verdicts and diff.",
      inputSchema: z.object({ id: z.string().describe('An attempt id from list_attempts') }),
      execute: async ({ id }) => {
        const a = byId(id)
        return a ? spend(attemptSummary(a)) : unknown(id)
      },
    }),
    compare_attempts: tool({
      description:
        "Where a failed attempt's steps first differ from a passing one's, the checks, verdicts and files that differ, and each diff's start.",
      inputSchema: z.object({
        failed: z.string().describe('The failed attempt id'),
        passed: z.string().describe('The passing attempt id'),
      }),
      execute: async ({ failed, passed }) => {
        const f = byId(failed)
        const p = byId(passed)
        if (!f) return unknown(failed)
        if (!p) return unknown(passed)
        return spend(divergence(f, p))
      },
    }),
  }
}

/** Writes one note; a failed call is a note with `error`, never a throw. */
export async function writeAgentNote(input: NoteInput): Promise<AnalysisNote> {
  const { model, runId, evalId, harness, attempts } = input
  const base = {
    kind: 'reeval-analysis-note' as const,
    schemaVersion: 1 as const,
    runId,
    evalId,
    harness,
    model: model.name,
    attempts: attempts.map((a) => a.id),
  }
  const count = (o: string) => attempts.filter((a) => a.outcome === o).length
  const prompt = [
    `Eval: ${evalId}`,
    `Harness: ${harness}`,
    `Attempts: ${attempts.length} (${count('pass')} passed, ${count('fail')} failed, ${count('infra_error')} infra errors, ${count('skipped')} skipped)`,
    ...(input.instructions ? ['', `What matters in this project: ${input.instructions}`] : []),
  ].join('\n')
  try {
    const result = await generateText({
      model: model.fake
        ? fakeNoteModel(model.fake, { eval: evalId, harness })
        : await providerModel(model),
      system: NOTE_PROMPT,
      prompt,
      tools: noteTools(attempts, input.maxInputTokens * 4),
      stopWhen: stepCountIs(NOTE_STEPS),
      prepareStep: ({ stepNumber }) =>
        stepNumber === NOTE_STEPS - 1 ? { toolChoice: 'none' as const } : undefined,
      temperature: 0.2,
      maxOutputTokens: input.maxOutputTokens,
      maxRetries: 3,
      ...(input.signal ? { abortSignal: input.signal } : {}),
    })
    const text = result.text.trim()
    return {
      ...base,
      resolvedModel: result.response?.modelId ?? null,
      createdAt: new Date().toISOString(),
      text,
      ...(text ? {} : { error: `the model wrote no note in ${NOTE_STEPS} steps` }),
      usage: {
        inputTokens: result.totalUsage?.inputTokens ?? null,
        outputTokens: result.totalUsage?.outputTokens ?? null,
      },
    }
  } catch (error) {
    return {
      ...base,
      resolvedModel: null,
      createdAt: new Date().toISOString(),
      text: '',
      error: error instanceof Error ? error.message : String(error),
      usage: { inputTokens: null, outputTokens: null },
    }
  }
}

type PromptPart = {
  type: string
  toolName?: string
  output?: { type: string; value: unknown }
}

/** Each tool result so far in the conversation, by tool name. */
function toolResults(prompt: Array<{ role: string; content: unknown }>) {
  const results: Array<{ tool: string; value: unknown }> = []
  for (const message of prompt) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content as PromptPart[]) {
      if (part.type === 'tool-result' && part.toolName && part.output) {
        results.push({ tool: part.toolName, value: part.output.value })
      }
    }
  }
  return results
}

/**
 * A language model that does what the prompt asks of a real one: lists the attempts, compares up
 * to three failed-vs-passed pairs, then answers with the fake's note, through the AI SDK's own
 * tool loop, so the tools and the budget run as they would.
 */
function fakeNoteModel(
  fake: FakeAnalysisModel,
  about: Pick<FakeNoteInput, 'eval' | 'harness'>,
): LanguageModel {
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  }
  let calls = 0
  const toolCalls = (calls: Array<{ name: string; input: unknown }>) => ({
    content: calls.map((c, i) => ({
      type: 'tool-call',
      toolCallId: `fake_${c.name}_${i}`,
      toolName: c.name,
      input: JSON.stringify(c.input),
    })),
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
    response: { modelId: 'fake-analysis' },
  })
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-analysis',
    supportedUrls: {},
    doGenerate: async (options: { prompt: Array<{ role: string; content: unknown }> }) => {
      calls++
      const { note } = fake
      if (typeof note === 'object' && note !== null) throw new Error(note.error)
      const results = toolResults(options.prompt)
      const listed = results.find((r) => r.tool === 'list_attempts')?.value as
        | ReturnType<typeof listOutcomes>
        | undefined
      if (!listed) return toolCalls([{ name: 'list_attempts', input: {} }])
      const compared = results
        .filter((r) => r.tool === 'compare_attempts')
        .map((r) => r.value as ReturnType<typeof divergence>)
      const pairs: FailedPair[] = listed.pairs ?? []
      if (pairs.length && !compared.length && calls < NOTE_STEPS) {
        return toolCalls(
          pairs.slice(0, FAKE_PAIRS).map((p) => ({
            name: 'compare_attempts',
            input: { failed: p.failed, passed: p.passed },
          })),
        )
      }
      const input: FakeNoteInput = {
        ...about,
        attempts: (listed.attempts ?? []).map((a) => ({ id: a.id, outcome: a.outcome })),
        compared: compared
          .filter((c) => c && 'failed' in c)
          .map((c) => ({ failed: c.failed, passed: c.passed, divergedAt: c.divergedAt })),
      }
      const text =
        typeof note === 'function'
          ? note(input)
          : (note ??
            `${input.attempts.filter((a) => a.outcome === 'pass').length} of ${input.attempts.length} attempts passed.`)
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
        response: { modelId: 'fake-analysis' },
      }
    },
    doStream: async () => {
      throw new Error('the fake analysis model does not stream')
    },
  } as unknown as LanguageModel
}
