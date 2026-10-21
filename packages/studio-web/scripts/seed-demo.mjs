// Builds a throwaway reeval project with real run history for studio development, screenshots and
// tests: a copy of examples/hello with a few commits and recorded fake runs (passing, failing, CI,
// multi-cell with a compared skill environment, and its answered and failed compare questions),
// plus one unrecorded scratch run.
//
//   node packages/studio-web/scripts/seed-demo.mjs [dir]    (default: $TMPDIR/reeval-studio-demo)
import { spawnSync } from 'node:child_process'
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(repo, 'packages/reeval/dist/cli.js')
const dir = resolve(process.argv[2] ?? join(tmpdir(), 'reeval-studio-demo'))

const sh = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', REEVAL_UI: 'plain', CI: '', GITHUB_ACTIONS: '', ...env },
  })
  if (r.error) throw r.error
  return r
}
const git = (...args) => {
  const r = sh('git', args)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}
const commit = (message, who) => {
  git('config', 'user.name', who)
  // Records stay untracked here, so switching branches keeps every run visible.
  git('add', '-A', '--', '.', ':!evals/.history')
  git('commit', '-qm', message)
}
const reeval = (args, env) => {
  const r = sh(process.execPath, [cli, ...args], env)
  const last = r.stdout.trim().split('\n').slice(-3).join('\n')
  console.log(`$ reeval ${args.join(' ')}  (exit ${r.status})\n${last}\n`)
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: the fake agent's file content
const GREET = "export function greet(name = 'world') {\n  return `Hello, ${name}!`\n}\n"
const GREET_TEST = [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { greet } from './greet.js'",
  '',
  "test('greets by name', () => assert.equal(greet('Ada'), 'Hello, Ada!'))",
  '',
].join('\n')
const PKG = '{ "type": "module" }\n'

const tools = [
  {
    tool: 'shell',
    input: { command: 'ls -la' },
    output: 'total 0\ndrwxr-xr-x  2 agent agent  64 .\n',
  },
  {
    tool: 'read',
    input: { path: 'package.json' },
    output: 'No such file: package.json',
    ok: false,
  },
]
const reasoning =
  'The workspace is empty, so I need to create greet.js from scratch. The task asks for node:test, which ships with Node, so no dependencies are needed. I will add a package.json with "type": "module" so the ES module imports work.'

const harness = (options) => `fakeHarness(${JSON.stringify(options, null, 2)})`

/** The demo model's reply to review.eval.ts's second question, which the studio shows. */
const QUESTION_ERROR = 'Rate limit exceeded (429): the demo model refuses this question'

// Both arms write greet.js and neither agent flakes here, so every attempt passes its checks and
// every pair of the compare is judged: the studio test needs both cuts' win rates on every seed.
const REVIEW = `import { evaluate, expect } from 'reeval'
import { plain, withHouseGreeting } from './environments.ts'

evaluate(
  'reviews a greet module',
  {
    harness: (inherited) => inherited.map((h) => (h.kind === 'fake' ? { ...h, flakeRate: 0 } : h)),
    compare: {
      baseline: plain,
      variants: [withHouseGreeting],
      questions: [
        'Which greet.js reads more like our house style?',
        'Which greet.js handles a missing name?',
      ],
    },
  },
  async (c) => {
    await c.send('Create greet.js exporting greet(name).')
    await expect(c).toHaveFile('greet.js')
  },
)
`

const config = ({
  include,
  harnesses,
  judge = 0.95,
  extra = '',
}) => `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  include: ${JSON.stringify(include)},
  harness: [${harnesses.join(', ')}],
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: ${judge} }), state: { transcript: 'tools' } },
  // Answers the compare questions: the attempt whose diff says Ahoy wins, then the one that
  // defaults the name. review.eval.ts's second question fails at the model.
  analysis: {
    insights: false,
    model: fakeAnalysis({
      vote: (p) => {
        if (p.question.includes('missing name')) throw new Error('${QUESTION_ERROR}')
        const score = (diff) => (diff.includes('Ahoy') ? 2 : 0) + (diff.includes("name = 'world'") ? 1 : 0)
        const [a, b] = [score(p.a.diff ?? ''), score(p.b.diff ?? '')]
        return a === b ? 'tie' : a > b ? 'A' : 'B'
      },
    }),
  },
  timeout: '2m',
  ${extra}
})
`

const good = {
  files: { 'greet.js': GREET, 'greet.test.js': GREET_TEST, 'package.json': PKG },
  text: 'I created greet.js exporting greet(name), and greet.test.js which tests it with node:test.',
  reasoning,
  tools,
}

await rm(dir, { recursive: true, force: true })
await mkdir(dir, { recursive: true })
await cp(join(repo, 'examples/hello'), dir, {
  recursive: true,
  // `.env*` holds the developer's real keys; the demo commits everything it copies.
  filter: (src) => !/[\\/](node_modules|\.reeval|\.history|\.env[^\\/]*)([\\/]|$)/.test(src),
})
await writeFile(
  join(dir, 'tsconfig.json'),
  '{ "compilerOptions": { "target": "es2023", "module": "nodenext", "strict": true, "skipLibCheck": true } }\n',
)
await mkdir(join(dir, 'node_modules'), { recursive: true })
await symlink(join(repo, 'packages/reeval'), join(dir, 'node_modules/reeval'), 'dir')
await writeFile(join(dir, '.gitignore'), 'node_modules/\n.reeval/\n')

const include = ['evals/hello.eval.ts', 'evals/preferences.eval.ts']
await writeFile(join(dir, 'reeval.demo.config.ts'), config({ include, harnesses: [harness(good)] }))
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'demo@example.com')
commit('feat: greet module evals', 'Ada Lovelace')
reeval(['run', '--config', 'reeval.demo.config.ts', '--record'])

// A regression with the same agent: a stricter judge fails every judged eval. Fingerprints
// match, so reeval compare calls these regressed rather than not comparable.
await writeFile(
  join(dir, 'reeval.demo.config.ts'),
  config({ include, judge: 0.42, harnesses: [harness(good)] }),
)
git('checkout', '-q', '-b', 'stricter-judge')
commit('test: try a stricter judge', 'Grace Hopper')
reeval(['run', '--config', 'reeval.demo.config.ts', '--record'])

// Back on main, from CI.
git('checkout', '-q', 'main')
reeval(['run', '--config', 'reeval.demo.config.ts', '--record'], {
  CI: '1',
  GITHUB_ACTIONS: 'true',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'invertase/reeval-demo',
  GITHUB_RUN_ID: '9182736450',
  GITHUB_RUN_ATTEMPT: '1',
})

// A matrix: two agents, each with skill.eval.ts's and review.eval.ts's control and house-greeting
// variant, three runs per cell. Only the careful agent's greeting defaults the name.
// biome-ignore lint/suspicious/noTemplateCurlyInString: the fake agent's file content
const AHOY = "export function greet(name = 'world') {\n  return `Ahoy, ${name}!`\n}\n"
// biome-ignore lint/suspicious/noTemplateCurlyInString: the fake agent's file content
const TERSE_AHOY = 'export const greet = (name) => `Ahoy, ${name}!`\n'
await writeFile(join(dir, 'evals/review.eval.ts'), REVIEW)
await writeFile(
  join(dir, 'reeval.matrix.config.ts'),
  config({
    include: ['evals/hello.eval.ts', 'evals/skill.eval.ts', 'evals/review.eval.ts'],
    harnesses: [
      harness({
        ...good,
        id: 'careful',
        withSkill: {
          files: { 'greet.js': AHOY, 'package.json': PKG },
          text: 'I followed the house-greeting skill: greet() says Ahoy.',
        },
      }),
      harness({
        ...good,
        id: 'hasty',
        flakeRate: 0.35,
        withSkill: { files: { 'greet.js': TERSE_AHOY, 'package.json': PKG } },
      }),
    ],
    extra: 'runs: 3,',
  }),
)
commit('feat: compare agents with and without the house-greeting skill', 'Ada Lovelace')
reeval(['run', '--config', 'reeval.matrix.config.ts', '--record'])

// An unrecorded run with uncommitted changes: shows up as scratch.
await writeFile(join(dir, 'NOTES.md'), 'Trying a stricter judge threshold.\n')
await writeFile(
  join(dir, 'reeval.scratch.config.ts'),
  config({ include, harnesses: [harness(good)] }),
)
reeval(['run', '--config', 'reeval.scratch.config.ts'])

console.log(
  `Demo project: ${dir}\nRun: node ${cli} studio --config ${join(dir, 'reeval.demo.config.ts')}`,
)
