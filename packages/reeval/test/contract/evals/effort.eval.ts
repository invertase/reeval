import { evaluate, expect } from 'reeval'
import { contractHarness } from '../harness.ts'
import { notes, prompts, trimmed } from './probes.ts'

// The edit-and-run task again, on the row's harness with `effort` set (REEVAL_CONTRACT_EFFORT):
// contract.test.ts checks every model call it made carried the effort where the model takes it,
// and that the edit-and-run attempt's, without it, didn't. Tagged so a row with no effort to
// check leaves it out with --tag '!effort'.
evaluate(
  'effort',
  {
    environment: notes,
    harness: contractHarness(process.env.REEVAL_CONTRACT_EFFORT),
    tags: ['effort'],
  },
  async (c) => {
    await c.send(prompts.editAndRun)
    expect(await trimmed(c.readFile, 'notes.txt')).toBe('status: final')
  },
)
