import { evaluate, expect } from 'reeval'
import { BLOCKED_HOST, closed, prompts, reach, trimmed } from './probes.ts'

// Under deny-all the harness's automatic hosts stay open, so the agent works; any other host is
// refused at CONNECT (403). contract.test.ts checks the record: the refusal and the API reached.
evaluate('egress', { environment: closed }, async (c) => {
  const turn = await c.send(prompts.egress)
  expect(turn.status).toBe('completed')
  expect(await trimmed(c.readFile, 'blocked.txt')).toMatch(/^403 /)
})

// Must fail: the blocked host is refused without a turn too, so it never answers 200.
evaluate('egress canary', { environment: closed }, async (c) => {
  await c.exec(`${reach(BLOCKED_HOST)} || true`)
  expect(await trimmed(c.readFile, 'blocked.txt')).toMatch(/^200 /)
})
