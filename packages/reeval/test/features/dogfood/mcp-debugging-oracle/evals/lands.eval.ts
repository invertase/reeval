import { evaluate, expect } from 'reeval'
import { checkPath } from './env.ts'

const intro =
  'This is a reeval project (reeval is an eval runner for coding agents; its CLI is `reeval`, already installed, and it runs here without Docker or API keys).'

const fixTask = `${intro} Its latest run failed.

Find out why, and fix the project so that \`reeval run\` passes. Fix the cause: don't delete or skip checks, and leave reeval.config.ts alone (it is the agent under test and its judge).

Then write answer.json: {"cause": "check-path", "evidence": "<one sentence>"}.`

const parseAnswer = (text: string | null): Record<string, unknown> => {
  try {
    return JSON.parse(text ?? '') as Record<string, unknown>
  } catch {
    return {}
  }
}

evaluate('lands', { environment: checkPath }, async (c) => {
  await c.send(fixTask)
  const answer = parseAnswer(await c.readFile('answer.json'))
  expect.soft(answer.cause, 'names the cause').toBe('check-path')
  await expect
    .soft(c.exec('node_modules/.bin/reeval run --ui plain'), 'reeval run passes')
    .toSucceed()
  expect.soft(c, 'leaves the agent under test alone').not.toHaveChanged(['reeval.config.ts'])
  const source = (await c.readFile('evals/greet.eval.ts')) ?? ''
  expect.soft(source, 'keeps the checks').toMatch(/toHaveFile\(\s*'lib\/greet\.js'/)
})
