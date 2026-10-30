import { evaluate, expect } from 'reeval'
import { closed, prompt, varsSeen } from './env.ts'

// Must fail: the agent's shell has the eval's project.
evaluate('canary', { environment: closed }, async (c) => {
  await c.send(prompt)
  const vars = varsSeen(await c.readFile('vars.txt'))
  expect(vars).not.toContain('GCP_PROJECT_ID=eval-project')
})
