import { defineEnvironment, evaluate, expect, group } from 'reeval'

const fixtures = defineEnvironment('user-fixtures', ({ file }) => ({
  files: { 'scripts/prepare-fixture.js': file('../scripts/prepare-fixture.js') },
  setup: ['node scripts/prepare-fixtures.js'],
}))

group('users', { environment: fixtures }, () => {
  evaluate('counts the users', async (c) => {
    await c.send('Write count.js, which prints how many users data/users.json has.')
    const run = await c.exec('node count.js')
    expect(run.stdout.trim(), 'prints 3').toBe('3')
  })
})
