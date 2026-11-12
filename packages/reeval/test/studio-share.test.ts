// `reeval studio share` and `reeval cloud push --out` against a fake platform with the studio's
// run routes (upload and status) and its share routes (create, list, revoke), answering and
// refusing as they do.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { openArchive } from '../src/archive/index.ts'
import { baseEnv, fakeConfig, project, runCli, tempDir } from './helpers.ts'

const TOKEN = 'cli-session-token-0123'
const HISTORY = 'evals/.history'
const SECRET = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const LIMIT_MESSAGE = "This org has reached its plan's share limit. Revoke a share or upgrade."

type Seen = { method: string; path: string; query: string; auth?: string; body: Buffer }

type Share = {
  id: string
  url: string
  runId: string
  type: string
  scope: string
  createdAt: string
  revokedAt: string | null
}

type Options = {
  /** Runs the project has read. */
  ready?: string[]
  /** Runs the project has a copy of that it answers pending for one status check. */
  pending?: string[]
  /** The share limit's refusal, with this status. */
  limit?: number
  limitMessage?: string
  /** How many share requests answer 409 not_ready whatever the run's state. */
  notReady?: number
  /** Changes each share the POST answers with. */
  answer?: (made: Share) => unknown
  /** The platform fails to read every upload, with this error. */
  readError?: string
  /** Changes each share the list answers with. */
  listed?: (s: Share) => unknown
}

async function platform(options: Options = {}) {
  const seen: Seen[] = []
  const runs = new Map<string, { revision: number; pendingChecks: number }>([
    ...(options.ready ?? []).map((id) => [id, { revision: 1, pendingChecks: 0 }] as const),
    ...(options.pending ?? []).map((id) => [id, { revision: 1, pendingChecks: 1 }] as const),
  ])
  let notReady = options.notReady ?? 0
  const shares: Share[] = []
  let base = ''
  const json = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const fail = (res: ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { error: { code, message } })
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
      query: url.search,
      ...(req.headers.authorization && { auth: req.headers.authorization }),
      body,
    })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return fail(res, 401, 'unauthorized', 'Sign in first.')
    }
    const prefix = '/api/orgs/org_a/projects/proj_a/studio'
    const run = new RegExp(`^${prefix}/runs/([^/]+)$`).exec(url.pathname)
    if (run) {
      const runId = decodeURIComponent(run[1] as string)
      const there = runs.get(runId)
      if (req.method === 'PUT') {
        const revision = (there?.revision ?? 0) + 1
        runs.set(runId, { revision, pendingChecks: 0 })
        return json(res, 202, { runId, revision, status: 'pending', error: null })
      }
      if (req.method === 'GET') {
        if (!there) return fail(res, 404, 'not_found', `No run ${runId}.`)
        const status = options.readError ? 'failed' : there.pendingChecks > 0 ? 'pending' : 'ready'
        there.pendingChecks = Math.max(0, there.pendingChecks - 1)
        const error = options.readError ?? null
        return json(res, 200, { runId, revision: there.revision, status, error })
      }
    }
    if (url.pathname === `${prefix}/shares` && req.method === 'POST') {
      const { runId, type, scope } = JSON.parse(body.toString()) as Share
      if (options.limit) {
        return fail(res, options.limit, 'share_limit', options.limitMessage ?? LIMIT_MESSAGE)
      }
      const there = runs.get(runId)
      if (!there) return fail(res, 404, 'not_found', `No run ${runId}.`)
      if (there.pendingChecks > 0 || notReady > 0) {
        notReady--
        return fail(res, 409, 'not_ready', 'Not read yet.')
      }
      const same = shares.find(
        (s) => s.runId === runId && s.type === type && s.scope === scope && !s.revokedAt,
      )
      if (same) return json(res, 200, options.answer ? options.answer(same) : same)
      const id = `sh${shares.length + 1}xxxxxxxxxxxxxxxxxxxx`
      const made = {
        id,
        url: `${base}/s/${id}`,
        runId,
        type,
        scope,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      }
      shares.push(made)
      const { revokedAt: _, ...created } = made
      return json(res, 201, options.answer ? options.answer(made) : created)
    }
    if (url.pathname === `${prefix}/shares` && req.method === 'GET') {
      const runId = url.searchParams.get('runId')
      const listed = shares.filter((s) => !runId || s.runId === runId)
      return json(res, 200, { shares: options.listed ? listed.map(options.listed) : listed })
    }
    const one = new RegExp(`^${prefix}/shares/([^/]+)$`).exec(url.pathname)
    if (one && req.method === 'DELETE') {
      const s = shares.find((x) => x.id === decodeURIComponent(one[1] as string))
      if (!s) return fail(res, 404, 'not_found', 'No such share.')
      s.revokedAt = new Date().toISOString()
      return json(res, 204)
    }
    fail(res, 404, 'not_found', `no route ${req.method} ${url.pathname}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    seen,
    shares,
    calls: () => seen.map((s) => `${s.method} ${s.path.replace(prefixOf, '')}${s.query}`),
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const prefixOf = '/api/orgs/org_a/projects/proj_a/studio'

const GIT_ENV = {
  ...baseEnv,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

const EVAL = `import { evaluate, expect } from 'reeval'
evaluate('agent', async (c) => {
  await c.send('write hello.txt')
  await expect(c.exec('cat hello.txt')).toSucceed()
})
`

async function linkedProject(name: string) {
  const p = await project(name, {
    '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
    'reeval.config.ts': fakeConfig({ harness: `{ files: { 'hello.txt': 'hi\\n' } }` }),
    'evals/agent.eval.ts': EVAL,
    '.reeval/project.json': JSON.stringify({ orgId: 'org_a', projectId: 'proj_a' }),
  })
  sh(p.dir, 'init', '-q', '-b', 'main')
  sh(p.dir, 'add', '-A')
  sh(p.dir, 'commit', '-q', '-m', 'init')
  return p.dir
}

const envFor = (base: string, token: string | null = TOKEN) =>
  ({
    REEVAL_CLOUD_URL: base,
    ...(token && { REEVAL_TOKEN: token }),
    XDG_CONFIG_HOME: tempDir('studio-share-config'),
    REEVAL_NO_KEYCHAIN: '1',
  }) as NodeJS.ProcessEnv

const never = (text: string) => assert.ok(!text.includes(TOKEN), `no token printed: ${text}`)

const recordedRunId = (dir: string) =>
  (readdirSync(join(dir, HISTORY)).find((f) => f.endsWith('.json')) as string).replace(
    /\.json$/,
    '',
  )

/** The archive's files under the run's folder that are transcripts. */
async function transcripts(file: string): Promise<string[]> {
  const archive = await openArchive(file)
  try {
    await archive.verify()
    return archive.manifest.files.map((f) => f.path).filter((p) => /transcript/.test(p))
  } finally {
    await archive.close()
  }
}

describe('reeval studio share', () => {
  let dir = ''
  let runId = ''
  before(async () => {
    dir = await linkedProject('studio-share')
    const run = await runCli(dir, ['run', '--record'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    runId = recordedRunId(dir)
  })

  test('pushes a run the cloud project lacks, then shares its report with the team', async () => {
    const p = await platform()
    try {
      const r = await runCli(dir, ['studio', 'share'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.deepEqual(p.calls(), [
        'POST /shares',
        `PUT /runs/${runId}`,
        `GET /runs/${runId}`,
        'POST /shares',
      ])
      assert.deepEqual(JSON.parse((p.seen.at(-1) as Seen).body.toString()), {
        runId,
        type: 'report',
        scope: 'team',
      })
      assert.match(r.stdout, new RegExp(`^Pushing ${runId}: \\d+ files`, 'm'))
      const id = p.shares[0]?.id
      assert.ok(
        r.stdout.trimEnd().endsWith(`Shared ${runId} (report, team): ${p.base}/s/${id}`),
        r.stdout,
      )
      assert.doesNotMatch(r.stdout, /transcripts|without signing in/)
      never(r.stdout + r.stderr)
    } finally {
      await p.close()
    }
  })

  test('shares a run the cloud project has read already without uploading it again', async () => {
    const p = await platform({ ready: [runId] })
    try {
      const r = await runCli(dir, ['studio', 'share', runId], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.deepEqual(p.calls(), ['POST /shares'])
      assert.doesNotMatch(r.stdout, /Pushing/)
      const again = await runCli(dir, ['studio', 'share', runId], { env: envFor(p.base) })
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.match(again.stdout, new RegExp(`^Already shared ${runId} \\(report, team\\): `, 'm'))
      assert.equal(p.shares.length, 1)
    } finally {
      await p.close()
    }
  })

  test('--full and --public ask for them and say what they share', async () => {
    const p = await platform({ ready: [runId] })
    try {
      const full = await runCli(dir, ['studio', 'share', '--full'], { env: envFor(p.base) })
      assert.equal(full.code, 0, full.stdout + full.stderr)
      assert.match(full.stdout, /^This share includes the run's transcripts and artifacts\.$/m)
      assert.match(
        full.stderr,
        /recorded with artifacts failures, so passing attempts' transcripts weren't kept: reeval run --artifacts all/,
      )
      assert.doesNotMatch(full.stdout, /without signing in/)
      assert.match(full.stdout, /\(full, team\)/)
      const pub = await runCli(dir, ['studio', 'share', '--public'], { env: envFor(p.base) })
      assert.equal(pub.code, 0, pub.stdout + pub.stderr)
      assert.match(pub.stdout, /^Anyone with the link can view it, without signing in\.$/m)
      assert.doesNotMatch(pub.stdout, /transcripts/)
      assert.match(pub.stdout, /\(report, public\)/)
      const bodies = p.seen
        .filter((s) => s.method === 'POST')
        .map((s) => JSON.parse(s.body.toString()))
      assert.deepEqual(bodies, [
        { runId, type: 'full', scope: 'team' },
        { runId, type: 'report', scope: 'public' },
      ])
    } finally {
      await p.close()
    }
  })

  test('--json prints only the share on stdout', async () => {
    const p = await platform()
    try {
      const r = await runCli(dir, ['studio', 'share', '--json', '--full', '--public'], {
        env: envFor(p.base),
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const share = JSON.parse(r.stdout)
      assert.equal(share.runId, runId)
      assert.equal(share.type, 'full')
      assert.equal(share.scope, 'public')
      assert.equal(share.url, `${p.base}/s/${share.id}`)
      assert.equal(share.pushed, true)
      assert.equal(share.created, true)
      assert.match(r.stderr, /Pushing /)
      assert.match(r.stderr, /transcripts/)
      assert.match(r.stderr, /without signing in/)
    } finally {
      await p.close()
    }
  })

  test("the share limit prints the platform's message as it is and exits 2, at any status", async () => {
    for (const limit of [402, 403]) {
      const p = await platform({ limit })
      try {
        const r = await runCli(dir, ['studio', 'share'], { env: envFor(p.base) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.equal(r.stderr.trim(), `reeval: ${LIMIT_MESSAGE}`)
        assert.doesNotMatch(r.stdout, /Shared|Pushing/)
        assert.deepEqual(p.calls(), ['POST /shares'])
      } finally {
        await p.close()
      }
    }
  })

  test("the platform's message loses its control characters", async () => {
    const p = await platform({ limit: 402, limitMessage: 'Limit\u001b[2J reached\u0007.' })
    try {
      const r = await runCli(dir, ['studio', 'share'], { env: envFor(p.base) })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.equal(r.stderr.trim(), 'reeval: Limit[2J reached.')
    } finally {
      await p.close()
    }
  })

  test('a copy still being read is waited on, not uploaded again', async () => {
    const p = await platform({ pending: [runId] })
    try {
      const r = await runCli(dir, ['studio', 'share', '--json'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.deepEqual(p.calls(), [
        'POST /shares',
        `GET /runs/${runId}`,
        `GET /runs/${runId}`,
        'POST /shares',
      ])
      assert.match(r.stderr, /Waiting for the cloud platform to read run .* \(revision 1\)/)
      const share = JSON.parse(r.stdout)
      assert.equal(share.pushed, false)
      assert.equal(share.created, true)
    } finally {
      await p.close()
    }
  })

  test('a share refused as not ready right after the run is read is asked for once more', async () => {
    const once = await platform({ ready: [runId], notReady: 2 })
    try {
      const r = await runCli(dir, ['studio', 'share'], { env: envFor(once.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.deepEqual(once.calls(), [
        'POST /shares',
        `GET /runs/${runId}`,
        'POST /shares',
        'POST /shares',
      ])
    } finally {
      await once.close()
    }
    const stuck = await platform({ ready: [runId], notReady: 3 })
    try {
      const r = await runCli(dir, ['studio', 'share'], { env: envFor(stuck.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stderr, /has read run .* but won't share it yet/)
      assert.equal(stuck.calls().filter((c) => c === 'POST /shares').length, 3)
    } finally {
      await stuck.close()
    }
  })

  test('a share answer for something else exits 3 and says how to revoke it', async () => {
    for (const answer of [
      (s: Share) => ({ ...s, scope: 'public' }),
      (s: Share) => ({ ...s, url: `https://elsewhere.example/s/${s.id}` }),
    ]) {
      const p = await platform({ ready: [runId], answer })
      try {
        const r = await runCli(dir, ['studio', 'share'], { env: envFor(p.base) })
        assert.equal(r.code, 3, r.stdout + r.stderr)
        assert.match(
          r.stderr,
          /different share \(sh1\w+, .*\): revoke it with reeval studio share --revoke sh1|answered share run .* with something else/,
        )
        assert.doesNotMatch(r.stdout, /elsewhere/)
      } finally {
        await p.close()
      }
    }
  })

  test('a revoked share in the answer exits 3 and is never printed as shared', async () => {
    const p = await platform({
      ready: [runId],
      answer: (s) => ({ ...s, revokedAt: '2026-11-12T00:00:00.000Z' }),
    })
    try {
      const r = await runCli(dir, ['studio', 'share'], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stderr, /answered with a revoked share \(sh1\w+\): ask for the share again/)
      assert.doesNotMatch(r.stdout, /Shared/)
    } finally {
      await p.close()
    }
  })

  test('a share with a bad id or date, or a link with credentials, is a bad answer', async () => {
    for (const answer of [
      (s: Share) => ({ ...s, id: '../x' }),
      (s: Share) => ({ ...s, createdAt: 'yesterday\u001b[2J' }),
      (s: Share) => ({ ...s, url: s.url.replace('http://', 'http://user:pw@') }),
      (s: Share) => ({ ...s, url: s.url.replace('http://', 'http://evil@') }),
    ]) {
      const p = await platform({ ready: [runId], answer })
      try {
        const r = await runCli(dir, ['studio', 'share'], { env: envFor(p.base) })
        assert.equal(r.code, 3, r.stdout + r.stderr)
        assert.match(r.stderr, /answered share run .* with something else/)
        assert.doesNotMatch(r.stdout + r.stderr, /evil|user:pw/)
        assert.ok(!(r.stdout + r.stderr).includes('\u001b'))
      } finally {
        await p.close()
      }
    }
  })

  test('the link is printed normalized', async () => {
    const p = await platform({
      ready: [runId],
      answer: (s) => ({ ...s, url: s.url.replace('http://', 'HTTP://') }),
    })
    try {
      const r = await runCli(dir, ['studio', 'share'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.ok(r.stdout.trimEnd().endsWith(`${p.base}/s/${p.shares[0]?.id}`), r.stdout)
    } finally {
      await p.close()
    }
  })

  test("the platform's read error loses its control characters", async () => {
    const p = await platform({ readError: 'bad \u001b[31mrecord\u001b[0m' })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stderr, /couldn't read run .*: bad \[31mrecord\[0m/)
      assert.ok(!r.stderr.includes('\u001b'))
    } finally {
      await p.close()
    }
  })

  test('a listed share with a bad revokedAt or another origin is a bad answer', async () => {
    for (const listed of [
      (s: Share) => ({ ...s, revokedAt: 5 }),
      (s: Share) => ({ ...s, url: 'https://elsewhere.example/s/x' }),
    ]) {
      const p = await platform({ ready: [runId], listed })
      try {
        const env = envFor(p.base)
        assert.equal((await runCli(dir, ['studio', 'share'], { env })).code, 0)
        const r = await runCli(dir, ['studio', 'share', '--list'], { env })
        assert.equal(r.code, 3, r.stdout + r.stderr)
        assert.match(r.stderr, /answered list the project's shares with something else/)
      } finally {
        await p.close()
      }
    }
  })

  test('--list passes a run id it has no record of straight through', async () => {
    const p = await platform()
    try {
      const other = '20990101T000000Z_main_agent_abcd'
      const r = await runCli(dir, ['studio', 'share', '--list', other], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.deepEqual(p.calls(), [`GET /shares?runId=${other}`])
      assert.equal(r.stdout.trim(), `Run ${other} has no shares`)
    } finally {
      await p.close()
    }
  })

  test('--list lists the shares, and --revoke revokes one', async () => {
    const p = await platform({ ready: [runId] })
    try {
      const env = envFor(p.base)
      const empty = await runCli(dir, ['studio', 'share', '--list'], { env })
      assert.equal(empty.code, 0, empty.stdout + empty.stderr)
      assert.equal(empty.stdout.trim(), 'No shares in this project')
      assert.equal((await runCli(dir, ['studio', 'share'], { env })).code, 0)
      assert.equal((await runCli(dir, ['studio', 'share', '--public'], { env })).code, 0)
      const [team, pub] = p.shares as [Share, Share]

      const listed = await runCli(dir, ['studio', 'share', '--list', runId], { env })
      assert.equal(listed.code, 0, listed.stdout + listed.stderr)
      assert.equal(p.calls().at(-1), `GET /shares?runId=${runId}`)
      const lines = listed.stdout.trim().split('\n')
      assert.equal(lines.length, 2)
      assert.match(
        lines[0] as string,
        new RegExp(`^${team.id}  ${runId}  report  team  .*  ${team.url}$`),
      )
      assert.match(lines[1] as string, new RegExp(`^${pub.id}  ${runId}  report  public  `))

      const revoked = await runCli(dir, ['studio', 'share', '--revoke', pub.id], { env })
      assert.equal(revoked.code, 0, revoked.stdout + revoked.stderr)
      assert.equal(revoked.stdout.trim(), `Revoked share ${pub.id}`)
      assert.equal(p.calls().at(-1), `DELETE /shares/${pub.id}`)

      const json = await runCli(dir, ['studio', 'share', '--list', '--json'], { env })
      assert.equal(json.code, 0, json.stdout + json.stderr)
      const { shares } = JSON.parse(json.stdout) as { shares: Share[] }
      assert.deepEqual(
        shares.map((s) => [s.id, !!s.revokedAt]),
        [
          [team.id, false],
          [pub.id, true],
        ],
      )
      const after = await runCli(dir, ['studio', 'share', '--list'], { env })
      assert.match(after.stdout, new RegExp(`^${pub.id}  .*  revoked `, 'm'))

      const missing = await runCli(dir, ['studio', 'share', '--revoke', 'nope'], { env })
      assert.equal(missing.code, 2, missing.stdout + missing.stderr)
      assert.match(missing.stderr, /refused to revoke share nope: No such share\./)
      never(json.stdout + json.stderr + listed.stdout + revoked.stdout)
    } finally {
      await p.close()
    }
  })

  test('mixed actions are refused before anything is sent', async () => {
    const p = await platform()
    try {
      for (const args of [
        ['--revoke', 'x', '--full'],
        ['--revoke', 'x', runId],
        ['--list', '--public'],
        ['--port', '1'],
        ['--public', '--skip-secret-scan'],
        ['--revoke', '../runs/x'],
        ['--revoke', 'a/b'],
      ]) {
        const r = await runCli(dir, ['studio', 'share', ...args], { env: envFor(p.base) })
        assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
      }
      const pub = await runCli(dir, ['studio', 'share', '--public', '--skip-secret-scan'], {
        env: envFor(p.base),
      })
      assert.match(pub.stderr, /a public share needs a clean secret scan/)
      const bad = await runCli(dir, ['studio', 'share', '--revoke', '..'], { env: envFor(p.base) })
      assert.match(bad.stderr, /--revoke takes a share's id/)
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })

  test('a run that looks like it holds a secret is refused with nothing sent', async () => {
    const p = await platform()
    const file = join(dir, HISTORY, runId, 'notes.txt')
    writeFileSync(file, `token ${SECRET}\n`)
    try {
      for (const args of [[], ['--full', '--public']]) {
        const r = await runCli(dir, ['studio', 'share', ...args], { env: envFor(p.base) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(r.stderr, /Refusing to push .*notes\.txt/s)
        assert.ok(!(r.stdout + r.stderr).includes(SECRET.slice(4, 14)))
      }
      assert.deepEqual(p.seen, [])
    } finally {
      rmSync(file)
      await p.close()
    }
  })

  test('signed out, it says how to sign in and sends nothing', async () => {
    const p = await platform()
    try {
      const r = await runCli(dir, ['studio', 'share'], { env: envFor(p.base, null) })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /reeval studio share needs you signed in: reeval login signs in/)
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })
})

describe('reeval cloud push --out and --json', () => {
  let dir = ''
  let runId = ''
  const out = () => join(dir, 'out', 'run.zip')
  before(async () => {
    dir = await linkedProject('cloud-push-out')
    const run = await runCli(dir, ['run', '--record'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    runId = recordedRunId(dir)
  })
  after(() => rmSync(join(dir, 'out'), { recursive: true, force: true }))

  test('--out writes the scanned archive and sends nothing, signed in or not', async () => {
    const p = await platform()
    try {
      const r = await runCli(dir, ['cloud', 'push', '--out', 'out/run.zip'], {
        env: envFor(p.base, null),
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`^Wrote ${runId} to out/run.zip: \\d+ files, `, 'm'))
      const archive = await openArchive(out())
      assert.equal(archive.manifest.contents, 'run')
      assert.equal(archive.manifest.runId, runId)
      assert.ok(archive.has(`${runId}.json`))
      await archive.verify()
      await archive.close()
      const json = await runCli(dir, ['cloud', 'push', '--out', 'out/run.zip', '--json'], {
        env: envFor(p.base),
      })
      assert.equal(json.code, 0, json.stdout + json.stderr)
      const wrote = JSON.parse(json.stdout)
      assert.equal(wrote.runId, runId)
      assert.equal(wrote.out, out())
      assert.ok(wrote.files > 0 && wrote.bytes > 0)
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })

  test('--out refuses on a secret and writes nothing', async () => {
    rmSync(join(dir, 'out'), { recursive: true, force: true })
    const file = join(dir, HISTORY, runId, 'notes.txt')
    writeFileSync(file, `token ${SECRET}\n`)
    try {
      const r = await runCli(dir, ['cloud', 'push', '--out', 'out/run.zip'])
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /Refusing to push/)
      assert.throws(() => readdirSync(join(dir, 'out')))
    } finally {
      rmSync(file)
    }
  })

  test('--out refuses a place where reeval keeps runs, a folder and stdout', async () => {
    for (const [target, why] of [
      [`${HISTORY}/run.zip`, /is inside .*, where reeval keeps runs/],
      ['.reeval/run.zip', /is inside .*, where reeval keeps runs/],
      ['evals', /is a folder/],
      ['-', /./],
    ] as const) {
      const r = await runCli(dir, ['cloud', 'push', '--out', target])
      assert.equal(r.code, 2, `${target}: ${r.stdout}${r.stderr}`)
      assert.match(r.stderr, why)
    }
    assert.ok(!readdirSync(join(dir, HISTORY)).includes('run.zip'))
    mkdirSync(join(dir, 'links'), { recursive: true })
    symlinkSync(join('..', HISTORY), join(dir, 'links', 'hist'))
    symlinkSync(join('..', '.reeval'), join(dir, 'links', 'state'))
    const record = readFileSync(join(dir, HISTORY, `${runId}.json`))
    try {
      for (const [target, what] of [
        [`links/hist/${runId}.json`, 'the history folder'],
        ['links/hist/new/run.zip', 'the history folder'],
        ['links/state/run.zip', '.reeval/'],
      ] as const) {
        const r = await runCli(dir, ['cloud', 'push', '--out', target])
        assert.equal(r.code, 2, `${target}: ${r.stdout}${r.stderr}`)
        assert.match(
          r.stderr,
          new RegExp(`is inside ${what.replace('.', '\\.')}, where reeval keeps runs`),
        )
      }
      assert.deepEqual(readFileSync(join(dir, HISTORY, `${runId}.json`)), record)
    } finally {
      rmSync(join(dir, 'links'), { recursive: true })
    }
    assert.ok(!existsSync(join(dir, '.reeval', 'run.zip')))
  })

  test('--out with an upload flag is refused', async () => {
    const r = await runCli(dir, ['cloud', 'push', '--out', 'x.zip', '--no-wait'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /--out writes the archive to a file and uploads nothing: leave out --no-wait/,
    )
  })

  test('--json prints the run state it ends on', async () => {
    const p = await platform()
    try {
      const r = await runCli(dir, ['cloud', 'push', '--json'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.deepEqual(JSON.parse(r.stdout), {
        runId,
        revision: 1,
        status: 'ready',
        error: null,
        studioUrl: `${p.base}/studio?run=${runId}`,
      })
      assert.match(r.stderr, /Pushing /)
    } finally {
      await p.close()
    }
  })

  test('--artifacts archives a run only in .reeval/runs at that level and never records it', async () => {
    const scratchOnly = await linkedProject('cloud-push-unrecorded')
    const ran = await runCli(scratchOnly, ['run'])
    assert.equal(ran.code, 0, ran.stdout + ran.stderr)
    const runs = join(scratchOnly, '.reeval', 'runs')
    const id = (readdirSync(runs).find((f) => f.endsWith('.json')) as string).replace(/\.json$/, '')
    const staged = readdirSync(join(runs, id), { recursive: true }).map(String)
    assert.ok(
      staged.some((f) => /transcript/.test(f)),
      `the passing attempt's transcript is in .reeval/runs: ${staged.join(', ')}`,
    )

    const refused = await runCli(scratchOnly, ['cloud', 'push', id, '--out', 'run.zip'])
    assert.equal(refused.code, 2, refused.stdout + refused.stderr)
    assert.match(refused.stderr, new RegExp(`Run ${id} isn't recorded: reeval record ${id}`))
    assert.ok(!existsSync(join(scratchOnly, 'run.zip')))

    const r = await runCli(scratchOnly, [
      'cloud',
      'push',
      id,
      '--artifacts',
      'all',
      '--out',
      'run.zip',
      '--json',
    ])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(JSON.parse(r.stdout).runId, id)
    const file = join(scratchOnly, 'run.zip')
    assert.ok((await transcripts(file)).length > 0, "the passing attempt's transcript")
    const archive = await openArchive(file)
    try {
      await archive.verify()
      assert.equal(archive.manifest.runId, id)
      const record = JSON.parse((await archive.read(`${id}.json`)).toString())
      assert.equal(record.artifacts, 'all')
    } finally {
      await archive.close()
    }
    assert.ok(!existsSync(join(scratchOnly, HISTORY)), 'the run stays unrecorded')
    const none = await runCli(scratchOnly, [
      'cloud',
      'push',
      id,
      '--artifacts',
      'none',
      '--out',
      'none.zip',
    ])
    assert.equal(none.code, 0, none.stdout + none.stderr)
    assert.deepEqual(await transcripts(join(scratchOnly, 'none.zip')), [])

    const p = await platform()
    try {
      const up = await runCli(scratchOnly, ['cloud', 'push', '--artifacts', 'all'], {
        env: envFor(p.base),
      })
      assert.equal(up.code, 0, up.stdout + up.stderr)
      assert.deepEqual(p.calls(), [`PUT /runs/${id}`, `GET /runs/${id}`])
      assert.ok(!existsSync(join(scratchOnly, HISTORY)))
    } finally {
      await p.close()
    }

    const staging = join(scratchOnly, '.reeval', 'staging', id)
    mkdirSync(staging, { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      join(staging, 'live.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: id,
        startedAt: now,
        pid: process.pid,
        host: hostname(),
        heartbeatAt: now,
        phase: 'running',
        attempts: [],
      }),
    )
    try {
      const running = await runCli(scratchOnly, [
        'cloud',
        'push',
        id,
        '--artifacts',
        'all',
        '--out',
        'x.zip',
      ])
      assert.equal(running.code, 2, running.stdout + running.stderr)
      assert.match(running.stderr, new RegExp(`Run ${id} is still running: push it once it ends`))
      assert.ok(!existsSync(join(scratchOnly, 'x.zip')))
    } finally {
      rmSync(staging, { recursive: true })
    }
  })

  test('--artifacts only narrows a recorded run', async () => {
    const wider = await runCli(dir, [
      'cloud',
      'push',
      runId,
      '--artifacts',
      'all',
      '--out',
      'w.zip',
    ])
    assert.equal(wider.code, 2, wider.stdout + wider.stderr)
    assert.match(
      wider.stderr,
      new RegExp(
        `Run ${runId} was recorded with artifacts failures, so --artifacts all can't add what recording left out: push it at failures or none`,
      ),
    )
    assert.ok(!existsSync(join(dir, 'w.zip')))
    const same = await runCli(dir, [
      'cloud',
      'push',
      runId,
      '--artifacts',
      'failures',
      '--out',
      'out/same.zip',
    ])
    assert.equal(same.code, 0, same.stdout + same.stderr)
    const recorded = await runCli(dir, ['cloud', 'push', runId, '--out', 'out/recorded.zip'])
    assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr)
    const listed = async (zip: string) => {
      const archive = await openArchive(join(dir, 'out', zip))
      try {
        await archive.verify()
        return archive.manifest.files
      } finally {
        await archive.close()
      }
    }
    assert.deepEqual(
      await listed('same.zip'),
      await listed('recorded.zip'),
      'the same level is the recorded archive',
    )
    const none = await runCli(dir, [
      'cloud',
      'push',
      runId,
      '--artifacts',
      'none',
      '--out',
      'out/none.zip',
    ])
    assert.equal(none.code, 0, none.stdout + none.stderr)
    const archive = await openArchive(join(dir, 'out', 'none.zip'))
    try {
      await archive.verify()
      const record = JSON.parse((await archive.read(`${runId}.json`)).toString())
      assert.equal(record.artifacts, 'none')
      assert.deepEqual(
        archive.manifest.files.map((f) => f.path).filter((f) => f !== `${runId}.json`),
        [`${runId}/remarks.json`].filter((f) => archive.has(f)),
      )
    } finally {
      await archive.close()
    }
  })

  test("a run recorded with --artifacts all carries every attempt's transcript", async () => {
    const all = await linkedProject('cloud-push-artifacts')
    const bad = await runCli(all, ['run', '--record', '--artifacts', 'some'])
    assert.equal(bad.code, 2, bad.stdout + bad.stderr)
    assert.match(bad.stderr, /--artifacts is all, failures or none \(got some\)/)
    assert.throws(() => readdirSync(join(all, HISTORY)))
    const run = await runCli(all, ['run', '--record', '--artifacts', 'all'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const r = await runCli(all, ['cloud', 'push', '--out', 'run.zip'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok((await transcripts(join(all, 'run.zip'))).length > 0, 'the passing attempt keeps it')
    const failures = await runCli(dir, ['cloud', 'push', '--out', 'out/run.zip'])
    assert.equal(failures.code, 0, failures.stdout + failures.stderr)
    assert.deepEqual(await transcripts(out()), [], "'failures' leaves a passing attempt's out")
    const unrecorded = await runCli(all, ['run', '--artifacts', 'all'])
    assert.match(unrecorded.stderr, /--artifacts applies when the run is recorded: pass --record/)
  })
})
