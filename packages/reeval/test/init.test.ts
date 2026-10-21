// `reeval init`: from an empty directory to a project that plans on every real agent it offers, with
// an environment its eval runs in (or, --bare, the config alone); it says whether Docker is ready
// without ever failing on it, never overwrites a file that differs without --force, and a second
// run changes nothing.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { describe, test } from 'node:test'
import { UsageError } from '../src/errors.ts'
import { AGENTS } from '../src/harness/agents.ts'
import { askHarness, INIT_HARNESSES, planInit } from '../src/init.ts'
import { pkgRoot, runCli, tempDir } from './helpers.ts'

const { name: pkg, version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

/** An empty directory where `import '<pkg>'` resolves to this package, as after an install. */
async function empty(name: string, sub = '') {
  const root = tempDir(name)
  await mkdir(join(root, 'node_modules', ...pkg.split('/').slice(0, -1)), { recursive: true })
  await symlink(pkgRoot, join(root, 'node_modules', pkg), 'dir')
  const dir = join(root, sub)
  return { root, dir, read: (path: string) => readFileSync(join(dir, path), 'utf8') }
}

const FILES = [
  'reeval.config.ts',
  'evals/environments.ts',
  'evals/greet.eval.ts',
  '.gitignore',
  'package.json',
]
const BARE = ['reeval.config.ts', '.gitignore', 'package.json']

const planOf = async (dir: string, args: string[] = []) => {
  const r = await runCli(dir, ['run', '--dry-run', '--json', ...args])
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout)
}

/** A `docker` CLI on the PATH whose `info` answers as a running daemon, or fails as a stopped one. */
async function dockerOnPath(state: 'running' | 'down') {
  const bin = await mkdtemp(join(tmpdir(), `reeval-init-docker-${state}-`))
  await writeFile(
    join(bin, 'docker.js'),
    state === 'running'
      ? "console.log(process.argv.includes('info') ? '29.1.0 linux' : '')\n"
      : "process.stderr.write('Cannot connect to the Docker daemon\\n'); process.exit(1)\n",
  )
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nexec node "$(dirname "$0")/docker.js" "$@"\n')
  await chmod(join(bin, 'docker'), 0o755)
  await writeFile(join(bin, 'docker.cmd'), '@node "%~dp0docker.js" %*\r\n')
  return { PATH: `${bin}${delimiter}${process.env.PATH}` }
}

/** A config on the fake agent and sandbox, for checking the scaffolded eval passes without keys. */
const fakeConfig = `import { defineConfig } from '${pkg}'
import { fakeHarness } from '${pkg}/harness'
import { fakeSandbox } from '${pkg}/sandbox'

export default defineConfig({
  include: ['evals/**/*.eval.ts'],
  harness: fakeHarness({
    files: { 'greet.js': 'export const greet = (name) => \`Hello, \${name}!\`\\n' },
  }),
  sandbox: fakeSandbox(),
})
`

describe('reeval init', () => {
  test('an empty directory, --yes: an environment and an eval in it that passes', async () => {
    const p = await empty('init-yes')
    const init = await runCli(p.dir, ['init', '--yes'])
    assert.equal(init.code, 0, init.stderr)
    for (const file of FILES) assert.match(init.stdout, new RegExp(`create +${file}`), file)
    assert.match(init.stdout, /create +\.gitignore +node_modules\/, \.reeval\/, \.env\*$/m)
    assert.match(init.stdout, /npx reeval run +the eval on Cursor, with CURSOR_API_KEY/)
    assert.match(p.read('evals/environments.ts'), /export const greeter = defineEnvironment\(/)
    assert.match(p.read('evals/greet.eval.ts'), /import \{ greeter \} from '\.\/environments\.ts'/)
    assert.match(p.read('evals/greet.eval.ts'), /\{ environment: greeter \}/)
    const cell = (await planOf(p.dir)).evals[0]?.cells[0]
    assert.equal(cell?.environment, 'greeter')
    assert.deepEqual(cell?.files, ['package.json'])
    const manifest = JSON.parse(p.read('package.json'))
    assert.deepEqual(manifest.scripts, { eval: 'reeval run' })
    assert.deepEqual(manifest.devDependencies, { [pkg]: `^${version}` })
    assert.equal(
      p.read('.gitignore'),
      'node_modules/\n\n# reeval: scratch runs and debug data; local keys\n.reeval/\n.env*\n',
    )

    const real = await runCli(p.dir, ['run'])
    assert.equal(real.code, 2)
    assert.match(real.stderr, /Missing credentials: CURSOR_API_KEY/)
    await writeFile(join(p.dir, 'fake.config.ts'), fakeConfig)
    const run = await runCli(p.dir, ['run', '--config', 'fake.config.ts'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /^pass {13}creates greet\.js$/m)
  })

  test('--bare writes only the config and its essentials', async () => {
    const p = await empty('init-bare')
    const init = await runCli(p.dir, ['init', '--harness', 'codex', '--bare'])
    assert.equal(init.code, 0, init.stderr)
    for (const file of BARE) assert.match(init.stdout, new RegExp(`create +${file}`), file)
    assert.doesNotMatch(init.stdout, /environments\.ts|greet\.eval\.ts/)
    assert.ok(!existsSync(join(p.dir, 'evals')), 'no evals/ directory')
    assert.match(init.stdout, /run +the evals you write in evals\/ on Codex, with OPENAI_API_KEY/)
    assert.match(p.read('reeval.config.ts'), /include: \['evals\/\*\*\/\*\.eval\.ts'\]/)
    const again = await runCli(p.dir, ['init', '--harness', 'codex', '--bare'])
    for (const file of BARE) assert.match(again.stdout, new RegExp(`keep +${file}`), file)
  })

  for (const h of INIT_HARNESSES) {
    test(`--harness ${h.kind} plans ${h.kind} and pr, and names no fake agent`, async () => {
      const p = await empty(`init-${h.kind}`)
      const init = await runCli(p.dir, ['init', '--harness', h.kind])
      assert.equal(init.code, 0, init.stderr)
      assert.match(init.stdout, new RegExp(`with ${AGENTS[h.kind].credential} in \\.env\\.local`))
      const written = FILES.map(p.read).join('\n')
      assert.doesNotMatch(`${init.stdout}${init.stderr}${written}`, /fake/i)
      const cell = (doc: { evals: Array<{ cells: Array<{ harness: string }> }> }) =>
        doc.evals[0]?.cells[0]?.harness
      assert.equal(cell(await planOf(p.dir)), `${h.kind}:${h.model.split('/').at(-1)}`)
      const pr = await planOf(p.dir, ['--profile', 'pr'])
      assert.equal(pr.profile?.name ?? pr.profile, 'pr')
      assert.equal(pr.images[0]?.harness, h.kind)
      const fake = await runCli(p.dir, ['run', '--dry-run', '--profile', 'fake'])
      assert.equal(fake.code, 2, 'no fake profile')
    })
  }

  test('ends with Docker ready, or what is wrong and the fix, and exits 0 either way', async () => {
    const running = await empty('init-docker-running')
    const ok = await runCli(running.dir, ['init', '--yes'], { env: await dockerOnPath('running') })
    assert.equal(ok.code, 0, ok.stderr)
    assert.match(ok.stdout, /\nDocker is running: ready for npx reeval image build\n$/)

    const stopped = await empty('init-docker-down')
    const down = await runCli(stopped.dir, ['init', '--yes'], { env: await dockerOnPath('down') })
    assert.equal(down.code, 0, down.stderr)
    // Canary: a stopped daemon must not read as ready.
    assert.doesNotMatch(down.stdout, /Docker is running/)
    assert.match(down.stdout, /\nDocker isn't running: .+, then run npx reeval image build\n$/)
    if (process.platform === 'linux') {
      assert.match(
        down.stdout,
        /Docker isn't running: start Docker Desktop, or the Docker service \(sudo systemctl start docker\), then run npx reeval image build/,
      )
    }

    const none = await empty('init-docker-missing')
    const noBin = await mkdtemp(join(tmpdir(), 'reeval-init-no-docker-'))
    const missing = await runCli(none.dir, ['init', '--yes', '--bare'], { env: { PATH: noBin } })
    assert.equal(missing.code, 0, missing.stderr)
    assert.match(
      missing.stdout,
      /\nDocker isn't installed: install Docker .+, then run npx reeval image build\n$/,
    )
  })

  test('a second reeval init changes nothing', async () => {
    const p = await empty('init-twice')
    await runCli(p.dir, ['init', '--harness', 'pi'])
    const before = FILES.map(p.read)
    const again = await runCli(p.dir, ['init', '--harness', 'pi'])
    assert.equal(again.code, 0, again.stderr)
    for (const file of FILES) assert.match(again.stdout, new RegExp(`keep +${file}`), file)
    assert.deepEqual(FILES.map(p.read), before)
  })

  test('refuses to overwrite a file that differs, writing nothing, until --force', async () => {
    const p = await empty('init-refuse')
    await writeFile(join(p.dir, 'reeval.config.ts'), 'export default {}\n')
    const refused = await runCli(p.dir, ['init', '--yes'])
    assert.equal(refused.code, 2)
    assert.match(
      refused.stderr,
      /^reeval: reeval init won't overwrite files in \.: reeval\.config\.ts exists and differs\. Nothing was written\. Pass --force to overwrite them\.\n$/,
    )
    assert.equal(p.read('reeval.config.ts'), 'export default {}\n')
    for (const file of FILES.slice(1)) assert.ok(!existsSync(join(p.dir, file)), file)
    const forced = await runCli(p.dir, ['init', '--yes', '--force'])
    assert.equal(forced.code, 0, forced.stderr)
    assert.match(forced.stdout, /overwrite +reeval\.config\.ts/)
    assert.match(p.read('reeval.config.ts'), /cursor\(\{ model: 'composer-2\.5' \}\)/)

    const other = await empty('init-other-config')
    await writeFile(join(other.dir, 'reeval.config.mjs'), 'export default {}\n')
    const shadowed = await runCli(other.dir, ['init', '--yes'])
    assert.equal(shadowed.code, 2)
    assert.match(shadowed.stderr, /reeval\.config\.mjs exists already/)
  })

  test('merges into an existing package.json and .gitignore', async () => {
    const p = await empty('init-merge')
    const manifest = { name: 'mine', scripts: { test: 'node --test' }, dependencies: { a: '1' } }
    await writeFile(join(p.dir, 'package.json'), JSON.stringify(manifest, null, 4))
    await writeFile(join(p.dir, '.gitignore'), 'node_modules\n/.reeval')
    const r = await runCli(p.dir, ['init', '--yes'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /update +package\.json +script eval, devDependency/)
    assert.match(r.stdout, /update +\.gitignore +\.env\*$/m)
    assert.equal(
      p.read('package.json'),
      `${JSON.stringify(
        {
          ...manifest,
          scripts: { test: 'node --test', eval: 'reeval run' },
          devDependencies: { [pkg]: `^${version}` },
        },
        null,
        4,
      )}\n`,
    )
    assert.equal(
      p.read('.gitignore'),
      'node_modules\n/.reeval\n\n# reeval: scratch runs and debug data; local keys\n.env*\n',
    )

    // Its own eval script and reeval dependency stay.
    const own = await empty('init-own')
    const mine = { scripts: { eval: 'vitest' }, dependencies: { [pkg]: '1.0.0' } }
    await writeFile(join(own.dir, 'package.json'), `${JSON.stringify(mine, null, 2)}\n`)
    const kept = await runCli(own.dir, ['init', '--yes'])
    assert.match(kept.stdout, /keep +package\.json/)
    assert.deepEqual(JSON.parse(own.read('package.json')), mine)

    await writeFile(join(own.dir, 'package.json'), '{ nope')
    const bad = await runCli(own.dir, ['init', '--yes', '--force'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /package\.json isn't valid JSON/)
  })

  test('--dry-run plans and writes nothing; a dir argument is created', async () => {
    const p = await empty('init-dry', 'a b/evals project')
    const dry = await runCli(p.root, ['init', 'a b/evals project', '--yes', '--dry-run'])
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /^reeval init · a b\/evals project \(nothing written: --dry-run\)\n/)
    assert.ok(!existsSync(join(p.root, 'a b')))
    const real = await runCli(p.root, ['init', 'a b/evals project', '--harness', 'goose'])
    assert.equal(real.code, 0, real.stderr)
    assert.match(real.stdout, /Next:\n {2}cd a b\/evals project\n/)
    // Nothing it writes names this machine's paths, so the project works on Windows too.
    for (const file of FILES) {
      const text = p.read(file)
      assert.doesNotMatch(text, /\b[A-Za-z]:[\\/]/, file)
      assert.ok(!text.includes(p.root), file)
    }
    assert.equal((await runCli(p.dir, ['run', '--dry-run'])).code, 0)
  })

  test('without a terminal it needs --yes or --harness; a bad --harness is exit 2', async () => {
    const p = await empty('init-tty')
    const r = await runCli(p.dir, ['init'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /no terminal to ask in\. Pass --harness <name> or --yes\./)
    for (const name of ['gemini', 'none', 'fake']) {
      const bad = await runCli(p.dir, ['init', '--harness', name])
      assert.equal(bad.code, 2)
      assert.match(
        bad.stderr,
        new RegExp(`--harness must be one of cursor, claude-code, .*grok-build \\(got ${name}\\)`),
      )
    }
    assert.ok(!existsSync(join(p.dir, 'reeval.config.ts')))
  })

  test('the prompt takes a number, a name or Enter, and asks again', async () => {
    const ask = async (input: string) => {
      let out = ''
      const output = new Writable({
        write: (chunk, _, done) => {
          out += chunk
          done()
        },
      })
      return { choice: await askHarness(Readable.from([input]), output), out }
    }
    const first = await ask('\n')
    assert.equal(first.choice, 'cursor')
    assert.doesNotMatch(first.out, /fake|none/i)
    assert.equal((await ask('2\n')).choice, 'claude-code')
    const choices = INIT_HARNESSES.length
    assert.equal((await ask(`${choices}\n`)).choice, INIT_HARNESSES.at(-1)?.kind)
    const again = await ask(`${choices + 1}\nClaude Code\n`)
    assert.equal(again.choice, 'claude-code')
    assert.match(again.out, new RegExp(`Answer 1 to ${choices}, or one of cursor, claude-code`))
    assert.match(again.out, /1\) Cursor +cursor:composer-2\.5, CURSOR_API_KEY/)
    await assert.rejects(ask(''), (e) => e instanceof UsageError && /no answer/.test(e.message))
  })

  test('plans with / paths on every platform', () => {
    const plan = (bare: boolean) =>
      planInit({ dir: tempDir('init-plan'), choice: 'goose', force: false, pkg, version, bare })
    assert.deepEqual(
      plan(false).actions.map((a) => a.path),
      FILES,
    )
    assert.deepEqual(
      plan(true).actions.map((a) => a.path),
      BARE,
    )
    assert.deepEqual(plan(false).conflicts, [])
  })
})
