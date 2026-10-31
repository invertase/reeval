import { evaluate, expect } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Results: a pass, a failed check with one that never ran after it, a check that fails one try
// of two, a throw no check explains, an infra error, and a skipped and a todo eval.
evaluate('writes greet.js', async (c) => {
  await c.send('Write greet.js.')
  await expect(c, 'writes greet.js').toHaveFile('greet.js')
})

evaluate('greets in French', async (c) => {
  await c.send('Write greet.js that greets in French.')
  await expect.soft(c, 'writes greet.js').toHaveFile('greet.js')
  await expect(c.exec('grep -q Bonjour greet.js'), 'french greeting').toSucceed()
  await expect(c.exec('grep -q Salut greet.js'), 'informal greeting').toSucceed()
})

evaluate('explains why greet.js fails', { runs: 2 }, async (c) => {
  await c.send('Why does greet.js fail?')
  await expect.soft(c, 'writes greet.js').toHaveFile('greet.js')
  await expect(
    c.attempt.n === 1 ? 'the name is null' : 'Docker is down',
    'names the root cause',
  ).toContain('null')
})

evaluate('reads the fixture repo', async (c) => {
  await c.send('Read the fixture repo.')
  throw new Error('the fixture repo is missing')
})

evaluate(
  'starts its sandbox',
  { harnesses: fakeHarness({ id: 'broken', failWith: 'the fake sandbox fell over' }) },
  async (c) => {
    await c.send('Write greet.js.')
  },
)

evaluate.skip('greets in Welsh', async () => {})

evaluate.todo('greets in Klingon')
