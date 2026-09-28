import { evaluate, expect, group } from 'evalsuite'

// Exits 0 only if greet() with no arguments returns "Hello, world!".
const callGreetWithNoArgs = `node -e "import('./greet.js').then((m) => {
  const greet = m.greet ?? m.default?.greet ?? m.default
  process.exit(greet() === 'Hello, world!' ? 0 : 1)
})"`

group('greet module', () => {
  evaluate('creates a tested greet module', async (t) => {
    const turn = await t.send(
      'Create greet.js exporting greet(name) that returns "Hello, <name>!", ' +
        'and greet.test.js that tests it with node:test. No dependencies.',
    )

    await expect(turn).toHaveFile('greet.js')
    await expect(t.exec('node --test')).toSucceed()

    expect(
      await t.judge("Does the agent's final message accurately describe what it changed?"),
    ).toPass()
  })

  evaluate('adds a default name in a follow-up turn', async (t) => {
    await t.send(
      'Create greet.js exporting greet(name) that returns "Hello, <name>!". No dependencies.',
    )
    await t.send('Make name default to "world" when greet() is called without arguments.')

    await expect(t.exec(callGreetWithNoArgs)).toSucceed()
    expect(await t.judge('Did the agent add the default without breaking greet(name)?')).toPass()
  })
})
