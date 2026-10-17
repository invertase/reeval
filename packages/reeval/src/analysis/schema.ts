// The one structured call: its output schema and versioned system prompt.
import { z } from 'zod'

const confidence = z.enum(['high', 'medium', 'low'])
const cites = z
  .array(z.string())
  .describe(
    'Ids from the digest: F<n>, E<n>, E<n>:L<line>, an attempt id, or <attempt id>:check<n>',
  )

const claim = z.object({
  text: z.string(),
  cites,
  confidence,
  quotes: z
    .array(z.string())
    .optional()
    .describe('Exact spans copied from the cited evidence, if the claim quotes any'),
})

export const analysisSchema = z.object({
  tldr: z
    .string()
    .describe('One sentence: what happened, how sure, why, next. No fact ids or intervals'),
  whatHappened: z.array(claim),
  results: z
    .array(claim)
    .describe(
      'pass@1 and effort that were measured, each with its noise verdict. insufficient is not measured: never a results line',
    ),
  why: z
    .array(claim)
    .describe('Causes: the thing under test, the eval itself, or reeval/infrastructure'),
  anomalies: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(['reeval-bug', 'eval-design', 'judge', 'noise', 'other']),
      cites,
    }),
  ),
  actions: z
    .array(
      z.object({
        title: z.string(),
        target: z.string().describe('The file, skill, eval or reeval setting to change'),
        kind: z.enum(['skill', 'docs', 'eval', 'judge', 'reeval', 'harness']),
        change: z.string(),
        expectedEffect: z.string().describe('What should measurably change'),
        verify: z
          .string()
          .describe(
            'One reeval command from the CLI list that would show the effect. --tag only if that tag is on setup.evals; otherwise reeval run <id>',
          ),
        impact: z.enum(['high', 'medium', 'low']),
        effort: z.enum(['low', 'medium', 'high']),
        cites,
      }),
    )
    .max(5),
  confidence: z.object({ overall: confidence, why: z.string() }),
})

export type AnalysisOutput = z.infer<typeof analysisSchema>

export const SYSTEM_PROMPT = `You analyse the results of a reeval run for the engineer who wrote the evals.
reeval runs coding agents in sandboxes. A compare eval runs a control cell and variant cells (with a skill, docs or MCP, say) and reports lift in pass@1 (the share of attempts that pass) with a 95% interval, and effort (tool calls, agent time, and tokens when both sides reported usage) next to it.

You get a DIGEST: facts computed deterministically by reeval (ids F1...), evidence excerpts (ids E1...; transcript lines start with their line number L<n>), an attempts table (ids like r2/fix-config/control#1), the RULES reeval used for every verdict, and the CLI.

Rules:
- Every claim cites at least one id from the digest: F<n>, E<n>, E<n>:L<line> for a line the evidence shows, an attempt id, or <attempt id>:check<n>. Never cite anything that isn't in the digest.
- Take numbers from the facts. Don't compute new statistics beyond simple ratios of cited numbers.
- A cited judge score must be the recorded score on that attempt. Do not invent a different number.
- The verdicts in the facts are final: if a lift or effort verdict says within noise, insufficient or not comparable, say so; never call it an effect. insufficient is not measured: never put it on a results line. insufficient on effort is statistical only (too few attempts); a missing token metric is omitted, not insufficient — do not treat unreportedUsage as a result. When sources or the eval fingerprint differ across the compared runs, the first line says the eval changed; that pass@1 difference is not an effect, and mixed counts such as 6/10 vs 8/9 are not a results line. A lift is an effect only when sources match. Name each factor claim's tier (controlled, pooled, observed). Check facts (kind checks) list each expect label on a variant and its control: a both-pass or both-fail check is no evidence for the variant; cite discriminates rows for which requirement separated them. Compare-question facts (kind compare-question) are annotation: win rates, ties, errors and vote reasons never change pass, fail or the exit code. Do not put them on a results line as a gate. A vote's reason is the model's wording: do not treat it as a check.
- Say what can't be attributed (factors that are not_measured).
- Separate causes: the thing under test (skill, docs), the eval itself (task, checks, judge question), and reeval or infrastructure (bugs, fingerprints, harness).
- Explain a failed judge verdict by comparing the cited output with the judge question, and say it's your reading: judges record no reason.
- Actions: at most 5, each with a concrete target, the change, the expected measurable effect, and a verify command that is exactly one of the reeval commands in the CLI list, with only the flags listed for it. A \`--tag\` value must appear on some eval's \`tags\` in the digest. If none does, select that eval with \`reeval run <id>\` using its \`id\` from setup.evals; do not invent a tag from the eval name. "No actions" is a valid answer when nothing is worth doing. No generic advice ("add more tests") without a concrete target.
- Quotes, if any, must be copied exactly from the cited evidence.
- TL;DR: one sentence: what happened, how sure, why, next. No fact ids or intervals.
- Do not rate your own citation or command checks; reeval caps confidence after it checks them.
- Plain, direct English. No hype.`
