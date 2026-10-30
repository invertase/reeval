import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  DEFAULT_IMAGE,
  HARNESS_PACKAGES,
  harnessLabel,
  imageFor,
  LABEL,
} from '@reeval/sandbox-docker'
import type { RunRecord } from '../src/history/types.ts'
import { assertKeyRejected, pkgRoot, project, readRun, runCli, tempDir } from './helpers.ts'

const dockerReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const liveContainers = (runId: string) =>
  execFileSync('docker', ['ps', '-aq', '--filter', `label=${LABEL.run}=${runId}`], {
    encoding: 'utf8',
  }).trim()

const config = (harness: string) => `
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
export default defineConfig({
  harness: fakeHarness(${harness}),
  judge: { model: fakeJudge() },
})
`

test('the pinned harness versions match the installed adapters', () => {
  const pkg = JSON.parse(readFileSync(`${pkgRoot}/package.json`, 'utf8'))
  for (const { name, version, patch } of Object.values(HARNESS_PACKAGES)) {
    // This repo's own adapters and the patched upstream ones are bundled into dist, so they're
    // pinned as dev dependencies.
    if (name.startsWith('@reeval/')) {
      assert.equal(pkg.devDependencies[name], `workspace:${version}`, name)
    } else if (patch) {
      assert.equal(pkg.devDependencies[name], version, name)
      assert.equal(pkg.dependencies[name], undefined, name)
    } else assert.equal(pkg.dependencies[name], version, name)
  }
})

// Per test, not on the describe: a skipped describe hides its tests from the summary's count.
/** A first run may build an environment layer. */
const slow = { timeoutMs: 240_000 }
// REEVAL_TEST_REQUIRE_DOCKER=1 (CI's docker job) fails instead of skipping.
const requireDocker = process.env.REEVAL_TEST_REQUIRE_DOCKER === '1'
const docker = {
  skip: !dockerReady && !requireDocker && `needs Docker and ${DEFAULT_IMAGE}`,
  timeout: 300_000,
}
/** Per-test options for a test that needs a harness's own image. */
const harnessImage = (harness: Parameters<typeof imageFor>[0]) => {
  let built = true
  try {
    execFileSync('docker', ['image', 'inspect', imageFor(harness)], { stdio: 'ignore' })
  } catch {
    built = false
  }
  return {
    skip: !built && !requireDocker && `needs Docker and ${imageFor(harness)}`,
    timeout: 300_000,
  }
}
/** A `docker` shim on PATH that counts reeval's `docker build` calls. */
function countBuilds(dir: string, match = '') {
  const shim = join(dir, 'bin')
  const log = join(dir, 'builds.log')
  mkdirSync(shim, { recursive: true })
  const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
  writeFileSync(
    join(shim, 'docker'),
    `#!/bin/sh\n[ "$1" = build ] && case "$*" in *'${match}'*) echo build >> '${log}';; esac\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  )
  return {
    env: { PATH: `${shim}:${process.env.PATH}` },
    count: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').length - 1 : 0),
    reset: () => rmSync(log, { force: true }),
  }
}
const gooseImage = harnessImage('goose')
const claudeImage = harnessImage('claude-code')

describe('docker sandbox', () => {
  test('runs checks in the container, diffs, and removes it', docker, async () => {
    const p = await project('docker-pass', {
      'reeval.config.ts': config(
        `{ files: { 'greet.js': 'export const greet = (n) => \`Hello, \${n}!\`\\n', 'package.json': '{"type":"module"}' } }`,
      ),
      'evals/d.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('docker', async (c) => {
  const turn = await c.send('write greet.js')
  await expect(turn).toHaveFile('greet.js', /Hello/)
  await expect(c.exec('node -e "import(\\'./greet.js\\').then(m => console.log(m.greet(\\'Ada\\')))"')).toSucceed()
  const r = await c.exec('pwd && git --version && ls -A')
  expect(r.stdout).toContain('/reeval/workspace')
  expect(turn.diff.files).toEqual(expect.arrayContaining([{ path: 'greet.js', status: 'added' }]))
})
`,
    })
    const r = await runCli(p.dir, ['run'], slow)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run, evals } = readRun(p.dir)
    assert.equal(run.stack.images[0]?.ref, DEFAULT_IMAGE)
    assert.match(run.stack.images[0]?.id ?? '', /^sha256:[0-9a-f]{64}$/)
    assert.match(run.stack.images[0]?.agentCli ?? '', /^@cursor\/sdk \d+\.\d+\.\d+$/)
    const shown = await runCli(p.dir, ['show', 'latest'])
    assert.match(
      shown.stdout,
      /! Image .+ isn't pushed, so an exact rerun needs this machine's image/,
    )
    const log = evals[0]?.read(evals[0].trial.checks[0]?.log.path ?? '') ?? ''
    assert.match(log, /--- stdout\nHello, Ada!\n/)
    assert.equal(liveContainers(run.runId), '')
  })

  test(
    'install bakes into a cached layer; setup runs outside the timeout; secrets reach the container or only checks',
    docker,
    async () => {
      const install = [
        {
          run: 'pwd > /opt/reeval-cwd && ls /reeval/workspace | wc -l > /opt/reeval-workspace',
          timeout: '2m',
        },
        '(printenv DB_URL || echo none) > /opt/reeval-secret && echo layer > /opt/reeval-layer && date +%s%N > /opt/reeval-built',
      ]
      const eval_ = `import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'
const tools = defineEnvironment('tools', ({ secret }) => ({
  files: { '~/.config/reeval/hint.txt': 'from home' },
  env: {
    DB_URL: secret.fromEnv('REEVAL_TEST_DB_URL'),
    CHECK_ONLY: secret.fromEnv('REEVAL_TEST_DB_URL', { to: 'checks' }),
  },
  setup: [{ run: 'sleep 6 && printf %s "$CHECK_ONLY" > /tmp/check-only', timeout: '30s' }],
}))
evaluate('layered', { environment: tools.extend('layered', { sandbox: docker({ install: ${JSON.stringify(install)} }) }), timeout: '5s' }, async (c) => {
  const turn = await c.send('x')
  const agentEnv = turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : [])).join('')
  expect(agentEnv.split('\\n')).toContain('DB_URL')
  expect(agentEnv.split('\\n')).not.toContain('CHECK_ONLY')
  expect((await c.exec('cat /opt/reeval-layer')).stdout).toBe('layer\\n')
  expect((await c.exec('cat /opt/reeval-cwd')).stdout).toBe('/\\n')
  expect((await c.exec('cat /opt/reeval-workspace')).stdout).toBe('0\\n')
  expect((await c.exec('cat /opt/reeval-secret')).stdout).toBe('none\\n')
  expect((await c.exec('printf %s "$DB_URL"')).stdout).toBe('postgres://u:pw-long-enough@db')
  expect((await c.exec('cat ~/.config/reeval/hint.txt')).stdout).toBe('from home')
  await c.exec('cat /opt/reeval-built')
  expect((await c.exec('cat /tmp/check-only')).stdout).toBe('postgres://u:pw-long-enough@db')
})
`
      const p = await project('docker-env', {
        // The agent's own environment: the container's, without the checks' variables.
        'reeval.config.ts': config(`{ script: [[{ exec: 'env | cut -d= -f1' }]] }`),
        'evals/d.eval.ts': eval_,
      })
      const env = { REEVAL_TEST_DB_URL: 'postgres://u:pw-long-enough@db' }
      const first = await runCli(p.dir, ['run'], { env, ...slow })
      assert.equal(first.code, 0, first.stdout + first.stderr)
      const built = (run: ReturnType<typeof readRun>) =>
        run.evals[0]?.read(run.evals[0].trial.checks[6]?.log.path ?? '') ?? ''
      const a = readRun(p.dir)
      const image = a.evals[0]?.image
      assert.match(image?.ref ?? '', /^reeval-install:[0-9a-f]{16}$/)
      assert.equal(image?.base, DEFAULT_IMAGE)
      assert.deepEqual(
        image?.install,
        install.map((s) => (typeof s === 'string' ? s : s.run)),
      )
      assert.equal(image?.dockerfile, null)
      assert.deepEqual(
        a.run.stack.images.map((i) => i.ref),
        [image?.ref],
      )
      assert.equal('image' in (a.run.environments[0] ?? {}), false)
      assert.ok(a.evals[0]?.trial.files.setupLog, 'setup.log is kept')
      assert.doesNotMatch(JSON.stringify(a.run), /pw-long-enough/, 'declared secrets are redacted')
      const second = await runCli(p.dir, ['run'], { env, ...slow })
      assert.equal(second.code, 0, second.stdout + second.stderr)
      const b = readRun(p.dir)
      assert.equal(built(a), built(b), 'the second run reused the cached layer')
      assert.equal(b.evals[0]?.image?.id, image?.id)
      assert.equal(liveContainers(b.run.runId), '')
    },
  )

  test(
    'a root sandbox warns at the start of reeval run, in the record and in summary.md; canary: without root, nothing',
    docker,
    async () => {
      const p = await project('docker-root-warning', {
        'reeval.config.ts': config('{}'),
        'evals/root.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('installs deps', { environment: defineEnvironment('installs-deps', { sandbox: docker({ root: true }) }) }, async (c) => {
  expect((await c.exec('id -u')).stdout.trim()).toBe('0')
})
`,
        'evals/plain.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('stays unprivileged', async (c) => {
  expect((await c.exec('id -u')).stdout.trim()).toBe('10001')
})
`,
      })
      const message =
        'running as root in the sandbox: evaluate("installs deps") (docker({ root: true }))'
      const warned = (stdout: string, run: RunRecord, summary: string) => {
        const lines = stdout.split('\n')
        const at = lines.indexOf(`WARNING: ${message}`)
        assert.ok(at >= 0, `no root warning in:\n${stdout}`)
        assert.ok(
          at < lines.findIndex((l) => l.includes('▶')),
          'the warning comes before the first attempt starts',
        )
        assert.deepEqual(run.plan.sandboxWarnings, [
          {
            kind: 'root',
            level: 'eval',
            where: 'evaluate("installs deps")',
            file: 'evals/root.eval.ts',
            message,
          },
        ])
        assert.match(
          summary,
          /^> \*\*Warning:\*\* running as root in the sandbox: evaluate\("installs deps"\)/m,
        )
      }

      const r = await runCli(
        p.dir,
        ['run', '--ui', 'plain', '--output-logs', 'full', 'evals/root.eval.ts'],
        slow,
      )
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const rooted = readRun(p.dir)
      warned(r.stdout, rooted.run, rooted.read('summary.md'))

      const canary = await runCli(p.dir, ['run', '--ui', 'plain', 'evals/plain.eval.ts'], slow)
      assert.equal(canary.code, 0, canary.stdout + canary.stderr)
      const plain = readRun(p.dir)
      assert.notEqual(plain.run.runId, rooted.run.runId)
      assert.throws(
        () => warned(canary.stdout, plain.run, plain.read('summary.md')),
        /no root warning/,
      )
      assert.deepEqual(plain.run.plan.sandboxWarnings, [])
      assert.doesNotMatch(plain.read('summary.md'), /running as root/)
    },
  )

  test(
    'a failing install command names itself and is an infra error, headline first',
    docker,
    async () => {
      const p = await project('docker-install-fail', {
        'reeval.config.ts': config('{}'),
        'evals/d.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('broken', { environment: defineEnvironment('broken', { sandbox: docker({ install: ['echo one', 'exit 9', 'echo never'] }) }) }, async (c) => {
  await c.send('x')
})
`,
      })
      const r = await runCli(p.dir, ['run', '--ui', 'plain'], slow)
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(
        r.stdout,
        /^ +Building the install layer \(3 commands\) failed: install 2\/3 exited 9: exit 9$/m,
      )
      assert.match(r.stdout, /^ {2}\s*\| one$/m, "the step's own output")
      assert.match(r.stdout, /full log: \.reeval\/cache\/images\/reeval-install-[0-9a-f]{16}\.log/)
      assert.doesNotMatch(r.stdout, /RUN echo [A-Za-z0-9+/=]{16}/, 'no base64 Dockerfile')
      assert.doesNotMatch(r.stdout, /earlier lines/)
    },
  )

  test(
    'ENOSPC and exit 137 in install are named in the headline; canary: a plain exit is not',
    docker,
    async () => {
      const p = await project('docker-install-causes', {
        'reeval.config.ts': config('{}'),
        'evals/d.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const body = async (c) => { await c.exec('true') }
evaluate('disk', { environment: defineEnvironment('disk', { sandbox: docker({ install: ['echo filling && dd if=/dev/zero of=/dev/shm/fill bs=1M count=200'] }) }) }, body)
evaluate('oom', { environment: defineEnvironment('oom', { sandbox: docker({ install: ['echo dying && kill -9 $$'] }) }) }, body)
evaluate('plain', { environment: defineEnvironment('plain', { sandbox: docker({ install: ['echo plain && exit 4'] }) }) }, body)
`,
      })
      const r = await runCli(p.dir, ['run', '--ui', 'plain'], slow)
      assert.equal(r.code, 3, r.stdout + r.stderr)
      const { evals } = readRun(p.dir)
      const message = (name: string) =>
        evals.find((e) => e.name === name)?.trial.error?.message ?? ''
      assert.match(message('disk'), /^out of disk space \(ENOSPC\)/m)
      assert.match(
        message('disk'),
        /\| dd: error writing '\/dev\/shm\/fill': No space left on device/,
      )
      assert.match(message('oom'), /install 1\/1 exited 137/)
      assert.match(message('oom'), /^killed \(exit 137\): usually out of memory/m)
      assert.match(message('plain'), /install 1\/1 exited 4/)
      assert.doesNotMatch(message('plain'), /ENOSPC|exit 137/)
      assert.match(r.stdout, /out of disk space \(ENOSPC\)/)
    },
  )

  test(
    'a Dockerfile syntax error, and a from that is not Debian, say so first',
    docker,
    async () => {
      const p = await project('docker-bad-images', {
        'reeval.config.ts': config('{}'),
        'evals/bad.Dockerfile': 'FROM debian:bookworm-slim\nCOPYY a b\n',
        'evals/d.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('syntax', { environment: defineEnvironment('syntax', { sandbox: docker({ dockerfile: './bad.Dockerfile' }) }) }, async (c) => { await c.exec('true') })
evaluate('alpine', { environment: defineEnvironment('alpine', { sandbox: docker({ from: 'alpine:3.20' }) }) }, async (c) => { await c.exec('true') })
`,
      })
      const r = await runCli(p.dir, ['run', '--ui', 'plain'], { timeoutMs: 600_000 })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      const { evals } = readRun(p.dir)
      const message = (name: string) =>
        evals.find((e) => e.name === name)?.trial.error?.message ?? ''
      assert.match(
        message('syntax').split('\n')[0] ?? '',
        /^Building evals\/bad\.Dockerfile failed: dockerfile parse error on line 2: unknown instruction: COPYY/,
      )
      assert.match(
        message('alpine').split('\n')[0] ?? '',
        /^Building the toolchain layer FROM alpine:3\.20 failed: reeval needs a Debian or Ubuntu based image/,
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes.
      assert.doesNotMatch(r.stdout, /\x1b\[/, 'no raw ANSI from BuildKit warnings')
    },
  )

  test(
    'a registry that cannot be reached is retried, bounded; canary: a failing RUN is built once',
    docker,
    async () => {
      const p = await project('docker-retry', {
        'reeval.config.ts': config('{}'),
        'evals/run.Dockerfile': 'FROM debian:bookworm-slim\nRUN echo broken && exit 42\n',
        'evals/net.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('net', { environment: defineEnvironment('net', { sandbox: docker({ from: 'registry.invalid.example:5000/reeval/none:1' }) }) }, async (c) => { await c.exec('true') })
`,
        'evals/run.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('run', { environment: defineEnvironment('run', { sandbox: docker({ dockerfile: './run.Dockerfile' }) }) }, async (c) => { await c.exec('true') })
`,
      })
      const counter = countBuilds(p.dir)
      const net = await runCli(p.dir, ['run', 'net'], { env: counter.env, ...slow })
      assert.equal(net.code, 3, net.stdout + net.stderr)
      assert.equal(counter.count(), 3, 'one try and two retries')
      assert.match(readRun(p.dir).evals[0]?.trial.error?.message ?? '', /no such host/)
      counter.reset()
      const run = await runCli(p.dir, ['run', 'run'], { env: counter.env, ...slow })
      assert.equal(run.code, 3, run.stdout + run.stderr)
      assert.equal(counter.count(), 1, 'a deterministic failure is not retried')
      assert.match(readRun(p.dir).evals[0]?.trial.error?.message ?? '', /a RUN step exited 42/)
    },
  )

  test(
    'reeval clean --images removes the images reeval left dangling; canary: an image reeval did not build stays',
    docker,
    async () => {
      const p = await project('docker-clean-images', { 'reeval.config.ts': config('{}') })
      const nonce = `${Date.now()}-${process.pid}`
      // A commit over an existing tag leaves the old image dangling.
      const container = execFileSync('docker', ['create', 'debian:bookworm-slim', 'true'], {
        encoding: 'utf8',
      }).trim()
      const commit = (ours: boolean, n: number) =>
        execFileSync(
          'docker',
          [
            'commit',
            '--change',
            `LABEL ${ours ? LABEL.harness : 'reeval.test.other'}="${nonce}-${n}"`,
            container,
            `reeval-clean-test-${ours ? 'ours' : 'theirs'}:${nonce}`,
          ],
          { encoding: 'utf8' },
        ).trim()
      const ours = commit(true, 1)
      commit(true, 2)
      const theirs = commit(false, 1)
      commit(false, 2)
      execFileSync('docker', ['rm', container], { stdio: 'ignore' })
      const exists = (id: string) =>
        spawnSync('docker', ['image', 'inspect', id], { stdio: 'ignore' }).status === 0
      try {
        assert.ok(exists(ours) && exists(theirs), 'both replaced images are dangling')
        const r = await runCli(p.dir, ['clean', '--images'])
        assert.equal(r.code, 0, r.stdout + r.stderr)
        assert.match(r.stdout, /Removed \d+ images? reeval built that nothing uses/)
        assert.equal(exists(ours), false, "reeval's dangling image is removed")
        assert.equal(exists(theirs), true, "an image reeval didn't build is left alone")
      } finally {
        execFileSync('sh', [
          '-c',
          `docker rmi -f ${theirs} reeval-clean-test-ours:${nonce} reeval-clean-test-theirs:${nonce} >/dev/null 2>&1 || true`,
        ])
      }
    },
  )

  test(
    'an eval-level image that fails fails only its cells, each once, built once, annotated once; everything else runs',
    docker,
    async () => {
      const broken = `import { defineEnvironment, evaluate, group } from 'reeval'
import { docker } from 'reeval/sandbox'
group('broken tools', { environment: defineEnvironment('broken-tools', { sandbox: docker({ install: ['echo nope && exit 5'] }) }) }, () => {
  evaluate('a', { runs: 2 }, async (c) => { await c.exec('true') })
  evaluate('b', async (c) => { await c.exec('true') })
})
`
      const p = await project('docker-prepare-scoped', {
        'reeval.config.ts': config('{}'),
        'evals/ok.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('ok', async (c) => {
  expect((await c.exec('echo fine')).stdout).toBe('fine\\n')
})
`,
        'evals/broken.eval.ts': broken,
      })
      const counter = countBuilds(p.dir, 'reeval-install')
      const r = await runCli(p.dir, ['run', '--ui', 'plain', '--concurrency', '4'], {
        env: { ...counter.env, GITHUB_ACTIONS: 'true' },
        ...slow,
      })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.equal(counter.count(), 1, 'the failing install layer is built once for three attempts')
      const { run, read } = readRun(p.dir)
      const outcome = (name: string) => run.evals.find((e) => e.name === name)
      assert.equal(outcome('ok')?.outcome, 'pass', 'the eval that needs no broken image runs')
      const failed = run.evals.filter((e) => e.name !== 'ok').flatMap((e) => e.attempts)
      assert.equal(failed.length, 3)
      for (const a of failed) {
        assert.equal(a.outcome, 'infra_error')
        assert.match(
          a.error?.message ?? '',
          /^Building the install layer \(1 command\) failed: install 1\/1 exited 5/,
        )
        assert.equal(a.error?.prepare?.stage, 'install')
        assert.equal(a.error?.prepare?.class, 'config')
        assert.match(a.error?.prepare?.ref ?? '', /^reeval-install:/)
        assert.match(
          a.error?.prepare?.log ?? '',
          /^\.reeval\/cache\/images\/reeval-install-.+\.log$/,
        )
        assert.deepEqual(a.error?.prepare?.setBy, ['group("broken tools")'])
      }
      const lines = r.stdout.split('\n')
      const failedAt = lines.findIndex((l) =>
        /✗ docker\+[0-9a-f]+ \+ install failed to prepare \(set by group\("broken tools"\)/.test(l),
      )
      assert.ok(failedAt >= 0, r.stdout)
      assert.ok(
        failedAt < lines.findIndex((l) => l.includes('▶')),
        'reported before any attempt starts',
      )
      assert.equal(
        lines.filter((l) =>
          /^::error title=Sandbox docker\+[0-9a-f]+ \+ install failed to prepare::/.test(l),
        ).length,
        1,
      )
      assert.equal(
        lines.filter((l) => l.startsWith('::error file=evals/broken.eval.ts')).length,
        0,
        'no annotation per attempt',
      )
      const summary = lines.slice(lines.indexOf('Infra errors (3)'))
      assert.equal(
        summary.filter((l) => l.includes(' record ')).length,
        0,
        'no record path for attempts that never started',
      )
      assert.match(
        read('summary.md'),
        /Building the install layer \(1 command\) failed: install 1\/1 exited 5/,
      )

      // Canary: with the install fixed, nothing fails to prepare, so the checks above would fail.
      writeFileSync(join(p.dir, 'evals/broken.eval.ts'), broken.replace('exit 5', 'true'))
      const fixed = await runCli(p.dir, ['run', '--ui', 'plain'], slow)
      assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr)
      assert.doesNotMatch(fixed.stdout, /failed to prepare/)
    },
  )

  test(
    'a config-level image that fails stops the run before any attempt: exit 3, or 2 for a missing image',
    docker,
    async () => {
      const p = await project('docker-prepare-config', {
        'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig({
  harness: fakeHarness({}),
  environment: defineEnvironment('broken', { sandbox: docker({ install: ['echo config && exit 6'] }) }),
  judge: { model: fakeJudge() },
})
`,
        'evals/a.eval.ts': `import { evaluate } from 'reeval'
evaluate('a', async (c) => { await c.exec('true') })
evaluate('b', async (c) => { await c.exec('true') })
`,
      })
      const r = await runCli(p.dir, ['run', '--ui', 'plain'], slow)
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /^reeval: Building the install layer \(1 command\) failed: install 1\/1 exited 6/m,
      )
      assert.match(
        r.stderr,
        /The sandbox docker\+[0-9a-f]+ \+ install is set by reeval\.config\.ts for every eval, so nothing ran\./,
      )
      assert.doesNotMatch(r.stdout, /▶/, 'no attempt started')

      writeFileSync(
        join(p.dir, 'reeval.config.ts'),
        `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig({
  harness: fakeHarness({}),
  environment: defineEnvironment('broken', { sandbox: docker({ image: 'reeval-missing-image:nope' }) }),
  judge: { model: fakeJudge() },
})
`,
      )
      const missing = await runCli(p.dir, ['run', '--ui', 'plain'], slow)
      assert.equal(missing.code, 2, missing.stdout + missing.stderr)
      assert.match(
        missing.stderr,
        /Docker image reeval-missing-image:nope not found\. docker\(\{ image \}\) is used as is/,
      )
      assert.doesNotMatch(missing.stdout, /▶/)
    },
  )

  test(
    'two sandboxes on one failing from build it once: the failure is cached for the run',
    docker,
    async () => {
      const p = await project('docker-prepare-cache', {
        'reeval.config.ts': config('{}'),
        'evals/a.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('one', { environment: defineEnvironment('one', { sandbox: docker({ from: 'alpine:3.20', install: ['echo one'] }) }) }, async (c) => { await c.exec('true') })
evaluate('two', { environment: defineEnvironment('two', { sandbox: docker({ from: 'alpine:3.20', install: ['echo two'] }) }) }, async (c) => { await c.exec('true') })
evaluate('plain', { environment: defineEnvironment('plain', { sandbox: docker({ from: 'alpine:3.20' }) }) }, async (c) => { await c.exec('true') })
`,
      })
      const counter = countBuilds(p.dir, '-base')
      const r = await runCli(p.dir, ['run', '--ui', 'plain'], { env: counter.env, ...slow })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.equal(counter.count(), 1, 'one toolchain build for three sandboxes on it')
      const { run } = readRun(p.dir)
      for (const e of run.evals) {
        assert.equal(e.outcome, 'infra_error', e.name)
        assert.equal(e.attempts[0]?.error?.prepare?.stage, 'from')
        assert.match(
          e.attempts[0]?.error?.message ?? '',
          /reeval needs a Debian or Ubuntu based image/,
        )
      }
    },
  )

  test(
    'reeval image build builds every image, reports every failure and exits 3; --dry-run says how each stands',
    docker,
    async () => {
      const p = await project('docker-image-build-all', {
        'reeval.config.ts': config('{}'),
        'evals/bad.Dockerfile': 'FROM debian:bookworm-slim\nRUN echo broken && exit 42\n',
        'evals/a.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('plain', async (c) => { await c.exec('true') })
evaluate('bad', { environment: defineEnvironment('bad', { sandbox: docker({ dockerfile: './bad.Dockerfile' }) }) }, async (c) => { await c.exec('true') })
evaluate('nope', { environment: defineEnvironment('nope', { sandbox: docker({ from: 'nonexistent-reeval-image-${process.pid}:1' }) }) }, async (c) => { await c.exec('true') })
`,
      })
      const dry = await runCli(p.dir, ['image', 'build', '--dry-run'])
      assert.equal(dry.code, 0, dry.stdout + dry.stderr)
      assert.match(dry.stdout, /^ {2}✓ base +reeval-sandbox:cursor-[\d.]+ +\(ready: built/m)
      assert.match(
        dry.stdout,
        /^ {2}\+ dockerfile evals\/bad\.Dockerfile .+\(to build: not built yet\)$/m,
      )
      assert.match(
        dry.stdout,
        /^ {2}✗ from nonexistent-reeval-image-\d+:1 .+\(missing: doesn't resolve: .*(denied|not found)/m,
      )
      const plan = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(plan.code, 0, plan.stdout + plan.stderr)
      assert.match(plan.stdout, /^images {2}3 sandbox images: 1 ready, 1 to build, 1 missing$/m)

      const r = await runCli(p.dir, ['image', 'build'], slow)
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stdout, /^✓ docker · cursor: reeval-sandbox:cursor-[\d.]+ [0-9a-f]{12}$/m)
      assert.match(
        r.stdout,
        /^✗ docker:bad\.Dockerfile · cursor \(1 eval\): Building evals\/bad\.Dockerfile failed: a RUN step exited 42$/m,
      )
      assert.match(
        r.stdout,
        /^✗ docker:nonexistent-reeval-image-\d+:1 · cursor \(1 eval\): Building the toolchain layer FROM nonexistent-reeval-image-\d+:1 failed/m,
      )
      assert.match(r.stdout, /^2 of 3 images failed to build$/m)
      // Canary: without the broken images there's nothing to fail.
      const plain = await runCli(p.dir, ['image', 'build', 'plain'], slow)
      assert.equal(plain.code, 0, plain.stdout + plain.stderr)
      assert.match(plain.stdout, /^1 image ready$/m)
    },
  )

  test('a from tag that moves upstream: reeval run keeps its build, --dry-run says stale, reeval image build rebuilds it; --force rebuilds anyway', {
    ...docker,
    timeout: 900_000,
  }, async () => {
    const name = `reeval-registry-${process.pid}`
    const port = 5100 + (process.pid % 800)
    const tag = `localhost:${port}/reeval/base:1`
    const push = (version: string) => {
      execFileSync('docker', ['build', '-q', '-t', tag, '-'], {
        input: `FROM debian:bookworm-slim\nRUN echo ${version} > /etc/reeval-version\n`,
      })
      execFileSync('docker', ['push', '-q', tag], { stdio: 'ignore' })
      execFileSync('docker', ['rmi', tag], { stdio: 'ignore' })
    }
    execFileSync(
      'docker',
      ['run', '-d', '--rm', '--name', name, '-p', `${port}:5000`, 'registry:2'],
      { stdio: 'ignore' },
    )
    let ref = ''
    try {
      for (let i = 0; i < 20; i++) {
        if (spawnSync('curl', ['-sf', `http://localhost:${port}/v2/`]).status === 0) break
        await new Promise((r) => setTimeout(r, 500))
      }
      push('v1')
      const p = await project('docker-from-moves', {
        'reeval.config.ts': config('{}'),
        'evals/a.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('base', { environment: defineEnvironment('base', { sandbox: docker({ from: '${tag}' }) }) }, async (c) => {
  expect((await c.exec('cat /etc/reeval-version')).stdout).toBe('v1\\n')
})
`,
      })
      const first = await runCli(p.dir, ['run'], { timeoutMs: 600_000 })
      assert.equal(first.code, 0, first.stdout + first.stderr)
      const image = readRun(p.dir).evals[0]?.image
      ref = image?.ref ?? ''
      assert.equal(image?.from?.ref, tag)
      assert.match(image?.from?.digest ?? '', /^sha256:[0-9a-f]{64}$/)

      push('v2')
      const dry = await runCli(p.dir, ['run', '--dry-run'])
      assert.match(
        dry.stdout,
        /^ {2}~ \S+ · \S+ +stale: from .+ moved upstream \([0-9a-f]{12} → [0-9a-f]{12}\): reeval image build rebuilds it$/m,
      )
      const kept = await runCli(p.dir, ['run'], slow)
      assert.equal(kept.code, 0, 'reeval run keeps the build it has')
      assert.equal(readRun(p.dir).evals[0]?.image?.id, image?.id)

      const counter = countBuilds(p.dir, '-base')
      const refreshed = await runCli(p.dir, ['image', 'build'], {
        env: counter.env,
        timeoutMs: 600_000,
      })
      assert.equal(refreshed.code, 0, refreshed.stdout + refreshed.stderr)
      assert.equal(counter.count(), 1, 'rebuilt once, on the moved tag')
      // Canary: the rebuilt image has v2, so the eval's v1 check now fails.
      const moved = await runCli(p.dir, ['run'], slow)
      assert.equal(moved.code, 1, moved.stdout + moved.stderr)
      assert.match(readRun(p.dir).evals[0]?.error?.message ?? '', /expected 'v2\\n' to be 'v1\\n'/)

      counter.reset()
      const current = await runCli(p.dir, ['image', 'build'], { env: counter.env, ...slow })
      assert.equal(current.code, 0, current.stdout + current.stderr)
      assert.equal(counter.count(), 0, 'nothing moved, so nothing is rebuilt')
      const forced = await runCli(p.dir, ['image', 'build', '--force'], {
        env: counter.env,
        timeoutMs: 600_000,
      })
      assert.equal(forced.code, 0, forced.stdout + forced.stderr)
      assert.equal(counter.count(), 1, '--force rebuilds it anyway')
    } finally {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
      if (ref) spawnSync('docker', ['rmi', '-f', ref], { stdio: 'ignore' })
    }
  })

  test('concurrent attempts in two workers share one build of a new layer', docker, async () => {
    const nonce = `${Date.now()}-${process.pid}`
    const env = `import { docker } from 'reeval/sandbox'
export const fresh = docker({
  install: ['echo ${nonce} > /opt/reeval-nonce && date +%s%N > /opt/reeval-built'],
})
`
    const file = (name: string) => `import { defineEnvironment, evaluate } from 'reeval'
import { fresh } from './env.ts'
evaluate('${name}', { environment: defineEnvironment('${name}', { sandbox: fresh }), runs: 2 }, async (c) => {
  await c.send('x')
  await c.exec('cat /opt/reeval-built')
})
`
    const p = await project('docker-dedupe', {
      'reeval.config.ts': config('{}'),
      'evals/env.ts': env,
      'evals/a.eval.ts': file('a'),
      'evals/b.eval.ts': file('b'),
    })
    // BuildKit merges identical builds that overlap, so count reeval's `docker build` calls instead.
    const shim = join(p.dir, 'bin')
    const builds = join(p.dir, 'builds.log')
    mkdirSync(shim)
    const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
    writeFileSync(
      join(shim, 'docker'),
      `#!/bin/sh\n[ "$1" = build ] && echo build >> '${builds}'\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    )
    const r = await runCli(p.dir, ['run', '--concurrency', '4'], {
      env: { PATH: `${shim}:${process.env.PATH}` },
      ...slow,
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run, read } = readRun(p.dir)
    const attempts = run.evals.flatMap((e) => e.attempts)
    assert.equal(attempts.length, 4)
    const ids = new Set(attempts.map((a) => a.imageId))
    const built = new Set(attempts.map((a) => read(a.checks[0]?.log.path ?? '')))
    try {
      assert.equal(readFileSync(builds, 'utf8'), 'build\n', 'one docker build for four attempts')
      assert.equal(ids.size, 1, `one image for every attempt, got ${[...ids].join(', ')}`)
      assert.equal(built.size, 1, 'every attempt saw the same build')
      assert.equal(liveContainers(run.runId), '')
    } finally {
      const refs = new Set(
        attempts
          .map((a) => run.stack.images.find((i) => i.id === a.imageId)?.ref)
          .filter(Boolean) as string[],
      )
      for (const ref of refs) execFileSync('docker', ['rmi', '-f', ref], { stdio: 'ignore' })
    }
  })

  test('dockerfile: FROM the REEVAL_BASE arg inherits the harness; another base gets it baked on; reeval image build builds them', {
    ...docker,
    timeout: 900_000,
  }, async () => {
    const nonce = `${Date.now()}-${process.pid}`
    const p = await project('docker-dockerfile', {
      'reeval.config.ts': config('{}'),
      'evals/tools/Dockerfile': `ARG REEVAL_BASE\nFROM \${REEVAL_BASE}\nCOPY greeting.txt /opt/greeting.txt\nRUN echo ${nonce} > /opt/nonce\n`,
      'evals/tools/greeting.txt': 'hello\n',
      'evals/tools/.dockerignore': 'scratch\n',
      'evals/deb.Dockerfile': `FROM debian:bookworm-slim\nRUN echo ${nonce} > /opt/deb\n`,
      'evals/d.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('tools', { environment: defineEnvironment('tools', { sandbox: docker({ dockerfile: './tools/Dockerfile' }) }) }, async (c) => {
  await c.send('x')
  const greeting = (await c.exec('cat /opt/greeting.txt')).stdout
  expect(greeting).toMatch(/^(hello|bonjour)\\n$/)
  expect((await c.exec('cat /opt/nonce')).stdout).toBe('${nonce}\\n')
  expect((await c.exec('pwd')).stdout).toBe('/reeval/workspace\\n')
})
evaluate('deb', { environment: defineEnvironment('deb', { sandbox: docker({ dockerfile: './deb.Dockerfile' }) }) }, async (c) => {
  await c.send('x')
  expect((await c.exec('cat /opt/deb')).stdout).toBe('${nonce}\\n')
  expect((await c.exec('grep -c bookworm /etc/os-release')).exitCode).toBe(0)
  expect((await c.exec('node --version && git --version')).exitCode).toBe(0)
})
`,
    })
    const refs = new Set<string>()
    try {
      // Only the deb eval, so reeval's own image (a FROM \${REEVAL_BASE} Dockerfile needs it) isn't rebuilt.
      const planned = await runCli(p.dir, ['image', 'build', '--dry-run', 'deb'])
      assert.equal(planned.code, 0, planned.stdout + planned.stderr)
      assert.match(planned.stdout, /^images {2}1 sandbox image/m)
      const build = await runCli(p.dir, ['image', 'build', 'deb'], { timeoutMs: 600_000 })
      assert.equal(build.code, 0, build.stdout + build.stderr)
      const debRef = /^✓ docker:deb\.Dockerfile · cursor: (\S+)/m.exec(build.stdout)?.[1] ?? ''
      assert.match(debRef, /^reeval-sandbox:cursor-[\d.]+-reeval-dockerfile-deb-dockerfile-/)
      refs.add(debRef)

      const first = await runCli(p.dir, ['run'], slow)
      assert.equal(first.code, 0, first.stdout + first.stderr)
      const a = readRun(p.dir)
      const image = (name: string) => a.evals.find((e) => e.name === name)?.image
      const tools = image('tools')
      const deb = image('deb')
      for (const i of [tools, deb]) if (i) refs.add(i.ref)
      assert.match(tools?.ref ?? '', /^reeval-dockerfile:tools-[0-9a-f]{16}$/)
      assert.equal(tools?.base, tools?.ref)
      assert.equal(tools?.dockerfile?.path, 'evals/tools/Dockerfile')
      assert.match(tools?.dockerfile?.sha256 ?? '', /^[0-9a-f]{64}$/)
      assert.match(tools?.agentCli ?? '', /\d/, 'the harness label comes from REEVAL_BASE')
      assert.equal(deb?.ref, debRef, 'the run used the image reeval image build made')
      assert.equal(deb?.dockerfile?.path, 'evals/deb.Dockerfile')
      assert.match(deb?.agentCli ?? '', /\d/)
      assert.deepEqual(deb?.install, [])

      mkdirSync(join(p.dir, 'evals/tools/scratch'))
      writeFileSync(join(p.dir, 'evals/tools/scratch/notes.txt'), 'ignored')
      const same = await runCli(p.dir, ['run', 'tools'], slow)
      assert.equal(same.code, 0, same.stdout + same.stderr)
      assert.equal(readRun(p.dir).evals[0]?.image?.id, tools?.id, 'an ignored file changes nothing')

      writeFileSync(join(p.dir, 'evals/tools/greeting.txt'), 'bonjour\n')
      const edited = await runCli(p.dir, ['run', 'tools'], slow)
      assert.equal(edited.code, 0, edited.stdout + edited.stderr)
      const b = readRun(p.dir).evals[0]
      if (b?.image) refs.add(b.image.ref)
      assert.notEqual(b?.image?.ref, tools?.ref, 'a context file edit is a new tag')
      assert.notEqual(b?.image?.dockerfile?.sha256, tools?.dockerfile?.sha256)
      assert.equal(b?.read(b.trial.checks[0]?.log.path ?? '').includes('bonjour'), true)
    } finally {
      for (const ref of refs) execFileSync('docker', ['rmi', '-f', ref], { stdio: 'ignore' })
      for (const ref of [...refs].filter((r) => r.startsWith('reeval-sandbox:'))) {
        execFileSync('docker', ['rmi', '-f', `${ref}-base`], { stdio: 'ignore' })
      }
      execFileSync(
        'sh',
        ['-c', `docker images -q 'reeval-dockerfile:deb-dockerfile-*' | xargs -r docker rmi -f`],
        { stdio: 'ignore' },
      )
    }
  })

  test('from: a toolchain image gets Node, git and the harness baked on, runs the attempt, and is cached', {
    ...docker,
    timeout: 900_000,
  }, async () => {
    const p = await project('docker-from', {
      'reeval.config.ts': config(
        `{ script: [[{ exec: 'node -e "process.stdout.write(process.version)"' }]] }`,
      ),
      'evals/f.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'
const bookworm = defineEnvironment('bookworm', { sandbox: docker({ from: 'debian:bookworm-slim' }) })
evaluate('bakes', { environment: bookworm }, async (c) => {
  const turn = await c.send('x')
  const shell = turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
  expect(shell.join('')).toMatch(/^v22\\./)
  expect((await c.exec('grep -c bookworm /etc/os-release')).exitCode).toBe(0)
  expect((await c.exec('git --version && curl --version && pnpm --version')).exitCode).toBe(0)
  expect((await c.exec('pwd')).stdout).toBe('/reeval/workspace\\n')
})
evaluate('canary', { environment: bookworm }, async (c) => {
  expect((await c.exec('grep -c trixie /etc/os-release')).stdout).toBe('1\\n')
})
`,
    })
    let ref = ''
    try {
      const first = await runCli(p.dir, ['run'], { timeoutMs: 600_000 })
      assert.equal(first.code, 1, first.stdout + first.stderr)
      const a = readRun(p.dir)
      const byName = Object.fromEntries(a.evals.map((e) => [e.name, e]))
      assert.equal(byName.bakes?.outcome, 'pass', first.stdout)
      assert.equal(byName.canary?.outcome, 'fail')
      assert.match(byName.canary?.error?.message ?? '', /expected '0\\n' to be '1\\n'/)
      const image = byName.bakes?.image
      ref = image?.ref ?? ''
      assert.match(ref, /^reeval-sandbox:cursor-[\d.]+-debian-bookworm-slim-[0-9a-f]{8}$/)
      assert.equal(image?.base, ref)
      assert.equal(image?.dockerfile, null)
      assert.match(image?.agentCli ?? '', /\d/, 'the harness is baked on')
      const base = spawnSync('docker', ['image', 'inspect', `${ref}-base`], { stdio: 'ignore' })
      assert.notEqual(base.status, 0, 'the intermediate -base tag is removed')
      assert.deepEqual(
        byName.bakes?.cells.map((c) => c.key),
        ['fake/bookworm/docker:debian:bookworm-slim'],
      )

      const again = await runCli(p.dir, ['run', 'bakes'], slow)
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.equal(readRun(p.dir).evals[0]?.image?.id, image?.id, 'the second run reuses the image')
    } finally {
      if (ref) {
        execFileSync('docker', ['rmi', '-f', ref], { stdio: 'ignore' })
        execFileSync('docker', ['rmi', '-f', `${ref}-base`], { stdio: 'ignore' })
      }
    }
  })

  test("dockerfile + claudeCode(): REEVAL_BASE is Claude Code's image; another base gets the claude CLI baked on", {
    ...claudeImage,
    timeout: 900_000,
  }, async () => {
    const nonce = `${Date.now()}-${process.pid}`
    const p = await project('docker-dockerfile-claude', {
      'reeval.config.ts': `
import { defineConfig } from 'reeval'
import { claudeCode } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({ harness: claudeCode({ model: 'claude-sonnet-5' }) })
`,
      'evals/tools/Dockerfile': `ARG REEVAL_BASE\nFROM \${REEVAL_BASE}\nRUN echo ${nonce} > /opt/nonce\n`,
      'evals/deb.Dockerfile': `FROM debian:bookworm-slim\nRUN echo ${nonce} > /opt/deb\n`,
      'evals/d.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
evaluate('tools', { environment: defineEnvironment('tools', { sandbox: docker({ dockerfile: './tools/Dockerfile' }) }) }, async () => {})
evaluate('deb', { environment: defineEnvironment('deb', { sandbox: docker({ dockerfile: './deb.Dockerfile' }) }) }, async () => {})
`,
    })
    const refs = new Set<string>()
    const claudeCli = (ref: string) =>
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--user',
          'reeval',
          '--entrypoint',
          'sh',
          ref,
          '-c',
          'find "$HOME/.ai-sdk-harness" -name claude \\( -type f -o -type l \\) -perm -u+x | head -1',
        ],
        { encoding: 'utf8' },
      ).trim()
    const label = (ref: string) =>
      execFileSync(
        'docker',
        ['image', 'inspect', '--format', `{{index .Config.Labels "${LABEL.harness}"}}`, ref],
        { encoding: 'utf8' },
      ).trim()
    try {
      // No credentials: reeval image build never starts an agent.
      const build = await runCli(p.dir, ['image', 'build', 'tools', 'deb'], {
        timeoutMs: 800_000,
        env: { ANTHROPIC_API_KEY: '' },
      })
      assert.equal(build.code, 0, build.stdout + build.stderr)
      const toolsRef = /^✓ docker:tools · claude-code: (\S+)/m.exec(build.stdout)?.[1] ?? ''
      const debRef = /^✓ docker:deb\.Dockerfile · claude-code: (\S+)/m.exec(build.stdout)?.[1] ?? ''
      refs.add(toolsRef)
      refs.add(debRef)
      assert.match(toolsRef, /^reeval-dockerfile:tools-[0-9a-f]{16}$/, build.stdout)
      assert.match(
        debRef,
        /^reeval-sandbox:claude-code-[\d.]+(-patch\.[0-9a-f]{8})?-reeval-dockerfile-deb-dockerfile-/,
        build.stdout,
      )
      const claudeLabel = harnessLabel('claude-code')
      for (const ref of [toolsRef, debRef]) {
        assert.equal(label(ref), claudeLabel, ref)
        assert.match(claudeCli(ref), /\/claude$/, ref)
      }
    } finally {
      for (const ref of refs) execFileSync('docker', ['rmi', '-f', ref], { stdio: 'ignore' })
      for (const ref of [...refs].filter((r) => r.startsWith('reeval-sandbox:'))) {
        execFileSync('docker', ['rmi', '-f', `${ref}-base`], { stdio: 'ignore' })
      }
      execFileSync(
        'sh',
        ['-c', `docker images -q 'reeval-dockerfile:deb-dockerfile-*' | xargs -r docker rmi -f`],
        { stdio: 'ignore' },
      )
    }
  })

  test('a timeout removes the container', docker, async () => {
    const p = await project('docker-timeout', {
      'reeval.config.ts': config('{ delayMs: 60_000 }'),
      'evals/d.eval.ts': `import { evaluate } from 'reeval'
evaluate('slow', { timeout: '3s' }, async (c) => { await c.send('wait') })
`,
    })
    const r = await runCli(p.dir, ['run'], slow)
    assert.equal(r.code, 1)
    const { run, evals } = readRun(p.dir)
    assert.equal(evals[0]?.error?.kind, 'timeout')
    assert.equal(liveContainers(run.runId), '')
  })

  test(
    'SIGTERM to the process group mid-turn exits 143 and leaves no container',
    docker,
    async () => {
      const p = await project('docker-sigterm', {
        'reeval.config.ts': config('{ delayMs: 60_000 }'),
        'evals/d.eval.ts': `import { evaluate } from 'reeval'
evaluate('slow', { runs: 2 }, async (c) => { await c.send('wait') })
`,
      })
      let started = 0
      const r = await runCli(p.dir, ['run', '--concurrency', '2', '--output-logs', 'full'], {
        ...slow,
        onOutput: (stdout, pid) => {
          started = stdout.match(/\] {2}\+\d+:\d\d turn 1 started$/gm)?.length ?? 0
          if (started < 2) return false
          process.kill(-pid, 'SIGTERM')
          return true
        },
      })
      assert.equal(r.code, 143, r.stdout + r.stderr)
      const runId = readdirSync(join(p.dir, '.reeval/runs'))
        .find((f) => f.endsWith('.json'))
        ?.replace(/\.json$/, '')
      assert.ok(runId, 'the run was written')
      assert.equal(liveContainers(runId), '')
      // The canary: both attempts had a container when the signal came.
      assert.equal(started, 2)
    },
  )

  test('Ctrl-C mid-capture stops the browser and the run', docker, async () => {
    // The page's script never answers, so its load never fires within the capture's budget.
    const server = `import http from 'node:http'
http.createServer((req, res) => {
  if (req.url === '/never.js') return
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<h1>stuck</h1><script>for (let i = 0; i < 1300; i++) console.log(i)</script><script src="/never.js"></script>')
}).listen(Number(process.env.PORT), '127.0.0.1')
`
    const p = await project('docker-capture-sigint', {
      'reeval.config.ts': config('{}'),
      'evals/d.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const box = defineEnvironment('box', { sandbox: docker(), files: { 'server.mjs': ${JSON.stringify(server)} } })
evaluate('stuck', { environment: box, timeout: '10m' }, async (c) => {
  const server = await c.serve('node server.mjs')
  console.log('capturing now')
  await c.capture(server, { timeout: '5m' })
})
`,
    })
    let sent = 0
    const r = await runCli(p.dir, ['run', '--output-logs', 'full'], {
      ...slow,
      onOutput: (stdout, pid) => {
        if (!stdout.includes('capturing now')) return false
        setTimeout(() => {
          sent = Date.now()
          process.kill(pid, 'SIGINT')
        }, 3_000)
        return true
      },
    })
    assert.equal(r.code, 130, r.stdout + r.stderr)
    assert.ok(sent > 0, 'the capture had started when the signal came')
    assert.ok(Date.now() - sent < 60_000, 'the run stopped well before the capture budget')
  })

  test(
    'Cursor attempts broker the key; without brokering the attempt fails closed',
    docker,
    async () => {
      const cursorConfig = (sandbox: string) => `
import { defineConfig, defineEnvironment } from 'reeval'
import { cursor } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({
  harness: cursor({ model: 'composer-2.5' }),
  environment: defineEnvironment('box', { sandbox: ${sandbox} }),
  timeout: '60s',
})
`
      const eval_ = `import { evaluate } from 'reeval'
evaluate('hi', async (c) => { await c.send('hi') })
`
      const warning = /CURSOR_API_KEY is passed into the sandbox container/
      // A made-up key: the sandbox and the gateway start, then the Cursor API refuses the key.
      const env = { CURSOR_API_KEY: 'crsr_not_a_real_key_0000000000000000' }
      const brokered = await project('docker-brokered', {
        'reeval.config.ts': cursorConfig('docker()'),
        'evals/d.eval.ts': eval_,
      })
      const a = await runCli(brokered.dir, ['run'], { env })
      assert.doesNotMatch(a.stdout + a.stderr, warning)
      assert.match(
        a.stdout + a.stderr,
        /The API rejected CURSOR_API_KEY: set a valid key in the environment or \.env\.local\. Cursor harness failed to start: .*HTTP 401/,
      )
      assert.equal(liveContainers(readRun(brokered.dir).run.runId), '')

      try {
        execFileSync('docker', ['pull', '-q', 'busybox:1.37'], { stdio: 'ignore' })
      } catch {
        return
      }
      // No node in the image, so the gateway can't start: by default that's an infra error, and
      // the key never enters the container.
      const refused = await project('docker-no-broker', {
        'reeval.config.ts': cursorConfig("docker({ image: 'busybox:1.37', root: true })"),
        'evals/d.eval.ts': eval_,
      })
      const b = await runCli(refused.dir, ['run'], { env })
      assert.equal(b.code, 3, b.stdout + b.stderr)
      assert.doesNotMatch(b.stdout + b.stderr, warning)
      const refusedRun = readRun(refused.dir)
      assert.equal(refusedRun.evals[0]?.error?.kind, 'infra')
      assert.match(
        refusedRun.evals[0]?.error?.message ?? '',
        /^Can't keep CURSOR_API_KEY out of the sandbox: credential brokering could not start \(the forwarder exited \(\d+\)[^)]*\)\. The egress gateway needs Node in the image: start from a Debian or Ubuntu image with docker\(\{ from: 'busybox:1\.37' \}\) or docker\(\{ dockerfile \}\), and reeval adds it\.$/,
      )
      assert.equal(liveContainers(refusedRun.run.runId), '')

      // There's no opt-in to pass the real key: the option doesn't exist.
      const optIn = await project('docker-no-opt-in', {
        'reeval.config.ts': cursorConfig(
          "docker({ image: 'busybox:1.37', credentials: 'allow-real-key' } as never)",
        ),
        'evals/d.eval.ts': eval_,
      })
      const c = await runCli(optIn.dir, ['run'], { env })
      assert.equal(c.code, 2, c.stdout + c.stderr)
      assert.match(c.stderr, /Unknown docker\(\) option "credentials"\./)
    },
  )

  test(
    'a brokered user secret on an image without the gateway fails closed, naming it',
    docker,
    async () => {
      execFileSync('docker', ['pull', '-q', 'busybox:1.37'], { stdio: 'ignore' })
      const value = 'reeval-docker-user-secret-5e4d3c2b1a'
      const p = await project('docker-secret-no-broker', {
        'reeval.config.ts': config('{}'),
        'evals/d.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const keys = defineEnvironment('keys', ({ secret }) => ({
  sandbox: docker({ image: 'busybox:1.37', root: true }),
  env: { GEMINI_API_KEY: secret.fromEnv('REEVAL_DOCKER_SECRET', { hosts: secret.hosts.gemini }) },
}))
evaluate('hi', { environment: keys }, async (c) => { await c.exec('true') })
`,
      })
      const r = await runCli(p.dir, ['run'], { env: { REEVAL_DOCKER_SECRET: value } })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      const { run, evals, dir } = readRun(p.dir)
      assert.equal(evals[0]?.error?.kind, 'infra')
      assert.match(
        evals[0]?.error?.message ?? '',
        /^Can't keep GEMINI_API_KEY out of the sandbox: credential brokering could not start \(the forwarder exited/,
      )
      assert.equal(liveContainers(run.runId), '')
      const grep = (needle: string) =>
        execFileSync('grep', ['-rlsF', needle, dir, `${dir}.json`], {
          encoding: 'utf8',
        }).trim()
      assert.throws(() => grep(value), 'the value is nowhere in the run')
      assert.notEqual(grep('GEMINI_API_KEY'), '', 'twin: the search finds the name')
    },
  )

  test(
    "egress 'proxy' on an image without the gateway fails closed; allow-all starts without it",
    docker,
    async () => {
      execFileSync('docker', ['pull', '-q', 'busybox:1.37'], { stdio: 'ignore' })
      const p = await project('docker-proxy-no-gateway', {
        'reeval.config.ts': config('{}'),
        'evals/d.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'
const bare = defineEnvironment('bare', { sandbox: docker({ image: 'busybox:1.37', root: true }) })
evaluate('proxied', { environment: bare }, async (c) => { await c.exec('true') })
evaluate('direct', { environment: bare, egress: 'allow-all' }, async (c) => { await c.exec('true') })
`,
      })
      const r = await runCli(p.dir, ['run'], { env: {} })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      const { run, evals } = readRun(p.dir)
      const proxied = evals.find((e) => e.name === 'proxied')
      assert.equal(proxied?.error?.kind, 'infra')
      assert.match(
        proxied?.error?.message ?? '',
        /^Can't enforce egress proxy: the egress gateway, the sandbox's only way out, could not start \(the forwarder exited .*\)\. The egress gateway needs Node in the image: start from a Debian or Ubuntu image with docker\(\{ from: 'busybox:1\.37' \}\)/,
      )
      // busybox has no git, so the attempt fails later on, past the gateway.
      assert.match(evals.find((e) => e.name === 'direct')?.error?.message ?? '', /snapshot/)
      assert.equal(liveContainers(run.runId), '')
    },
  )

  test(
    "two runs with the same agent context are comparable; a changed skill isn't",
    docker,
    async () => {
      const p = await project('docker-context', {
        'reeval.config.ts': config(`{ script: [[{ reply: 'done' }]] }`),
        'evals/d.eval.ts': `import { defineEnvironment, evaluate } from 'reeval'
const house = defineEnvironment('house', ({ skill }) => ({
  skills: [skill.inline({ name: 'house', description: 'House style', content: process.env.REEVAL_TEST_SKILL ?? 'v1' })],
}))
evaluate('context', { environment: house }, async (c) => { await c.send('go') })
`,
      })
      const run = async (env: NodeJS.ProcessEnv = {}) => {
        const r = await runCli(p.dir, ['run'], { ...slow, env })
        assert.equal(r.code, 0, r.stdout + r.stderr)
        return readRun(p.dir).run
      }
      const compareRows = async (base: string, head: string) => {
        const r = await runCli(p.dir, ['compare', base, head, '--json'])
        assert.equal(r.code, 0, r.stderr)
        return (JSON.parse(r.stdout) as { rows: Array<{ status: string; changes?: string[] }> })
          .rows
      }

      const first = await run()
      const second = await run()
      assert.ok(
        first.evals[0]?.attempts[0]?.context?.some((c) => c.path.endsWith('/house/SKILL.md')),
        JSON.stringify(first.evals[0]?.attempts[0]?.context),
      )
      assert.equal(first.evals[0]?.fingerprint, second.evals[0]?.fingerprint)
      assert.deepEqual(
        (await compareRows(first.runId, second.runId)).map((r) => r.status),
        ['same'],
      )

      // Twin: the skill the agent reads changes.
      const third = await run({ REEVAL_TEST_SKILL: 'v2' })
      const [row] = await compareRows(second.runId, third.runId)
      assert.equal(row?.status, 'drift')
      assert.ok(row?.changes?.includes('agent context changed'), JSON.stringify(row))
    },
  )

  test("npm installs the packed reeval tarball in reeval's image", {
    ...docker,
    timeout: 480_000,
  }, async () => {
    const out = tempDir('docker-pack')
    const packed = spawnSync('pnpm', ['pack', '--pack-destination', out], {
      cwd: pkgRoot,
      encoding: 'utf8',
    })
    assert.equal(packed.status, 0, packed.stdout + packed.stderr)
    const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'))
    assert.ok(tarball, readdirSync(out).join(', '))
    const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    const p = await project('docker-npm-tarball', {
      'reeval.config.ts': config('{}'),
      'evals/d.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const tarballEnv = defineEnvironment('reeval-tarball', ({ file }) => ({
  files: { 'reeval.tgz': file(${JSON.stringify(join(out, tarball))}) },
}))
evaluate('installs', { environment: tarballEnv, timeout: '6m' }, async (c) => {
  await expect(c.exec('npm install --no-audit --no-fund ./reeval.tgz')).toSucceed()
  expect((await c.exec('npx --no-install reeval --version')).stdout.trim()).toBe('${version}')
})
`,
    })
    const r = await runCli(p.dir, ['run'], { timeoutMs: 450_000 })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(liveContainers(readRun(p.dir).run.runId), '')
  })

  test(
    "-v summarizes a harness's expected blocked hosts once, and -vv still lists each request",
    docker,
    async () => {
      const curl = [
        'curl -s -o /dev/null https://play.googleapis.com/log',
        'curl -s -o /dev/null https://play.googleapis.com/log',
        'curl -s -o /dev/null https://antigravity-unleash.goog/api/',
        'curl -s -o /dev/null http://blocked.invalid/',
        'true',
      ].join('; ')
      const p = await project('docker-expected-blocked', {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({
  harness: fakeHarness({ layout: 'antigravity', script: [[{ exec: ${JSON.stringify(curl)} }]] }),
  egress: 'deny-all',
})
`,
        'evals/d.eval.ts': `import { evaluate } from 'reeval'
evaluate('calls home', async (c) => {
  await c.send('call home')
})
`,
      })
      const v = await runCli(p.dir, ['run', '-v'], slow)
      assert.equal(v.code, 0, v.stdout + v.stderr)
      const gateway = v.stdout.split('\n').filter((l) => / gateway {3}/.test(l))
      assert.deepEqual(
        gateway
          .filter((l) => /play\.googleapis|antigravity-unleash/.test(l))
          .map((l) => l.replace(/^.*? gateway {3}/, '')),
        [
          "expected blocks, not logged per request: antigravity-unleash.goog:443 ×1, play.googleapis.com:443 ×2 · Antigravity's telemetry and feature flags, which its CLI sends even with telemetry off",
        ],
      )
      assert.ok(
        gateway.some((l) => /GET http:\/\/blocked\.invalid:80\/ → 403 · blocked: /.test(l)),
        'a host nothing expects still gets its own line',
      )
      const vv = await runCli(p.dir, ['run', '-vv'], slow)
      assert.equal(vv.code, 0, vv.stdout + vv.stderr)
      assert.equal(
        vv.stdout.match(/ gateway {3}CONNECT play\.googleapis\.com:443 → 403 · blocked: /g)?.length,
        2,
        '-vv keeps every request',
      )
    },
  )

  test(
    '-v and -vv trace the image, container, brokering, gateway and docker commands',
    docker,
    async () => {
      const TOKEN = 'reeval-docker-verbose-token-5b8e2c'
      const curl = [
        'curl -s -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $API_KEY" https://example.com/',
        'curl -s -o /dev/null -w "%{http_code}" http://blocked.invalid/',
      ].join('; ')
      const p = await project('docker-verbose', {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
export default defineConfig(({ secret }) => ({
  harness: fakeHarness({ script: [[{ exec: ${JSON.stringify(curl)} }]] }),
  egress: { allow: ['example.com'] },
  env: { API_KEY: secret.fromEnv('REEVAL_DOCKER_TOKEN', { hosts: ['example.com'] }) },
  judge: { model: fakeJudge() },
}))
`,
        'evals/d.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('calls out', async (c) => {
  await c.send('call the api')
  await expect(c.exec('true')).toSucceed()
})
`,
      })
      const env = { REEVAL_DOCKER_TOKEN: TOKEN }
      const v = await runCli(p.dir, ['run', '-v'], { env, ...slow })
      assert.equal(v.code, 0, v.stdout + v.stderr)
      const line = (phase: string, text: string) =>
        new RegExp(`^\\[calls#1 fake\\]\\s+\\d{2}:\\d{2}:\\d{2} ${phase.padEnd(9)} ${text}`, 'm')
      for (const [phase, text] of [
        [
          'image',
          `ready ${DEFAULT_IMAGE.replace(/[.:]/g, '\\$&')} \\([0-9a-f]{12}\\) · prepared before the run`,
        ],
        ['container', 'created [0-9a-f]{12} from '],
        ['container', 'network policy allow example\\.com · detached from every Docker network'],
        ['container', 'egress gateway started · brokers API_KEY$'],
        [
          'broker',
          'API_KEY is a placeholder in the sandbox · swapped in on HTTPS to example\\.com in the header',
        ],
        [
          'gateway',
          'GET https://example\\.com/ → \\d{3} · allowed · ↑\\d+ B ↓[\\d.]+ K?B · \\d+ms · substituted API_KEY$',
        ],
        ['broker', 'substituted API_KEY for example\\.com \\(GET https://example\\.com/\\)$'],
        [
          'gateway',
          "GET http://blocked\\.invalid:80/ → 403 · blocked: blocked\\.invalid isn't in the allowlist · ",
        ],
        ['check', '\\$ true → exit 0 · '],
        ['teardown', 'sandbox destroyed'],
      ]) {
        assert.match(v.stdout, line(phase as string, text as string), `${phase} ${text}`)
      }
      assert.doesNotMatch(v.stdout, / docker {4}\$ docker /, '-v leaves the docker commands out')
      const run = readRun(p.dir).run
      const debugDir = join(p.dir, '.reeval/debug', run.runId)
      const [requests] = execFileSync('find', [debugDir, '-name', 'requests.ndjson'], {
        encoding: 'utf8',
      }).split('\n')
      const listed = readFileSync(requests as string, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      assert.deepEqual(
        listed.map((r) => [r.method, r.url, r.allowed, r.substituted]),
        [
          ['GET', 'https://example.com/', true, ['API_KEY']],
          ['GET', 'http://blocked.invalid:80/', false, []],
        ],
      )

      const vv = await runCli(p.dir, ['run', '-vv'], { env, ...slow })
      assert.equal(vv.code, 0, vv.stdout + vv.stderr)
      const traced = (text: string) =>
        new RegExp(`^\\[calls#1 fake\\]\\s+\\d{2}:\\d{2}:\\d{2}\\.\\d{3} ${text}`, 'm')
      for (const text of [
        'docker {4}\\$ docker image inspect ',
        'docker {4}\\$ docker run --detach --rm --init .* → exit 0 · \\d+ms$',
        'docker {4}\\$ docker network disconnect --force ',
        'docker {4}\\$ docker exec --interactive --user 0:0 [0-9a-f]{64} node -e ',
        'docker {4}\\$ docker rm -f [0-9a-f]{64} → exit 0',
        'gateway {3}dns example\\.com → ',
        'gateway {3}dns blocked\\.invalid refused: ',
        'gateway {3}headers https://example\\.com/$',
      ]) {
        assert.match(vv.stdout, traced(text), text)
      }
      // The headers are as the sandbox sent them: the placeholder, never the key.
      assert.match(vv.stdout, /"authorization":"Bearer reeval_secret_[0-9A-Za-z]{32}"/)
      const everything = vv.stdout + vv.stderr + v.stdout + v.stderr
      assert.equal(everything.includes(TOKEN), false, 'the key never prints')
      const leaked = spawnSync('grep', ['-rlF', TOKEN, join(p.dir, '.reeval')], {
        encoding: 'utf8',
      })
      assert.equal(leaked.stdout.trim(), '', 'no file under .reeval has the key')
      assert.equal(leaked.status, 1, leaked.stderr)
    },
  )

  test(
    'Goose gets the key on the model list it fetches each turn, and nothing is refused',
    gooseImage,
    async () => {
      const p = await project('docker-goose-endpoints', {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { goose } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({ harness: goose({ model: 'gemini-3.8-flash' }), timeout: '90s' })
`,
        'evals/d.eval.ts': `import { evaluate } from 'reeval'
evaluate('hi', async (c) => { await c.send('Reply with the word hi.') })
`,
      })
      // A made-up key: Goose lists the models, then Gemini refuses the key on the model call.
      const env = {
        GOOGLE_GENERATIVE_AI_API_KEY: 'AIzaSy-not_a_real_key_0000000000000000',
        REEVAL_DEBUG: '1',
      }
      const r = await runCli(p.dir, ['run', '--ui', 'plain', '--output-logs', 'full'], {
        env,
        timeoutMs: 240_000,
      })
      const out = r.stdout + r.stderr
      assert.match(
        out,
        /reeval:egress GET https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models HTTP\/[\d.]+ \(set x-goog-api-key\)/,
      )
      // The twin: the model call is brokered the same way, so the search can see a brokered line.
      assert.match(
        out,
        /reeval:egress POST \S+:streamGenerateContent HTTP\/[\d.]+ \(set x-goog-api-key\)/,
      )
      assert.doesNotMatch(out, /refused/)
      // Gemini's refusal fails the turn and names the host variable to fix.
      assert.match(
        out,
        /turn 1 error: The API rejected GOOGLE_GENERATIVE_AI_API_KEY: set a valid key/,
      )
      assert.equal(r.code, 3, out)
      assertKeyRejected(p.dir, 'GOOGLE_GENERATIVE_AI_API_KEY')
      assert.equal(liveContainers(readRun(p.dir).run.runId), '')
    },
  )

  test(
    "Goose on Vertex AI gets the route's project, region and service account from its launcher, over the eval's own",
    gooseImage,
    async () => {
      // A stand-in metadata server, the host's only Application Default Credentials: reeval mints
      // a made-up token from it, which Vertex AI refuses (401) once the gateway adds it.
      const token = 'reeval-test-host-token-0000'
      const metadata = createServer((req, res) => {
        res.setHeader('Metadata-Flavor', 'Google')
        if (req.url?.includes('/token')) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ access_token: token, expires_in: 3600, token_type: 'Bearer' }))
        } else res.end(req.url?.includes('project-id') ? 'reeval-test-project' : '')
      })
      await new Promise<void>((resolve) => metadata.listen(0, '127.0.0.1', resolve))
      try {
        const { port } = metadata.address() as AddressInfo
        const p = await project('docker-goose-vertex', {
          'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { vertex } from 'reeval/gateway'
import { goose } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({
  harness: goose({ model: 'gemini-3.8-flash' }),
  gateway: [vertex({ project: 'reeval-test-project', location: 'global' })],
  environment: defineEnvironment('box', {
    sandbox: docker(),
    egress: 'deny-all',
    env: { GCP_PROJECT_ID: 'eval-project', GCP_LOCATION: 'eval-location' },
  }),
  timeout: '90s',
})
`,
          'evals/d.eval.ts': String.raw`import { evaluate, expect } from 'reeval'
evaluate('hi', async (c) => {
  // The refused token makes the attempt an infra error; the checks below still run, caught.
  await c.send('Reply with the word hi.').catch(() => {})
  // Goose's own environment, read from /proc while its session is open.
  const env = await c.exec(
    "for p in /proc/[0-9]*; do case \"$(tr '\\0' ' ' < $p/cmdline 2>/dev/null)\" in */goose\\ acp*) tr '\\0' '\\n' < $p/environ;; esac; done",
  )
  const goose = env.stdout.split('\n').filter((l) => /^(GCP_|GOOGLE_APPLICATION|REEVAL_GOOSE)/.test(l))
  expect(goose.sort()).toEqual([
    'GCP_LOCATION=global',
    'GCP_PROJECT_ID=reeval-test-project',
    'GOOGLE_APPLICATION_CREDENTIALS=/reeval/google-adc.json',
  ])
  expect((await c.exec('printenv GCP_PROJECT_ID')).stdout.trim()).toBe('eval-project')
})
`,
        })
        const r = await runCli(p.dir, ['run', '--ui', 'plain', '-v'], {
          env: {
            GCE_METADATA_HOST: `127.0.0.1:${port}`,
            METADATA_SERVER_DETECTION: 'assume-present',
            CLOUDSDK_CONFIG: tempDir('docker-goose-vertex-gcloud'),
          },
          timeoutMs: 240_000,
        })
        const out = r.stdout + r.stderr
        assert.equal(r.code, 3, out)
        // Goose trades the service account's assertion at its token_uri, which the gateway answers.
        assert.match(out, /gateway +POST https:\/\/oauth2\.googleapis\.com\/token → 200/)
        // And calls the route's project and region, where the gateway adds the host's token.
        assert.match(
          out,
          /gateway +POST https:\/\/aiplatform\.googleapis\.com\/v1beta1\/projects\/reeval-test-project\/locations\/global\/publishers\/google\/models\/gemini-3\.8-flash:streamGenerateContent → 401 .*substituted Google Cloud credentials \(authorization\)/,
        )
        assert.doesNotMatch(out, /eval-project\/locations|eval-location\//)
        const { run, evals } = readRun(p.dir)
        const trial = evals[0]?.trial
        assert.equal(trial?.turns[0]?.status, 'error')
        assert.equal(trial?.outcome, 'infra_error', JSON.stringify(trial?.error))
        assert.match(
          trial?.error?.message ?? '',
          /^The API rejected the access token reeval minted from Google Cloud credentials/,
        )
        const failed = (trial?.assertions ?? []).filter((x) => x.status !== 'pass')
        assert.deepEqual(failed, [], "Goose's environment checks passed")
        assert.equal(trial?.assertions?.length, 2)
        const leaked = spawnSync('grep', ['-rlsF', token, join(p.dir, '.reeval')])
        assert.equal(leaked.stdout.toString().trim(), '', 'no file under .reeval has the token')
        assert.equal(liveContainers(run.runId), '')
      } finally {
        metadata.close()
      }
    },
  )

  for (const [factory, harness, model] of [
    ['opencode', 'opencode', 'google/gemini-3.8-flash'],
    ['pi', 'pi', 'gemini-3.8-flash'],
  ] as const) {
    test(
      `${factory}: Gemini refusing the key fails the turn and names the host variable`,
      harnessImage(harness),
      async () => {
        const p = await project(`docker-${factory}-refused-key`, {
          'reeval.config.ts': `import { defineConfig } from 'reeval'
import { ${factory} } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({ harness: ${factory}({ model: '${model}' }), timeout: '90s' })
`,
          'evals/d.eval.ts': `import { evaluate } from 'reeval'
evaluate('hi', async (c) => { await c.send('Reply with the word hi.') })
`,
        })
        const env = { GOOGLE_GENERATIVE_AI_API_KEY: 'AIzaSy-not_a_real_key_0000000000000000' }
        const r = await runCli(p.dir, ['run', '--ui', 'plain', '--output-logs', 'full'], {
          env,
          timeoutMs: 240_000,
        })
        const out = r.stdout + r.stderr
        assert.match(
          out,
          /turn 1 error: The API rejected GOOGLE_GENERATIVE_AI_API_KEY: set a valid key/,
        )
        assert.equal(r.code, 3, out)
        assertKeyRejected(p.dir, 'GOOGLE_GENERATIVE_AI_API_KEY')
        assert.equal(liveContainers(readRun(p.dir).run.runId), '')
      },
    )
  }

  test(
    'codex: the key is brokered on the Responses API only, and OpenAI refusing it names the host variable',
    harnessImage('codex'),
    async () => {
      const p = await project('docker-codex-refused-key', {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { codex } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({ harness: codex({ model: 'gpt-5.4-mini' }), timeout: '3m' })
`,
        'evals/d.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('hi', async (c) => {
  await c.send('Reply with the word hi.').catch(() => {})
  // Each turn is its own codex process, gone by now: the files it left are what can hold the key.
  const found = await c.exec('grep -rl not_a_real_key "$HOME" /reeval /tmp 2>/dev/null; true')
  expect(found.stdout).toBe('')
  expect(await c.exec('cat ~/.codex/config.toml').then((r) => r.stdout)).toContain('openai-http')
})
`,
      })
      const env = { OPENAI_API_KEY: 'sk-not_a_real_key_0000000000000000', REEVAL_DEBUG: '1' }
      const r = await runCli(p.dir, ['run', '--ui', 'plain', '--output-logs', 'full'], {
        env,
        timeoutMs: 300_000,
      })
      const out = r.stdout + r.stderr
      assert.match(
        out,
        /reeval:egress POST https:\/\/api\.openai\.com\/v1\/responses HTTP\/[\d.]+ \(set authorization\)/,
      )
      assert.doesNotMatch(out, /refused/)
      assert.doesNotMatch(out, /chatgpt\.com|github\.com/, 'no analytics or plugin sync')
      assert.match(out, /turn 1 error: The API rejected OPENAI_API_KEY: set a valid key/)
      assert.equal(r.code, 3, out)
      assertKeyRejected(p.dir, 'OPENAI_API_KEY')
      assert.equal(liveContainers(readRun(p.dir).run.runId), '')
    },
  )

  test(
    'grokBuild: the key is brokered on the xAI API only, and xAI refusing it names the host variable',
    harnessImage('grok-build'),
    async () => {
      const p = await project('docker-grok-build-refused-key', {
        'reeval.config.ts': `import { defineConfig } from 'reeval'
import { grokBuild } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({ harness: grokBuild({ model: 'grok-4.6' }), timeout: '3m' })
`,
        'evals/d.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('hi', async (c) => {
  await c.send('Reply with the word hi.').catch(() => {})
  const found = await c.exec('grep -rl not_a_real_key "$HOME" /reeval /tmp 2>/dev/null; true')
  expect(found.stdout).toBe('')
  const environ = await c.exec('cat /proc/[0-9]*/environ | tr "\\\\0" "\\\\n"')
  expect(environ.stdout).not.toContain('not_a_real_key')
  const config = await c.exec(
    'cat ~/.ai-sdk-harness/.harness-bootstrap/grok-build/implementation/home/.grok/config.toml',
  )
  expect(config.stdout).toContain('session_summary = "grok-4.6"')
  expect(config.stdout).toContain('telemetry = false')
})
`,
      })
      // A made-up key: Grok lists the models and checks the key as it starts, and xAI refuses it.
      const env = { XAI_API_KEY: 'xai-not_a_real_key_0000000000000000', REEVAL_DEBUG: '1' }
      const r = await runCli(p.dir, ['run', '--ui', 'plain', '--output-logs', 'full'], {
        env,
        timeoutMs: 300_000,
      })
      const out = r.stdout + r.stderr
      for (const path of ['/v1/models', '/v1/api-key']) {
        assert.match(
          out,
          new RegExp(
            `reeval:egress GET https://api\\.x\\.ai${path} HTTP/[\\d.]+ \\(set authorization\\)`,
          ),
          path,
        )
      }
      assert.doesNotMatch(out, /refused/)
      assert.match(out, /turn 1 error: The API rejected XAI_API_KEY: set a valid key/)
      assert.equal(r.code, 3, out)
      assertKeyRejected(p.dir, 'XAI_API_KEY')
      assert.equal(liveContainers(readRun(p.dir).run.runId), '')
    },
  )

  test(
    'Claude Code attempts broker the key on its endpoints; without brokering the attempt fails closed',
    claudeImage,
    async () => {
      const claudeConfig = (sandbox: string) => `
import { defineConfig, defineEnvironment } from 'reeval'
import { claudeCode } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({
  harness: claudeCode({ model: 'claude-sonnet-5' }),
  environment: defineEnvironment('box', { sandbox: ${sandbox} }),
  timeout: '90s',
})
`
      const eval_ = `import { evaluate, expect } from 'reeval'
evaluate('hi', async (c) => {
  // The rejected key makes the attempt an infra error; the checks below still run, caught.
  await c.send('Reply with the word hi.').catch(() => {})
  const environ = await c.exec('env; cat /proc/[0-9]*/environ | tr "\\\\0" "\\\\n"')
  // After a 401 the CLI may unset ANTHROPIC_API_KEY. What's left is reeval's
  // placeholder, the adapter's, or nothing — never the host key.
  const keyLines = environ.stdout
    .split('\\n')
    .filter((line) => line.startsWith('ANTHROPIC_API_KEY='))
  expect(
    keyLines.every((line) =>
      /^ANTHROPIC_API_KEY=(?:aisdkhc_[\\w-]{43}|reeval_secret_[0-9A-Za-z]{32})?$/.test(
        line,
      ),
    ),
  ).toBe(true)
  expect(environ.stdout).not.toContain('not_a_real_key')
})
`
      // A made-up key, and a host AI Gateway key the adapter must ignore: the sandbox, the
      // gateway and the CLI start, the gateway swaps the key in, and Anthropic refuses it (401).
      const env = {
        ANTHROPIC_API_KEY: 'sk-ant-not_a_real_key_000000000000000000',
        AI_GATEWAY_API_KEY: 'gw-not-used',
        REEVAL_DEBUG: '1',
      }
      const brokered = await project('docker-claude-brokered', {
        'reeval.config.ts': claudeConfig('docker()'),
        'evals/d.eval.ts': eval_,
      })
      const started = Date.now()
      const a = await runCli(brokered.dir, ['run', '--ui', 'plain', '--output-logs', 'full'], {
        env,
        timeoutMs: 240_000,
      })
      const out = a.stdout + a.stderr
      assert.equal(a.code, 3, out)
      assert.ok(Date.now() - started < 200_000, 'a refused key ends the turn; nothing hangs')
      assert.match(out, /turn 1 error: The API rejected ANTHROPIC_API_KEY: set a valid key/)
      const errors = assertKeyRejected(brokered.dir, 'ANTHROPIC_API_KEY')
      // The failed call is one error event, not the stream's and the thrown error's both.
      assert.equal(errors.length, 1, JSON.stringify(errors))
      assert.match(errors[0]?.message ?? '', /401|Invalid API key/i)
      assert.match(
        out,
        /reeval:egress POST https:\/\/api\.anthropic\.com\/v1\/messages HTTP\/[\d.]+ \(set x-api-key\)/,
      )
      // The twin of the check below: the same search finds the gateway's lines.
      assert.match(out, /reeval:egress /)
      assert.doesNotMatch(
        out,
        /refused|ai-gateway\.vercel\.sh/,
        'only its endpoints, never the AI Gateway',
      )
      const run = readRun(brokered.dir)
      assert.equal(liveContainers(run.run.runId), '')

      try {
        execFileSync('docker', ['pull', '-q', 'busybox:1.37'], { stdio: 'ignore' })
      } catch {
        return
      }
      const refused = await project('docker-claude-no-broker', {
        'reeval.config.ts': claudeConfig("docker({ image: 'busybox:1.37', root: true })"),
        'evals/d.eval.ts': eval_,
      })
      const b = await runCli(refused.dir, ['run'], { env })
      assert.equal(b.code, 3, b.stdout + b.stderr)
      const refusedRun = readRun(refused.dir)
      assert.equal(refusedRun.evals[0]?.error?.kind, 'infra')
      assert.match(
        refusedRun.evals[0]?.error?.message ?? '',
        /^Can't keep ANTHROPIC_API_KEY out of the sandbox: credential brokering could not start/,
      )
      assert.equal(liveContainers(refusedRun.run.runId), '')
    },
  )
})
