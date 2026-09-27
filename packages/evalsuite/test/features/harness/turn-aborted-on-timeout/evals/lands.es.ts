import { evaluate } from 'evalsuite'
import { plain } from './env.ts'

// A turn the eval's timeout cuts off is recorded as aborted, not completed (features.test.ts
// checks the record).
evaluate('lands', { environment: plain, timeout: '4s' }, async (t) => {
  await t.send('Run `sleep 30` in the shell, then reply with the word done.')
})
