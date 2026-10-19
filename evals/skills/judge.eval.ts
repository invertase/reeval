import { evaluate, expect, group } from 'reeval'
import { channels, PREAMBLE, project } from './utils/channels.ts'
import { dryRun, runsOnFake, typechecks } from './utils/checks.ts'

const task =
  PREAMBLE +
  'Write evals/readme.eval.ts: an eval that asks the agent to write README.md for the CLI in ' +
  'cli.js. Check deterministically that README.md exists and mentions `--help`, and ask the ' +
  "LLM judge whether the README explains how to install and run the CLI, labelling that judge's " +
  'check `explains usage`. It must typecheck with `npx tsc -p .` and pass with `npx reeval run`.'

group(
  'write an eval with a judge',
  { compare: { ...channels(project('cli', 'judge')), gate: 'none' } },
  () => {
    evaluate('writes a judged eval', async (c) => {
      await c.send(task)
      const source = (await c.readFile('evals/readme.eval.ts')) ?? ''
      expect.soft(source, 'writes evals/readme.eval.ts').not.toBe('')
      await expect.soft(c.exec(typechecks), 'typechecks').toSucceed()
      const { plan } = await dryRun(c)
      expect.soft(plan?.totals.evals, 'plans one eval').toBe(1)
      await expect.soft(c.exec(runsOnFake), 'passes on the fake config').toSucceed()
      expect.soft(source, 'asks the judge').toMatch(/\.judge\(/)
      expect.soft(source, 'labels the judge check').toMatch(/['"`]explains usage['"`]/)
      expect.soft(source, 'checks README.md deterministically').toMatch(/README\.md/)
      expect.soft(source, 'checks --help').toMatch(/--help/)
    })
  },
)
