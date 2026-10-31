import { evaluate, expect } from 'reeval'
import { closed, prompt, VARS, varsSeen } from './env.ts'

// The agent's shell has the eval's values, not the empty ones of a route the attempt isn't on.
evaluate('lands', { environments: closed }, async (c) => {
  await c.send(prompt)
  const vars = varsSeen(await c.readFile('vars.txt'))
  expect(vars).toEqual(
    Object.entries(VARS)
      .map(([name, value]) => `${name}=${value}`)
      .sort(),
  )
})
