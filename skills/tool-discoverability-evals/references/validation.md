# Validation template

Use when the question is "do agents know what the tool can do?". The developer asks, before
installing anything, whether the tool supports a requirement. The prompt names the tool; the
judge checks the answer against `reference.md`, the tool's real capabilities, so it grades
against your facts rather than its own memory.

```ts
// evals/discoverability/validation.eval.ts
import { readFileSync } from 'node:fs'
import { evaluate, expect } from 'reeval'
import { neutralApp } from '../environments.ts'
import { suite } from './suite.ts'

// Capabilities and limits, one fact a line, with the version each holds for.
// It stays under evals/, which no environment seeds: the agent never sees it.
const reference = readFileSync(
  new URL('./reference.md', import.meta.url),
  'utf8',
)

// Half the cases ask for something the tool can't do, so an agent that says
// yes to everything fails them.
const asks = [
  {
    need: 'edge runtimes',
    prompt: 'Does the acme-sdk Node client work in an edge runtime?',
    answer: 'yes',
  },
  {
    need: 'inbound email parsing',
    prompt: 'Can acme-sdk parse inbound email with attachments?',
    answer: 'no',
  },
  // … six or more, balanced between yes and no
]

evaluate.each(asks)(
  'knows whether acme-sdk supports $need',
  { ...suite, environment: neutralApp },
  async (c, { prompt, answer }) => {
    // Planning mode: the developer wants an answer before any change.
    const turn = await c.send(`${prompt} Answer before we change anything.`)
    const graded = { question: prompt, reply: turn.text, reference }

    expect.soft(
      await c.judge(`Does the reply's answer to the question amount to "${answer}"?`, {
        on: graded,
      }),
      'right answer',
    ).toPass()
    expect.soft(
      await c.judge(
        'Is every claim the reply makes about acme-sdk consistent with reference?',
        { on: graded },
      ),
      'no invented capabilities',
    ).toPass()
    expect.soft(c, 'changes nothing').not.toHaveChanged(['src/', 'package.json'])
  },
)
```

## Adapting it

- Ask what developers ask in planning: a runtime, a tier or plan limit, an integration, a
  protocol. Pull the cases from support questions and issue threads where you can.
- Write each `reference.md` line as a checkable fact ("Runs in edge runtimes from 4.0"), not
  marketing copy: the judge can only hold the reply to what the reference states.
- A reply that hedges ("probably", "check the docs") without answering fails `right answer`.
  That's intended: the developer still doesn't know.
