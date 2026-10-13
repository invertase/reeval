// The CLI's parser (commander, driven by src/cli-spec.ts): every command's help against a golden
// file, every flag of every command parsed, and every kind of bad command line exiting 2.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { parseCli } from '../src/cli-parse.ts'
import { COMMANDS, FLAGS, type FlagName, GLOBAL, helpText } from '../src/cli-spec.ts'
import { UsageError } from '../src/config.ts'
import { fakeConfig, pkgRoot, project, runCli } from './helpers.ts'

const GOLDEN = join(pkgRoot, 'test/fixtures/cli/help.golden.txt')
const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

/** Every command path with its spec: `run`, `studio`, `studio build`, `image build`, … */
const PATHS = Object.entries(COMMANDS).flatMap(([name, spec]) => [
  ...(spec.help ? [{ path: [name], spec }] : []),
  ...Object.entries(spec.sub ?? {}).map(([sub, s]) => ({ path: [name, sub], spec: s })),
])

const usage = (argv: string[], message: RegExp) =>
  assert.throws(
    () => parseCli(argv),
    (e: unknown) => e instanceof UsageError && message.test(e.message),
    argv.join(' '),
  )

describe('cli', () => {
  test('reeval --help matches the golden file', () => {
    // As console.log prints it.
    const text = `${helpText('VERSION')}\n`
    if (process.env.REEVAL_UPDATE_SNAPSHOTS) writeFileSync(GOLDEN, text)
    assert.equal(text, readFileSync(GOLDEN, 'utf8'))
  })

  test('every command prints the same help with --help and -h, exit 0', async () => {
    const p = await project('cli-help', { 'reeval.config.ts': fakeConfig() })
    const golden = readFileSync(GOLDEN, 'utf8').replace('reeval VERSION', `reeval ${version}`)
    const lines = [[], ...PATHS.map((c) => c.path), ['image']]
    await Promise.all(
      lines.flatMap((path) =>
        ['--help', '-h'].map(async (flag) => {
          const r = await runCli(p.dir, [...path, flag])
          assert.equal(r.code, 0, `reeval ${path.join(' ')} ${flag}: ${r.stderr}`)
          assert.equal(r.stdout, golden, `reeval ${path.join(' ')} ${flag}`)
        }),
      ),
    )
  })

  test('reeval alone prints the help and exits 2; --version prints the version', async () => {
    const p = await project('cli-bare', { 'reeval.config.ts': fakeConfig() })
    const bare = await runCli(p.dir, [])
    assert.equal(bare.code, 2)
    assert.match(bare.stdout, /^reeval \S+ — eval runner for coding agents\n/)
    for (const argv of [['--version'], ['run', '--version'], ['--version', '--help']]) {
      const r = await runCli(p.dir, argv)
      assert.equal(r.code, 0, argv.join(' '))
      assert.equal(r.stdout, `${version}\n`, argv.join(' '))
    }
  })

  test('every flag of every command parses, long, short and with =', () => {
    for (const { path, spec } of PATHS) {
      for (const flag of [...spec.flags, ...GLOBAL] as FlagName[]) {
        const s = FLAGS[flag] as { type: string; short?: string; multiple?: boolean }
        const name = `${path.join(' ')} --${flag}`
        const forms =
          s.type === 'string'
            ? s.optional
              ? [[`--${flag}`], [`--${flag}`, 'x'], [`--${flag}=x`]]
              : [[`--${flag}`, 'x'], [`--${flag}=x`]]
            : [[`--${flag}`], ...(s.short ? [[`-${s.short}`]] : [])]
        for (const form of forms) {
          const expected = s.type === 'string' ? (form.join('').includes('x') ? 'x' : '') : true
          const { values, positionals } = parseCli([...path, ...form])
          assert.deepEqual(positionals, path, name)
          assert.deepEqual(values, { [flag]: s.multiple ? [expected] : expected }, name)
        }
      }
    }
  })

  test('repeated flags, globals anywhere, filters and --', () => {
    assert.deepEqual(parseCli(['run', '-vv']).values, { verbose: [true, true] })
    assert.deepEqual(parseCli(['run', '-v', '--verbose', '-v']).values.verbose, [true, true, true])
    assert.deepEqual(parseCli(['run', '--tag', 'a', '--tag=!b']).values.tag, ['a', '!b'])
    assert.deepEqual(parseCli(['--config', 'c.ts', 'run', '--dry-run']), {
      positionals: ['run'],
      values: { config: 'c.ts', 'dry-run': true },
    })
    assert.deepEqual(parseCli(['run', 'a', '--runs', '2', 'b', '--config=c.ts']), {
      positionals: ['run', 'a', 'b'],
      values: { runs: '2', config: 'c.ts' },
    })
    assert.deepEqual(parseCli(['run', '--', '--odd', 'x']).positionals, ['run', '--odd', 'x'])
    assert.deepEqual(parseCli(['query', 'select 1']).positionals, ['query', 'select 1'])
    assert.deepEqual(parseCli(['compare', 'a', 'b']).positionals, ['compare', 'a', 'b'])
    assert.deepEqual(parseCli(['image', 'build', 'x', 'y', '--dry-run']), {
      positionals: ['image', 'build', 'x', 'y'],
      values: { 'dry-run': true },
    })
    assert.deepEqual(parseCli(['image', 'build', 'x', '--profile', 'nightly', '--dry-run']), {
      positionals: ['image', 'build', 'x'],
      values: { profile: 'nightly', 'dry-run': true },
    })
    assert.deepEqual(parseCli(['studio', '--no-token', '--no-scratch']).values, {
      'no-token': true,
      'no-scratch': true,
    })
    assert.deepEqual(parseCli(['studio', 'build', '--scratch']).values, { scratch: true })
    assert.deepEqual(parseCli(['mcp', '--http', '--port', '4990', '--token', 't']), {
      positionals: ['mcp'],
      values: { http: true, port: '4990', token: 't' },
    })
  })

  test('commands the dispatcher reports stay positionals', () => {
    assert.deepEqual(parseCli([]), { positionals: [], values: {} })
    assert.deepEqual(parseCli(['bogus', 'x']).positionals, ['bogus', 'x'])
    assert.deepEqual(parseCli(['image']).positionals, ['image'])
    assert.deepEqual(parseCli(['image', 'foo']).positionals, ['image', 'foo'])
    assert.deepEqual(parseCli(['help']).positionals, ['help'])
    // --help and --version come before the argument count.
    assert.deepEqual(parseCli(['show', 'a', 'b', '--help']).values, { help: true })
  })

  test('bad flags and arguments are usage errors', () => {
    usage(['--bogus'], /^Unknown option '--bogus'\. Run reeval --help\.$/)
    usage(['run', '--dry-runn'], /^Unknown option '--dry-runn'\. Did you mean --dry-run\?/)
    usage(['run', '-x'], /^Unknown option '-x'/)
    usage(['run', '--runs'], /^Option '--runs <value>' argument missing$/)
    usage(['run', '--json=1'], /^Option '--json' does not take an argument$/)
    usage(['run', '--port', '3'], /^--port isn't an option of reeval run\. Run reeval --help\.$/)
    usage(['show', '-v'], /^--verbose isn't an option of reeval show/)
    usage(['--dry-run', 'run'], /^--dry-run isn't an option of reeval\b/)
    usage(['studio', '--out', 'x'], /^--out isn't an option of reeval studio\b/)
    usage(['studio', 'build', '--port', '1'], /^--port isn't an option of reeval studio build/)
    usage(['clean', 'extra'], /^reeval clean takes no arguments \(got extra\)$/)
    usage(['show', 'a', 'b'], /^reeval show takes at most 1 argument \(got a b\)$/)
    usage(['compare', 'a', 'b', 'c'], /^reeval compare takes at most 2 arguments \(got a b c\)$/)
    usage(['studio', 'foo'], /^reeval studio takes no arguments \(got foo\)$/)
    usage(['mcp', 'x'], /^reeval mcp takes no arguments \(got x\)$/)
    usage(['mcp', '--json'], /^--json isn't an option of reeval mcp\b/)
    usage(['mcp', '--no-token'], /^--no-token isn't an option of reeval mcp\b/)
    // Every command refuses every flag that isn't its own.
    for (const { path, spec } of PATHS) {
      for (const flag of Object.keys(FLAGS) as FlagName[]) {
        if (spec.flags.includes(flag) || GLOBAL.includes(flag)) continue
        const value = FLAGS[flag].type === 'string' ? ['x'] : []
        usage([...path, `--${flag}`, ...value], /isn't an option of reeval /)
      }
      for (const flag of spec.flags.filter(
        (f) => FLAGS[f].type === 'string' && !('optional' in FLAGS[f] && FLAGS[f].optional),
      )) {
        usage([...path, `--${flag}`], /argument missing/)
      }
      for (const flag of spec.flags.filter((f) => FLAGS[f].type === 'boolean')) {
        usage([...path, `--${flag}=yes`], /does not take an argument/)
      }
    }
  })

  test('bad command lines exit 2 with one reeval: line', async () => {
    const p = await project('cli-usage', { 'reeval.config.ts': fakeConfig() })
    const cases: Array<[string[], RegExp]> = [
      [['bogus'], /^reeval: Unknown command "bogus"\. Run reeval --help\.\n$/],
      [['help'], /^reeval: Unknown command "help"\./],
      [['image'], /^reeval: Unknown command "image "\. Did you mean reeval image build\?\n$/],
      [
        ['image', 'foo'],
        /^reeval: Unknown command "image foo"\. Did you mean reeval image build\?\n$/,
      ],
      [['--bogus'], /^reeval: Unknown option '--bogus'\. Run reeval --help\.\n$/],
      [['run', '--runs'], /^reeval: Option '--runs <value>' argument missing\n$/],
      [['run', '--runs', '0'], /^reeval: --runs must be a whole number of at least 1 \(got 0\)\n$/],
      [['run', '--json'], /^reeval: reeval run --json only prints the plan: add --dry-run\./],
      [['clean', '--keep', 'x'], /^reeval: --keep must be a whole number \(got x\)\n$/],
      [
        ['run', '--port', '3'],
        /^reeval: --port isn't an option of reeval run\. Run reeval --help\.\n$/,
      ],
      [['show', 'a', 'b'], /^reeval: reeval show takes at most 1 argument \(got a b\)\n$/],
    ]
    await Promise.all(
      cases.map(async ([argv, stderr]) => {
        const r = await runCli(p.dir, argv)
        assert.equal(r.code, 2, `reeval ${argv.join(' ')}: ${r.stderr}`)
        assert.match(r.stderr, stderr, argv.join(' '))
      }),
    )
  })
})
