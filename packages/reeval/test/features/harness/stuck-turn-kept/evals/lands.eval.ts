import { evaluate } from 'reeval'
import { plain } from './env.ts'

// A turn that doesn't stop when the eval's timeout aborts it keeps what it did before reeval
// stopped waiting: its command, its edit and its usage (features.test.ts checks the record).
evaluate('lands', { environments: plain, timeout: '4s' }, async (c) => {
  await c.send('Run `echo step-1`, write notes.txt, then wait.')
})
