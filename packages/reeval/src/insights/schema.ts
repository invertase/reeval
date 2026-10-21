// The insight calls' output schemas and system prompts: one classification and one insights call
// per eval, then one headline for the run. Every sentence cites facts by the short ids the model
// is shown (`F1`, `A1#L12`), which become `SuiteResult` paths before the validator, not only the
// prompt, holds them to the plain-language rules. The insights call also returns the eval's
// remarks, by the eval rubric (`rubric.ts`), which the gates in `remarks.ts` hold to its source.
import { z } from 'zod'
import { MODEL_REMARK_KINDS } from '../view/insights.ts'
import { modelRubric, rubricHash } from './rubric.ts'

/** Bumped when a prompt or output schema changes: older insights were asked differently. */
const PROMPT_REVISION = 'insights-v6'

/**
 * The prompts' version: their revision and the rubric's hash, since the rubric is part of the
 * insights prompt (`insights-v6-1a2b3c4d`).
 */
export const insightsPromptVersion = (): string => `${PROMPT_REVISION}-${rubricHash()}`

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
  // Not `.max(3)`: a fourth finding would fail the whole call; the validator drops it instead.
  findings: z.array(sentence).describe('Only when slots.findings: up to three supporting points'),
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
  // `kind` is a string, not an enum: an unknown kind is dropped by the gates, not the whole call.
  remarks: z
    .array(
      z.object({
        kind: z.string().describe(`One of: ${MODEL_REMARK_KINDS.join(', ')}`),
        text: z.string().describe("One plain sentence: what's wrong with the eval"),
        source: z
          .object({
            at: z.string().describe('L<n> of a line in source.lines'),
            quote: z.string().describe("Copied exactly from that line's text"),
          })
          .nullable(),
        evidence: z
          .array(z.string())
          .describe('Fact ids (F1), or attempt lines (A2#L14), showing it mattered in this run'),
        fix: z
          .object({
            at: z.string().describe('L<n> of the line in source.lines to change'),
            edit: z.string().describe('The concrete edit'),
          })
          .nullable(),
      }),
    )
    .describe('Remarks on the eval itself, by the rubric; almost always empty'),
})

export type InsightsOutput = z.infer<typeof insightsSchema>

export const headlineSchema = z.object({ headline: sentence.nullable() })

export type HeadlineOutput = z.infer<typeof headlineSchema>

export const CLASSIFY_PROMPT = `You classify one reeval eval: what one attempt of it tests. reeval runs coding agents on a task and checks the result.

You get the eval's NAME first. The name is the author's statement of what the eval asks: read it first and let it set the question and the subject. Then the prompts the agent was given, the judge questions and the check labels, which confirm the name or contradict it.

- job: choose when the attempt asks the agent to pick or recommend a tool, library, framework or approach and the checks grade which one it picked; finish when it asks the agent to complete a task and the checks grade the result (files, builds, tests, output); other for anything else (explain, debug, answer).
- question: the eval's question in plain words, as a reader would ask it ("Do agents pick Genkit for production AI features?").
- subject.tool: for choose, the tool the eval asks about, as the name writes it; else null. subject.change: what the eval is about adding (a skill, a doc, an MCP server), as its name or its compare says, whether or not it compares tries with and without it; else null.
- name: states-intent when the name says what the eval asks and the checks agree; no-intent when it's a topic, a ticket id or "test N"; contradicts when it names something no check or judge question looks at.
- confidence: low when the name and the checks don't settle the job.
When trimmed is set, reeval left that detail out to fit.`

const INSIGHTS_PROMPT = `You explain one reeval eval's result to the developer who wrote it, in plain words an average developer understands. reeval ran a coding agent on the eval's task, a number of tries per row, and checked each try.

You get the eval (its name is its question), the classification (intent), the slots you may fill, its FACTS (each with an id, F1, and the path it stands for), its attempts (each with an id, A1, its cell's fact id, the final message and, for a failed try, transcript lines L<n>) and its source (the eval's declaration in its file, each line L<n>).

Rules, checked by code: a sentence that breaks one is dropped.
- Every sentence cites at least one fact by its id from facts[].id (F3), or <attempt id>#L<n> (A2#L14) for a line in that attempt's lines. Cite the facts whose numbers and words you use; never cite a path.
- Ids go in cites only, never in the text: the reader never sees them.
- Numbers come from the cited facts. Counts read "passed N of M tries", as the facts count passes; after "failed" a count is the failures ("failed 4 of 4 tries" when 0 of 4 passed). Never a percentage below 10 tries.
- An effect is said with the cited fact's effect word only: helped, made it worse, no difference, can't tell yet. Never use an effect word the cited facts don't have.
- Use the eval's own names ("with the skill", "plain", "on codex"), never: interval, significance, noise, p-value, confidence, Newcombe, Wilson, pass@1, lift, effect size, too close to call, within noise, control, variant, arm, cell, discriminates.
- Each sentence is 25 words or fewer and leads with the answer. No stacked hedges. Never quote judge questions or thresholds; quote a reply or an assertion only when it is the evidence, in double quotes, copied exactly.
- answer: the answer to intent.question, at most two sentences.
- findings: only when slots.findings; up to three points on what moved, what broke or what the agent did.
- rows: at most one sentence per fact id in slots.rows (row is that id), saying why that row failed or moved; none for other rows.
- namedTools: only when slots.namedTools; for each attempt (attempt is its id), the tools, libraries or frameworks its final message recommended or used, each copied exactly as written there.
- remarks: about the eval itself, not the agent, by the rubric below. Almost always none: raise one only when its kind's section says so and this run's facts show it mattered. Each has kind (only ${MODEL_REMARK_KINDS.join(', ')}), text (one plain sentence of 25 words or fewer), source (at: L<n> of a line in source.lines; quote: copied exactly from that line), evidence (the fact ids or attempt lines from this run that show it) and fix (at: L<n> of the line to change; edit: the concrete edit). One whose quote isn't on its line is dropped. At most one per kind.
When trimmed is set, reeval left that detail out to fit: say nothing about what isn't in the input.
When retry is set, your earlier sentences were refused for those reasons: write them again within the rules.`

/** The insights call's system prompt: the rules, then the rubric's sections on the model's kinds. */
export const insightsPrompt = (): string =>
  `${INSIGHTS_PROMPT}\n\n<rubric>\n${modelRubric(MODEL_REMARK_KINDS)}\n</rubric>`

export const HEADLINE_PROMPT = `You write the one-sentence headline of a reeval run for the developer who wrote its evals: what the run found, leading with what needs work. You get each eval's id (F1), path, name, verdict and answer, and the tally.

- 25 words or fewer, plain words, citing the evals it's about by their ids from evals[].id, in cites only, never in the text.
- Counts come from the evals and the tally. The tally counts results, not evals (tally.unit): each case of a family counts one and \`total\` is their sum ("9 of 22 results fail"). The number of evals is evals.length; never call a tally number evals. "All" needs more than one: a single result is "1 result passed", never "All 1 result passed". Never: interval, significance, noise, p-value, confidence, pass@1, lift, control, variant, arm, cell.
When retry is set, your earlier headline was refused for those reasons: write it again within the rules.`
