// `reeval init`: from an empty directory to a project that plans on every real agent it offers, with
// an environment its eval runs in (or, --bare, the config alone); it says whether Docker is ready
// without ever failing on it. In a project with a config it stops before asking; otherwise it only
// adds, merging into or skipping what's there, and a second run changes nothing.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { describe, test } from 'node:test'
import { UsageError } from '../src/errors.ts'
import { agentFor } from '../src/harness/agents.ts'
import { askHarness, INIT_HARNESSES, initCommand, planInit } from '../src/init.ts'
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
  'tsconfig.json',
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
    assert.match(
      init.stdout,
      /^Insights: google\/gemini-3\.8-flash explains each eval after a run, with GOOGLE_GENERATIVE_AI_API_KEY; analysis\.insights: false or --no-insights turns them off$/m,
    )
    assert.match(
      p.read('reeval.config.ts'),
      /^ {2}analysis: \{ model: 'google\/gemini-3\.8-flash' \},$/m,
    )
    const dry = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /^insights {2}google\/gemini-3\.8-flash · up to 250k tokens$/m)
    const off = await runCli(p.dir, ['run', '--dry-run', '--no-insights'])
    // Canary: --no-insights must drop the line the generated config adds.
    assert.doesNotMatch(off.stdout, /^insights /m)
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

  test('without the analysis key, a run prints one short line naming it, and keeps its exit code', async () => {
    const p = await empty('init-no-key')
    await runCli(p.dir, ['init', '--yes'])
    const model = /^ {2}analysis: .*$/m.exec(p.read('reeval.config.ts'))?.[0] ?? ''
    assert.ok(model, 'reeval init sets analysis.model')
    await writeFile(
      join(p.dir, 'fake.config.ts'),
      fakeConfig.replace('  sandbox: fakeSandbox(),', `  sandbox: fakeSandbox(),\n${model}`),
    )
    const run = await runCli(p.dir, ['run', '--config', 'fake.config.ts'])
    const skipped = (run.stdout + run.stderr).split('\n').filter((l) => /insights/.test(l))
    assert.deepEqual(skipped, [
      'warning: insights will be skipped: set GOOGLE_GENERATIVE_AI_API_KEY (for direct()) for analysis.model, "google/gemini-3.8-flash", in .env.local, or analysis: { insights: false }',
      'insights skipped: set GOOGLE_GENERATIVE_AI_API_KEY, or analysis: { insights: false }',
    ])
    assert.ok((skipped[1] ?? '').length <= 110, 'the closing line fits 110 columns, whole')
    const off = await runCli(p.dir, ['run', '--config', 'fake.config.ts', '--no-insights'])
    assert.equal(run.code, off.code)
    assert.equal(run.code, 0, run.stdout + run.stderr)
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
    for (const file of BARE) assert.match(again.stdout, new RegExp(`skip +${file}`), file)
  })

  for (const h of INIT_HARNESSES) {
    test(`--harness ${h.kind} plans ${h.kind} and pr, and names no fake agent`, async () => {
      const p = await empty(`init-${h.kind}`)
      const init = await runCli(p.dir, ['init', '--harness', h.kind])
      assert.equal(init.code, 0, init.stderr)
      const key = agentFor({ kind: h.kind, model: h.model } as never).credential
      assert.match(init.stdout, new RegExp(`with ${key} in \\.env\\.local`))
      const written = FILES.map(p.read).join('\n')
      assert.doesNotMatch(`${init.stdout}${init.stderr}${written}`, /fake/i)
      const cell = (doc: { evals: Array<{ cells: Array<{ harness: string }> }> }) =>
        doc.evals[0]?.cells[0]?.harness
      const plan = await planOf(p.dir)
      assert.equal(cell(plan), `${h.kind}:${h.model.split('/').at(-1)}`)
      assert.equal(plan.insights?.model, 'google/gemini-3.8-flash')
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
    for (const file of FILES) assert.match(again.stdout, new RegExp(`skip +${file}`), file)
    assert.deepEqual(FILES.map(p.read), before)
  })

  test('a project with a config: refuses before asking, until --force replaces only the config', async () => {
    const p = await empty('init-set-up')
    const mine = 'export default {}\n'
    await writeFile(join(p.dir, 'reeval.config.ts'), mine)
    await mkdir(join(p.dir, 'evals'))
    await writeFile(join(p.dir, 'evals/greet.eval.ts'), '// mine\n')
    const refusal =
      /^reeval: reeval is already set up in \.: reeval\.config\.ts exists and isn't the one reeval init writes\. Nothing was written\. Pass --force to replace it; init never overwrites another file\.\n$/
    for (const args of [['--yes'], ['--yes', '--bare'], ['--harness', 'codex']]) {
      const refused = await runCli(p.dir, ['init', ...args])
      assert.equal(refused.code, 2, args.join(' '))
      assert.match(refused.stderr, refusal)
    }
    assert.equal(p.read('reeval.config.ts'), mine)
    for (const file of FILES.slice(1)) {
      if (file !== 'evals/greet.eval.ts') assert.ok(!existsSync(join(p.dir, file)), file)
    }

    // In a terminal it stops before the question, not after it.
    let asked = ''
    const output = new Writable({
      write: (chunk, _, done) => {
        asked += chunk
        done()
      },
    })
    const input = Object.assign(Readable.from(['2\n']), { isTTY: true })
    await assert.rejects(
      initCommand({}, [], { out: () => {}, input, output, cwd: p.dir }),
      (e) => e instanceof UsageError && /already set up/.test(e.message),
    )
    assert.equal(asked, '', 'no question asked')

    const forced = await runCli(p.dir, ['init', '--yes', '--force'])
    assert.equal(forced.code, 0, forced.stderr)
    assert.match(forced.stdout, /overwrite +reeval\.config\.ts/)
    assert.match(forced.stdout, /skip +evals\/greet\.eval\.ts +exists: left as it is/)
    assert.match(p.read('reeval.config.ts'), /cursor\(\{ model: 'composer-2\.5' \}\)/)
    assert.equal(p.read('evals/greet.eval.ts'), '// mine\n', '--force never overwrites an eval')

    // A config init wrote is its own answer: no question, and -y doesn't swap the agent.
    const pi = await empty('init-set-up-pi')
    await runCli(pi.dir, ['init', '--harness', 'pi'])
    const again = await runCli(pi.dir, ['init', '--yes'])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /skip +reeval\.config\.ts +already as reeval init writes it/)
    assert.match(again.stdout, /npx reeval run +the eval on pi/)

    // Another config name can't be replaced: reeval.config.ts would shadow it or clash with it.
    for (const other of ['reeval.config.mjs', 'reeval.yaml']) {
      const o = await empty(`init-other-${other}`)
      await writeFile(join(o.dir, other), other.endsWith('yaml') ? 'include: []\n' : mine)
      const shadowed = await runCli(o.dir, ['init', '--yes', '--force'])
      assert.equal(shadowed.code, 2)
      assert.match(
        shadowed.stderr,
        new RegExp(
          `already set up in \\.: ${other.replace('.', '\\.')} is its config\\. Nothing was written\\. To start again with reeval\\.config\\.ts, delete it first\\.`,
        ),
      )
      assert.ok(!existsSync(join(o.dir, 'reeval.config.ts')))
    }
  })

  test('.gitignore: appends only the missing entries, in its own line endings', async () => {
    const p = await empty('init-gitignore')
    // No trailing newline, CRLF, and .reeval written without its slash.
    await writeFile(join(p.dir, '.gitignore'), 'dist/\r\n.env.local\r\n/.reeval')
    const r = await runCli(p.dir, ['init', '--yes', '--bare'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /update +\.gitignore +\.env\*$/m)
    assert.equal(
      p.read('.gitignore'),
      'dist/\r\n.env.local\r\n/.reeval\r\n\r\n# reeval: scratch runs and debug data; local keys\r\n.env*\r\n',
    )
    const again = await runCli(p.dir, ['init', '--yes', '--bare'])
    assert.match(again.stdout, /skip +\.gitignore +lists \.reeval\/, \.env\*$/m)
    assert.equal((p.read('.gitignore').match(/\.env\*/g) ?? []).length, 1, 'no duplicate')

    const lf = await empty('init-gitignore-lf')
    await writeFile(join(lf.dir, '.gitignore'), 'node_modules\n')
    await runCli(lf.dir, ['init', '--yes'])
    assert.equal(
      lf.read('.gitignore'),
      'node_modules\n\n# reeval: scratch runs and debug data; local keys\n.reeval/\n.env*\n',
    )
  })

  test('evals/: an existing file is skipped and said so, never overwritten', async () => {
    const emptyEvals = await empty('init-evals-empty')
    await mkdir(join(emptyEvals.dir, 'evals'))
    const fresh = await runCli(emptyEvals.dir, ['init', '--yes'])
    assert.equal(fresh.code, 0, fresh.stderr)
    assert.match(fresh.stdout, /create +evals\/environments\.ts/)
    assert.match(fresh.stdout, /create +evals\/greet\.eval\.ts/)

    // Its own eval: skipped, and the environment is still added beside it.
    const own = await empty('init-evals-own')
    await mkdir(join(own.dir, 'evals'))
    await writeFile(join(own.dir, 'evals/greet.eval.ts'), '// mine\n')
    const r = await runCli(own.dir, ['init', '--yes', '--force'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /skip +evals\/greet\.eval\.ts +exists: left as it is/)
    assert.match(r.stdout, /create +evals\/environments\.ts/)
    assert.match(r.stdout, /npx reeval run +the evals in evals\/ on Cursor/)
    assert.equal(own.read('evals/greet.eval.ts'), '// mine\n')

    // Its own environments.ts without greeter: both skipped, so no eval imports what isn't there.
    const env = await empty('init-evals-env')
    await mkdir(join(env.dir, 'evals'))
    await writeFile(join(env.dir, 'evals/environments.ts'), 'export const other = 1\n')
    const skipped = await runCli(env.dir, ['init', '--yes'])
    assert.equal(skipped.code, 0, skipped.stderr)
    assert.match(skipped.stdout, /skip +evals\/environments\.ts +exists: left as it is/)
    assert.match(
      skipped.stdout,
      /skip +evals\/greet\.eval\.ts +imports greeter, which your evals\/environments\.ts doesn't export/,
    )
    assert.equal(env.read('evals/environments.ts'), 'export const other = 1\n')
    assert.ok(!existsSync(join(env.dir, 'evals/greet.eval.ts')))

    // One that exports greeter: the eval is added, and plans in it.
    const withGreeter = await empty('init-evals-greeter')
    await mkdir(join(withGreeter.dir, 'evals'))
    const greeter = `import { defineEnvironment } from '${pkg}'\nexport const greeter = defineEnvironment('greeter', {})\n`
    await writeFile(join(withGreeter.dir, 'evals/environments.ts'), greeter)
    const used = await runCli(withGreeter.dir, ['init', '--yes'])
    assert.match(used.stdout, /create +evals\/greet\.eval\.ts/)
    assert.equal((await planOf(withGreeter.dir)).evals[0]?.cells[0]?.environment, 'greeter')
  })

  test('package.json: adds the script and devDependency in its own layout, every other byte kept', async () => {
    const p = await empty('init-package')
    // Tabs, an inline object, a scripts object with no eval, and no trailing newline.
    const tabs =
      '{\n\t"name": "mine",\n\t"scripts": {\n\t\t"test": "node --test"\n\t},\n\t"devDependencies": { "typescript": "^5" }\n}'
    await writeFile(join(p.dir, 'package.json'), tabs)
    const r = await runCli(p.dir, ['init', '--yes'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /update +package\.json +script eval, devDependency/)
    assert.equal(
      p.read('package.json'),
      `{\n\t"name": "mine",\n\t"scripts": {\n\t\t"test": "node --test",\n\t\t"eval": "reeval run"\n\t},\n\t"devDependencies": { "typescript": "^5", "${pkg}": "^${version}" }\n}`,
    )

    // No scripts or devDependencies: added as new members, nested in its indentation.
    const bare = await empty('init-package-bare')
    await writeFile(
      join(bare.dir, 'package.json'),
      '{\n    "name": "mine",\n    "private": true\n}\n',
    )
    await runCli(bare.dir, ['init', '--yes'])
    assert.equal(
      bare.read('package.json'),
      `{\n    "name": "mine",\n    "private": true,\n    "scripts": {\n        "eval": "reeval run"\n    },\n    "devDependencies": {\n        "${pkg}": "^${version}"\n    }\n}\n`,
    )
    await writeFile(join(bare.dir, 'package.json'), '{}')
    await runCli(bare.dir, ['init', '--yes'])
    assert.deepEqual(JSON.parse(bare.read('package.json')), {
      scripts: { eval: 'reeval run' },
      devDependencies: { [pkg]: `^${version}` },
    })

    // Its own eval script and reeval dependency stay, and the line says so.
    const own = await empty('init-own')
    const mine = `${JSON.stringify({ scripts: { eval: 'vitest' }, dependencies: { [pkg]: '1.0.0' } }, null, 2)}\n`
    await writeFile(join(own.dir, 'package.json'), mine)
    const kept = await runCli(own.dir, ['init', '--yes'])
    assert.match(kept.stdout, /skip +package\.json +has reeval; kept its eval script \(vitest\)/)
    assert.equal(own.read('package.json'), mine)

    await writeFile(join(own.dir, 'package.json'), '{ nope')
    const bad = await runCli(own.dir, ['init', '--yes', '--force'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /package\.json isn't valid JSON/)
  })

  test('.env.local and tsconfig.json: left alone, with a hint when the tsconfig needs one', async () => {
    const p = await empty('init-tsconfig')
    const env = 'CURSOR_API_KEY=abc\n'
    const own = '{\n  // mine\n  "compilerOptions": { "strict": true },\n}\n'
    await writeFile(join(p.dir, '.env.local'), env)
    await writeFile(join(p.dir, 'tsconfig.json'), own)
    const r = await runCli(p.dir, ['init', '--yes'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /skip +tsconfig\.json +exists: left as it is; for the eval's \.ts import, add "allowImportingTsExtensions": true \(with noEmit\)$/m,
    )
    assert.doesNotMatch(r.stdout, /\.env\.local +/)
    assert.equal(p.read('.env.local'), env)
    assert.equal(p.read('tsconfig.json'), own)

    // One that allows .ts imports, through extends, needs nothing.
    const ok = await empty('init-tsconfig-ok')
    await writeFile(
      join(ok.dir, 'base.json'),
      '{ "compilerOptions": { "rewriteRelativeImportExtensions": true } }\n',
    )
    await writeFile(join(ok.dir, 'tsconfig.json'), '{ "extends": "./base.json" }\n')
    const fine = await runCli(ok.dir, ['init', '--yes'])
    assert.match(fine.stdout, /skip +tsconfig\.json +exists: left as it is$/m)

    // --bare writes no tsconfig.json.
    const bare = await empty('init-tsconfig-bare')
    await runCli(bare.dir, ['init', '--yes', '--bare'])
    assert.ok(!existsSync(join(bare.dir, 'tsconfig.json')))
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
