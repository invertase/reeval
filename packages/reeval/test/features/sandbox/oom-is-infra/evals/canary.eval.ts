import { evaluate, expect } from 'reeval'
import { small } from './env.ts'

// Must fail as an assertion: the command exits 137 from its own SIGKILL, with no OOM kill.
evaluate('canary', { environment: small }, async (c) => {
  await expect(c.exec('kill -9 $$')).toSucceed()
})
