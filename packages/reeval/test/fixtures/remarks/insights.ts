// A rule-based stand-in for the insight model that raises one remark per eval it knows, for
// `fakeAnalysis({ insights })`: it reads the `L<n>` source lines and facts each call is shown and
// cites them as a model does, so its remarks go through the same gates with no key. A name with a
// trailing number (`answers kindly 3`) gets its base name's remark. `REMARKS`
// (an env var, a comma list of `kind:part`) breaks one part of a kind's remark, for the canaries.
import type { FakeInsights, FakeInsightsInput } from 'reeval/judge'

type Call = Exclude<FakeInsightsInput, { call: 'headline' }>
type Spec = {
  intent: NonNullable<FakeInsights['intent']>
  kind?: string
  text?: string
  quote?: string
  cite?: 'eval' | 'judge'
  edit?: string
}

const SPECS: Record<string, Spec> = {
  'adds a cache': {
    intent: { job: 'finish', name: 'contradicts' },
    kind: 'name-contradicts',
    text: 'The name says it adds a cache, but the prompt asks to remove the debug logging.',
    quote: 'adds a cache',
    cite: 'eval',
    edit: "rename it to 'removes the debug logging'",
  },
  'test 1': {
    intent: { job: 'other', name: 'no-intent' },
    kind: 'name-no-intent',
    text: "The name doesn't say what the agent should do, so a failure here reads as nothing.",
    quote: 'test 1',
    cite: 'eval',
    edit: "rename it to 'writes a greeting to hello.txt'",
  },
  'answers kindly': {
    intent: { job: 'other' },
    kind: 'judge-too-loose',
    text: 'The judge asks whether the answer is okay, which any reply passes.',
    quote: 'Is the answer okay?',
    cite: 'judge',
    edit: "ask 'Does the reply thank the user by name and offer one next step?'",
  },
  'finds the bug': {
    intent: { job: 'other' },
    kind: 'judge-leaks-answer',
    text: 'The judge question names the off-by-one in parse(), which the prompt never does.',
    quote: 'off-by-one in parse()',
    cite: 'judge',
    edit: "ask 'Does it name the line that causes the failure and why?'",
  },
  'ships the release': {
    intent: { job: 'finish' },
    kind: 'compound-judge',
    text: 'The judge asks three things at once, so a failure doesn’t say which one went wrong.',
    quote: 'add a test and update the changelog',
    cite: 'judge',
    edit: 'split it into three c.judge questions, one per change',
  },
  'picks Genkit': {
    intent: { job: 'choose', subject: { tool: 'Genkit' } },
    kind: 'prompt-names-tool',
    text: 'The prompt asks for Genkit by name, so picking it measures nothing.',
    quote: 'with Genkit',
    cite: 'eval',
    edit: "say 'Build a chat agent in TypeScript' without naming a framework",
  },
  'adds dark mode': { intent: { job: 'finish', subject: { change: 'dark mode' } } },
}

const broken = new Set((process.env.REMARKS ?? '').split(',').filter(Boolean))

const lineOf = (input: Call, needle: string) =>
  input.source?.lines.find((l) => l.includes(needle))?.match(/^L\d+/)?.[0] ?? 'L1'

export function insights(input: FakeInsightsInput): FakeInsights {
  if (input.call === 'headline') return {}
  const spec = SPECS[input.eval.name] ?? SPECS[input.eval.name.replace(/ \d+$/, '')]
  if (!spec) return {}
  if (input.call === 'classify' || !spec.kind || !spec.quote) return { intent: spec.intent }
  const kind = spec.kind
  const off = (part: string) => broken.has(`${kind}:${part}`)
  const at = lineOf(input, spec.quote)
  const fact =
    spec.cite === 'judge'
      ? input.facts.find((f) => (f as { judge?: boolean }).judge)
      : input.facts[0]
  return {
    intent: spec.intent,
    remarks: [
      {
        kind: off('kind') ? 'vague-name' : kind,
        text: spec.text ?? '',
        source: { at: off('line') ? `L${Number(at.slice(1)) + 1}` : at, quote: spec.quote },
        evidence: off('evidence') || !fact ? [] : [fact.id],
        fix: off('fix') ? null : { at, edit: spec.edit ?? '' },
      },
    ],
  }
}
