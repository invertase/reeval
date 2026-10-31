import { defineEnvironment, evaluate, expect } from 'reeval'

// One directory of a public repository, pinned to a full commit SHA so every run starts from the
// same code. init: true gives the workspace a .git with one commit of that tree.
const math = defineEnvironment('reeval-math', ({ git }) => ({
  workspace: git('github:invertase/reeval', {
    ref: 'f60f255edb8a110d42d2ae4e483bd8555168b854',
    path: 'examples/with-checks/project',
    init: true,
  }),
  files: { '.gitignore': 'node_modules/\n' },
}))

evaluate('adds subtract to a pinned repository', { environments: math }, async (c) => {
  await c.send('Add a subtract(a, b) function to src/math.js, with a test in test/math.test.js.')

  await expect(c.exec('node --test')).toSucceed()
  expect((await c.exec('git status --porcelain')).stdout).toContain(' M src/math.js')
})
