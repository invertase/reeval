import { evaluate, expect } from 'reeval'
import { contractHarness } from '../harness.ts'
import { notes, prompts, trimmed } from './probes.ts'

// A task the model has to think about, on a model of the row's that shows its thinking
// (REEVAL_CONTRACT_REASONING_MODEL): contract.test.ts checks the transcript has the reasoning's
// text and the turn its time. Tagged so a row with no such model leaves it out with
// --tag '!reasoning'.
evaluate(
  'reasoning',
  {
    environments: notes,
    harnesses: contractHarness(undefined, process.env.REEVAL_CONTRACT_REASONING_MODEL),
    tags: ['reasoning'],
  },
  async (c) => {
    await c.send(prompts.reasoning)
    expect(await trimmed(c.readFile, 'primes.txt')).toBe('97')
  },
)
