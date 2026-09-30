import { evaluate, expect } from 'reeval'
import { planted, prompts, scan, scanned } from './probes.ts'

// After a real turn (the harness has authenticated), the harness's real key is nowhere in the
// container: no process's environment or command line, no file. The scanner gets only hashes of
// the key's forms (REEVAL_CONTRACT_KEY_TARGETS, from contract.test.ts), never the key.
evaluate('key', { environment: scanned }, async (c) => {
  const turn = await c.send(prompts.key)
  expect(turn.status).toBe('completed')
  const found = await scan(c.exec, process.env.REEVAL_CONTRACT_KEY_TARGETS ?? '[]')
  expect(found.files).toBeGreaterThan(0)
  expect(found.hits).toEqual([])
})

// Must fail: the same scan for a value planted in the environment and a home file finds it.
evaluate('key canary', { environment: planted }, async (c) => {
  await c.sandbox()
  const found = await scan(c.exec, process.env.REEVAL_CONTRACT_PLANTED_TARGETS ?? '[]')
  expect(found.hits).toEqual([])
})
