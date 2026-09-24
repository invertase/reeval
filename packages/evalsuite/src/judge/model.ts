import { google } from '@ai-sdk/google'
import { generateText, Output } from 'ai'
import { z } from 'zod'
import type { Verdict } from '../types.ts'
import type { JudgeInput } from './index.ts'

const MAX_PATCH_CHARS = 60_000

const schema = z.object({
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  reason: z.string().describe('One or two sentences explaining the verdict.'),
  evidence: z
    .array(z.string())
    .describe('Short quotes from the final message or the diff that support the verdict.'),
})

const SYSTEM = `You grade the work of an AI coding agent.
Answer the question using only the task, the agent's final message and the diff of its changes.
Cite evidence: short, exact quotes from the final message or the diff. If you cannot cite any
evidence either way, answer "inconclusive". Never guess.`

export async function judgeWithModel(
  model: string,
  input: JudgeInput,
  signal: AbortSignal,
): Promise<Verdict> {
  const patch =
    input.diff.patch.length > MAX_PATCH_CHARS
      ? `${input.diff.patch.slice(0, MAX_PATCH_CHARS)}\n[diff truncated]`
      : input.diff.patch
  const { output } = await generateText({
    model: google(model),
    system: SYSTEM,
    prompt: [
      `## Task given to the agent\n${input.prompt}`,
      `## Agent's final message\n${input.text || '(empty)'}`,
      `## Files changed\n${input.diff.files.map((f) => `${f.status} ${f.path}`).join('\n') || '(none)'}`,
      `## Diff\n\`\`\`diff\n${patch || '(no changes)'}\n\`\`\``,
      `## Question\n${input.question}`,
    ].join('\n\n'),
    output: Output.object({ schema }),
    abortSignal: signal,
  })
  return output
}
