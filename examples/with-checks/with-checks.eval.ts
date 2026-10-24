import { evaluate, expect } from 'reeval'

// Exits 0 only if greet('Ada') returns "Hello, Ada!".
const greetsAda = `node -e "import('./greet.js').then((m) =>
  process.exit((m.greet ?? m.default)('Ada') === 'Hello, Ada!' ? 0 : 1))"`

evaluate('creates a tested greet module', async (c) => {
  const turn = await c.send(
    'Create greet.js exporting greet(name) that returns "Hello, <name>!", and greet.test.js ' +
      'that tests it with node:test. Add a package.json with "type": "module". No dependencies.',
  )

  await expect(turn).toHaveFile('greet.js', /export/)
  expect(await c.readFile('package.json')).toMatch(/"type":\s*"module"/)
  await expect(c.exec('node --test')).toSucceed()
  await expect(c.exec(greetsAda)).toSucceed()
})
