// `reeval report`: the bundle's contents, its redaction (seeded secrets, fragments, paths and
// variables never leak, with a canary proving they reach the raw data the report reads), no
// network unless filing, the issue URL and its truncation, the gh path, the failure hint and the
// `--out` formats.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, relative, sep } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { readInvocations } from '../src/report/invocations.ts'
import {
  FIELDS,
  fileIssue,
  ISSUE_TEMPLATE,
  issueRepo,
  issueUrl,
  MAX_URL,
} from '../src/report/issue.ts'
import { commandOf, redactArgv, scrubber, shortHome } from '../src/report/scrub.ts'
import { tarGz } from '../src/report/tar.ts'
import type { ReportBundle } from '../src/report/types.ts'
import { fakeConfig, pkgRoot, project, runCli, tempDir } from './helpers.ts'

// Seeds: each must never appear in anything reeval report writes or prints.
const NAMED = 'sk-live-report-7f3a9c2e1b8d4f6a' // in a secret-named variable
const UNNAMED = 'hunter2-webhook-q8w7e6r5t4y3' // in .env.local under an innocent name
const TOKEN = `ghp_${'R3p0rtT0k3n'.repeat(4)}` // a token shape, set nowhere
const FRAGMENT = NAMED.slice(-12) // a stretch of a secret on its own

const NO_NETWORK = pathToFileURL(join(pkgRoot, 'test/support/no-network.mjs')).href

/** Every seed found in `text`, by name. */
function leaks(text: string, paths: Record<string, string> = {}): string[] {
  const seeds: Record<string, string> = {
    NAMED,
    UNNAMED,
    TOKEN,
    FRAGMENT,
    NAMED_BASE64: Buffer.from(NAMED).toString('base64'),
    ...paths,
  }
  return Object.entries(seeds).flatMap(([name, seed]) => (text.includes(seed) ? [name] : []))
}

/** Every file under `dir`, as text, with any .tar.gz extracted first. */
function allText(dir: string): string {
  let text = ''
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (path.endsWith('.tar.gz')) {
      const into = tempDir('untar')
      untar(path, into)
      text += allText(into)
    } else text += readFileSync(path, 'utf8')
  }
  return text
}

/**
 * Unpacks `archive` into `into` by a relative path from there: Git for Windows' GNU tar reads a
 * `C:` in a path as a remote host, in `-f` and `-C` alike.
 */
const untar = (archive: string, into: string) =>
  execFileSync('tar', ['-xzf', relative(into, archive).replaceAll(sep, '/')], { cwd: into })

/** A project in a fake HOME whose agent fails with every seed and both paths in its message. */
async function failingProject(name: string) {
  const home = tempDir(`${name}-home`)
  const p = await project(`${name}`, {
    'reeval.config.ts': fakeConfig({
      harness: `{ failWith: ['agent broke', process.env.MY_API_KEY, process.env.WEBHOOK, '${TOKEN}', '${FRAGMENT}', process.cwd(), process.env.HOME + '/elsewhere/cache'].join(' ') }`,
      extra: 'profiles: { pr: { defaults: { runs: 1 } } },',
    }),
    'evals/agent.eval.ts': `import { evaluate } from 'reeval'
evaluate('agent eval', async (c) => { await c.send('go') })
`,
    '.env.local': `WEBHOOK=${UNNAMED}\n`,
  })
  // USERPROFILE: Windows' home directory, which os.homedir() reads there.
  const env = { HOME: home, USERPROFILE: home, MY_API_KEY: NAMED }
  return { ...p, home, env }
}

describe('reeval report: redaction', () => {
  test("Windows' 8.3 short home, as TEMP spells it, is masked too", () => {
    const long = (p: string) => p.replace('RUNNER~1', 'runneradmin')
    const temp = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp'
    assert.equal(shortHome('C:\\Users\\runneradmin', temp, long), 'C:\\Users\\RUNNER~1')
    assert.equal(
      shortHome('C:\\Users\\runneradmin', 'C:\\Users\\runneradmin\\Temp', long),
      undefined,
    )
    assert.equal(shortHome('C:\\Users\\bob', temp, long), undefined, 'TEMP is under no one else')
    assert.equal(shortHome('/home/alice', undefined, long), undefined)
    const s = scrubber({ env: { TEMP: temp }, home: 'C:\\Users\\runneradmin' })
    // Where the machine can't expand the short name (not Windows), the long form is still masked.
    assert.equal(s.text('at C:\\Users\\runneradmin\\x'), 'at ~\\x')
  })

  test('argv keeps commands and flag names, never values or arguments', () => {
    assert.deepEqual(redactArgv(['run', '--profile', 'secret-profile', 'greet', '-vv', '--json']), [
      'run',
      '--profile',
      '<value>',
      '<arg>',
      '-vv',
      '--json',
    ])
    assert.deepEqual(redactArgv(['--config=es.x.ts', 'studio', 'build', '--out', '/home/me/x']), [
      '--config=<value>',
      'studio',
      'build',
      '--out',
      '<value>',
    ])
    assert.deepEqual(redactArgv(['query', 'select 1', '--api-key=abc', '--', 'x']), [
      'query',
      '<arg>',
      '<flag>',
      '--',
      '<arg>',
    ])
    assert.deepEqual(redactArgv(['mcp', '--http', '--token=abc']), [
      'mcp',
      '--http',
      '--token=<value>',
    ])
    // A positional that happens to name a command, after the command, is still an argument.
    assert.deepEqual(redactArgv(['show', 'run']), ['show', '<arg>'])
    assert.equal(commandOf(['--config', 'x', 'image', 'build', 'greet']), 'image build')
    assert.equal(commandOf(['--bogus']), null)
  })

  test('the scrubber masks secrets, their fragments and encodings, token shapes and paths', () => {
    const scrub = scrubber({
      env: { MY_API_KEY: NAMED },
      home: '/home/alice',
      project: '/home/alice/work/app',
    })
    const text = [
      NAMED,
      FRAGMENT,
      Buffer.from(NAMED).toString('base64'),
      encodeURIComponent(NAMED),
      TOKEN,
      '/home/alice/work/app/reeval.config.ts',
      '/home/alice/.npm/_logs',
    ].join('\n')
    const out = scrub.text(text)
    assert.deepEqual(leaks(out, { HOME: '/home/alice', PROJECT: '/home/alice/work/app' }), [])
    assert.match(out, /<project>\/reeval\.config\.ts/)
    assert.match(out, /~\/\.npm\/_logs/)
    // Keys are scrubbed as well as values.
    assert.deepEqual(scrub.value({ [`/home/alice/${NAMED}`]: [NAMED] }), {
      '~/[REDACTED]': ['[REDACTED]'],
    })
  })

  test('canary: the leak check finds every seed when nothing scrubs', () => {
    const raw = [NAMED, UNNAMED, TOKEN, Buffer.from(NAMED).toString('base64'), '/home/alice/x']
    assert.deepEqual(leaks(raw.join(' '), { HOME: '/home/alice' }).sort(), [
      'FRAGMENT',
      'HOME',
      'NAMED',
      'NAMED_BASE64',
      'TOKEN',
      'UNNAMED',
    ])
  })
})

describe('reeval report: the bundle', () => {
  test('a failed run: bundle contents, --out as a directory, nothing leaks, no network', async () => {
    const p = await failingProject('report-bundle')
    const run = await runCli(p.dir, ['run', '--profile', 'pr', 'agent'], { env: p.env })
    assert.equal(run.code, 3, run.stdout + run.stderr)
    // The canary: reeval's own debug data holds the seeds reeval report must mask (an innocently named
    // .env value and the paths), so a report that copied it unscrubbed would fail below.
    const debugText = allText(join(p.dir, '.reeval/debug'))
    assert.deepEqual(leaks(debugText, { PROJECT: p.dir, HOME: p.home }).sort(), [
      'HOME',
      'PROJECT',
      'UNNAMED',
    ])

    const out = join(tempDir('report-out'), 'bundle')
    const log = join(tempDir('report-net'), 'network.log')
    writeFileSync(log, '')
    const r = await runCli(p.dir, ['report', '--out', out], {
      env: { ...p.env, NODE_OPTIONS: `--import ${NO_NETWORK}`, REEVAL_TEST_NETWORK_LOG: log },
    })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readFileSync(log, 'utf8'), '', 'reeval report used the network')
    assert.deepEqual(readdirSync(out).sort(), ['report-logs.tar.gz', 'report.json', 'report.md'])

    const bundle: ReportBundle = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
    assert.equal(bundle.kind, 'reeval-report')
    assert.equal(bundle.node, process.versions.node)
    assert.equal(bundle.os.platform, process.platform)
    assert.deepEqual(bundle.invocation?.argv, ['run', '--profile', '<value>', '<arg>'])
    assert.equal(bundle.invocation?.exitCode, 3)
    assert.equal(bundle.run?.runId, bundle.invocation?.runId)
    assert.equal(bundle.run?.outcome, 'infra_error')
    assert.equal(bundle.run?.failures[0]?.error?.kind, 'infra')
    assert.ok(bundle.run?.failures[0]?.debugLog.some((l) => l.includes('teardown')))
    assert.ok(bundle.run?.failures[0]?.debugFiles.includes('debug.log'))
    assert.deepEqual(bundle.config?.optionKeys, ['harness', 'judge', 'profiles', 'sandbox'])
    assert.deepEqual(bundle.config?.harnesses, ['fake'])
    assert.deepEqual(bundle.config?.profiles, [
      { name: 'pr', keys: ['defaults'], defaults: ['runs'] },
    ])
    assert.ok(Array.isArray((bundle.doctor as { checks: unknown[] }).checks))
    assert.ok(bundle.env.includes('MY_API_KEY'))
    assert.deepEqual(bundle.redaction.paths, ['~', '<project>'])
    // The config's values stay out, even from the attached trace.
    const written = allText(out)
    assert.doesNotMatch(written, /"kind":"config","data"/)
    assert.match(written, /<project>/)
    assert.deepEqual(leaks(written + r.stdout + r.stderr, { PROJECT: p.dir, HOME: p.home }), [])

    // The summary names the run, the failure and where it wrote.
    assert.match(r.stdout, /^reeval report\n/)
    assert.match(r.stdout, /\ncommand +reeval run --profile <value> <arg> → exit 3/)
    assert.match(r.stdout, /\nfailing +evals\/agent\.eval\.ts › agent eval # .*\(infra\)/)
    assert.match(r.stdout, /\nlogs +2 debug files attached/)

    // The count is every masked value the report holds: the key reeval masked in the record and
    // logs before the report read them, plus the .env value only the report masks.
    const { masked, upstream } = bundle.redaction
    const markers = (text: string) => text.split('[REDACTED]').length - 1
    const tar = tempDir('report-count')
    untar(join(out, 'report-logs.tar.gz'), tar)
    assert.equal(
      masked,
      markers(readFileSync(join(out, 'report.json'), 'utf8')) + markers(allText(tar)),
    )
    assert.ok(upstream >= 1 && upstream < masked, `${upstream} of ${masked}`)
    assert.match(
      r.stdout,
      new RegExp(
        `\\nredacted +${masked} secret values masked, ${upstream} of them already by reeval's records and logs;`,
      ),
    )
    assert.match(r.stdout, /Nothing was uploaded/)
  })

  test('values reeval masked before the report read them count, though the report masks none', async () => {
    const p = await project('report-upstream', {
      'reeval.config.ts': fakeConfig({
        harness: `{ failWith: 'agent failed: key ' + process.env.MY_API_KEY }`,
      }),
      'evals/agent.eval.ts': `import { evaluate } from 'reeval'
evaluate('agent eval', async (c) => { await c.send('go') })
`,
    })
    const env = { MY_API_KEY: NAMED }
    assert.equal((await runCli(p.dir, ['run'], { env })).code, 3)
    const r = await runCli(p.dir, ['report', '--json'], { env })
    const bundle: ReportBundle = JSON.parse(r.stdout)
    assert.match(bundle.run?.failures[0]?.error?.message ?? '', /key \[REDACTED\]$/)
    const { masked, upstream } = bundle.redaction
    assert.ok(masked >= 1, `masked ${masked}`)
    assert.equal(upstream, masked)
    const plain = await runCli(p.dir, ['report'], { env })
    assert.match(
      plain.stdout,
      new RegExp(
        `\\nredacted +${masked} secret values? masked, all already by reeval's records and logs;`,
      ),
    )
  })

  test('--out formats, the default folder, and --json writing nothing', async () => {
    const p = await failingProject('report-formats')
    await runCli(p.dir, ['run'], { env: p.env })
    const dir = tempDir('report-formats-out')
    for (const [out, files] of [
      [join(dir, 'a', 'bug.md'), ['bug-logs.tar.gz', 'bug.json', 'bug.md']],
      [join(dir, 'b', 'bug.json'), ['bug-logs.tar.gz', 'bug.json', 'bug.md']],
    ] as const) {
      const r = await runCli(p.dir, ['report', '--out', out], { env: p.env })
      assert.equal(r.code, 0, r.stderr)
      assert.deepEqual(readdirSync(dirname(out)).sort(), files)
    }
    assert.match(readFileSync(join(dir, 'a', 'bug.md'), 'utf8'), /^# reeval report\n/)

    const json = await runCli(p.dir, ['report', '--json'], { env: p.env })
    assert.equal(json.code, 0, json.stderr)
    assert.equal((JSON.parse(json.stdout) as ReportBundle).kind, 'reeval-report')
    assert.equal(existsSync(join(p.dir, '.reeval/reports')), false)

    const plain = await runCli(p.dir, ['report'], { env: p.env })
    const [stamp] = readdirSync(join(p.dir, '.reeval/reports'))
    assert.match(stamp ?? '', /^\d{8}T\d{6}Z$/)
    assert.match(plain.stdout, new RegExp(`Wrote \\.reeval/reports/${stamp}/report\\.md`))

    const both = await runCli(p.dir, ['report', '--json', '--issue'], { env: p.env })
    assert.equal(both.code, 2)
  })

  test('a crash: its stack is logged and --last reports it; the log skips reeval report', async () => {
    const p = await project('report-crash', {
      'reeval.config.ts': `${fakeConfig()}
if (process.argv.includes('run')) {
  setTimeout(() => Promise.reject(new Error('late failure in ' + process.cwd())), 0)
}
`,
      '.gitignore': '.env*\n.reeval/\n',
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
evaluate('slow', async (c) => { await new Promise((r) => setTimeout(r, 2000)) })
`,
      '.reeval/.keep': '',
    })
    const crash = await runCli(p.dir, ['run'])
    assert.equal(crash.code, 3, crash.stdout + crash.stderr)
    assert.match(crash.stderr, /reeval: late failure/)
    assert.match(crash.stderr, /hint: .*reeval report/)
    await runCli(p.dir, ['report', '--json'])
    await runCli(p.dir, ['doctor'])
    const logged = readInvocations(p.dir)
    assert.deepEqual(
      logged.map((i) => i.command),
      ['run', 'report', 'doctor'],
    )
    const r = await runCli(p.dir, ['report', '--last', '--json'])
    const bundle: ReportBundle = JSON.parse(r.stdout)
    assert.equal(bundle.invocation?.command, 'run')
    assert.equal(bundle.invocation?.error?.kind, 'crash')
    assert.match(bundle.invocation?.error?.stack ?? '', /late failure in <project>\n\s+at /)
    assert.deepEqual(leaks(r.stdout, { PROJECT: p.dir }), [])
  })

  test('the log keeps the newest 20 commands, and nothing outside a project with .reeval/', async () => {
    const p = await project('report-log', { 'reeval.config.ts': fakeConfig() })
    await runCli(p.dir, ['--version'])
    assert.equal(existsSync(join(p.dir, '.reeval')), false)
    mkdirSync(join(p.dir, '.reeval'))
    for (let i = 0; i < 22; i++) await runCli(p.dir, ['--version'])
    assert.equal(readInvocations(p.dir).length, 20)
  })
})

describe('reeval report: filing an issue', () => {
  const repo = issueRepo({ bugs: { url: 'https://github.com/invertase/reeval/issues' } })

  test("the repository comes from the package's bugs field, so a rename moves it", () => {
    assert.deepEqual(repo, {
      issues: 'https://github.com/invertase/reeval/issues',
      slug: 'invertase/reeval',
    })
    assert.equal(
      issueRepo({ bugs: 'https://github.com/acme/renamed/issues/' }).slug,
      'acme/renamed',
    )
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    assert.equal(issueRepo().issues, pkg.bugs.url)
  })

  test('the URL fills the repo’s issue form, and a long report is cut at a line to fit', () => {
    const template = readFileSync(
      join(pkgRoot, '../../.github/ISSUE_TEMPLATE', ISSUE_TEMPLATE),
      'utf8',
    )
    for (const id of Object.values(FIELDS)) assert.match(template, new RegExp(`id: ${id}\\n`))

    const short = new URL(issueUrl(repo, 'reeval run: it broke', 'line one\nline two'))
    assert.equal(short.origin + short.pathname, 'https://github.com/invertase/reeval/issues/new')
    assert.equal(short.searchParams.get('template'), ISSUE_TEMPLATE)
    assert.equal(short.searchParams.get('title'), 'reeval run: it broke')
    assert.equal(short.searchParams.get(FIELDS.report), 'line one\nline two')

    const body = Array.from({ length: 800 }, (_, i) => `line ${i} ${'é ✓ '.repeat(4)}`).join('\n')
    const url = issueUrl(repo, 'reeval run: it broke', body)
    assert.ok(url.length <= MAX_URL, `${url.length}`)
    const report = new URL(url).searchParams.get(FIELDS.report) ?? ''
    assert.match(report, /\n\n…cut to fit the URL: attach report\.md for the rest\.$/)
    const kept = report.slice(0, report.indexOf('\n\n…cut'))
    assert.ok(body.startsWith(`${kept}\n`), 'cut at a line')
    assert.ok(kept.length > 1000, `${kept.length}`)
    assert.throws(() => issueUrl(repo, 'x'.repeat(MAX_URL), body), /too long/)
  })

  test('gh: files it when gh is there and the user says yes; else the URL', async () => {
    const calls: string[][] = []
    const opened: string[] = []
    const out: string[] = []
    const deps = (over: { hasGh?: boolean; code?: number } = {}) => ({
      hasGh: async () => over.hasGh ?? true,
      gh: async (args: string[]) => {
        calls.push(args)
        return over.code
          ? { code: over.code, stdout: '', stderr: 'HTTP 403' }
          : { code: 0, stdout: 'https://github.com/invertase/reeval/issues/9\n', stderr: '' }
      },
      open: async (url: string) => {
        opened.push(url)
        return true
      },
    })
    const base = {
      repo,
      title: 'reeval run: it broke',
      body: 'the body',
      bodyFile: '/tmp/issue.md',
      whatHappened: '',
      yes: false,
      interactive: true,
      out: (l: string) => out.push(l),
    }
    assert.equal(await fileIssue({ ...base, confirm: async () => true }, deps()), 'gh')
    assert.deepEqual(calls[0], [
      'issue',
      'create',
      '--repo',
      'invertase/reeval',
      '--title',
      'reeval run: it broke',
      '--body-file',
      '/tmp/issue.md',
    ])
    assert.match(out.at(-1) ?? '', /^Filed https:\/\/github\.com\/invertase\/reeval\/issues\/9$/)
    assert.deepEqual(opened, [])
    assert.equal(await fileIssue({ ...base, yes: true }, deps()), 'gh')
    assert.equal(calls.length, 2)
    // No, no terminal to ask in, a failing gh, or no gh: the URL, opened only in a terminal.
    assert.equal(await fileIssue({ ...base, confirm: async () => false }, deps()), 'url')
    assert.equal(await fileIssue({ ...base }, deps()), 'url')
    assert.equal(await fileIssue({ ...base, yes: true }, deps({ code: 1 })), 'url')
    assert.match(out.join('\n'), /gh issue create failed \(HTTP 403\)/)
    assert.equal(await fileIssue({ ...base, interactive: false }, deps({ hasGh: false })), 'url')
    assert.equal(calls.length, 3)
    assert.equal(opened.length, 3)
    assert.match(out.at(-1) ?? '', /^https:\/\/github\.com\/invertase\/reeval\/issues\/new\?/)
  })

  test('reeval report --issue --yes runs gh issue create with a scrubbed body file', async () => {
    const p = await failingProject('report-gh')
    await runCli(p.dir, ['run'], { env: p.env })
    const bin = tempDir('report-gh-bin')
    const log = join(bin, 'gh.log')
    // Node behind an sh and a .cmd wrapper, so it runs on every OS.
    writeFileSync(
      join(bin, 'gh.js'),
      `const args = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
if (args[0] === 'issue') console.log('https://github.com/invertase/reeval/issues/42')
`,
    )
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec node "$(dirname "$0")/gh.js" "$@"\n`)
    chmodSync(join(bin, 'gh'), 0o755)
    writeFileSync(join(bin, 'gh.cmd'), '@node "%~dp0gh.js" %*\r\n')
    const env = { ...p.env, PATH: `${bin}${delimiter}${process.env.PATH}` }
    const r = await runCli(p.dir, ['report', '--issue', '--yes'], { env })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Filed https:\/\/github\.com\/invertase\/reeval\/issues\/42/)
    const create = readFileSync(log, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('issue create'))
    const bodyFile = /--body-file (\S+)/.exec(create ?? '')?.[1] ?? ''
    assert.match(create ?? '', /--repo invertase\/reeval --title reeval run: infra: agent broke/)
    const body = readFileSync(bodyFile, 'utf8')
    assert.match(body, /\*\*Command:\*\* `reeval run` → exit 3/)
    assert.match(body, /attach `report\.md`/)
    // The body file's own path is local, for gh; everything sent is scrubbed.
    const sent = (create ?? '').replace(bodyFile, '')
    assert.deepEqual(leaks(body + sent, { PROJECT: p.dir, HOME: p.home }), [])

    // Without --yes and no terminal to ask in, it prints the URL instead.
    const url = await runCli(p.dir, ['report', '--issue'], { env })
    assert.match(
      url.stdout,
      /\nhttps:\/\/github\.com\/invertase\/reeval\/issues\/new\?template=bug_report\.yml&/,
    )
    assert.equal(
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('issue')).length,
      1,
    )
  })
})

describe('reeval report: the failure hint', () => {
  test('an infra error suggests reeval report once, unless hidden, JSON or agent output', async () => {
    const p = await failingProject('report-hint')
    const hint =
      /^hint: if this looks like a bug in reeval, reeval report collects a redacted report/m
    const r = await runCli(p.dir, ['run'], { env: p.env })
    assert.equal(r.code, 3)
    assert.equal(r.stderr.match(new RegExp(hint.source, 'gm'))?.length, 1)
    for (const [args, env] of [
      [['run'], { REEVAL_NO_REPORT_HINT: '1' }],
      [['run', '--ui', 'agent'], {}],
      [['run'], { REEVAL_UI: 'agent' }],
      [['run'], { CURSOR_AGENT: '1', REEVAL_UI: '' }],
    ] as const) {
      const quiet = await runCli(p.dir, [...args], { env: { ...p.env, ...env } })
      assert.equal(quiet.code, 3, args.join(' '))
      assert.doesNotMatch(
        quiet.stderr + quiet.stdout,
        hint,
        `${args.join(' ')} ${JSON.stringify(env)}`,
      )
    }
    // An error the engine caught outside any eval gets it too, and reeval report has it.
    const stray = await project('report-hint-stray', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
setTimeout(() => Promise.reject(new Error('stray rejection')), 0)
evaluate('waits', async () => { await new Promise((r) => setTimeout(r, 500)) })
`,
      '.reeval/.keep': '',
    })
    const unhandled = await runCli(stray.dir, ['run'])
    assert.equal(unhandled.code, 1, unhandled.stdout + unhandled.stderr)
    assert.match(unhandled.stderr, hint)
    const report = await runCli(stray.dir, ['report', '--json'])
    const logged = (JSON.parse(report.stdout) as ReportBundle).invocation?.unhandledErrors ?? []
    assert.match(logged.join('\n'), /stray rejection/)
    // Usage errors and passing runs are the user's to fix, not reeval's.
    const usage = await runCli(p.dir, ['run', '--runs', 'x'], { env: p.env })
    assert.equal(usage.code, 2)
    assert.doesNotMatch(usage.stderr, hint)
    const ok = await project('report-hint-ok', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
evaluate('passes', async () => {})
`,
    })
    const pass = await runCli(ok.dir, ['run'])
    assert.equal(pass.code, 0, pass.stdout)
    assert.doesNotMatch(pass.stderr, hint)
  })
})

describe('reeval report: the logs archive', () => {
  test('tar -xzf reads it, long paths included', () => {
    const long = `${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(40)}/debug.log`
    const archive = join(tempDir('tar'), 'x.tar.gz')
    writeFileSync(
      archive,
      tarGz([
        { path: 'run/one.log', data: Buffer.from('one\n') },
        { path: long, data: Buffer.alloc(1300, 'x') },
      ]),
    )
    const into = tempDir('untar')
    untar(archive, into)
    assert.equal(readFileSync(join(into, 'run/one.log'), 'utf8'), 'one\n')
    assert.equal(readFileSync(join(into, long), 'utf8').length, 1300)
  })
})
