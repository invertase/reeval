import { evaluate, expect, group } from 'reeval'

// Exits 0 only if greet() with no arguments returns "Hello, world!".
const callGreetWithNoArgs = `node -e "import('./greet.js').then((m) => {
  const greet = m.greet ?? m.default?.greet ?? m.default
  process.exit(greet() === 'Hello, world!' ? 0 : 1)
})"`

// What each judge here reads: the turn, the changed files and the commands the agent ran.
const sees = { task: true, output: true, files: true, diff: true, transcript: 'tools' } as const

group('greet module', () => {
  evaluate('creates a tested greet module', async (c) => {
    const turn = await c.send(
      'Create greet.js exporting greet(name) that returns "Hello, <name>!", ' +
        'and greet.test.js that tests it with node:test. No dependencies.',
    )

    await expect(turn).toHaveFile('greet.js')
    await expect(c.exec('node --test')).toSucceed()

    expect(
      await c.judge("Does the agent's final message accurately describe what it changed?", sees),
    ).toPass()
  })

  evaluate('adds a default name in a follow-up turn', async (c) => {
    await c.send(
      'Create greet.js exporting greet(name) that returns "Hello, <name>!". No dependencies.',
    )
    await c.send('Make name default to "world" when greet() is called without arguments.')

    await expect(c.exec(callGreetWithNoArgs)).toSucceed()
    expect(
      await c.judge('Did the agent add the default without breaking greet(name)?', sees),
    ).toPass()
  })
})
