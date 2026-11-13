// `reeval cloud push` against a fake platform that takes a run's history archive and answers how
// reading it stands, as the platform's studio routes do, and refuses as they do.
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
import { join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'
import * as zlib from 'node:zlib'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import type { ShapeSchema } from '../scripts/schema/generate.ts'
import { validate } from '../scripts/schema/validate.ts'
import { analysisProblem } from '../src/analysis/push.ts'
import { MANIFEST_FILE, openArchive } from '../src/archive/index.ts'
import { bufferSource, ZipWriter } from '../src/archive/zip.ts'
import { scanPush } from '../src/cloud-push-scan.ts'
import { readableAnalysis } from '../src/view/record.ts'
import { baseEnv, fakeConfig, project, runCli, tempDir } from './helpers.ts'
import { type FakeS3, fakeS3 } from './support/fake-s3.ts'

type Doc = Record<string, unknown>
const RECORDS = join(import.meta.dirname, 'fixtures', 'records')
const CORPUS_ANALYSIS = join(
  RECORDS,
  'with-observations/evals/.history/20261030T183503Z_7e9208f_cursor-agent_c479/analysis/20261030T183514Z_cursor-agent_6ffd5e1e.json',
)
const ANALYSIS_NAME = '20261112T000000Z_test_0123abcd.json'

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

/** What one status poll gets before the final answer: a state, a status code, junk or a reset. */
type Poll = 'pending' | 503 | 429 | 'junk' | 'reset'

type Answer =
  | { status: 'ready' | 'failed'; polls?: Poll[]; error?: string }
  | { refuse: 409 | 413 }
  | { redirect: true }
  | { redirectStatus: true }

/** How the platform answers an analysis upload: as its route does by default, or otherwise. */
type AnalysisAnswer = 'route' | 'no-route' | 'redirect' | 401 | 503

/**
 * `known`: the runs the platform has before any upload; an upload adds its run. `analysis`: how it
 * answers `PUT /api/v1/runs/:runId/analysis`.
 */
async function platform(answer: Answer, known: string[] = [], analysis: AnalysisAnswer = 'route') {
  const seen: Seen[] = []
  const runs = new Set(known)
  let polls = 0
  let revision = 0
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const fail = (res: ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { error: { code, message, retryable: status >= 500 } })
  const read = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  let base = ''
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
    const analysisRun = /^\/api\/v1\/runs\/([^/]+)\/analysis$/.exec(url.pathname)?.[1]
    if (analysisRun && req.method === 'PUT') {
      const runId = decodeURIComponent(analysisRun)
      if (analysis === 'no-route') return fail(res, 404, 'not_found', `no route ${url.pathname}`)
      if (analysis === 'redirect') {
        res.writeHead(307, { location: `${base}/elsewhere` })
        return res.end()
      }
      if (analysis === 401) return fail(res, 401, 'unauthorized', 'That token was revoked.')
      if (analysis === 503) return fail(res, 503, 'unavailable', 'Try again shortly.')
      if (!runs.has(runId)) {
        return json(res, 404, { error: 'run_not_found', message: `No run ${runId}.` })
      }
      return json(res, 200, { runId, stored: true })
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
      if ('redirect' in answer) {
        res.writeHead(307, { location: `${base}/elsewhere` })
        return res.end()
      }
      if ('refuse' in answer && answer.refuse === 413) {
        return fail(res, 413, 'payload_too_large', 'That archive is too large.')
      }
      if ('refuse' in answer) {
        return fail(res, 409, 'conflict', `Run ${runId} was uploaded to another project.`)
      }
      revision++
      runs.add(runId)
      return json(res, 202, state('pending'))
    }
    if (req.method === 'PUT' && 'redirectStatus' in answer) {
      revision++
      return json(res, 202, state('pending'))
    }
    if (req.method === 'GET' && 'redirectStatus' in answer) {
      res.writeHead(302, { location: `${base}/elsewhere` })
      return res.end()
    }
    if (req.method === 'GET' && 'status' in answer) {
      const poll = answer.polls?.[polls++]
      if (poll === 'reset') return void req.socket.destroy()
      if (poll === 503) return fail(res, 503, 'unavailable', 'Try again shortly.')
      if (poll === 429) return fail(res, 429, 'rate_limited', 'Slow down.')
      if (poll === 'junk') return json(res, 200, 'not a state')
      if (poll === 'pending') return json(res, 200, state('pending'))
      return json(res, 200, state(answer.status, answer.error ?? null))
    }
    fail(res, 405, 'invalid_request', 'No.')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    seen,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

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

/** A git project linked to `org_a`/`proj_a` on the fake harness. */
async function linkedProject(name: string, extra = '', imports = '') {
  const p = await project(name, {
    '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
    'reeval.config.ts':
      imports + fakeConfig({ harness: `{ files: { 'hello.txt': 'hi\\n' } }`, extra }),
    'evals/agent.eval.ts': EVAL,
    '.reeval/project.json': JSON.stringify({ orgId: 'org_a', projectId: 'proj_a' }),
  })
  sh(p.dir, 'init', '-q', '-b', 'main')
  sh(p.dir, 'add', '-A')
  sh(p.dir, 'commit', '-q', '-m', 'init')
  return p.dir
}

let tmp = ''
const envFor = (base: string, token: string | null = TOKEN) => {
  tmp = tempDir('cloud-push-tmp')
  return {
    REEVAL_CLOUD_URL: base,
    ...(token && { REEVAL_TOKEN: token }),
    XDG_CONFIG_HOME: tempDir('cloud-push-config'),
    REEVAL_NO_KEYCHAIN: '1',
    TMPDIR: tmp,
  } as NodeJS.ProcessEnv
}

const pushTemps = () => readdirSync(tmp).filter((f) => f.startsWith('reeval-push-'))

const never = (text: string) => assert.ok(!text.includes(TOKEN), `no token printed: ${text}`)
const noSecret = (text: string) => {
  for (const part of [SECRET, SECRET.slice(4, 14), SECRET.slice(-4)]) {
    assert.ok(!text.includes(part), `no part of the secret printed: ${text}`)
  }
}

describe('reeval cloud push', () => {
  let dir = ''
  let runId = ''
  const path = () => `/api/orgs/org_a/projects/proj_a/studio/runs/${runId}`
  /** Runs `fn` with `name` in the recorded run's folder, then removes it. */
  const withFile = async (name: string, data: string | Buffer, fn: () => Promise<void>) => {
    const file = join(dir, HISTORY, runId, name)
    writeFileSync(file, data)
    try {
      await fn()
    } finally {
      rmSync(file)
    }
  }
  before(async () => {
    dir = await linkedProject('cloud-push')
    const run = await runCli(dir, ['run', '--record'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const records = readdirSync(join(dir, HISTORY)).filter((f) => f.endsWith('.json'))
    runId = (records[0] as string).replace(/\.json$/, '')
  })

  test('uploads the run as its history archive, waits until it is read and prints the studio URL', async () => {
    const p = await platform({ status: 'ready', polls: ['pending', 'pending'] })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`^Pushing ${runId}: \\d+ files, [\\d.]+ KB$`, 'm'))
      assert.match(r.stdout, /^Uploaded revision 1; waiting for the cloud platform to read it$/m)
      assert.ok(
        r.stdout.trimEnd().endsWith(`Ready: ${p.base}/studio?run=${runId}`),
        `ends with the studio URL:\n${r.stdout}`,
      )
      assert.equal(r.stderr, '')
      never(r.stdout + r.stderr)
      assert.deepEqual(
        p.seen.map((s) => `${s.method} ${s.path}`),
        [`PUT ${path()}`, `GET ${path()}`, `GET ${path()}`, `GET ${path()}`],
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
      assert.deepEqual(pushTemps(), [], 'the archive is removed once uploaded')
    } finally {
      await p.close()
    }
  })

  test('--no-wait returns once the run is uploaded', async () => {
    const p = await platform({ status: 'ready', polls: ['pending'] })
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

  test('status checks ride out a 503, a 429 and a dropped connection', async () => {
    const p = await platform({ status: 'ready', polls: [503, 429, 'reset'] })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /^Ready: /m)
      assert.equal(p.seen.filter((s) => s.method === 'GET').length, 4)
    } finally {
      await p.close()
    }
  })

  test('a status answer that is not one exits 3, naming it', async () => {
    const p = await platform({ status: 'ready', polls: ['junk'] })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stderr, /answered how run .* stands with something else/)
      assert.doesNotMatch(r.stderr, /TypeError|at /)
    } finally {
      await p.close()
    }
  })

  test('a run the platform fails to read exits 3 with its error', async () => {
    const p = await platform({
      status: 'failed',
      polls: ['pending'],
      error: 'The archive is run x, not y.',
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
        const env = envFor(p.base)
        const r = await runCli(dir, ['cloud', 'push'], { env })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(r.stderr, said)
        assert.deepEqual(
          p.seen.map((s) => s.method),
          ['PUT'],
        )
        assert.deepEqual(pushTemps(), [], 'no archive is left behind')
        never(r.stdout + r.stderr)
      } finally {
        await p.close()
      }
    }
  })

  test('a redirected status check is refused and followed nowhere', async () => {
    const p = await platform({ redirectStatus: true })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /redirected the request to the status check elsewhere, and reeval doesn't send your sign-in on/,
      )
      assert.deepEqual(
        p.seen.map((s) => `${s.method} ${s.path}`),
        [`PUT ${path()}`, `GET ${path()}`],
      )
    } finally {
      await p.close()
    }
  })

  test('a symlink in the run folder is left out, never followed', async () => {
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, `GITHUB_TOKEN=${SECRET}\n`)
    const link = join(dir, HISTORY, runId, 'linked.txt')
    symlinkSync(outside, link)
    const p = await platform({ status: 'ready' })
    try {
      const r = await runCli(dir, ['cloud', 'push', '--no-wait'], { env: envFor(p.base) })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const archive = await openArchive(bufferSource((p.seen[0] as Seen).body))
      assert.ok(!archive.has(`${runId}/linked.txt`))
      await archive.close()
      noSecret(r.stdout + r.stderr)
    } finally {
      rmSync(link)
      rmSync(outside)
      await p.close()
    }
  })

  test('a redirected upload is refused and followed nowhere', async () => {
    const p = await platform({ redirect: true })
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /redirected the request to the upload elsewhere, and reeval doesn't send your sign-in on: check REEVAL_CLOUD_URL/,
      )
      assert.deepEqual(
        p.seen.map((s) => s.path),
        [path()],
      )
    } finally {
      await p.close()
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

  const refused = async (name: string, data: string | Buffer, said: RegExp) => {
    const p = await platform({ status: 'ready' })
    try {
      await withFile(name, data, async () => {
        const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(r.stderr, new RegExp(`Refusing to push ${runId}: `))
        assert.match(r.stderr, said)
        assert.match(r.stderr, /pass --skip-secret-scan to push anyway/)
        noSecret(r.stdout + r.stderr)
        assert.deepEqual(p.seen, [], 'nothing is sent')
      })
    } finally {
      await p.close()
    }
  }

  test('a text file that looks like it holds a secret stops the push before anything is sent', () =>
    refused(
      'notes.txt',
      `first line\nGITHUB_TOKEN=${SECRET}\n`,
      new RegExp(
        `1 file looks like it holds a secret:\\n  ${runId}/notes\\.txt: line 2: GitHub token`,
      ),
    ))

  test('a binary file with NULs is scanned too', () =>
    refused(
      'blob.log',
      Buffer.concat([Buffer.from([0, 1, 2, 0, 255]), Buffer.from(`\nGITHUB_TOKEN=${SECRET}\n`)]),
      new RegExp(`  ${runId}/blob\\.log: line 2: GitHub token`),
    ))

  test('a UTF-16 file is scanned as UTF-16, with or without a byte-order mark', async () => {
    await refused(
      'notes16.txt',
      Buffer.from(`first\nGITHUB_TOKEN=${SECRET}\n`, 'utf16le'),
      new RegExp(`  ${runId}/notes16\\.txt: line 2: GitHub token`),
    )
    await refused(
      'bom16.txt',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`GITHUB_TOKEN=${SECRET}`, 'utf16le')]),
      new RegExp(`  ${runId}/bom16\\.txt: line 1: GitHub token`),
    )
  })

  test('a gzip file is unpacked and scanned', () =>
    refused(
      'out.log.gz',
      gzipSync(`ok\nGITHUB_TOKEN=${SECRET}\n`),
      new RegExp(`  ${runId}/out\\.log\\.gz!: line 2: GitHub token`),
    ))

  test('a file compressed in a format the scan cannot read is refused, naming it', () =>
    refused(
      'trace.tar.xz',
      Buffer.from('not readable here'),
      new RegExp(
        `the secret scan can't read 1 file:\\n  ${runId}/trace\\.tar\\.xz \\(xz-compressed\\)`,
      ),
    ))

  test("a file's name is scanned, and masked where it's shown", () =>
    refused(
      `${SECRET}.bin`,
      'harmless',
      new RegExp(`  ${runId}/\\[REDACTED\\]: name: GitHub token`),
    ))

  test("a folder's name is scanned, and masked in every path shown", async () => {
    const folder = join(dir, HISTORY, runId, SECRET)
    mkdirSync(folder)
    try {
      await refused(
        `${SECRET}/notes.txt`,
        `GITHUB_TOKEN=${SECRET}\n`,
        new RegExp(
          `  ${runId}/\\[REDACTED\\]: name: GitHub token\\n  ${runId}/\\[REDACTED\\]/notes\\.txt: line 1: GitHub token`,
        ),
      )
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('--skip-secret-scan uploads anyway, printing what the scan found', async () => {
    const p = await platform({ status: 'ready' })
    try {
      await withFile('notes.txt', `GITHUB_TOKEN=${SECRET}\n`, async () => {
        const r = await runCli(dir, ['cloud', 'push', '--skip-secret-scan', '--no-wait'], {
          env: envFor(p.base),
        })
        assert.equal(r.code, 0, r.stdout + r.stderr)
        assert.match(
          r.stderr,
          new RegExp(
            `Pushing ${runId} despite what looks like a secret in:\\n  ${runId}/notes\\.txt: line 1: GitHub token`,
          ),
        )
        noSecret(r.stdout + r.stderr)
        assert.deepEqual(
          p.seen.map((s) => s.method),
          ['PUT'],
        )
      })
    } finally {
      await p.close()
    }
  })

  test('a file name an archive cannot hold is refused cleanly', async () => {
    const p = await platform({ status: 'ready' })
    try {
      await withFile('back\\slash.txt', 'fine', async () => {
        const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(
          r.stderr,
          new RegExp(
            `${runId} has a file whose name can't go in an archive: ".*back\\\\\\\\slash\\.txt"`,
          ),
        )
        assert.deepEqual(p.seen, [])
      })
    } finally {
      await p.close()
    }
  })

  /** A saved analysis of `of` (default the run), from the corpus, with `change` applied. */
  const analysisOf = (change: (doc: Doc) => void = () => {}, of = runId) => {
    const doc = JSON.parse(readFileSync(CORPUS_ANALYSIS, 'utf8')) as Doc
    doc.anchor = of
    ;(doc.scope as Doc).head = of
    change(doc)
    return `${JSON.stringify(doc, null, 2)}\n`
  }
  const withAnalysis = (data: string, fn: () => Promise<void>) => {
    mkdirSync(join(dir, HISTORY, runId, 'analysis'), { recursive: true })
    return withFile(`analysis/${ANALYSIS_NAME}`, data, fn)
  }

  test("carries the run's saved analyses, which its history archive leaves out, without their Markdown", async () => {
    const p = await platform({ status: 'ready' })
    try {
      await withAnalysis(analysisOf(), () =>
        withFile(
          `analysis/${ANALYSIS_NAME.replace(/\.json$/, '.md')}`,
          '# The analysis\n',
          async () => {
            const r = await runCli(dir, ['cloud', 'push', runId, '--no-wait'], {
              env: envFor(p.base),
            })
            assert.equal(r.code, 0, r.stdout + r.stderr)
            const archive = await openArchive(bufferSource((p.seen[0] as Seen).body))
            const path = `${runId}/analysis/${ANALYSIS_NAME}`
            const paths = archive.manifest.files.map((f) => f.path)
            assert.ok(archive.has(path), paths.join('\n'))
            assert.equal(JSON.parse((await archive.read(path)).toString()).anchor, runId)
            assert.deepEqual(
              paths.filter((f) => f.includes('/analysis/')),
              [path],
              'only the analysis documents, not their Markdown',
            )
            await archive.verify()
            await archive.close()
          },
        ),
      )
    } finally {
      await p.close()
    }
  })

  test('--out writes the saved analyses into the archive too', async () => {
    const out = join(tempDir('cloud-push-out'), 'run.zip')
    await withAnalysis(analysisOf(), async () => {
      const r = await runCli(dir, ['cloud', 'push', runId, '--out', out], {
        env: envFor('http://127.0.0.1:9'),
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const archive = await openArchive(bufferSource(readFileSync(out)))
      assert.ok(archive.has(`${runId}/analysis/${ANALYSIS_NAME}`))
      await archive.close()
    })
  })

  test("a .json that isn't an analysis, and an analysis linked from outside the run's folder, are left out with a warning", async () => {
    const p = await platform({ status: 'ready' })
    const outside = join(dir, 'outside.json')
    writeFileSync(outside, analysisOf())
    const link = join(dir, HISTORY, runId, 'analysis', 'linked.json')
    try {
      await withAnalysis(analysisOf(), () =>
        withFile('analysis/notes.json', '{"kind": "my-notes"}', async () => {
          symlinkSync(outside, link)
          const r = await runCli(dir, ['cloud', 'push', runId, '--no-wait'], {
            env: envFor(p.base),
          })
          assert.equal(r.code, 0, r.stdout + r.stderr)
          assert.match(
            r.stderr,
            new RegExp(
              `Leaving ${runId}/analysis/notes\\.json out of the push: it isn't a reeval analysis`,
            ),
          )
          assert.match(
            r.stderr,
            new RegExp(
              `Leaving ${runId}/analysis/linked\\.json out of the push: it links outside the run's folder`,
            ),
          )
          const archive = await openArchive(bufferSource((p.seen[0] as Seen).body))
          assert.deepEqual(
            archive.manifest.files.map((f) => f.path).filter((f) => f.includes('/analysis/')),
            [`${runId}/analysis/${ANALYSIS_NAME}`],
          )
          await archive.close()
        }),
      )
    } finally {
      rmSync(link, { force: true })
      rmSync(outside)
      await p.close()
    }
  })

  test('a saved analysis past the size cap, failing its schema or of another run is refused with nothing sent', async () => {
    const path = `${runId}/analysis/${ANALYSIS_NAME}`
    const cases: Array<[string, RegExp]> = [
      [
        analysisOf((d) => {
          d.cited = { F1: 'x'.repeat(2 ** 20) }
        }),
        new RegExp(`${path} is \\d{7} bytes, and an analysis may be at most 1048576 \\(1 MiB\\)`),
      ],
      [
        analysisOf((d) => {
          ;(d.analysis as Doc).tldr = 42
        }),
        new RegExp(`${path}'s analysis\\.tldr`),
      ],
      [
        analysisOf((d) => {
          delete d.validation
        }),
        new RegExp(`${path}'s validation`),
      ],
      [
        analysisOf((d) => {
          d.schemaVersion = 99
        }),
        new RegExp(`${path} was written by a newer reeval \\(schemaVersion 99`),
      ],
      ['{"kind": "reeval-analysis", ', new RegExp(`${path} isn't JSON`)],
      [
        '{"kind": "reeval-analysis"}',
        new RegExp(`${path} has no schemaVersion, which every reeval analysis has`),
      ],
      [
        analysisOf((d) => {
          d.analysis = {}
        }),
        new RegExp(`${path}'s analysis\\.tldr`),
      ],
      [
        analysisOf(() => {}, '20260101T000000Z_0000000_ci_aaaa'),
        new RegExp(`${path} is an analysis of run 20260101T000000Z_0000000_ci_aaaa, not ${runId}`),
      ],
    ]
    for (const [data, said] of cases) {
      const p = await platform({ status: 'ready' })
      try {
        await withAnalysis(data, async () => {
          for (const command of [
            ['cloud', 'push', runId],
            ['studio', 'share', runId],
          ]) {
            const r = await runCli(dir, command, { env: envFor(p.base) })
            assert.equal(r.code, 2, r.stdout + r.stderr)
            assert.match(
              r.stderr,
              new RegExp(`Refusing to push ${runId}: a saved analysis can't go with it:`),
            )
            assert.match(r.stderr, said)
            assert.match(r.stderr, /Fix or remove it, then push again\./)
          }
          assert.deepEqual(p.seen, [], 'nothing is sent')
        })
      } finally {
        await p.close()
      }
    }
  })

  test('a run another process is recording is refused until it finishes', async () => {
    const p = await platform({ status: 'ready' })
    const claim = join(dir, HISTORY, `.tmp-${runId}.claim`)
    writeFileSync(claim, `${process.pid}\n${hostname()}\nabc\n`)
    try {
      const r = await runCli(dir, ['cloud', 'push'], { env: envFor(p.base) })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /is being recorded by another process right now/)
      assert.deepEqual(p.seen, [])
    } finally {
      rmSync(claim)
      await p.close()
    }
  })

  test('the newest run, or one named, only in .reeval/runs is refused with how to record it', async () => {
    const p = await platform({ status: 'ready' })
    try {
      const run = await runCli(dir, ['run'])
      assert.equal(run.code, 0, run.stdout + run.stderr)
      const scratch = readdirSync(join(dir, '.reeval/runs'))
        .filter((f) => f.endsWith('.json') && f !== `${runId}.json`)
        .map((f) => f.replace(/\.json$/, ''))
      assert.equal(scratch.length, 1)
      for (const args of [[], [scratch[0] as string]]) {
        const r = await runCli(dir, ['cloud', 'push', ...args], { env: envFor(p.base) })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(
          r.stderr,
          new RegExp(`Run ${scratch[0]} isn't recorded: reeval record ${scratch[0]} records it`),
        )
      }
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })
})

describe('reeval cloud push from a remote history store', () => {
  let s3: FakeS3
  let dir = ''
  before(async () => {
    s3 = await fakeS3()
    dir = await linkedProject(
      'cloud-push-store',
      `profiles: {
    ci: { history: { store: { kind: 's3', bucket: '${s3.bucket}', endpoint: '${s3.url}', prefix: 'ci' } } },
  },`,
    )
  })
  after(() => s3.close())

  test('pulls the store before reading it, unless --offline', async () => {
    const keys = {
      AWS_ACCESS_KEY_ID: s3.accessKey,
      AWS_SECRET_ACCESS_KEY: s3.secretKey,
      CI: 'false',
      GITHUB_ACTIONS: 'false',
    }
    const run = await runCli(dir, ['run', '--profile', 'ci', '--record'], { env: keys })
    assert.equal(run.code, 0, run.stdout + run.stderr)
    rmSync(join(dir, '.reeval/store'), { recursive: true, force: true })
    rmSync(join(dir, '.reeval/runs'), { recursive: true, force: true })
    const p = await platform({ status: 'ready' })
    try {
      const env = { ...envFor(p.base), ...keys }
      const offline = await runCli(dir, ['cloud', 'push', '--profile', 'ci', '--offline'], { env })
      assert.equal(offline.code, 2, offline.stdout + offline.stderr)
      assert.deepEqual(p.seen, [])
      const r = await runCli(dir, ['cloud', 'push', '--profile', 'ci', '--no-wait'], { env })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /^Pushing \S+: \d+ files/m)
      assert.deepEqual(
        p.seen.map((s) => s.method),
        ['PUT'],
      )
    } finally {
      await p.close()
    }
  })
})

describe('the push scan', () => {
  const zipOf = async (files: Record<string, string | Buffer>) => {
    const chunks: Buffer[] = []
    const zip = new ZipWriter((b) => void chunks.push(Buffer.from(b)), { mtime: new Date(0) })
    for (const [path, data] of Object.entries(files)) await zip.add(path, Buffer.from(data))
    await zip.finish()
    return Buffer.concat(chunks)
  }

  test('a file larger than one string can hold is scanned in windows, across their seams', async () => {
    const line = 'ordinary log output of a moderate length, nothing to see here\n'
    const size = 600 * 2 ** 20
    const big = Buffer.alloc(size, line)
    // Across the first window's seam (4 MiB, less the 64 KiB the next one repeats), and at the end.
    const seam = 4 * 2 ** 20 - 64 * 2 ** 10 - 10
    big.write(`\nX ${SECRET}\n`, seam)
    big.write(`\nGITHUB_TOKEN=${SECRET}\n`, size - 100)
    const lineOf = (at: number) => {
      let n = 2
      for (let i = big.indexOf(10); i !== -1 && i < at; i = big.indexOf(10, i + 1)) n++
      return n
    }
    const scan = await scanPush([{ path: 'run/big.log', data: big }])
    assert.deepEqual(scan.unread, [])
    assert.deepEqual(scan.findings, [
      `run/big.log: line ${lineOf(seam)}: GitHub token; line ${lineOf(size - 100)}: GitHub token`,
    ])
  })

  test('a secret a window cuts through, with no line break to cut at, is found once', async () => {
    const flat = Buffer.alloc(9 * 2 ** 20, ' ')
    // One across where the window's own part ends, one across the window's end.
    flat.write(SECRET, 4 * 2 ** 20 - 64 * 2 ** 10 - 10)
    flat.write(SECRET, 4 * 2 ** 20 - 10)
    const scan = await scanPush([{ path: 'run/flat.txt', data: flat }])
    assert.deepEqual(scan.findings, ['run/flat.txt: line 1: GitHub token; line 1: GitHub token'])
  })

  test('a gzip bomb stops at the unpack limit and is named unread', async () => {
    const bomb = gzipSync(Buffer.alloc(300 * 2 ** 20, 'a'), { level: 9 })
    assert.ok(bomb.length < 2 ** 20)
    const scan = await scanPush([
      { path: 'run/bomb.gz', data: bomb },
      { path: 'run/after.gz', data: gzipSync(`GITHUB_TOKEN=${SECRET}`) },
    ])
    assert.deepEqual(scan.unread, [
      'run/bomb.gz (too large to unpack and scan)',
      'run/after.gz (too large to unpack and scan)',
    ])
    assert.deepEqual(scan.findings, [])
  })

  test('a zip entry that would unpack past the limit is named unread, not unpacked', async () => {
    const big = await zipOf({ 'big.txt': Buffer.alloc(300 * 2 ** 20, 'a') })
    assert.ok(big.length < 2 ** 20)
    const scan = await scanPush([
      { path: 'run/big.zip', data: big },
      { path: 'run/after.zip', data: await zipOf({ 'x.txt': `GITHUB_TOKEN=${SECRET}` }) },
    ])
    assert.deepEqual(scan.unread, ['run/big.zip!/big.txt (too large to unpack and scan)'])
    assert.deepEqual(scan.findings, ['run/after.zip!/x.txt: line 1: GitHub token'])
  })

  test('nested gzip, brotli and zip are unpacked, each labeled once', async () => {
    const scan = await scanPush([
      { path: 'run/twice.gz', data: gzipSync(gzipSync(`GITHUB_TOKEN=${SECRET}`)) },
      { path: 'run/out.br', data: brotliCompressSync(`GITHUB_TOKEN=${SECRET}`) },
      { path: 'run/plain.br', data: Buffer.from(`GITHUB_TOKEN=${SECRET}`) },
      {
        path: 'run/art.zip',
        data: await zipOf({ 'a/inner.zip': await zipOf({ 'b/x.txt': `GITHUB_TOKEN=${SECRET}` }) }),
      },
    ])
    assert.deepEqual(scan.unread, [])
    assert.deepEqual(scan.findings, [
      'run/twice.gz!: line 1: GitHub token',
      'run/out.br!: line 1: GitHub token',
      'run/plain.br: line 1: GitHub token',
      'run/art.zip!/a/inner.zip!/b/x.txt: line 1: GitHub token',
    ])
  })

  test('compressed data under any name is found by its magic number', async () => {
    const token = `GITHUB_TOKEN=${SECRET}`
    const zstd = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync
    const scan = await scanPush([
      { path: 'run/blob.bin', data: deflateSync(token) },
      { path: 'run/fast.bin', data: deflateSync(token, { level: 1 }) },
      { path: 'run/x.txt', data: Buffer.from(`x^ ${token}`) },
      {
        path: 'run/a.bin',
        data: Buffer.concat([Buffer.from('fd377a585a00', 'hex'), Buffer.from(token)]),
      },
      {
        path: 'run/b.bin',
        data: Buffer.concat([Buffer.from('BZh9'), Buffer.from('314159265359', 'hex')]),
      },
      {
        path: 'run/c.bin',
        data: zstd ? zstd(Buffer.from(token)) : Buffer.from('28b52ffd00', 'hex'),
      },
    ])
    assert.deepEqual(scan.unread, [
      'run/a.bin (xz-compressed)',
      'run/b.bin (bzip2-compressed)',
      ...(zstd ? [] : ['run/c.bin (zstd-compressed)']),
    ])
    assert.deepEqual(scan.findings, [
      'run/blob.bin!: line 1: GitHub token',
      'run/fast.bin!: line 1: GitHub token',
      'run/x.txt: line 1: GitHub token',
      ...(zstd ? ['run/c.bin!: line 1: GitHub token'] : []),
    ])
  })

  test('what follows the end of a compressed stream is scanned too', async () => {
    const token = Buffer.from(`GITHUB_TOKEN=${SECRET}`)
    const zstd = (zlib as { zstdCompressSync?: (b: string) => Buffer }).zstdCompressSync
    const scan = await scanPush([
      { path: 'run/a.bin', data: Buffer.concat([deflateSync('short'), token]) },
      { path: 'run/b.bin', data: Buffer.concat([deflateSync('short'), deflateSync(token)]) },
      { path: 'run/c.br', data: Buffer.concat([brotliCompressSync('short'), token]) },
      ...(zstd ? [{ path: 'run/d.bin', data: Buffer.concat([zstd('short'), token]) }] : []),
      { path: 'run/e.gz', data: Buffer.concat([gzipSync('short'), token]) },
    ])
    assert.deepEqual(scan.findings, [
      'run/a.bin: line 1: GitHub token',
      'run/b.bin!: line 1: GitHub token',
      'run/c.br: line 1: GitHub token',
      ...(zstd ? ['run/d.bin: line 1: GitHub token'] : []),
    ])
    assert.deepEqual(scan.unread, ["run/e.gz (the scan couldn't finish reading it)"])
  })

  test('a percent-encoded secret in a path segment is found and masked', async () => {
    const encoded = SECRET.replace('_', '%5F')
    const scan = await scanPush([
      { path: `run/${encoded}.html`, data: Buffer.from('fine') },
      { path: 'run/art.zip', data: await zipOf({ [`d/${encoded}/ok.txt`]: 'fine' }) },
      { path: 'run/100%off.txt', data: Buffer.from('fine') },
    ])
    assert.deepEqual(scan.unread, [])
    assert.deepEqual(scan.findings, [
      'run/[REDACTED]: name: GitHub token',
      'run/art.zip!/d/[REDACTED]: name: GitHub token',
    ])
    assert.equal(scan.mask('run/100%off.txt'), 'run/100%off.txt')
    const shown = JSON.stringify(scan.findings)
    noSecret(shown)
    assert.ok(!shown.includes(encoded.slice(0, 12)), shown)
  })

  test("a zip entry's folders are scanned and masked", async () => {
    const scan = await scanPush([
      {
        path: 'run/art.zip',
        data: await zipOf({ [`d/${SECRET}/ok.txt`]: 'fine', 'd/ok.txt': 'fine' }),
      },
    ])
    assert.deepEqual(scan.unread, [])
    assert.deepEqual(scan.findings, ['run/art.zip!/d/[REDACTED]: name: GitHub token'])
    assert.equal(scan.mask(`run/art.zip!/d/${SECRET}/ok.txt`), 'run/art.zip!/d/[REDACTED]/ok.txt')
    noSecret(JSON.stringify(scan.findings))
  })
})

describe('the analyses a push carries', () => {
  const shapeSchema = (name: string) =>
    JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'schema', `${name}.schema.json`), 'utf8'),
    ) as ShapeSchema
  const corpusAnalyses = () =>
    (readdirSync(RECORDS, { recursive: true }) as string[])
      .map((f) => f.replaceAll(sep, '/'))
      .filter((f) => /\/analysis\/[^/]+\.json$/.test(f))

  test('every saved analysis in the corpus passes, as it fits the analysis schema', () => {
    const files = corpusAnalyses()
    assert.ok(files.length >= 3, files.join('\n'))
    const schema = shapeSchema('analysis')
    for (const file of files) {
      const bytes = readFileSync(join(RECORDS, file))
      const runId = file.split('/').at(-3) as string
      const doc = readableAnalysis(JSON.parse(bytes.toString()))
      assert.deepEqual(validate(schema, doc), [], file)
      assert.equal(analysisProblem(bytes, file, runId), undefined, file)
    }
  })

  test('a field the schema refuses is refused, and one a newer reeval added passes', () => {
    const bytes = readFileSync(CORPUS_ANALYSIS)
    const runId = '20261030T183503Z_7e9208f_cursor-agent_c479'
    const changed = (change: (doc: Doc) => void) => {
      const doc = JSON.parse(bytes.toString()) as Doc
      change(doc)
      return Buffer.from(JSON.stringify(doc))
    }
    const schema = shapeSchema('analysis')
    for (const change of [
      (d: Doc) => {
        d.route = 'carrier-pigeon'
      },
      (d: Doc) => {
        ;((d.analysis as Doc).actions as Doc[]).push({ title: 'no target' })
      },
      (d: Doc) => {
        ;(d.usage as Doc).inputTokens = 'many'
      },
    ]) {
      const bad = changed(change)
      assert.notDeepEqual(validate(schema, JSON.parse(bad.toString())), [])
      assert.match(analysisProblem(bad, 'a.json', runId) ?? '', /^a\.json's /)
    }
    const newer = changed((d) => {
      d.addedLater = { by: 'a newer reeval' }
      ;(d.analysis as Doc).addedLater = 1
    })
    assert.equal(analysisProblem(newer, 'a.json', runId), undefined)
  })
})

/** A canned analysis, no citations to check; \`TEST_TLDR_BYTES\` pads its TL;DR to that size. */
const ANALYZE = `analysis: {
    model: fakeAnalysis({
      output: () => ({
        tldr: process.env.TEST_TLDR_BYTES
          ? 'x'.repeat(Number(process.env.TEST_TLDR_BYTES))
          : 'The agent wrote hello.txt.',
        whatHappened: [],
        results: [],
        why: [],
        anomalies: [],
        actions: [],
        confidence: { overall: 'low', why: 'one attempt' },
      }),
    }),
  },`

describe('reeval analyze --save --push', () => {
  let dir = ''
  let runId = ''
  const saved = () =>
    readdirSync(join(dir, HISTORY, runId, 'analysis')).filter((f) => f.endsWith('.json'))
  before(async () => {
    dir = await linkedProject(
      'analyze-push',
      ANALYZE,
      "import { fakeAnalysis } from 'reeval/judge'\n",
    )
    const run = await runCli(dir, ['run', '--record'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    runId = (readdirSync(join(dir, HISTORY)).find((f) => f.endsWith('.json')) as string).replace(
      /\.json$/,
      '',
    )
  })
  const fresh = () =>
    rmSync(join(dir, HISTORY, runId, 'analysis'), { recursive: true, force: true })

  test('saves the analysis, then sends it as it was saved to PUT /api/v1/runs/:runId/analysis', async () => {
    fresh()
    const p = await platform({ status: 'ready' }, [runId])
    try {
      const r = await runCli(dir, ['analyze', runId, '--save', '--push', '--no-cache'], {
        env: envFor(p.base),
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.deepEqual(
        p.seen.map((s) => `${s.method} ${s.path}`),
        [`PUT /api/v1/runs/${runId}/analysis`],
      )
      const put = p.seen[0] as Seen
      assert.equal(put.auth, `Bearer ${TOKEN}`)
      assert.equal(put.type, 'application/json')
      const [name] = saved()
      assert.ok(name)
      assert.deepEqual(put.body, readFileSync(join(dir, HISTORY, runId, 'analysis', name)))
      assert.equal(JSON.parse(put.body.toString()).anchor, runId)
      assert.match(
        r.stderr,
        new RegExp(`pushed it to the cloud studio: ${p.base}/studio\\?run=${runId}`),
      )
      assert.match(r.stdout, /The agent wrote hello\.txt\./)
      never(r.stdout + r.stderr)
    } finally {
      await p.close()
    }
  })

  test('a run the cloud lacks exits 2, says how to push it, and keeps the analysis saved', async () => {
    fresh()
    const p = await platform({ status: 'ready' })
    try {
      const r = await runCli(dir, ['analyze', runId, '--save', '--push'], { env: envFor(p.base) })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        new RegExp(
          `The cloud has no run ${runId}, so the analysis stays saved here only: reeval cloud push ${runId} uploads the run with its saved analyses\\.`,
        ),
      )
      assert.equal(saved().length, 1)
      assert.deepEqual(
        p.seen.map((s) => s.method),
        ['PUT'],
      )
      const push = await runCli(dir, ['cloud', 'push', runId, '--no-wait'], { env: envFor(p.base) })
      assert.equal(push.code, 0, push.stdout + push.stderr)
      const archive = await openArchive(bufferSource((p.seen.at(-1) as Seen).body))
      assert.ok(archive.has(`${runId}/analysis/${saved()[0]}`))
      await archive.close()
    } finally {
      await p.close()
    }
  })

  test('a platform that takes no analysis uploads exits 3, saying so, and keeps the analysis saved', async () => {
    fresh()
    const p = await platform({ status: 'ready' }, [runId], 'no-route')
    try {
      const r = await runCli(dir, ['analyze', runId, '--save', '--push'], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        new RegExp(
          `The cloud platform doesn't take analysis uploads \\(HTTP 404 from /api/v1/runs/${runId}/analysis\\), so the analysis stays saved here only\\.`,
        ),
      )
      assert.doesNotMatch(r.stderr, /reeval cloud push/)
      assert.equal(saved().length, 1)
    } finally {
      await p.close()
    }
  })

  test('a redirected analysis upload is refused and followed nowhere', async () => {
    fresh()
    const p = await platform({ status: 'ready' }, [runId], 'redirect')
    try {
      const r = await runCli(dir, ['analyze', runId, '--save', '--push'], { env: envFor(p.base) })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /redirected the request to the analysis upload elsewhere, and reeval doesn't send your sign-in on: check REEVAL_CLOUD_URL/,
      )
      assert.deepEqual(
        p.seen.map((s) => `${s.method} ${s.path}`),
        [`PUT /api/v1/runs/${runId}/analysis`],
      )
      assert.equal(saved().length, 1)
    } finally {
      await p.close()
    }
  })

  test('a refused token exits 2 and a failing platform 3, naming the upload, never the token', async () => {
    for (const [answer, code, said] of [
      [
        401,
        2,
        `the cloud platform refused to upload the analysis of run ${runId}: That token was revoked\\.`,
      ],
      [503, 3, `couldn't upload the analysis of run ${runId}: Try again shortly\\.`],
    ] as const) {
      fresh()
      const p = await platform({ status: 'ready' }, [runId], answer)
      try {
        const r = await runCli(dir, ['analyze', runId, '--save', '--push'], {
          env: envFor(p.base),
        })
        assert.equal(r.code, code, r.stdout + r.stderr)
        assert.match(r.stderr, new RegExp(said))
        never(r.stdout + r.stderr)
        assert.equal(saved().length, 1)
      } finally {
        await p.close()
      }
    }
  })

  test('an analysis that fails its checks is refused before anything is sent, and stays saved', async () => {
    fresh()
    const p = await platform({ status: 'ready' }, [runId])
    try {
      const r = await runCli(dir, ['analyze', runId, '--save', '--push', '--no-cache'], {
        env: { ...envFor(p.base), TEST_TLDR_BYTES: String(2 ** 20) },
      })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /Refusing to push the analysis: \S+\.json is \d{7} bytes, and an analysis may be at most 1048576 \(1 MiB\)/,
      )
      assert.deepEqual(p.seen, [], 'nothing is sent')
      assert.equal(saved().length, 1)
    } finally {
      rmSync(join(dir, '.reeval', 'analysis'), { recursive: true, force: true })
      await p.close()
    }
  })

  test('--save --push --dry-run plans without signing in', async () => {
    fresh()
    const p = await platform({ status: 'ready' }, [runId])
    try {
      const r = await runCli(dir, ['analyze', runId, '--save', '--push', '--dry-run'], {
        env: envFor(p.base, null),
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`digest ${runId}: `))
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })

  test('--push without --save, and --push signed out, are refused before anything is saved or sent', async () => {
    fresh()
    const p = await platform({ status: 'ready' }, [runId])
    try {
      const alone = await runCli(dir, ['analyze', runId, '--push'], { env: envFor(p.base) })
      assert.equal(alone.code, 2, alone.stdout + alone.stderr)
      assert.match(
        alone.stderr,
        /reeval analyze --push uploads the analysis --save writes: pass --save --push/,
      )
      const out = await runCli(dir, ['analyze', runId, '--save', '--push'], {
        env: envFor(p.base, null),
      })
      assert.equal(out.code, 2, out.stdout + out.stderr)
      assert.match(
        out.stderr,
        /reeval analyze --push needs you signed in: reeval login signs in, or set REEVAL_TOKEN/,
      )
      assert.deepEqual(p.seen, [])
      assert.ok(!existsSync(join(dir, HISTORY, runId, 'analysis')), 'nothing is saved')
    } finally {
      await p.close()
    }
  })
})
