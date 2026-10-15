// Git workspaces through the CLI: the repository is fetched on the host before any attempt, its
// ref resolved once and its tree cached by hash; a bad URL, ref, path or token fails only the
// attempts that use it (exit 3), as an eval's sandbox image does; and the agent's diff starts
// from the repository.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { classifyGitError } from '../src/workspace.ts'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'
import { gitHttpServer } from './support/git-http.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

/** `repo/` with `app/greet.js` and `README.md`, tagged v1. */
function makeRepo(dir: string) {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'app'), { recursive: true })
  writeFileSync(join(repo, 'app/greet.js'), "export const greeting = 'Hello'\n")
  writeFileSync(join(repo, 'README.md'), '# app\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'v1')
  git(repo, 'tag', 'v1')
  return repo
}

async function withEval(env: string, body = 'await c.sandbox()', harness?: string) {
  const p = await project('workspace', {
    'reeval.config.ts': fakeConfig(harness ? { harness } : {}),
    'evals/w.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const env = defineEnvironment('app', ({ git }) => ({ sandbox: fakeSandbox(), ${env} }))
evaluate('works on the repo', { environment: env }, async (c) => {
  ${body}
})
evaluate('needs no workspace', async () => {})
`,
  })
  return { ...p, repo: makeRepo(p.dir) }
}

/**
 * A workspace that can't be prepared, reported once before the run as a sandbox's is: only the
 * attempts that use it fail, as infra errors (exit 3), and the other eval still passes.
 */
async function failsOnlyItsAttempts(env: string, message: RegExp, hostEnv: NodeJS.ProcessEnv = {}) {
  const p = await withEval(env)
  const r = await runCli(p.dir, ['run'], { env: hostEnv })
  const output = r.stdout + r.stderr
  assert.equal(r.code, 3, output)
  assert.match(
    output,
    /✗ workspace .+ failed to prepare \(set by environment app; only its attempts fail\)/,
  )
  assert.match(output, message)
  const { run } = readRun(p.dir)
  const outcome = (name: string) =>
    run.evals.find((e) => e.name === name)?.attempts.map((a) => a.outcome)
  assert.deepEqual(outcome('works on the repo'), ['infra_error'])
  assert.deepEqual(outcome('needs no workspace'), ['pass'])
  const error = run.evals.find((e) => e.name === 'works on the repo')?.attempts[0]?.error
  assert.equal(error?.prepare?.stage, 'workspace')
  assert.match(error?.message ?? '', message)
  assert.match(
    error?.message ?? '',
    /set by environment app, failed to prepare before the run started; every attempt that needs it fails with this\)$/,
  )
  return { p, r, run }
}

// Sequential: each case starts a `reeval run` that fetches git. Concurrent cases on a
// 2-vCPU Windows runner starve each other and trip the CLI idle detector.
describe('git workspaces', { concurrency: false }, () => {
  test('a ref the repository lacks fails only the attempts that use it', async () => {
    const { run } = await failsOnlyItsAttempts(
      `workspace: git('../repo', { ref: 'v9' })`,
      /Workspace git\("\.\.\/repo#v9"\): the repository has no ref "v9" \(a branch, tag or commit SHA\)\./,
    )
    const prepare = run.evals.flatMap((e) => e.attempts).find((a) => a.error)?.error?.prepare
    assert.deepEqual(
      [prepare?.class, prepare?.ref, prepare?.setBy],
      ['config', '../repo#v9', ['environment app']],
    )
  })

  test('an abbreviated SHA gets a hint', async () => {
    await failsOnlyItsAttempts(
      `workspace: git('../repo', { ref: 'abc1234' })`,
      /no ref "abc1234".*Give a commit as its full 40-character SHA\./,
    )
  })

  test('a missing subdirectory names what is there', async () => {
    await failsOnlyItsAttempts(
      `workspace: git('../repo', { ref: 'v1', path: 'apps/web' })`,
      /Workspace git\("\.\.\/repo#v1:apps\/web"\) at v1 \(commit [0-9a-f]{7}\) has no directory "apps\/web"; its top level has: README\.md, app\//,
    )
  })

  test('a file as the path is refused', async () => {
    await failsOnlyItsAttempts(
      `workspace: git('../repo', { ref: 'v1', path: 'README.md' })`,
      /"README\.md" is a file, not a directory/,
    )
  })

  test('a path that is not a repository says to check the URL', async () => {
    await failsOnlyItsAttempts(
      `workspace: git('../nowhere', { ref: 'v1' })`,
      /Workspace git\("\.\.\/nowhere#v1"\): couldn't fetch it \(.+\)\. Check the URL; a private repository also needs this machine's git credentials\./,
    )
  })

  test('a token variable that is not set fails only its attempts, naming the variable', async () => {
    await failsOnlyItsAttempts(
      `workspace: git('https://git.example.invalid/acme/app', { ref: 'v1', token: 'REEVAL_TEST_UNSET_TOKEN' })`,
      /Workspace git\("https:\/\/git\.example\.invalid\/acme\/app#v1"\): its token variable REEVAL_TEST_UNSET_TOKEN isn't set\. Set it in the environment or \.env\.local\./,
    )
  })

  test('a token fetches over HTTPS on the host, a wrong one is an auth failure, and neither is written anywhere', async () => {
    const token = 'reeval-test-git-token-8d31c6f0a2b4'
    const server = await gitHttpServer(token)
    try {
      const p = await withEval(
        "workspace: git(process.env.REEVAL_TEST_GIT_URL as string, { ref: 'v1', path: 'app', token: 'REEVAL_TEST_GIT_TOKEN' })",
        "await c.sandbox()\n  expect(await c.readFile('greet.js')).toContain('Hello')",
      )
      const url = `${server.serve(p.dir)}/repo`
      const good = await runCli(p.dir, ['run'], {
        env: { REEVAL_TEST_GIT_URL: url, REEVAL_TEST_GIT_TOKEN: token },
      })
      assert.equal(good.code, 0, good.stdout + good.stderr)
      const wrong = 'reeval-test-git-wrong-4f19a7'
      const bad = await runCli(p.dir, ['run'], {
        env: {
          REEVAL_TEST_GIT_URL: url,
          REEVAL_TEST_GIT_TOKEN: wrong,
          GIT_CONFIG_GLOBAL: join(p.dir, 'no-gitconfig'),
          GIT_CONFIG_NOSYSTEM: '1',
        },
      })
      assert.equal(bad.code, 3, bad.stdout + bad.stderr)
      assert.match(
        bad.stdout + bad.stderr,
        /isn't readable with this machine's git credentials, or doesn't exist/,
      )
      const header = (t: string) => Buffer.from(`x-access-token:${t}`).toString('base64')
      const leaks = [token, wrong, header(token), header(wrong)]
      for (const out of [good.stdout, good.stderr, bad.stdout, bad.stderr]) {
        for (const leak of leaks) assert.ok(!out.includes(leak), `printed ${leak}`)
      }
      for (const file of readdirSync(join(p.dir, '.reeval'), {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!file.isFile()) continue
        const text = readFileSync(join(file.parentPath, file.name), 'latin1')
        for (const leak of leaks) assert.ok(!text.includes(leak), `${leak} in ${file.name}`)
      }
    } finally {
      await server.close()
    }
  })

  test('init: true gives the workspace a .git that the diff leaves out, and the same HEAD in every attempt', async () => {
    const p = await project('workspace-init', {
      'reeval.config.ts': fakeConfig({
        harness: `{ script: [[{ exec: 'echo x > NOTES.md && git add -A && git -c user.name=a -c user.email=a@b commit -qm notes' }]] }`,
      }),
      'evals/w.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const env = defineEnvironment('app', ({ git }) => ({
  sandbox: fakeSandbox(),
  workspace: git('../repo', { ref: 'v1', init: true }),
  files: { 'app/extra.js': 'x' },
}))
evaluate('commits in the repo', { environment: env, runs: 2 }, async (c) => {
  const box = await c.sandbox()
  expect((await box.exec('git status --porcelain')).stdout).toBe('?? app/extra.js\\n')
  expect((await box.exec('git rev-parse HEAD')).stdout.trim()).toBe(process.env.EXPECTED_HEAD)
  const turn = await c.send('x')
  expect(turn.diff.files).toEqual([{ path: 'NOTES.md', status: 'added' }])
})
`,
    })
    const repo = makeRepo(p.dir)
    // What init: true commits: the tree, by reeval at a fixed date, so its hash is known up front.
    const at = '2000-01-01T00:00:00Z'
    const head = execFileSync(
      'git',
      [
        'commit-tree',
        git(repo, 'rev-parse', 'v1^{tree}'),
        '-m',
        `../repo#v1 at ${git(repo, 'rev-parse', 'v1')}`,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'reeval',
          GIT_AUTHOR_EMAIL: 'reeval@localhost',
          GIT_AUTHOR_DATE: at,
          GIT_COMMITTER_NAME: 'reeval',
          GIT_COMMITTER_EMAIL: 'reeval@localhost',
          GIT_COMMITTER_DATE: at,
        },
      },
    ).trim()
    const r = await runCli(p.dir, ['run'], { env: { EXPECTED_HEAD: head } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run } = readRun(p.dir)
    assert.equal(run.environments.find((e) => e.workspace)?.workspace?.init, true)
    assert.deepEqual(
      run.evals[0]?.attempts.map((a) => a.outcome),
      ['pass', 'pass'],
    )
  })

  test('a pinned SHA reruns offline from the cache, with the same commit and tree', async () => {
    const p = await withEval(
      "workspace: git('../repo', { ref: process.env.PIN, path: 'app' })",
      "await c.sandbox()\n  expect(await c.readFile('greet.js')).toContain('Hello')",
    )
    const sha = git(p.repo, 'rev-parse', 'v1')
    const env = { PIN: sha }
    const first = await runCli(p.dir, ['run'], { env })
    assert.equal(first.code, 0, first.stdout + first.stderr)
    assert.match(
      first.stdout,
      new RegExp(`workspace \\.\\./repo#${sha}:app at ${sha.slice(0, 12)}`),
    )
    renameSync(p.repo, join(p.dir, 'gone'))
    const second = await runCli(p.dir, ['run'], { env })
    assert.equal(second.code, 0, second.stdout + second.stderr)
    const records = readdirSync(join(p.dir, '.reeval/runs')).filter((f) => f.endsWith('.json'))
    assert.equal(records.length, 2)
    const workspace = readRun(p.dir).run.environments.find((e) => e.workspace)?.workspace
    assert.deepEqual(workspace, {
      source: 'repo',
      ref: sha,
      path: 'app',
      commit: sha,
      tree: git(join(p.dir, 'gone'), 'rev-parse', 'v1:app'),
    })
    assert.deepEqual(readdirSync(join(p.dir, '.reeval/cache/git/trees')), [
      `${workspace?.tree}.tar`,
    ])
  })

  test("the agent's diff starts from the repository, and a variant's workspace overrides", async () => {
    const p = await project('workspace-diff', {
      'reeval.config.ts': fakeConfig({
        harness: `{ script: [[{ write: { 'app/greet.js': "export const greeting = 'Hi'\\n", 'NOTES.md': 'x' } }]] }`,
      }),
      'evals/w.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const base = defineEnvironment('base', ({ git }) => ({
  sandbox: fakeSandbox(),
  workspace: git('../repo', { ref: 'v1' }),
}))
const sub = base.extendEnvironment('sub', ({ git }) => ({ workspace: git('../repo', { ref: 'v1', path: 'app' }) }))
evaluate('edits the repo', { environment: base }, async (c) => {
  const turn = await c.send('x')
  expect(turn.diff.files).toEqual([
    { path: 'NOTES.md', status: 'added' },
    { path: 'app/greet.js', status: 'modified' },
  ])
})
evaluate('in the subdirectory', { environment: sub }, async (c) => {
  await c.sandbox()
  expect(await c.readFile('greet.js')).toContain('Hello')
})
`,
    })
    makeRepo(p.dir)
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const sub = readRun(p.dir).run.environments.find((e) => e.name === 'sub')
    assert.deepEqual(sub?.overrides, ['workspace'])
    assert.equal(sub?.workspace?.path, 'app')
  })

  test('git failures are classed by what git says', () => {
    const cases: Array<[string, ReturnType<typeof classifyGitError>]> = [
      ["fatal: couldn't find remote ref v9", 'ref'],
      [
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        'auth',
      ],
      ['git@github.com: Permission denied (publickey).', 'auth'],
      ['remote: Repository not found.\nfatal: repository ... not found', 'url'],
      ["fatal: '/x' does not appear to be a git repository", 'url'],
      ["fatal: unable to access 'https://x/': Could not resolve host: x", 'transient'],
      ['error: RPC failed; HTTP 502 curl 22', 'transient'],
      ['something else', 'other'],
    ]
    for (const [stderr, want] of cases) assert.equal(classifyGitError(stderr), want, stderr)
  })
})
