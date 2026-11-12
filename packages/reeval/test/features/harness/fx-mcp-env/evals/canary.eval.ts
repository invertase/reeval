import { evaluate, expect } from 'reeval'
import { LOG, own, probedLines, prompt } from './env.ts'

// Must fail: the server's own PROBE_WORD wins over the eval's.
evaluate('canary', { environments: own }, async (c) => {
  await c.send(prompt)
  expect(probedLines(await c.readFile(LOG))).toContain('word=HERON-41')
})
