// `reeval cloud push` against a fake platform that takes a run's history archive and answers how
// reading it stands, as the platform's studio routes do, and refuses as they do.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { MANIFEST_FILE, openArchive } from '../src/archive/index.ts'
import { bufferSource } from '../src/archive/zip.ts'
import { baseEnv, fakeConfig, project, runCli, tempDir } from './helpers.ts'

const TOKEN = 'cli-session-token-0123'
const HISTORY = 'evals/.history'
const SECRET = `ghp_${'a1B2c3D4e5'.repeat(4)}`

type Seen = {
  method: string
  path: string
  auth?: string
  type?: string
  length?: string
  body: Buffer
}

type Answer =
  | { status: 'ready' | 'failed'; pending?: number; error?: string }
  | { refuse: 409 | 413 }

async function platform(answer: Answer) {
  const seen: Seen[] = []
  let polls = 0
  let revision = 0
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const fail = (res: ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { error: { code, message, retryable: false } })
  const read = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://platform')
    const body = await read(req)
    seen.push({
      method: req.method ?? '',
      path: url.pathname,
      ...(req.headers.authorization && { auth: req.headers.authorization }),
      ...(req.headers['content-type'] && { type: req.headers['content-type'] }),
      ...(req.headers['content-length'] && { length: req.headers['content-length'] }),
      body,
    })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return fail(res, 401, 'unauthorized', 'Sign in first.')
    }
    const m = /^\/api\/orgs\/org_a\/projects\/proj_a\/studio\/runs\/([^/]+)$/.exec(url.pathname)
    if (!m) return fail(res, 404, 'not_found', `no route ${url.pathname}`)
    const runId = decodeURIComponent(m[1] as string)
    const state = (status: string, error: string | null = null) => ({
      runId,
      revision,
      status,
      error,
      viewVersion: status === 'ready' ? 1 : null,
    })
    if (req.method === 'PUT') {
      if ('refuse' in answer && answer.refuse === 413) {
        return fail(res, 413, 'payload_too_large', 'That archive is too large.')
      }
      if ('refuse' in answer) {
        return fail(res, 409, 'conflict', `Run ${runId} was uploaded to another project.`)
      }
      revision++
      return json(res, 202, state('pending'))
    }
    if (req.method === 'GET' && !('refuse' in answer)) {
      polls++
      if (polls <= (answer.pending ?? 0)) return json(res, 200, state('pending'))
      return json(res, 200, state(answer.status, answer.error ?? null))
    }
    fail(res, 405, 'invalid_request', 'No.')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    seen,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: {
      ...baseEnv,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    encoding: 'utf8',
  }).trim()

const envFor = (base: string, token: string | null = TOKEN) =>
  ({
    REEVAL_CLOUD_URL: base,
    ...(token && { REEVAL_TOKEN: token }),
    XDG_CONFIG_HOME: tempDir('cloud-push-config'),
    REEVAL_NO_KEYCHAIN: '1',
  }) as NodeJS.ProcessEnv

const never = (text: string) => assert.ok(!text.includes(TOKEN), `no token printed: ${text}`)

describe('reeval cloud push', () => {
  let dir = ''
  let runId = ''
  before(async () => {
    const p = await project('cloud-push', {
      '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
      'reeval.config.ts': fakeConfig({ harness: `{ files: { 'hello.txt': 'hi\\n' } }` }),
      'evals/agent.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('agent', async (c) => {
  await c.send('write hello.txt')
  await expect(c.exec('cat hello.txt')).toSucceed()
})
`,
      '.reeval/project.json': JSON.stringify({ orgId: 'org_a', projectId: 'proj_a' }),
    })
    dir = p.dir
    sh(dir, 'init', '-q', '-b', 'main')
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-q', '-m', 'init')
    const run = await runCli(dir, ['run', '--record'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const records = readdirSync(join(dir, HISTORY)).filter((f) => f.endsWith('.json'))
    runId = (records[0] as string).replace(/\.json$/, '')
  })

  test('uploads the run as its history archive, waits until it is read and prints the studio URL', async () => {
    const p = await platform({ status: 'ready', pending: 2 })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`^Pushing ${runId}: \\d+ files, [\\d.]+ KB$`, 'm'))
      assert.match(r.stdout, /^Uploaded revision 1; waiting for the cloud platform to read it$/m)
      assert.ok(
        r.stdout.trimEnd().endsWith(`Ready: ${p.base}/studio?run=${runId}`),
        `ends with the studio URL:\n${r.stdout}`,
      )
      never(r.stdout + r.stderr)
      const path = `/api/orgs/org_a/projects/proj_a/studio/runs/${runId}`
      assert.deepEqual(
        p.seen.map((s) => `${s.method} ${s.path}`),
        [`PUT ${path}`, `GET ${path}`, `GET ${path}`, `GET ${path}`],
      )
      const put = p.seen[0] as Seen
      assert.equal(put.auth, `Bearer ${TOKEN}`)
      assert.equal(put.type, 'application/zip')
      assert.equal(put.length, String(put.body.length))
      const archive = await openArchive(bufferSource(put.body))
      assert.equal(archive.manifest.contents, 'run')
      assert.equal(archive.manifest.runId, runId)
      assert.ok(archive.has(`${runId}.json`))
      assert.ok(archive.manifest.files.some((f) => f.path === `${runId}/summary.md`))
      assert.ok(!archive.has(MANIFEST_FILE), 'the manifest is not one of its own files')
      await archive.verify()
      await archive.close()
    } finally {
      await p.close()
    }
  })

  test('--no-wait returns once the run is uploaded', async () => {
    const p = await platform({ status: 'ready', pending: 5 })
    try {
      const r = await runCli(dir, ['cloud', 'push', runId, '--no-wait'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(
        r.stdout,
        new RegExp(
          `^Uploaded revision 1; the studio shows it once it's read: .*/studio\\?run=${runId}$`,
          'm',
        ),
      )
      assert.deepEqual(
        p.seen.map((s) => s.method),
        ['PUT'],
      )
    } finally {
      await p.close()
    }
  })

  test('a run the platform fails to read exits 3 with its error', async () => {
    const p = await platform({
      status: 'failed',
      pending: 1,
      error: `The archive is run x, not ${'y'}.`,
    })
    try {
      const r = await runCli(dir, ['cloud', 'push', runId], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        new RegExp(
          `reeval: the cloud platform couldn't read run ${runId}: The archive is run x, not y\\.`,
        ),
      )
      assert.doesNotMatch(r.stdout, /Ready/)
      never(r.stdout + r.stderr)
    } finally {
      await p.close()
    }
  })

  test('a run id another project has and an archive too large are refused with exit 2', async () => {
    for (const [status, said] of [
      [409, /refused to upload run .*: Run .* was uploaded to another project\./],
      [413, /refused to upload run .*: That archive is too large\./],
    ] as const) {
      const p = await platform({ refuse: status })
      try {
        const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(r.stderr, said)
        assert.deepEqual(
          p.seen.map((s) => s.method),
          ['PUT'],
        )
        never(r.stdout + r.stderr)
      } finally {
        await p.close()
      }
    }
  })

  test('signed out, it says how to sign in and sends nothing', async () => {
    const p = await platform({ status: 'ready' })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base, null) })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /reeval cloud push needs you signed in: reeval login signs in, or set REEVAL_TOKEN/,
      )
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })

  test('a refused token names the fix, never the token', async () => {
    const p = await platform({ status: 'ready' })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base, 'stale-token-4567') })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /refused to upload run .*: Sign in first\. \(check REEVAL_TOKEN\)/)
      assert.ok(!(r.stdout + r.stderr).includes('stale-token-4567'))
    } finally {
      await p.close()
    }
  })

  test('a file that looks like it holds a secret stops the push before anything is sent', async () => {
    const p = await platform({ status: 'ready' })
    const file = join(dir, HISTORY, runId, 'notes.txt')
    writeFileSync(file, `first line\nGITHUB_TOKEN=${SECRET}\n`)
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        new RegExp(`Refusing to push ${runId}: 1 file looks like it holds a secret`),
      )
      assert.match(r.stderr, new RegExp(`  ${runId}/notes\\.txt: line 2: GitHub token`))
      assert.match(r.stderr, /pass --skip-secret-scan if these are false positives/)
      const output = r.stdout + r.stderr
      assert.ok(!output.includes(SECRET.slice(4, 14)), `no part of the secret printed: ${output}`)
      assert.ok(!output.includes(SECRET.slice(-4)), `no part of the secret printed: ${output}`)
      assert.deepEqual(p.seen, [], 'nothing is sent')
    } finally {
      rmSync(file)
      await p.close()
    }
  })

  test('a run only in .reeval/runs is refused with how to record it', async () => {
    const p = await platform({ status: 'ready' })
    try {
      mkdirSync(join(dir, '.reeval'), { recursive: true })
      const run = await runCli(dir, ['run'])
      assert.equal(run.code, 0, run.stdout + run.stderr)
      const scratch = readdirSync(join(dir, '.reeval/runs'))
        .filter((f) => f.endsWith('.json') && f !== `${runId}.json`)
        .map((f) => f.replace(/\.json$/, ''))
      assert.equal(scratch.length, 1)
      const r = await runCli(dir, ['cloud', 'push', scratch[0] as string], {
        env: envFor(p.base),
      })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        new RegExp(`Run ${scratch[0]} isn't recorded: reeval record ${scratch[0]} records it`),
      )
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })
})
