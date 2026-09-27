// Drives the built studio in a real browser: a static build served from a subpath, and a live
// `es studio` that picks up a new run over SSE. Skips when no Chrome or Chromium is installed.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type Page } from 'playwright-core'
import { withUnknownFields } from '../../evalsuite/scripts/schema/validate.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(repo, 'packages/evalsuite/dist/cli.js')
const demo = join(tmpdir(), `es-studio-e2e-${process.pid}`)
const config = join(demo, 'es.demo.config.ts')
const corpus = join(repo, 'packages/evalsuite/test/fixtures/records')

let browser: Browser | null = null
const children: ChildProcess[] = []
const servers: Server[] = []

async function launch(): Promise<Browser | null> {
  for (const options of [{ channel: 'chrome' }, {}]) {
    try {
      return await chromium.launch(options)
    } catch {}
  }
  return null
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

/** A dumb static host that serves `root` under `/deploy/sub/`. */
function host(root: string): Promise<string> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    if (!path.startsWith('/deploy/sub/')) return res.writeHead(404).end()
    let file = normalize(join(root, path.slice('/deploy/sub/'.length)))
    if (!file.startsWith(root)) return res.writeHead(403).end()
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain' })
    createReadStream(file).pipe(res)
  })
  servers.push(server)
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve(`http://127.0.0.1:${port}/deploy/sub/`)
    }),
  )
}

async function open(url: string): Promise<{ page: Page; errors: string[] }> {
  const page = await (browser as Browser).newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(url)
  return { page, errors }
}

before(async () => {
  browser = await launch()
  if (!browser) return
  const seeded = spawnSync(
    process.execPath,
    [join(repo, 'packages/studio-web/scripts/seed-demo.mjs'), demo],
    {
      encoding: 'utf8',
    },
  )
  assert.equal(seeded.status, 0, seeded.stderr)
})

after(async () => {
  for (const c of children) c.kill('SIGINT')
  for (const s of servers) s.close()
  await browser?.close()
  await rm(demo, { recursive: true, force: true })
})

/** A saved analysis as `es analyze --save` writes it, citing one failing attempt. */
function savedAnalysis(runId: string, attempt: { slug: string; id: string }) {
  const doc = {
    kind: 'es-analysis',
    schemaVersion: 1,
    scope: { kind: 'run', head: runId, base: null, evals: null },
    anchor: runId,
    inputs: { records: [], digestVersion: 1, digestHash: 'sha256:0' },
    promptVersion: 'analysis-v1',
    model: 'fake',
    resolvedModel: null,
    route: 'fake',
    usage: { inputTokens: null, outputTokens: null },
    latencyMs: 0,
    createdAt: '2026-09-26T12:00:00.000Z',
    author: 'grace-hopper',
    validation: {
      citations: 2,
      invalid: [],
      dropped: 0,
      commands: 1,
      invalidCommands: ['es run --nope'],
      unverifiedNumbers: 0,
    },
    analysis: {
      tldr: 'The greet module regressed in one attempt.',
      whatHappened: [
        { text: 'One attempt failed.', cites: ['r1/greet/control#1', 'F1'], confidence: 'high' },
      ],
      results: [],
      why: [],
      anomalies: [],
      actions: [
        {
          title: 'Retry it',
          target: 'evals/greet.es.ts',
          kind: 'eval',
          change: 'Run it again',
          expectedEffect: 'It passes',
          verify: null,
          verifyProblem: 'es run --nope',
          impact: 'low',
          effort: 'low',
          cites: ['F1'],
        },
      ],
      confidence: { overall: 'low', why: 'one attempt' },
    },
    attempts: { 'r1/greet/control#1': { runId, evalSlug: attempt.slug, attempt: attempt.id } },
    cited: { F1: '{"kind":"failure"}' },
  }
  return { runId, entries: [{ file: 'analysis/x.json', source: 'saved', doc }] }
}

describe('studio in a browser', () => {
  test('a static build works from a subpath: runs → run → attempt → tabs', async (t) => {
    if (!browser) return t.skip('no Chrome or Chromium found')
    const out = join(demo, 'studio-dist')
    const built = spawnSync(
      process.execPath,
      [cli, 'studio', 'build', '--config', config, '--out', out],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(built.status, 0, built.stderr)
    const grace = readdirSync(join(out, 'data/runs'))
      .filter((n) => n.endsWith('.json') && n.includes('grace-hopper'))[0]
      ?.slice(0, -5) as string
    const record = JSON.parse(readFileSync(join(out, 'data/runs', `${grace}.json`), 'utf8'))
    const failing = record.evals
      .flatMap((e: { slug: string; attempts: Array<{ id: string; outcome: string }> }) =>
        e.attempts.map((a) => ({ slug: e.slug, ...a })),
      )
      .find((a: { outcome: string }) => a.outcome === 'fail')
    mkdirSync(join(out, 'data/analysis'), { recursive: true })
    writeFileSync(
      join(out, 'data/analysis', `${grace}.json`),
      JSON.stringify(savedAnalysis(grace, failing)),
    )
    const { page, errors } = await open(await host(out))

    await page.waitForSelector('tbody tr')
    assert.equal(await page.locator('tbody tr').count(), 4)
    assert.equal(await page.getByText('Snapshot').count(), 1)

    await page.locator('tbody tr', { hasText: 'grace-hopper' }).click()
    await page.waitForSelector('h2')
    assert.match(page.url(), /#\/runs\/\d{8}T\d{6}Z_[0-9a-f]+_grace-hopper/)
    assert.ok((await page.getByText('9 failed').count()) > 0)

    await page.getByRole('tab', { name: 'Analysis' }).click()
    await page.getByText('The greet module regressed in one attempt.').waitFor()
    await page.getByText('Verify command rejected: es run --nope').waitFor()
    await page.getByRole('link', { name: 'r1/greet/control#1' }).click()
    await page.waitForSelector('[role=tablist]')
    assert.match(page.url(), /\/attempts\//, 'a citation opens its attempt')
    await page.goBack()
    await page.getByRole('tab', { name: 'Evals' }).click()

    await page.locator('a[href*="/attempts/"]').first().click()
    await page.waitForSelector('[role=tablist]')
    await page.getByText('Turn 1', { exact: true }).waitFor()
    await page.getByRole('button', { name: /^shell/ }).click()
    await page.getByText('Input', { exact: true }).waitFor()

    await page.getByRole('tab', { name: /^Diff/ }).click()
    await page.getByRole('button', { name: /greet\.test\.js/ }).waitFor()
    await page.getByRole('tab', { name: /^Judge/ }).click()
    await page.getByText('What the judge saw').waitFor()
    await page.getByRole('tab', { name: /^State/ }).click()
    await page.getByText('Package versions').waitFor()
    assert.equal(
      await page.getByRole('tab', { name: 'Debug' }).count(),
      0,
      'no debug data in a build',
    )

    await page.getByRole('link', { name: 'Compare' }).click()
    await page.getByText('Regressed').first().waitFor()
    assert.deepEqual(errors, [])
  })

  /** Copies a corpus entry into a project, adds `extra` runs, and builds its static studio. */
  async function buildCorpus(name: string, extra?: (history: string) => void) {
    const project = join(demo, `corpus-${name}${extra ? '-changed' : ''}`)
    cpSync(join(corpus, name), project, { recursive: true })
    extra?.(join(project, 'evals/.history'))
    mkdirSync(join(project, 'node_modules'), { recursive: true })
    symlinkSync(join(repo, 'packages/evalsuite'), join(project, 'node_modules/evalsuite'), 'dir')
    const out = join(project, 'site')
    const built = spawnSync(process.execPath, [cli, 'studio', 'build', '--out', out], {
      cwd: project,
      encoding: 'utf8',
    })
    assert.equal(built.status, 0, built.stderr)
    assert.doesNotMatch(built.stderr, /warning: skipped/)
    return out
  }

  /** Opens every run of a build, its analysis, and every tab of every attempt. */
  async function readEverything(out: string, label: string) {
    const url = await host(out)
    const { page, errors } = await open(url)
    const broken = async (where: string) => {
      assert.equal(await page.getByText("Couldn't load this").count(), 0, where)
      assert.deepEqual(errors, [], where)
    }
    const runs = readdirSync(join(out, 'data/runs'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .sort()
    await page.waitForSelector('tbody tr')
    assert.equal(await page.locator('tbody tr').count(), runs.length, label)
    for (const runId of runs) {
      await page.goto(`${url}#/runs/${runId}`)
      await page.waitForSelector('h2', { timeout: 10_000 }).catch((e) => {
        throw new Error(`${label} ${runId} didn't render: ${errors.join('\n') || e}`)
      })
      await broken(`${label} ${runId}`)
      if (existsSync(join(out, 'data/analysis', `${runId}.json`))) {
        await page.getByRole('tab', { name: 'Analysis' }).click()
        await page.getByText('Suggested actions').first().waitFor()
        await broken(`${label} ${runId} analysis`)
        await page.getByRole('tab', { name: 'Evals' }).click()
      }
      const attempts = await page
        .locator('a[href*="/attempts/"]')
        .evaluateAll((links) => [...new Set(links.map((a) => (a as HTMLAnchorElement).href))])
      assert.ok(attempts.length > 0, `${label} ${runId} links its attempts`)
      for (const href of attempts) {
        await page.goto(href)
        await page.waitForSelector('[role=tablist]')
        for (const tab of ['Transcript', 'Diff', 'Checks', 'Judge', 'State']) {
          await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
          await page.waitForTimeout(50)
          await broken(`${label} ${href} ${tab}`)
        }
        await page.getByText('Package versions').waitFor()
      }
    }
    if (runs.length > 1) {
      await page.goto(`${url}#/compare?base=${runs[0]}&head=${runs.at(-1)}`)
      await page.waitForTimeout(300)
      await broken(`${label} compare`)
    }
    await page.close()
  }

  test('every run in the record corpus renders: runs, analysis, and every attempt tab', async (t) => {
    if (!browser) return t.skip('no Chrome or Chromium found')
    const names = readdirSync(corpus).filter((n) => existsSync(join(corpus, n, 'evals/.history')))
    assert.ok(names.length >= 3)
    for (const name of names) await readEverything(await buildCorpus(name), name)
  })

  test('a run from a newer ES, with fields and values this one lacks, still renders', async (t) => {
    if (!browser) return t.skip('no Chrome or Chromium found')
    const schema = JSON.parse(
      readFileSync(join(repo, 'packages/evalsuite/schema/run-record.schema.json'), 'utf8'),
    )
    const out = await buildCorpus('real-harnesses', (history) => {
      const [name] = readdirSync(history).filter((n) => n.endsWith('.json'))
      const r = JSON.parse(readFileSync(join(history, name as string), 'utf8'))
      withUnknownFields(schema, r, () => ({ by: 'a newer ES' }))
      r.status = 'paused'
      r.evals[0].attempts[0].outcome = 'cancelled'
      r.evals[0].attempts[0].error = { kind: 'quota', message: 'a kind this ES does not know' }
      r.evals[0].attempts[1].turns[0].status = 'paused'
      writeFileSync(join(history, name as string), JSON.stringify(r, null, 2))
      for (const f of readdirSync(history, { recursive: true }) as string[]) {
        if (!f.endsWith('transcript.jsonl')) continue
        const line = { turn: 1, ts: '2027-01-01T00:00:00.000Z', atMs: 1, type: 'hologram' }
        writeFileSync(
          join(history, f),
          `${readFileSync(join(history, f), 'utf8')}${JSON.stringify(line)}\n`,
        )
      }
    })
    await readEverything(out, 'newer')
  })

  test('es studio needs its token, then shows new runs as they land', async (t) => {
    if (!browser) return t.skip('no Chrome or Chromium found')
    // Only the run made below has local debug data.
    const cleaned = spawnSync(process.execPath, [cli, 'clean', '--config', config], {
      cwd: demo,
      encoding: 'utf8',
    })
    assert.equal(cleaned.status, 0, cleaned.stderr)
    const child = spawn(process.execPath, [cli, 'studio', '--config', config, '--port', '47412'], {
      env: { ...process.env, NO_COLOR: '1' },
    })
    children.push(child)
    const url = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (d) => {
        out += d
        const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(out)
        if (m) resolve(m[0])
      })
      child.on('exit', () => reject(new Error(out)))
    })

    const denied = await open(new URL('/', url).href)
    assert.match((await denied.page.textContent('body')) ?? '', /session token/)

    const { page, errors } = await open(url)
    await page.waitForSelector('tbody tr')
    assert.doesNotMatch(page.url(), /token=/)
    assert.equal(await page.locator('tbody tr').count(), 5)
    assert.equal(await page.getByText('scratch', { exact: true }).count(), 1)
    assert.equal(await page.getByText('Live', { exact: true }).count(), 1)

    const run = spawnSync(process.execPath, [cli, 'run', '--config', config], {
      cwd: demo,
      env: { ...process.env, NO_COLOR: '1', ES_UI: 'plain', CI: '' },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 6, null, {
      timeout: 10_000,
    })

    // An attempt of the new run has a Debug tab: its phase timeline, from .es/debug.
    await page.locator('tbody tr').first().click()
    await page.waitForSelector('h2')
    await page.locator('a[href*="/attempts/"]').first().click()
    await page.getByRole('tab', { name: 'Debug' }).click()
    await page.getByText('Phase timeline').waitFor()
    await page.getByRole('button', { name: /^plan/ }).first().click()
    await page.locator('pre', { hasText: 'config es.demo.config.ts · no profile' }).waitFor()
    await page.getByText('Network requests').waitFor()

    // An older run's attempt has none, so no tab.
    await page.goBack()
    await page.goBack()
    await page.locator('tbody tr').nth(2).click()
    await page.waitForSelector('h2')
    const checked = page.waitForResponse((r) => r.url().includes('/api/debug/'))
    await page.locator('a[href*="/attempts/"]').first().click()
    assert.equal(await (await checked).text(), 'null')
    await page.getByRole('tab', { name: /^State/ }).waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Debug' }).count(), 0)
    assert.deepEqual(errors, [])
  })

  /** Waits for the runs list to show a run in progress at 0/4; throws after `timeout`. */
  const waitForLive = (page: Page, timeout: number) =>
    page.locator('[data-live-run]', { hasText: /Running 0\/4/ }).waitFor({ timeout })

  test('es studio shows a run in progress attempt by attempt, until its record replaces it', async (t) => {
    if (!browser) return t.skip('no Chrome or Chromium found')
    // Each turn takes 1.5 s: hello.es.ts's two evals × two runs, two attempts at a time.
    const slow = join(demo, 'es.slow.config.ts')
    writeFileSync(
      slow,
      readFileSync(config, 'utf8')
        .replace(/include: \[[^\]]*\]/, 'include: ["evals/hello.es.ts"]')
        .replace('"text":', '"delayMs": 1500,\n  "text":'),
    )
    const child = spawn(process.execPath, [cli, 'studio', '--config', config, '--port', '47433'], {
      env: { ...process.env, NO_COLOR: '1' },
    })
    children.push(child)
    const url = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (d) => {
        out += d
        const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(out)
        if (m) resolve(m[0])
      })
      child.on('exit', () => reject(new Error(out)))
    })
    const { page, errors } = await open(url)
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.waitForSelector('tbody tr')
    const before = await page.locator('tbody tr').count()
    assert.equal(await page.locator('[data-live-run]').count(), 0)

    const run = spawn(
      process.execPath,
      [cli, 'run', '--config', slow, '--runs', '2', '--concurrency', '2'],
      { cwd: demo, env: { ...process.env, NO_COLOR: '1', ES_UI: 'plain', CI: '' } },
    )
    children.push(run)
    let runOut = ''
    run.stdout.on('data', (d) => (runOut += d))
    run.stderr.on('data', (d) => (runOut += d))
    const ran = new Promise<number | null>((resolve) => run.on('close', resolve))

    await waitForLive(page, 30_000)
    const live = page.locator('[data-live-run]')
    const runId = (await live.getAttribute('data-live-run')) as string
    assert.match(runId, /^\d{8}T\d{6}Z_/)
    assert.equal(await live.getByRole('progressbar').count(), 1)
    assert.equal(await page.locator('tbody tr').count(), before, 'not in the list until it lands')

    // A static build made mid-run has no live section: the same wait must fail there.
    const out = join(demo, 'studio-mid-run')
    const built = spawnSync(
      process.execPath,
      [cli, 'studio', 'build', '--config', config, '--out', out],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(built.status, 0, built.stderr)
    assert.equal(existsSync(join(out, 'api')), false)
    const snapshot = await open(await host(out))
    await snapshot.page.waitForSelector('tbody tr')
    await assert.rejects(waitForLive(snapshot.page, 2000), /Timeout/)
    assert.deepEqual(snapshot.errors, [])
    await snapshot.page.close()

    await live.click()
    await page.getByRole('heading', { name: 'Run in progress' }).waitFor()
    assert.match(page.url(), new RegExp(`#/live/${runId}$`))
    assert.equal(await page.locator('[data-live-attempt]').count(), 4)
    await page.waitForFunction(
      () => {
        const done = document.querySelectorAll('[data-live-attempt=pass]').length
        const running = document.querySelectorAll('[data-live-attempt=running]').length
        return done >= 1 && running >= 1
      },
      null,
      { timeout: 30_000 },
    )
    const shot = process.env.ES_STUDIO_LIVE_SCREENSHOT
    if (shot) await page.screenshot({ path: shot })
    assert.match((await page.getByText(/^Running \d\/4$/).textContent()) ?? '', /Running [1-3]\/4/)

    // A finished attempt opens its transcript while the run goes on.
    await page.locator('[data-live-attempt=pass] a').first().click()
    assert.match(page.url(), /#\/live\/.+\/attempt\?key=/)
    await page.getByText('Turn 1', { exact: true }).waitFor()
    await page
      .getByRole('button', { name: /^shell/ })
      .first()
      .waitFor()
    await page.goBack()

    // When the record lands, the live page becomes the run's own page.
    assert.equal(await ran, 0, runOut)
    await page.waitForURL(new RegExp(`#/runs/${runId}$`), { timeout: 20_000 })
    await page.waitForSelector('h2')
    assert.equal(await page.getByText("Couldn't load this").count(), 0)
    await page.getByRole('link', { name: 'Runs' }).first().click()
    await page.waitForFunction(
      (n) => document.querySelectorAll('tbody tr').length === n,
      before + 1,
    )
    assert.equal(await page.locator('[data-live-run]').count(), 0)
    assert.match((await page.locator('tbody tr').first().textContent()) ?? '', new RegExp(runId))
    assert.deepEqual(errors, [])
  })
})
