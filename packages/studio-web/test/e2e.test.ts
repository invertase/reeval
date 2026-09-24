// Drives the built studio in a real browser: a static build served from a subpath, and a live
// `es studio` that picks up a new run over SSE. Skips when no Chrome or Chromium is installed.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type Page } from 'playwright-core'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(repo, 'packages/evalsuite/dist/cli.js')
const demo = join(tmpdir(), `es-studio-e2e-${process.pid}`)
const config = join(demo, 'es.demo.config.ts')

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
    const { page, errors } = await open(await host(out))

    await page.waitForSelector('tbody tr')
    assert.equal(await page.locator('tbody tr').count(), 4)
    assert.equal(await page.getByText('Snapshot').count(), 1)

    await page.locator('tbody tr', { hasText: 'grace-hopper' }).click()
    await page.waitForSelector('h2')
    assert.match(page.url(), /#\/runs\/\d{8}T\d{6}Z_[0-9a-f]+_grace-hopper/)
    assert.ok((await page.getByText('9 failed').count()) > 0)

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

    await page.getByRole('link', { name: 'Compare' }).click()
    await page.getByText('Regressed').first().waitFor()
    assert.deepEqual(errors, [])
  })

  test('es studio needs its token, then shows new runs as they land', async (t) => {
    if (!browser) return t.skip('no Chrome or Chromium found')
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
    assert.equal(await page.getByText('Live').count(), 1)

    const run = spawnSync(process.execPath, [cli, 'run', '--config', config], {
      cwd: demo,
      env: { ...process.env, NO_COLOR: '1', ES_UI: 'plain', CI: '' },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 6, null, {
      timeout: 10_000,
    })
    assert.deepEqual(errors, [])
  })
})
