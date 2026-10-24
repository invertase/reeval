import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

const users = defineEnvironment('users', ({ directory }) => ({ files: directory('./project') }))
const withConventions = users.extendEnvironment('api-conventions', ({ skill }) => ({
  skills: [skill.local('./skills/api-conventions')],
}))
const pagesTest = readFileSync(new URL('./hidden/users.test.js', import.meta.url), 'utf8')

evaluate(
  'pages the user list',
  // No baseline: the eval's own environment, users, is the control.
  { environment: users, compare: { variants: [withConventions] } },
  async (c) => {
    await c.send('Make listUsers() in src/users.js return the users one page at a time.')

    await c.writeFile('test/users.test.js', pagesTest)
    await expect(c.exec('node --test'), 'pages by cursor').toSucceed()
  },
)
