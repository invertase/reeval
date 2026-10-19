import { evaluate, expect } from 'reeval'
import { judgeCli } from './env.ts'

const task =
  'This project tests a coding agent with reeval (npm package `reeval`, already installed; run it with `npx reeval`). ' +
  'Write evals/readme.eval.ts: an eval that asks the agent to write README.md for the CLI in ' +
  'cli.js. Check deterministically that README.md exists and mentions `--help`, and ask the ' +
  "LLM judge whether the README explains how to install and run the CLI, labelling that judge's " +
  'check `explains usage`. It must typecheck with `npx tsc -p .` and pass with `npx reeval run`.'

evaluate('lands', { environment: judgeCli }, async (c) => {
  await c.send(task)
  const source = (await c.readFile('evals/readme.eval.ts')) ?? ''
  expect.soft(source, 'writes evals/readme.eval.ts').not.toBe('')
  await expect.soft(c.exec('./node_modules/.bin/tsc -p .'), 'typechecks').toSucceed()
  await expect
    .soft(c.exec('./node_modules/.bin/reeval run --ui plain'), 'passes on fake config')
    .toSucceed()
  expect.soft(source, 'asks the judge').toMatch(/\.judge\(/)
})
