import { evaluate, expect, group } from 'reeval'
import { channels, PREAMBLE, project } from './channels.ts'
import { runsOnFake } from './checks.ts'

const task =
  PREAMBLE +
  'The last `npx reeval run` failed; its results are in .reeval/. Use reeval to find which ' +
  'check failed and why before you change anything. The fake agent in reeval.config.ts is ' +
  'right, so fix the eval, not the config, and keep every check. Rerun until it passes, then ' +
  'tell me the label of the check that failed.'

const failing = project('slug', 'debug', ['./node_modules/.bin/reeval run --ui plain || true'])

group('debug a failing check', { compare: { ...channels(failing), gate: 'none' } }, () => {
  evaluate('finds and fixes the failing check', async (c) => {
    const turn = await c.send(task)
    await expect.soft(c.exec(runsOnFake), 'passes on the fake config').toSucceed()
    expect.soft(c, 'leaves the config alone').not.toHaveChanged(['reeval.config.ts'])
    const source = (await c.readFile('evals/slug.eval.ts')) ?? ''
    expect.soft(source, 'keeps the check').toMatch(/trims punctuation/)
    expect.soft(source, 'expects a single hyphen').toMatch(/ahoy-ada/)
    expect.soft(turn.text, 'names the failed check').toMatch(/trims punctuation/)
  })
})
