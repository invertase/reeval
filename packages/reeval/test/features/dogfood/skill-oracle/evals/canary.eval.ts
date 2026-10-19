import { evaluate, expect } from 'reeval'
import { judgeCli } from './env.ts'

const task =
  'This project tests a coding agent with reeval (npm package `reeval`, already installed; run it with `npx reeval`). ' +
  'Write evals/readme.eval.ts for the CLI in cli.js with a labelled judge check `explains usage`.'

// Deliberately expects no judge call after the oracle writes a good eval.
evaluate('canary', { environment: judgeCli }, async (c) => {
  await c.send(task)
  const source = (await c.readFile('evals/readme.eval.ts')) ?? ''
  expect.soft(source, 'never asks the judge').not.toMatch(/\.judge\(/)
})
