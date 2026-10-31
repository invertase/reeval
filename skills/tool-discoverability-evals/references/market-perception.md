# Market perception template

Use when the question is "does the design agents recommend lead to the tool?". The developer
asks how to architect a system, before any vendor is named. The judge checks whether the
recommended pattern is the one the tool implements, as `reference.md` describes it.

```ts
// evals/discoverability/market-perception.eval.ts
import { readFileSync } from 'node:fs'
import { evaluate, expect } from 'reeval'
import { suite } from './suite.ts'

// reference.md has a short section on the tool's core pattern: how it works,
// in terms that don't depend on its name (for a flags service: evaluation at
// the edge from a streamed ruleset, no request to a server per check).
const reference = readFileSync(
  new URL('./reference.md', import.meta.url),
  'utf8',
)

// Architecture questions in the tool's problem space. None names a vendor,
// a product or the pattern itself.
const asks = [
  { topic: 'feature flags', prompt: 'How should I architect feature flags for a low-latency API?' },
  { topic: 'A/B tests', prompt: 'How do we run A/B tests without slowing down requests?' },
  // … six or more
]

evaluate.each(asks)(
  'recommends a design acme-flags fits for $topic',
  {
    ...suite,
    // Records which product, if any, each reply leads with. Never gates.
    questions: [
      {
        question: 'Which product or library does the reply recommend first, if any?',
        choices: ['acme-flags', 'rival-one', 'rival-two', 'build it yourself', 'none'],
      },
    ],
  },
  async (c, { prompt }) => {
    const turn = await c.send(prompt)
    expect(
      await c.judge(
        'Is the architecture the reply recommends the pattern reference describes?',
        { on: { reply: turn.text, reference } },
      ),
    ).toPass()
  },
)
```

## Adapting it

- No environment: an architecture question doesn't depend on a repo. Add one only when the
  question names "this service" and needs its stack.
- Describe the pattern in `reference.md` well enough that a design built on a rival with the
  same pattern passes too. The case measures whether agents think in the tool's terms; the
  question's tally shows which product they then name.
- Keep the pattern's vocabulary out of the prompt. "Evaluate flags at the edge" in the prompt
  measures whether the agent agrees with you, not what it recommends.
