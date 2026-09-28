// Git workspaces through the CLI: the repository is fetched on the host before any attempt, its
// ref resolved once and its tree cached by hash; bad URLs, refs and paths stop the run (exit 2)
// before anything starts; and the agent's diff starts from the repository.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { classifyGitError } from '../src/workspace.ts'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

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

async function withEval(env: string, body = 'await t.sandbox()', harness?: string) {
  const p = await project('workspace', {
    'es.config.ts': fakeConfig(harness ? { harness } : {}),
    'evals/w.es.ts': `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const env = defineEnvironment('app', ({ git }) => ({ ${env} }))
evaluate('works on the repo', { environment: env }, async (t) => {
  ${body}
})
`,
  })
  return { ...p, repo: makeRepo(p.dir) }
}

describe('git workspaces', { concurrency: true }, () => {
  test('a ref the repository lacks stops the run before any attempt', async () => {
    const p = await withEval(`workspace: git('../repo', { ref: 'v9' })`)
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /Workspace git\("\.\.\/repo#v9"\) in environment app: the repository has no ref "v9" \(a branch, tag or commit SHA\)\./,
    )
    assert.equal(existsSync(join(p.dir, '.es/runs')), false, 'no attempt ran')
  })

  test('an abbreviated SHA gets a hint', async () => {
    const p = await withEval(`workspace: git('../repo', { ref: 'abc1234' })`)
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /no ref "abc1234".*Give a commit as its full 40-character SHA\./)
  })

  test('a missing subdirectory names what is there', async () => {
    const p = await withEval(`workspace: git('../repo', { ref: 'v1', path: 'apps/web' })`)
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /Workspace git\("\.\.\/repo#v1:apps\/web"\) in environment app at v1 \(commit [0-9a-f]{7}\) has no directory "apps\/web"; its top level has: README\.md, app\//,
    )
  })

  test('a file as the path is refused', async () => {
    const p = await withEval(`workspace: git('../repo', { ref: 'v1', path: 'README.md' })`)
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /"README\.md" is a file, not a directory/)
  })

  test('a path that is not a repository says to check the URL', async () => {
    const p = await withEval(`workspace: git('../nowhere', { ref: 'v1' })`)
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /Workspace git\("\.\.\/nowhere#v1"\) in environment app: couldn't fetch it \(.+\)\. Check the URL; a private repository also needs this machine's git credentials\./,
    )
  })

  test('a pinned SHA reruns offline from the cache, with the same commit and tree', async () => {
    const p = await withEval(
      "workspace: git('../repo', { ref: process.env.PIN, path: 'app' })",
      "await t.sandbox()\n  expect(await t.readFile('greet.js')).toContain('Hello')",
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
    const records = readdirSync(join(p.dir, '.es/runs')).filter((f) => f.endsWith('.json'))
    assert.equal(records.length, 2)
    const workspace = readRun(p.dir).run.environments[0]?.workspace
    assert.deepEqual(workspace, {
      source: 'repo',
      ref: sha,
      path: 'app',
      commit: sha,
      tree: git(join(p.dir, 'gone'), 'rev-parse', 'v1:app'),
    })
    assert.deepEqual(readdirSync(join(p.dir, '.es/cache/git/trees')), [`${workspace?.tree}.tar`])
  })

  test("the agent's diff starts from the repository, and a variant's workspace overrides", async () => {
    const p = await project('workspace-diff', {
      'es.config.ts': fakeConfig({
        harness: `{ script: [[{ write: { 'app/greet.js': "export const greeting = 'Hi'\\n", 'NOTES.md': 'x' } }]] }`,
      }),
      'evals/w.es.ts': `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const base = defineEnvironment('base', ({ git }) => ({ workspace: git('../repo', { ref: 'v1' }) }))
const sub = base.extend('sub', ({ git }) => ({ workspace: git('../repo', { ref: 'v1', path: 'app' }) }))
evaluate('edits the repo', { environment: base }, async (t) => {
  const turn = await t.send('x')
  expect(turn.diff.files).toEqual([
    { path: 'NOTES.md', status: 'added' },
    { path: 'app/greet.js', status: 'modified' },
  ])
})
evaluate('in the subdirectory', { environment: sub }, async (t) => {
  await t.sandbox()
  expect(await t.readFile('greet.js')).toContain('Hello')
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
