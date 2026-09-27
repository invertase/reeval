// `es init`: from an empty directory to a passing `es run`, for every agent it offers; it never
// overwrites a file that differs without --force, and a second run changes nothing.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

const FILES = ['es.config.ts', 'evals/greet.es.ts', '.gitignore', 'package.json']

const planOf = async (dir: string, args: string[] = []) => {
  const r = await runCli(dir, ['run', '--dry-run', '--json', ...args])
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout)
}

describe('es init', () => {
  test('an empty directory, --harness none, then es run passes', async () => {
    const p = await empty('init-none')
    const init = await runCli(p.dir, ['init', '--harness', 'none'])
    assert.equal(init.code, 0, init.stderr)
    for (const file of FILES) assert.match(init.stdout, new RegExp(`create +${file}`), file)
    assert.match(init.stdout, /npx es run +passes now/)
    const run = await runCli(p.dir, ['run'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /✓ evals\/greet\.es\.ts › creates greet\.js/)
    const manifest = JSON.parse(p.read('package.json'))
    assert.deepEqual(manifest.scripts, { eval: 'es run' })
    assert.deepEqual(manifest.devDependencies, { [pkg]: `^${version}` })
    assert.equal(
      p.read('.gitignore'),
      '# ES: scratch runs and debug data; local keys\n.es/\n.env*\n',
    )
  })

  test('--yes configures Cursor: the fake profile passes, a real run needs the key', async () => {
    const p = await empty('init-yes')
    assert.equal((await runCli(p.dir, ['init', '-y'])).code, 0)
    const fake = await runCli(p.dir, ['run', '--profile', 'fake'])
    assert.equal(fake.code, 0, fake.stdout + fake.stderr)
    const real = await runCli(p.dir, ['run'])
    assert.equal(real.code, 2)
    assert.match(real.stderr, /Missing credentials: CURSOR_API_KEY/)
  })

  for (const h of INIT_HARNESSES) {
    test(`--harness ${h.kind} writes a config that plans ${h.kind}, pr and fake`, async () => {
      const p = await empty(`init-${h.kind}`)
      const init = await runCli(p.dir, ['init', '--harness', h.kind])
      assert.equal(init.code, 0, init.stderr)
      assert.match(init.stdout, new RegExp(`with ${AGENTS[h.kind].credential} in \\.env\\.local`))
      const cell = (doc: { evals: Array<{ cells: Array<{ harness: string }> }> }) =>
        doc.evals[0]?.cells[0]?.harness
      assert.equal(cell(await planOf(p.dir)), `${h.kind}:${h.model}`)
      assert.equal(cell(await planOf(p.dir, ['--profile', 'fake'])), 'fake')
      const pr = await planOf(p.dir, ['--profile', 'pr'])
      assert.equal(pr.profile?.name ?? pr.profile, 'pr')
      assert.equal(pr.images[0]?.harness, h.kind)
    })
  }

  test('a second es init changes nothing', async () => {
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
    await writeFile(join(p.dir, 'es.config.ts'), 'export default {}\n')
    const refused = await runCli(p.dir, ['init', '--yes'])
    assert.equal(refused.code, 2)
    assert.match(
      refused.stderr,
      /^es: es init won't overwrite files in \.: es\.config\.ts exists and differs\. Nothing was written\. Pass --force to overwrite them\.\n$/,
    )
    assert.equal(p.read('es.config.ts'), 'export default {}\n')
    for (const file of FILES.slice(1)) assert.ok(!existsSync(join(p.dir, file)), file)
    const forced = await runCli(p.dir, ['init', '--yes', '--force'])
    assert.equal(forced.code, 0, forced.stderr)
    assert.match(forced.stdout, /overwrite +es\.config\.ts/)
    assert.match(p.read('es.config.ts'), /cursor\(\{ model: 'composer-2\.5' \}\)/)

    const other = await empty('init-other-config')
    await writeFile(join(other.dir, 'es.config.mjs'), 'export default {}\n')
    const shadowed = await runCli(other.dir, ['init', '--yes'])
    assert.equal(shadowed.code, 2)
    assert.match(shadowed.stderr, /es\.config\.mjs exists already/)
  })

  test('merges into an existing package.json and .gitignore', async () => {
    const p = await empty('init-merge')
    const manifest = { name: 'mine', scripts: { test: 'node --test' }, dependencies: { a: '1' } }
    await writeFile(join(p.dir, 'package.json'), JSON.stringify(manifest, null, 4))
    await writeFile(join(p.dir, '.gitignore'), 'node_modules\n/.es')
    const r = await runCli(p.dir, ['init', '--yes'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /update +package\.json +script eval, devDependency/)
    assert.match(r.stdout, /update +\.gitignore +\.env\*$/m)
    assert.equal(
      p.read('package.json'),
      `${JSON.stringify(
        {
          ...manifest,
          scripts: { test: 'node --test', eval: 'es run' },
          devDependencies: { [pkg]: `^${version}` },
        },
        null,
        4,
      )}\n`,
    )
    assert.equal(
      p.read('.gitignore'),
      'node_modules\n/.es\n\n# ES: scratch runs and debug data; local keys\n.env*\n',
    )

    // Its own eval script and ES dependency stay.
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
    assert.match(dry.stdout, /^es init · a b\/evals project \(nothing written: --dry-run\)\n/)
    assert.ok(!existsSync(join(p.root, 'a b')))
    const real = await runCli(p.root, ['init', 'a b/evals project', '--harness', 'none'])
    assert.equal(real.code, 0, real.stderr)
    assert.match(real.stdout, /Next:\n {2}cd a b\/evals project\n/)
    // Nothing it writes names this machine's paths, so the project works on Windows too.
    for (const file of FILES) {
      const text = p.read(file)
      assert.doesNotMatch(text, /\b[A-Za-z]:[\\/]/, file)
      assert.ok(!text.includes(p.root), file)
    }
    const run = await runCli(p.dir, ['run'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
  })

  test('without a terminal it needs --yes or --harness; a bad --harness is exit 2', async () => {
    const p = await empty('init-tty')
    const r = await runCli(p.dir, ['init'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /no terminal to ask in\. Pass --harness <name> or --yes\./)
    const bad = await runCli(p.dir, ['init', '--harness', 'gemini'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /--harness must be one of cursor, claude-code, .*none \(got gemini\)/)
    assert.ok(!existsSync(join(p.dir, 'es.config.ts')))
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
    assert.equal((await ask('\n')).choice, 'cursor')
    assert.equal((await ask('2\n')).choice, 'claude-code')
    assert.equal((await ask(`${INIT_HARNESSES.length + 1}\n`)).choice, 'none')
    const again = await ask('9\nClaude Code\n')
    assert.equal(again.choice, 'claude-code')
    assert.match(again.out, /Answer 1 to 7, or one of cursor, claude-code/)
    assert.match(again.out, /1\) Cursor +cursor:composer-2\.5, CURSOR_API_KEY/)
    await assert.rejects(ask(''), (e) => e instanceof UsageError && /no answer/.test(e.message))
  })

  test('plans with / paths on every platform', () => {
    const plan = planInit({
      dir: tempDir('init-plan'),
      choice: 'goose',
      force: false,
      pkg,
      version,
    })
    assert.deepEqual(
      plan.actions.map((a) => a.path),
      FILES.slice(0, 2).concat(['.gitignore', 'package.json']),
    )
    assert.deepEqual(plan.conflicts, [])
  })
})
