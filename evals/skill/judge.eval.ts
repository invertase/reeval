import { evaluate, expect, group } from 'reeval'
import { channels, PREAMBLE, project } from './channels.ts'
import { dryRun, runsOnFake, typechecks } from './checks.ts'

const task =
  PREAMBLE +
  'Write evals/readme.eval.ts: an eval that asks the agent to write README.md for the CLI in ' +
  'cli.js. Check deterministically that README.md exists and mentions `--help`, and ask the ' +
  "LLM judge whether the README explains how to install and run the CLI, labeling that judge's " +
  'check `explains usage`. It must typecheck with `npx tsc -p .` and pass with `npx reeval run`.'

group(
  'write an eval with a judge',
  { compare: { ...channels(project('cli', 'judge')), gate: 'none' } },
  () => {
    evaluate('writes a judged eval', async (c) => {
      await c.send(task)
      const source = (await c.readFile('evals/readme.eval.ts')) ?? ''
      expect(source, 'writes evals/readme.eval.ts').not.toBe('')
      await expect(c.exec(typechecks), 'typechecks').toSucceed()
      const { plan } = await dryRun(c)
      expect(plan?.totals.evals, 'plans one eval').toBe(1)
      await expect(c.exec(runsOnFake), 'passes on the fake config').toSucceed()
      expect(source, 'asks the judge').toMatch(/\.judge\(/)
      expect(source, 'labels the judge check').toMatch(/['"`]explains usage['"`]/)
      expect(source, 'checks README.md deterministically').toMatch(/README\.md/)
      expect(source, 'checks --help').toMatch(/--help/)
    })
  },
)
