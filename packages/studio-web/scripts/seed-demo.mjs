// Builds a throwaway reeval project with real run history for studio development, screenshots and
// tests: a copy of examples/hello with a few commits and recorded fake runs (passing, failing, CI,
// multi-cell with a compared skill environment), plus one unrecorded scratch run.
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
const es = (args, env) => {
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
  judge: { model: fakeJudge({ score: ${judge} }) },
  // Answers skill.eval.ts's compare question: the attempt whose diff says Ahoy wins.
  analysis: {
    model: fakeAnalysis({
      vote: (p) =>
        p.a.includes('Ahoy') === p.b.includes('Ahoy') ? 'tie' : p.a.includes('Ahoy') ? 'A' : 'B',
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
es(['run', '--config', 'reeval.demo.config.ts', '--record'])

// A regression with the same agent: a stricter judge fails every judged eval. Fingerprints
// match, so reeval compare calls these regressed rather than not comparable.
await writeFile(
  join(dir, 'reeval.demo.config.ts'),
  config({ include, judge: 0.42, harnesses: [harness(good)] }),
)
git('checkout', '-q', '-b', 'stricter-judge')
commit('test: try a stricter judge', 'Grace Hopper')
es(['run', '--config', 'reeval.demo.config.ts', '--record'])

// Back on main, from CI.
git('checkout', '-q', 'main')
es(['run', '--config', 'reeval.demo.config.ts', '--record'], {
  CI: '1',
  GITHUB_ACTIONS: 'true',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'invertase/reeval-demo',
  GITHUB_RUN_ID: '9182736450',
  GITHUB_RUN_ATTEMPT: '1',
})

// A matrix: two agents, each with skill.eval.ts's control and its house-greeting variant, three
// runs per cell.
// biome-ignore lint/suspicious/noTemplateCurlyInString: the fake agent's file content
const AHOY = "export function greet(name = 'world') {\n  return `Ahoy, ${name}!`\n}\n"
await writeFile(
  join(dir, 'reeval.matrix.config.ts'),
  config({
    include: ['evals/hello.eval.ts', 'evals/skill.eval.ts'],
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
        withSkill: { files: { 'greet.js': AHOY, 'package.json': PKG } },
      }),
    ],
    extra: 'runs: 3,',
  }),
)
commit('feat: compare agents with and without the house-greeting skill', 'Ada Lovelace')
es(['run', '--config', 'reeval.matrix.config.ts', '--record'])

// An unrecorded run with uncommitted changes: shows up as scratch.
await writeFile(join(dir, 'NOTES.md'), 'Trying a stricter judge threshold.\n')
es(['run', '--config', 'reeval.demo.config.ts'])

console.log(
  `Demo project: ${dir}\nRun: node ${cli} studio --config ${join(dir, 'reeval.demo.config.ts')}`,
)
