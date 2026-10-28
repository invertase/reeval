import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project, where users.js and orders.js each parse records the same way.
const records = defineEnvironment('records', ({ directory }) => ({ files: directory('./project') }))

evaluate('extracts the duplicated parsing', { environment: records }, async (c) => {
  await c.send(
    'src/users.js and src/orders.js parse records the same way. Move that parsing into ' +
      'src/parse.js and use it from both, without changing what they return.',
  )

  await expect(c).toHaveFile('src/parse.js', /export function/)
  await expect(c.exec('node --test')).toSucceed()
  expect(c, 'tests unchanged').not.toHaveChanged(['test/**'])
  const question = 'Is the parsing loop gone from users.js and orders.js, both now using parse.js?'
  expect(await c.judge(question, { diff: ['src/**'] })).toPass()
})
