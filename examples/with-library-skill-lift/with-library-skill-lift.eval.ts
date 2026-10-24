import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

// The small package in ./project is the control; the variant adds a published skill, fetched
// from its repository at a pinned commit.
const usersApi = defineEnvironment('users-api', ({ directory }) => ({
  files: directory('./project'),
}))
const withSkill = usersApi.extendEnvironment('api-conventions', ({ skill }) => ({
  skills: [
    skill.git('github:invertase/reeval', {
      ref: 'af7517232dddb419f8241f37bf07670b67e29c7c',
      path: 'examples/hello/skills',
      only: ['api-conventions'],
    }),
  ],
}))
const conventions = readFileSync(new URL('./checks/conventions.test.js', import.meta.url), 'utf8')

evaluate(
  'pages the users list by the API conventions',
  // No baseline, so the eval's environment is the control. Four tries a side is the fewest that
  // gives a verdict; the variant passes on 3 of 4 or more.
  { environment: usersApi, compare: { variants: [withSkill] }, runs: 4, gate: { passRate: 0.75 } },
  async (c) => {
    await c.send(
      'Add a GET /users handler to src/api.js: listUsers(query) takes the query parameters as ' +
        'an object of strings, returns { status, body }, and lists src/users.js a page at a ' +
        'time. Add tests that node --test runs.',
    )

    await expect.soft(c.exec('node --test'), 'tests pass').toSucceed()
    await c.writeFile('test/conventions.test.js', conventions)
    const run = c.exec('node --test test/conventions.test.js')
    await expect(run, 'follows the API conventions').toSucceed()
  },
)
