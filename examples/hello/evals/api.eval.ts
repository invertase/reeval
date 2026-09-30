import { defineEnvironment, evaluate, expect } from 'reeval'
import { claudeCode, codex, cursor } from 'reeval/harness'
import { appFiles, probeUsers } from './api/app.ts'

// create-next-app's API template at a tag. No baseline, so it's the control.
const nextApi = defineEnvironment('nextjs-api', ({ git }) => ({
  workspace: git('github:vercel/next.js', {
    ref: 'v16.3.7',
    path: 'packages/create-next-app/templates/app-api/ts',
  }),
  files: appFiles, // package.json, and lib/users.ts to list
  setup: ['mv gitignore .gitignore', 'npm install --no-audit --no-fund'],
}))

const withSkill = nextApi.extendEnvironment('with-api-conventions', ({ skill }) => ({
  skills: [
    skill.git('github:invertase/reeval', {
      ref: '052108cae3ca4c9d1bad1e6b527d76bdf11fd4cc',
      path: 'examples/hello/skills',
      only: ['api-conventions'],
    }),
  ],
}))

evaluate(
  'how well the api-conventions skill influences the output',
  {
    environment: nextApi,
    harness: [
      cursor({ model: 'composer-2.5' }),
      claudeCode({ model: 'claude-sonnet-5' }),
      codex({ model: 'gpt-5.6-luna' }),
    ],
    runs: 3,
    timeout: '20m',
    compare: {
      variants: [withSkill],
      questions: ['Which endpoint follows our API conventions?'],
    },
  },
  async (c) => {
    await c.send(
      'Add a paginated GET /api/users endpoint (app/api/users/route.ts) ' +
        'over lib/users.ts, with tests that npm test runs.',
    )
    // The route exists and pages by cursor.
    await expect(c).toHaveFile('app/api/users/route.ts', /cursor/i)
    // It builds, types included.
    await expect(c.exec('npm run build')).toSucceed()
    // The agent's own tests pass.
    await expect(c.exec('npm test')).toSucceed()
    // The built route pages as { data, nextCursor } and rejects a bad cursor.
    await expect(c.exec(probeUsers)).toSucceed()
    // A judge for what the checks can't read: do the tests cover it?
    const covered = 'Do the tests follow nextCursor to the end and check invalid_cursor?'
    expect(await c.judge(covered)).toPass()
  },
)
