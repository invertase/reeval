// `analysis.agent`'s run summary: once a run is written, the same run-scoped document `reeval
// analyze` makes, under the same cache key, so `reeval analyze` on the run is served from the cache.
// Before the one structured call, the model reads what the digest leaves out with tools: evidence
// dropped to fit its cap, and attempts (with their diffs). The last call has no tools and emits
// `analysisSchema`; `validateAnalysis` checks its citations against the digest and what was read.
import { join } from 'node:path'
import { generateText, type LanguageModel, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { allRuns } from '../../commands.ts'
import type { ResolvedConfig } from '../../types.ts'
import type { AnalysisDoc } from '../../view/analysis.ts'
import {
  analyseDigest,
  defaultBase,
  failedAnalysis,
  type PreparedAnalysis,
  prepareAnalysis,
  promptOf,
  type ToolReads,
} from '../command.ts'
import type { DigestEvidence } from '../digest.ts'
import { writeCached } from '../files.ts'
import { providerModel, type ResolvedAnalysisModel } from '../model.ts'
import { attemptSummary, fromRecorded } from './tools.ts'

/** Model calls before the structured one: reading, then a line saying what was read. */
export const SUMMARY_STEPS = 4
/** Items the fake reads of each kind, as a careful model would: a few, not all of them. */
const FAKE_READS = 3

export const SUMMARY_TOOLS_PROMPT = `You are about to analyse a reeval run from the DIGEST in the prompt. First, read what the digest leaves out, with the tools:
- read_evidence: an evidence item dropped from the digest to fit its size cap (the ids in "dropped").
- open_attempt: one attempt's turns, steps, checks, verdicts and diff, by its id in the attempts table (e.g. r1/skill/control#1).

Open failing attempts, and attempts whose facts look odd; at most six items in all, never every attempt. Then reply with one line saying what you read, and stop: you write the analysis itself in the next step.`

/** The tools over a prepared digest, with every result counted against `maxChars`. */
export function summaryTools(p: PreparedAnalysis, maxChars: number) {
  let left = maxChars
  const spend = <T>(value: T): T | { error: string } => {
    const size = JSON.stringify(value).length
    if (size > left) {
      return {
        error:
          'The input budget (analysis.maxInputTokens) is spent: write the analysis from what you have.',
      }
    }
    left -= size
    return value
  }
  const runs = [p.headRun, p.baseRun].flatMap((r) => (r ? [r] : []))
  return {
    read_evidence: tool({
      description:
        'An evidence item dropped from the digest to fit its cap: its lines (transcript lines keep their L<n>), what it is and why it was chosen.',
      inputSchema: z.object({
        id: z.string().describe('An evidence id from the digest\u2019s dropped'),
      }),
      execute: async ({ id }) => {
        const item = p.dropped.find((e) => e.id === id)
        if (item) {
          const { priority: _priority, ...rest } = item
          return spend(rest)
        }
        return {
          error: p.digest.evidence.some((e) => e.id === id)
            ? `${id} is in the digest already.`
            : `No dropped evidence ${id}. Dropped: ${p.digest.dropped.join(', ') || 'none'}.`,
        }
      },
    }),
    open_attempt: tool({
      description:
        "One attempt: each turn's prompt, steps (tool calls, edits, errors) and final message, its checks, verdicts and diff.",
      inputSchema: z.object({
        id: z.string().describe('An attempt id from the digest\u2019s attempts table'),
      }),
      execute: async ({ id }) => {
        const a = p.digest.attempts[id]
        const run = a && runs.find((r) => r.record.runId === a.runId)
        const record = run?.record.evals.flatMap((e) => e.attempts).find((x) => x.key === a?.key)
        if (!a || !run || !record) {
          return {
            error: `No attempt ${id}. The attempts are ${Object.keys(p.digest.attempts).join(', ')}.`,
          }
        }
        const view = await fromRecorded(join(run.dir, run.record.runId), record)
        return spend({ ...attemptSummary(view), id })
      },
    }),
  }
}

type ToolRead = { tool: string; input: unknown; output: unknown }

const isError = (v: unknown) => typeof v === 'object' && v !== null && 'error' in v

/** What the tools returned, as evidence to cite and as the text the structured call is shown. */
export function toolReads(reads: ToolRead[]): ToolReads {
  const ok = reads.filter((r) => !isError(r.output))
  const evidence = ok
    .filter((r) => r.tool === 'read_evidence')
    .map((r) => ({ ...(r.output as Omit<DigestEvidence, 'priority'>), priority: 1 }))
  if (!ok.length) return { evidence, text: '' }
  return {
    evidence,
    text: `\n\nREAD WITH TOOLS (cite a dropped evidence item read here by its id, as you would the digest's):\n${ok
      .map((r) => `${r.tool} ${JSON.stringify(r.input)}: ${JSON.stringify(r.output)}`)
      .join('\n')}`,
  }
}

/** Lets the model read with the tools; what it read, for the structured call. */
export async function investigate(
  p: PreparedAnalysis,
  model: ResolvedAnalysisModel,
  config: Pick<ResolvedConfig, 'analysis'>,
): Promise<{ reads: ToolRead[]; usage: { inputTokens: number; outputTokens: number } }> {
  const result = await generateText({
    model: model.fake ? fakeSummaryModel(p) : await providerModel(model),
    system: SUMMARY_TOOLS_PROMPT,
    prompt: promptOf(p.digest),
    tools: summaryTools(p, config.analysis.maxInputTokens * 4),
    stopWhen: stepCountIs(SUMMARY_STEPS),
    prepareStep: ({ stepNumber }) =>
      stepNumber === SUMMARY_STEPS - 1 ? { toolChoice: 'none' as const } : undefined,
    temperature: 0.2,
    maxOutputTokens: config.analysis.maxOutputTokens,
    maxRetries: 3,
  })
  return {
    reads: result.steps.flatMap((s) =>
      s.toolResults.map((r) => ({ tool: r.toolName, input: r.input, output: r.output })),
    ),
    usage: {
      inputTokens: result.totalUsage?.inputTokens ?? 0,
      outputTokens: result.totalUsage?.outputTokens ?? 0,
    },
  }
}

export type RunSummary = { doc: AnalysisDoc; key: string; path: string }

/**
 * Writes the run's summary into the cache. A failed call is cached as a document with `error`, never
 * a throw; only reading the run (before any call) can throw.
 */
export async function writeRunSummary(options: {
  config: ResolvedConfig
  runId: string
  model: ResolvedAnalysisModel
}): Promise<RunSummary> {
  const { config, runId, model } = options
  const entries = await allRuns(config)
  const head = entries.find((e) => e.runId === runId)
  if (!head) throw new Error(`${runId} isn't in .reeval/runs`)
  const prepared = await prepareAnalysis(
    config,
    head,
    await defaultBase(config, entries, head),
    null,
  )
  const started = Date.now()
  let doc: AnalysisDoc
  try {
    const { reads, usage } = await investigate(prepared, model, config)
    doc = await analyseDigest(config, prepared, model, toolReads(reads))
    const plus = (a: number | null, b: number) => (a === null ? null : a + b)
    doc.usage = {
      inputTokens: plus(doc.usage.inputTokens, usage.inputTokens),
      outputTokens: plus(doc.usage.outputTokens, usage.outputTokens),
    }
    doc.latencyMs = Date.now() - started
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    doc = await failedAnalysis(config, prepared, model, message, Date.now() - started)
  }
  const path = await writeCached(config.root, prepared.key, doc)
  return { doc, key: prepared.key, path }
}

type PromptPart = { type: string; toolName?: string }

/**
 * A language model that reads as the prompt asks a real one to: the dropped evidence and the
 * failing attempts, a few of each, in one round, then says it's done, through the AI SDK's own tool
 * loop, so the tools and the budget run as they would.
 */
function fakeSummaryModel(p: PreparedAnalysis): LanguageModel {
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  }
  const answer = (content: unknown[], finish: 'stop' | 'tool-calls') => ({
    content,
    finishReason: { unified: finish, raw: finish === 'stop' ? 'stop' : 'tool_calls' },
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
      const readSome = options.prompt.some(
        (m) =>
          m.role === 'tool' &&
          Array.isArray(m.content) &&
          (m.content as PromptPart[]).some((c) => c.type === 'tool-result'),
      )
      const calls = [
        ...p.digest.dropped
          .slice(0, FAKE_READS)
          .map((id) => ({ name: 'read_evidence', input: { id } })),
        ...Object.entries(p.digest.attempts)
          .filter(([, a]) => a.outcome === 'fail')
          .slice(0, FAKE_READS)
          .map(([id]) => ({ name: 'open_attempt', input: { id } })),
      ]
      if (readSome || !calls.length) {
        return answer(
          [{ type: 'text', text: `Read ${readSome ? 'what I needed' : 'nothing'}.` }],
          'stop',
        )
      }
      return answer(
        calls.map((c, i) => ({
          type: 'tool-call',
          toolCallId: `fake_${c.name}_${i}`,
          toolName: c.name,
          input: JSON.stringify(c.input),
        })),
        'tool-calls',
      )
    },
    doStream: async () => {
      throw new Error('the fake analysis model does not stream')
    },
  } as unknown as LanguageModel
}
