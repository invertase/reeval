// The insight calls' output schemas and system prompts: one classification and one insights call
// per eval, then one headline for the run. Every sentence cites facts by the short ids the model
// is shown (`F1`, `A1#L12`), which become `SuiteResult` paths before the validator, not only the
// prompt, holds them to the plain-language rules.
import { z } from 'zod'

/** Bumped when a prompt or output schema changes: older insights were asked differently. */
export const INSIGHTS_PROMPT_VERSION = 'insights-v2'

const sentence = z.object({
  text: z.string(),
  cites: z
    .array(z.string())
    .describe(
      'Fact ids from facts[].id (F1), or <attempt id>#L<n> (A2#L14) for a line in attempts[].lines',
    ),
})

export const classificationSchema = z.object({
  job: z.enum(['choose', 'finish', 'other']),
  question: z.string().describe("The eval's question in plain words, from its name"),
  subject: z.object({
    tool: z.string().nullable().describe('For choose: the tool the eval asks about; else null'),
    change: z
      .string()
      .nullable()
      .describe(
        'When the eval measures a change: what the change adds (a skill, a doc); else null',
      ),
  }),
  name: z.enum(['states-intent', 'no-intent', 'contradicts']),
  confidence: z.enum(['high', 'medium', 'low']),
})

export type ClassificationOutput = z.infer<typeof classificationSchema>

export const insightsSchema = z.object({
  answer: sentence
    .nullable()
    .describe('The answer to the question, at most two sentences; null when the facts give none'),
  findings: z
    .array(sentence)
    .max(3)
    .describe('Only when slots.findings: up to three supporting points'),
  rows: z
    .array(sentence.extend({ row: z.string().describe('A fact id from slots.rows') }))
    .describe('At most one sentence per id in slots.rows; empty when there are none'),
  namedTools: z
    .array(
      z.object({
        attempt: z.string().describe('An attempts[].id (A1)'),
        tools: z.array(z.string()).describe("Each copied exactly as it's written in lastText"),
      }),
    )
    .describe('Only when slots.namedTools: per attempt, the tools its reply recommended or used'),
})

export type InsightsOutput = z.infer<typeof insightsSchema>

export const headlineSchema = z.object({ headline: sentence.nullable() })

export type HeadlineOutput = z.infer<typeof headlineSchema>

export const CLASSIFY_PROMPT = `You classify one reeval eval: what one attempt of it tests. reeval runs coding agents on a task and checks the result.

You get the eval's NAME first. The name is the author's statement of what the eval asks: read it first and let it set the question and the subject. Then the prompts the agent was given, the judge questions and the check labels, which confirm the name or contradict it.

- job: choose when the attempt asks the agent to pick or recommend a tool, library, framework or approach and the checks grade which one it picked; finish when it asks the agent to complete a task and the checks grade the result (files, builds, tests, output); other for anything else (explain, debug, answer).
- question: the eval's question in plain words, as a reader would ask it ("Do agents pick Genkit for production AI features?").
- subject.tool: for choose, the tool the eval asks about, as the name writes it; else null. subject.change: when across is change, what the change adds (a skill, a doc), else null.
- name: states-intent when the name says what the eval asks and the checks agree; no-intent when it's a topic, a ticket id or "test N"; contradicts when it names something no check or judge question looks at.
- confidence: low when the name and the checks don't settle the job.`

export const INSIGHTS_PROMPT = `You explain one reeval eval's result to the developer who wrote it, in plain words an average developer understands. reeval ran a coding agent on the eval's task, a number of tries per row, and checked each try.

You get the eval (its name is its question), the classification (intent), the slots you may fill, its FACTS (each with an id, F1, and the path it stands for) and its attempts (each with an id, A1, its cell's fact id, the final message and, for a failed try, transcript lines L<n>).

Rules, checked by code: a sentence that breaks one is dropped.
- Every sentence cites at least one fact by its id from facts[].id (F3), or <attempt id>#L<n> (A2#L14) for a line in that attempt's lines. Cite the facts whose numbers and words you use; never cite a path.
- Numbers come from the cited facts. Counts read "N of M tries", never a percentage below 10 tries.
- An effect is said with the cited fact's effect word only: helped, made it worse, no difference, can't tell yet. Never use an effect word the cited facts don't have.
- Use the eval's own names ("with the skill", "plain", "on codex"), never: interval, significance, noise, p-value, confidence, Newcombe, Wilson, pass@1, lift, effect size, too close to call, within noise, control, variant, arm, cell, discriminates.
- Each sentence is 25 words or fewer and leads with the answer. No stacked hedges. Never quote judge questions or thresholds; quote a reply or an assertion only when it is the evidence, in double quotes, copied exactly.
- answer: the answer to intent.question, at most two sentences.
- findings: only when slots.findings; up to three points on what moved, what broke or what the agent did.
- rows: at most one sentence per fact id in slots.rows (row is that id), saying why that row failed or moved; none for other rows.
- namedTools: only when slots.namedTools; for each attempt (attempt is its id), the tools, libraries or frameworks its final message recommended or used, each copied exactly as written there.
When retry is set, your earlier sentences were refused for those reasons: write them again within the rules.`

export const HEADLINE_PROMPT = `You write the one-sentence headline of a reeval run for the developer who wrote its evals: what the run found, leading with what needs work. You get each eval's id (F1), path, name, verdict and answer, and the tally.

- 25 words or fewer, plain words, citing the evals it's about by their ids from evals[].id.
- Counts come from the evals and the tally, where each case counts one and \`total\` is their sum ("9 of 22 fail"). Never: interval, significance, noise, p-value, confidence, pass@1, lift, control, variant, arm, cell.
When retry is set, your earlier headline was refused for those reasons: write it again within the rules.`
