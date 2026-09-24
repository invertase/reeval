import { evaluate, expect } from 'evalsuite'

evaluate('creates a tested greet module', async ({ agent, judge }) => {
  const run = await agent.run(
    'Create greet.js exporting greet(name) that returns "Hello, <name>!", ' +
      'and greet.test.js that tests it with node:test. No dependencies.',
  )

  await expect(run).toHaveFile('greet.js')
  await expect(run.exec('node --test')).toSucceed()

  const verdict = await judge(
    run,
    "Does the agent's final message accurately describe what it changed?",
  )
  expect(verdict).toPass()
})
