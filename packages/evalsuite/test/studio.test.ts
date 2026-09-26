import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import type { HistoryEntry, RunRecord } from '../src/history/types.ts'
import { COOKIE, createStudioApp } from '../src/studio/server.ts'
import { listHeaders, type StudioSource } from '../src/studio/source.ts'
import {
  activityLabel,
  artifactPath,
  buildIndex,
  cellRows,
  compareView,
  type DebugView,
  debugApiPath,
  evalHistory,
  evalTree,
  manifestPath,
  parseDataPath,
  parseTranscript,
  recordPath,
  runOutcome,
  runRows,
  shardPath,
  splitPatch,
  traceApiPath,
  transcriptItems,
} from '../src/view/index.ts'
import { baseEnv, fakeConfig, pkgRoot, project, runCli } from './helpers.ts'

const RUN = '20260924T220414Z_f7e1b53_elliot-hesp_k3f9'

describe('studio data paths', () => {
  test('map the file layout and nothing else', () => {
    assert.deepEqual(parseDataPath('studio.json'), { kind: 'studio' })
    assert.deepEqual(parseDataPath(manifestPath), { kind: 'manifest' })
    assert.deepEqual(parseDataPath(shardPath('2026-09')), { kind: 'shard', id: '2026-09' })
    assert.deepEqual(parseDataPath(recordPath(RUN)), { kind: 'record', runId: RUN })
    assert.deepEqual(parseDataPath(artifactPath(RUN, 'my-eval-abc123/fake-x/1/transcript.jsonl')), {
      kind: 'artifact',
      runId: RUN,
      segments: ['my-eval-abc123', 'fake-x', '1', 'transcript.jsonl'],
    })
  })

  test('reject traversal, odd segments and unknown areas', () => {
    for (const path of [
      `data/runs/${RUN}/../../es.config.ts`,
      `data/runs/${RUN}/./summary.md`,
      `data/runs/${RUN}//summary.md`,
      `data/runs/${RUN}/.hidden`,
      `data/runs/${RUN}/a\\b`,
      `data/runs/${RUN}/a\0b`,
      `data/runs/${RUN}/${'a/'.repeat(9)}x`,
      'data/runs/../secrets.json',
      'data/runs/not-a-run.json',
      'data/runs/not-a-run/summary.md',
      'data/index/latest.json',
      'data/index/2026-09/x.json',
      'data/other/x.json',
      '../data/index/manifest.json',
      '/etc/passwd',
      '',
    ]) {
      assert.equal(parseDataPath(path), null, path)
    }
  })
})

// A real history: three recorded runs of the fake agent (pass, fail, a control and a variant ×
// two runs) and one scratch run.
const evalFile = `import { defineEnvironment, evaluate, expect, group } from 'evalsuite'
const other = defineEnvironment('other', {})
group('greet', process.env.ES_TEST_COMPARE ? { compare: [other], runs: 2 } : {}, () => {
  evaluate('writes hello', async (t) => {
    await t.send('write hello.txt')
    await expect(t.exec('test -f hello.txt')).toSucceed()
    expect(await t.judge('Did it write hello.txt?')).toPass()
  })
})
`
const agent = "{ files: { 'hello.txt': 'hi\\n' }, text: 'Wrote it' }"

let dir = ''
let source: StudioSource
let headers: HistoryEntry[]
const records = new Map<string, RunRecord>()

before(async () => {
  const p = await project('studio', {
    '.gitignore': '.es/\nnode_modules/\nsandboxes/\n',
    'es.config.ts': fakeConfig({ harness: agent }),
    'evals/hello.es.ts': evalFile,
    'es.fail.config.ts': fakeConfig({
      harness: agent,
      judge: '{ model: fakeJudge({ score: 0.2 }) }',
    }),
  })
  dir = p.dir
  for (const [args, env] of [
    [['run', '--record']],
    [['run', '--record', '--config', 'es.fail.config.ts']],
    [['run', '--record'], { ES_TEST_COMPARE: '1' }],
    [['run']],
  ] as Array<[string[], NodeJS.ProcessEnv?]>) {
    const r = await runCli(dir, args, { env })
    assert.ok(r.code === 0 || r.code === 1, r.stderr + r.stdout)
  }
  source = { root: dir, historyDir: join(dir, 'evals/.history'), scratch: true }
  headers = await listHeaders(source)
  for (const h of headers) {
    const folder = h.recorded ? source.historyDir : join(dir, '.es/runs')
    records.set(h.runId, JSON.parse(readFileSync(join(folder, `${h.runId}.json`), 'utf8')))
  }
})

describe('run outcome and activity, as the CLI has them', () => {
  const skilled = `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const skilled = defineEnvironment('skilled', ({ skill }) => ({
  skills: [skill.inline({ name: 'ok', description: 'Writes ok.txt', content: 'Write ok.txt.' })],
}))
const compare = process.env.ES_TEST_GATE_ALL ? { variants: [skilled], gate: 'all' as const } : [skilled]
evaluate('writes ok', { compare }, async (t) => {
  await t.send('write ok.txt')
  await expect(t.exec('test -f ok.txt')).toSucceed()
})
`

  test("a run whose only failures are ungated is passed, as es run's exit 0 says", async () => {
    const p = await project('studio-ungated', {
      'es.config.ts': fakeConfig({ harness: "{ withSkill: { files: { 'ok.txt': 'y' } } }" }),
      'evals/ok.es.ts': skilled,
    })
    const ungated = await runCli(p.dir, ['run'])
    assert.equal(ungated.code, 0, ungated.stdout + ungated.stderr)
    const [header] = await listHeaders({
      root: p.dir,
      historyDir: join(p.dir, 'evals/.history'),
      scratch: true,
    })
    assert.ok(header)
    assert.deepEqual([header.summary.fail, header.summary.notGated], [1, 1])
    assert.equal(runOutcome(header), 'pass')

    // Twin: the same failure in a gated control fails the run, and es run exits 1.
    const gated = await runCli(p.dir, ['run'], { env: { ES_TEST_GATE_ALL: '1' } })
    assert.equal(gated.code, 1, gated.stdout + gated.stderr)
    const latest = (
      await listHeaders({ root: p.dir, historyDir: join(p.dir, 'evals/.history'), scratch: true })
    ).at(-1)
    assert.ok(latest && latest.runId !== header.runId)
    assert.equal(runOutcome(latest), 'fail')
  })

  test('the outcome follows the status too', () => {
    const pass = [{ outcome: 'pass' as const }]
    assert.equal(runOutcome({ status: 'complete', evals: pass }), 'pass')
    assert.equal(runOutcome({ status: 'budget', evals: pass }), 'fail')
    assert.equal(runOutcome({ status: 'interrupted', evals: pass }), 'skipped')
    assert.equal(
      runOutcome({ status: 'complete', evals: [...pass, { outcome: 'infra_error' }] }),
      'infra_error',
    )
  })

  test('tool calls and file edits are counted apart, on every page', () => {
    assert.equal(activityLabel({ tools: 21, fileEdits: 2 }), '21 tool calls · 2 file edits')
    assert.equal(activityLabel({ tools: 1, fileEdits: 0 }), '1 tool call · 0 file edits')
    const pages = ['pages/run.tsx', 'pages/attempt/index.tsx'].map((f) =>
      readFileSync(join(pkgRoot, '../studio-web/src', f), 'utf8'),
    )
    for (const page of pages) {
      assert.match(page, /activityLabel\((a|attempt)\.activity\)/)
      assert.doesNotMatch(page, /'tool call'/, 'no page counts tool calls its own way')
    }
  })
})

describe('view-models over a real history', () => {
  test('headers list recorded runs and unrecorded scratch runs, oldest first', () => {
    assert.deepEqual(
      headers.map((h) => h.recorded),
      [true, true, true, false],
    )
    assert.deepEqual(
      headers.map((h) => h.runId),
      [...headers.map((h) => h.runId)].sort(),
    )
    const evalHeader = headers[0]?.evals[0]
    assert.match(evalHeader?.slug ?? '', /^evals-hello-es-ts-greet-writes-hello-/)
    assert.deepEqual(
      evalHeader?.cells.map((c) => [c.key, c.pass, c.runs]),
      [['fake/-/fake', 1, 1]],
    )
  })

  test('the index shards by UTC month, newest first, with an eval catalog', () => {
    const { manifest, shards } = buildIndex(headers, '2026-01-01T00:00:00.000Z')
    const month = headers[0]?.startedAt.slice(0, 7) as string
    assert.deepEqual(manifest.shards, [{ id: month, runs: 4 }])
    assert.equal(manifest.latest, headers[3]?.runId)
    assert.deepEqual(
      shards.get(month)?.map((h) => h.runId),
      headers.map((h) => h.runId).reverse(),
    )
    assert.equal(manifest.evals.length, 1)
    assert.deepEqual(manifest.evals[0]?.path, ['greet', 'writes hello'])
    assert.equal(manifest.evals[0]?.runs, 4)
  })

  test('runs list: newest first, pass counts, drift against the previous complete run', () => {
    const rows = runRows(headers)
    assert.deepEqual(
      rows.map((r) => [r.passed, r.total]),
      [
        [1, 1],
        [4, 4],
        [0, 1],
        [1, 1],
      ],
    )
    // The compare run adds a variant cell: new coverage, while the control it shares is unchanged.
    assert.deepEqual(rows[1]?.drift, [])
    assert.equal(rows[1]?.changedEvals, 0)
    assert.deepEqual(rows[2]?.drift, [])
  })

  test('runs list: a run over a subset of cells is no drift, before or after it', () => {
    const cell = (harness: string, env: string, image: string) => ({
      key: `${harness}/${env}/es-tarball`,
      role: 'variant',
      variant: env,
      harness,
      environment: env,
      environmentDigest: `sha256:${env}0000000000000`,
      fingerprint: `${harness}/${env}/${image}`,
      fingerprintParts: { image, agentCli: harness.startsWith('cursor') ? '2026.09' : '1.2.11' },
    })
    const agy = ['es-good', 'es-weak'].map((e) => cell('antigravity:gemini', e, 'sha256:a1'))
    const cursor = (image: string) =>
      ['es-good', 'es-weak'].map((e) => cell('cursor:composer', e, image))
    const run = (n: number, cells: ReturnType<typeof cell>[]) =>
      ({
        runId: `2026092${n}T000000Z_abc1234_ci_000${n}`,
        status: 'complete',
        summary: { pass: cells.length, fail: 0, infraError: 0 },
        stack: {
          imageIds: [...new Set(cells.map((c) => c.fingerprintParts.image))],
          agentClis: [...new Set(cells.map((c) => c.fingerprintParts.agentCli))],
          harnesses: [...new Set(cells.map((c) => c.harness))],
          environments: [...new Set(cells.map((c) => `${c.environment}@${c.environment}00000`))],
          judgeModel: 'google/gemini-3.8-flash',
          judgeServed: [],
          judgeVersion: '1',
          threshold: 0.8,
          fingerprintScope: ['sources'],
        },
        evals: [
          {
            id: 'evals/scaffold.es.ts › scaffolds',
            fingerprint: cells.map((c) => c.fingerprint).join(),
            cells,
          },
        ],
      }) as unknown as HistoryEntry
    const rows = runRows([
      run(1, [...cursor('sha256:c1'), ...agy]),
      run(2, agy.slice(0, 1)),
      run(3, [...cursor('sha256:c2'), ...agy]),
      run(4, agy.slice(0, 1)),
      run(5, [...cursor('sha256:c2'), ...agy]),
    ]).reverse()
    assert.deepEqual(
      rows.map((r) => [r.drift.map((c) => `${c.label}: ${c.base} → ${c.head}`), r.changedEvals]),
      [
        [[], 0],
        [[], 0],
        // Measured against the last run that had the Cursor cells, not the subset run before it.
        [['image ids: sha256:c1 → sha256:c2'], 1],
        [[], 0],
        [[], 0],
      ],
    )
  })

  test('eval tree, cells and lift for a multi-cell run', () => {
    const matrix = records.get(headers[2]?.runId as string) as RunRecord
    const tree = evalTree(matrix)
    assert.equal(tree[0]?.kind, 'group')
    assert.equal(tree[0]?.name, 'evals/hello.es.ts')
    assert.deepEqual(tree[0]?.tally, { pass: 4, fail: 0, infra: 0, skipped: 0 })
    const rows = cellRows(matrix.evals[0] as RunRecord['evals'][number])
    assert.deepEqual(
      rows.map((r) => [r.environment, r.role, r.gated, r.pass, r.runs, r.lift, r.attempts.length]),
      [
        ['-', 'control', false, 2, 2, null, 2],
        ['other', 'variant', true, 2, 2, 0, 2],
      ],
    )
  })

  test('eval history marks where the eval changed', () => {
    const points = evalHistory(headers, headers[0]?.evals[0]?.slug as string)
    assert.deepEqual(
      points.map((p) => [p.outcome, p.changed]),
      [
        ['pass', false],
        ['fail', false],
        ['pass', true],
        ['pass', true],
      ],
    )
  })

  test('compare flags the regression and its judge-score delta', () => {
    const [base, head] = headers as [HistoryEntry, HistoryEntry]
    const view = compareView(base, head, {
      base: records.get(base.runId),
      head: records.get(head.runId),
    })
    assert.equal(view.counts.regressed, 1)
    assert.deepEqual(
      view.rows.map((r) => [r.status, r.basePassRate, r.headPassRate, r.baseScore, r.headScore]),
      [['regressed', 1, 0, 0.9, 0.2]],
    )
  })

  test('transcripts parse into turns and events, skipping broken lines', async () => {
    const run = records.get(headers[0]?.runId as string) as RunRecord
    const ref = run.evals[0]?.attempts[0]?.files.transcript
    assert.ok(ref)
    const text = await readFile(join(source.historyDir, run.runId, ref.path), 'utf8')
    const items = transcriptItems(parseTranscript(`${text}{"truncated`))
    assert.equal(items[0]?.kind, 'turn')
    assert.equal(items.at(-1)?.kind, 'turn-end')
    assert.ok(items.some((i) => i.kind === 'event' && i.event.type === 'file-edit'))
  })

  test('patches split per file with line counts', () => {
    const files = splitPatch(
      [
        'diff --git a/a.js b/a.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/a.js',
        '@@ -0,0 +1,2 @@',
        '+one',
        '+two',
        'diff --git a/b.js b/b.js',
        '--- a/b.js',
        '+++ b/b.js',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    )
    assert.deepEqual(
      files.map((f) => [f.path, f.status, f.added, f.removed]),
      [
        ['a.js', 'added', 2, 0],
        ['b.js', 'modified', 1, 1],
      ],
    )
  })
})

const HOST = '127.0.0.1:4984'
const TOKEN = 'test-token-0123456789'

async function fakeApp() {
  const app = join(dir, 'app')
  await mkdir(join(app, 'assets'), { recursive: true })
  await writeFile(join(app, 'index.html'), '<!doctype html><title>studio</title>')
  await writeFile(join(app, 'assets', 'app.js'), 'console.log(1)')
  return app
}

describe('studio server', () => {
  let app: ReturnType<typeof createStudioApp>
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, cookie: `${COOKIE}=${TOKEN}`, ...headers },
    })

  before(async () => {
    app = createStudioApp({
      source,
      appDir: await fakeApp(),
      es: 'test',
      project: 'studio',
      token: TOKEN,
      hosts: [HOST, 'localhost:4984'],
    })
  })

  test('a token in the URL becomes an httpOnly cookie and is stripped', async () => {
    const res = await app.request(`http://${HOST}/?token=${TOKEN}`, { headers: { host: HOST } })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/')
    const cookie = res.headers.get('set-cookie') ?? ''
    assert.match(cookie, new RegExp(`^${COOKIE}=${TOKEN}`))
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
  })

  test('every route needs the token', async () => {
    for (const path of ['/', '/studio.json', `/${manifestPath}`, '/api/events']) {
      const res = await app.request(`http://${HOST}${path}`, { headers: { host: HOST } })
      assert.equal(res.status, 401, path)
    }
    assert.equal((await get('/studio.json', { cookie: `${COOKIE}=nope` })).status, 401)
    const badQuery = await app.request(`http://${HOST}/?token=nope`, { headers: { host: HOST } })
    assert.equal(badQuery.status, 401)
  })

  test('foreign hosts and origins, and anything but GET, are refused', async () => {
    assert.equal((await get('/studio.json', { host: 'evil.example:4984' })).status, 403)
    assert.equal((await get('/studio.json', { origin: 'http://evil.example' })).status, 403)
    assert.equal((await get('/studio.json', { origin: `http://${HOST}` })).status, 200)
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      assert.equal((await get('/studio.json', {}, method)).status, 405, method)
    }
    const res = await get('/studio.json')
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  })

  test('serves the app with a strict CSP, the index, records and artifacts', async () => {
    const index = await get('/')
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-security-policy') ?? '', /script-src 'self'/)
    assert.equal((await get('/assets/app.js')).status, 200)
    const info = await (await get('/studio.json')).json()
    assert.equal(info.mode, 'live')
    assert.equal(info.features.scratch, true)
    const manifest = await (await get(`/${manifestPath}`)).json()
    assert.equal(manifest.shards[0].runs, 4)
    const scratch = headers[3]?.runId as string
    const record = await get(`/${recordPath(scratch)}`)
    assert.equal(record.status, 200)
    assert.equal((await record.json()).runId, scratch)

    const run = records.get(headers[0]?.runId as string) as RunRecord
    const ref = run.evals[0]?.attempts[0]?.files.diff
    assert.ok(ref)
    const artifact = await get(`/${artifactPath(run.runId, ref.path)}`)
    assert.equal(artifact.status, 200)
    assert.equal(artifact.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(artifact.headers.get('content-security-policy'), 'sandbox')
    assert.equal(artifact.headers.get('x-content-type-options'), 'nosniff')
    assert.match(await artifact.text(), /hello\.txt/)
    const etag = artifact.headers.get('etag') as string
    const again = await get(`/${artifactPath(run.runId, ref.path)}`, { 'if-none-match': etag })
    assert.equal(again.status, 304)
  })

  test('traversal, encoded tricks and symlinks out of a run never reach a file', async () => {
    const runId = headers[0]?.runId as string
    await symlink(join(dir, 'es.config.ts'), join(source.historyDir, runId, 'escape.txt'))
    await symlink(
      join(dir, 'es.config.ts'),
      join(source.historyDir, '20990101T000000Z_abc1234_x_a1b2.json'),
    )
    for (const path of [
      `/data/runs/${runId}/escape.txt`,
      '/data/runs/20990101T000000Z_abc1234_x_a1b2.json',
      `/data/runs/${runId}/..%2F..%2F..%2Fes.config.ts`,
      `/data/runs/${runId}/%2e%2e/%2e%2e/es.config.ts`,
      `/data/runs/${runId}/summary.md%00.txt`,
      `/data/runs/${runId}/..%5C..%5Ces.config.ts`,
      '/data/runs/20260101T000000Z_0000000_nobody_a1b2.json',
      '/assets/../../es.config.ts',
      '/es.config.ts',
      '/data/unknown',
    ]) {
      const res = await get(path)
      assert.ok(res.status === 404 || res.status === 400, `${path} → ${res.status}`)
    }
  })

  test("serves an attempt's local debug data, and null where there is none", async () => {
    assert.equal((await (await get('/studio.json')).json()).features.debug, true)
    // The second run fails its judge, so its attempt kept a trace; the first passed.
    const [passed, failed] = [headers[0], headers[1]].map((h) => {
      const run = records.get(h?.runId as string) as RunRecord
      return { runId: run.runId, key: run.evals[0]?.attempts[0]?.key as string }
    }) as [{ runId: string; key: string }, { runId: string; key: string }]
    const view = async (runId: string, key: string) => {
      const res = await get(`/${debugApiPath(runId, key)}`)
      assert.equal(res.status, 200)
      return (await res.json()) as DebugView | null
    }
    const pass = (await view(passed.runId, passed.key)) as DebugView
    assert.deepEqual(
      [...new Set(pass.lines.map((l) => l.phase))],
      ['plan', 'env', 'image', 'container', 'harness', 'check', 'judge', 'teardown'],
    )
    assert.match(pass.lines[0]?.at ?? '', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    assert.deepEqual([pass.requests, pass.trace], [[], false])
    assert.equal((await get(`/${traceApiPath(passed.runId, passed.key)}`)).status, 404)

    const fail = (await view(failed.runId, failed.key)) as DebugView
    assert.equal(fail.trace, true)
    const trace = await get(`/${traceApiPath(failed.runId, failed.key)}`)
    assert.equal(trace.status, 200)
    assert.equal(trace.headers.get('content-security-policy'), 'sandbox')
    assert.match(await trace.text(), /^\{"kind":"trace",/)

    for (const [runId, key] of [
      [passed.runId, `${passed.key}0`],
      [passed.runId, 'evals/hello.es.ts › greet › writes hello'],
      [passed.runId, '../../../es.config.ts # x#1'],
      ['not-a-run', passed.key],
    ]) {
      assert.equal(await view(runId as string, key as string), null, key)
    }
  })

  test("without the scratch source, unrecorded runs aren't served", async () => {
    const recordedOnly = createStudioApp({
      source: { ...source, scratch: false },
      appDir: await fakeApp(),
      es: 'test',
      project: 'studio',
      token: null,
      hosts: [],
    })
    const url = `http://${HOST}/${recordPath(headers[3]?.runId as string)}`
    assert.equal((await recordedOnly.request(url)).status, 404)
    const manifest = await (await recordedOnly.request(`http://${HOST}/${manifestPath}`)).json()
    assert.equal(manifest.shards[0].runs, 3)
  })
})

const filesIn = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
    .sort()

describe('es studio build', () => {
  test('writes a static site with the same paths the server answers', async () => {
    assert.ok(existsSync(join(pkgRoot, 'dist/studio-app/index.html')), 'run pnpm build first')
    const out = join(dir, 'site')
    const r = await runCli(dir, ['studio', 'build', '--out', out, '--scratch'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /built site\/: 4 runs/)
    const written = filesIn(out)
    assert.ok(written.includes('index.html'))
    assert.ok(written.some((f) => /^assets\/.+\.js$/.test(f)))
    assert.ok(!written.some((f) => f.endsWith('escape.txt')), 'symlinks are never published')
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    assert.doesNotMatch(html, /(src|href)="\/(?!\/)/, 'assets are relative')
    const info = JSON.parse(readFileSync(join(out, 'studio.json'), 'utf8'))
    assert.equal(info.mode, 'static')
    assert.equal(info.features.artifacts, true)
    assert.equal(info.features.debug, false, 'local debug data is never published')
    assert.ok(existsSync(join(dir, '.es/debug')), 'twin: the project has debug data')
    assert.deepEqual(
      written.filter((f) => /debug\.log|trace\.ndjson|requests\.ndjson|^api\//.test(f)),
      [],
    )

    const app = createStudioApp({
      source: { ...source, historyDir: source.historyDir },
      appDir: join(pkgRoot, 'dist/studio-app'),
      es: 'test',
      project: 'studio',
      token: null,
      hosts: [],
    })
    const urls = [manifestPath, ...new Set(headers.map((h) => shardPath(h.startedAt.slice(0, 7))))]
    for (const h of headers) {
      urls.push(recordPath(h.runId))
      const run = records.get(h.runId) as RunRecord
      for (const a of run.evals.flatMap((e) => e.attempts)) {
        const refs = [...Object.values(a.files), ...a.checks.flatMap((c) => (c.log ? [c.log] : []))]
        for (const ref of refs) urls.push(artifactPath(h.runId, ref.path))
      }
    }
    for (const url of urls) {
      assert.ok(written.includes(url), `${url} is in the build`)
      const served = await (await app.request(`http://x/${url}`)).text()
      const built = readFileSync(join(out, url), 'utf8')
      if (url === manifestPath) {
        const strip = (s: string) => JSON.stringify({ ...JSON.parse(s), generatedAt: null })
        assert.equal(strip(built), strip(served), url)
      } else {
        assert.equal(built, served, url)
      }
    }
  })

  test('--no-artifacts writes records and the index only; a non-studio folder is refused', async () => {
    const out = join(dir, 'site-lean')
    const r = await runCli(dir, ['studio', 'build', '--out', out, '--no-artifacts'])
    assert.equal(r.code, 0, r.stderr)
    const runs = filesIn(join(out, 'data')).filter((f) => f.startsWith('runs/'))
    assert.deepEqual(
      runs,
      headers.filter((h) => h.recorded).map((h) => `runs/${h.runId}.json`),
    )
    assert.equal(
      JSON.parse(readFileSync(join(out, 'studio.json'), 'utf8')).features.artifacts,
      false,
    )

    const refused = await runCli(dir, ['studio', 'build', '--out', 'evals'])
    assert.equal(refused.code, 2)
    assert.match(refused.stderr, /isn't empty and isn't a previous studio build/)
  })

  test('es studio prints a tokenised 127.0.0.1 URL and serves the app', async () => {
    const child = spawn(
      process.execPath,
      [join(pkgRoot, 'dist/cli.js'), 'studio', '--port', '47311'],
      { cwd: dir, env: baseEnv },
    )
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = ''
        child.stdout.on('data', (d) => {
          out += d
          const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(out)
          if (m) resolve(m[0])
        })
        child.on('exit', () => reject(new Error(out)))
      })
      const redirect = await fetch(url, { redirect: 'manual' })
      assert.equal(redirect.status, 302)
      const cookie = (redirect.headers.get('set-cookie') ?? '').split(';')[0] as string
      const page = await fetch(new URL('/', url), { headers: { cookie } })
      assert.equal(page.status, 200)
      assert.match(await page.text(), /<div id="root">/)
      assert.equal((await fetch(new URL('/', url))).status, 401)
    } finally {
      child.kill('SIGINT')
    }
  })
})
