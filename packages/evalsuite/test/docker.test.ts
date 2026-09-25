import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { DEFAULT_IMAGE, HARNESS_PACKAGES, imageFor, LABEL } from '@evalsuite/sandbox-docker'
import { pkgRoot, project, readRun, runCli } from './helpers.ts'

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
import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
import { fakeJudge } from 'evalsuite/judge'
export default defineConfig({
  harness: fakeHarness(${harness}),
  sandbox: docker(),
  judge: { model: fakeJudge() },
})
`

test('the pinned harness versions match the installed adapters', () => {
  const pkg = JSON.parse(readFileSync(`${pkgRoot}/package.json`, 'utf8'))
  for (const { name, version } of Object.values(HARNESS_PACKAGES)) {
    assert.equal(pkg.dependencies[name], version, name)
  }
})

// Per test, not on the describe: a skipped describe hides its tests from the summary's count.
/** A first run may build an environment layer. */
const slow = { timeoutMs: 240_000 }
// ES_TEST_REQUIRE_DOCKER=1 (CI's docker job) fails instead of skipping.
const requireDocker = process.env.ES_TEST_REQUIRE_DOCKER === '1'
const docker = {
  skip: !dockerReady && !requireDocker && `needs Docker and ${DEFAULT_IMAGE}`,
  timeout: 300_000,
}
const claudeImageBuilt = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', imageFor('claude-code')], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const claudeImage = {
  skip: !claudeImageBuilt && !requireDocker && `needs Docker and ${imageFor('claude-code')}`,
  timeout: 300_000,
}

describe('docker sandbox', () => {
  test('runs checks in the container, diffs, and removes it', docker, async () => {
    const p = await project('docker-pass', {
      'es.config.ts': config(
        `{ files: { 'greet.js': 'export const greet = (n) => \`Hello, \${n}!\`\\n', 'package.json': '{"type":"module"}' } }`,
      ),
      'evals/d.es.ts': `import { evaluate, expect } from 'evalsuite'
evaluate('docker', async (t) => {
  const turn = await t.send('write greet.js')
  await expect(turn).toHaveFile('greet.js', /Hello/)
  await expect(t.exec('node -e "import(\\'./greet.js\\').then(m => console.log(m.greet(\\'Ada\\')))"')).toSucceed()
  const r = await t.exec('pwd && git --version && ls -A')
  expect(r.stdout).toContain('/es/workspace')
  expect(turn.diff.files).toEqual(expect.arrayContaining([{ path: 'greet.js', status: 'added' }]))
})
`,
    })
    const r = await runCli(p.dir, ['run'], slow)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run, evals } = readRun(p.dir)
    assert.equal(run.stack.images[0]?.ref, DEFAULT_IMAGE)
    assert.match(run.stack.images[0]?.id ?? '', /^sha256:[0-9a-f]{64}$/)
    assert.match(run.stack.images[0]?.agentCli ?? '', /\d/)
    const shown = await runCli(p.dir, ['show', 'latest'])
    assert.match(
      shown.stdout,
      /! Image .+ isn't pushed, so an exact rerun needs this machine's image/,
    )
    assert.ok(
      run.stack.context.some((c) => c.path === '~/.cursor/cli-config.json'),
      JSON.stringify(run.stack.context),
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
        { run: 'pwd > /opt/es-cwd && ls /es/workspace | wc -l > /opt/es-workspace', timeout: '2m' },
        '(printenv DB_URL || echo none) > /opt/es-secret && echo layer > /opt/es-layer && date +%s%N > /opt/es-built',
      ]
      const eval_ = `import { defineEnvironment, evaluate, expect } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
const tools = defineEnvironment('tools', ({ secret }) => ({
  files: { '~/.config/es/hint.txt': 'from home' },
  env: {
    DB_URL: secret.fromEnv('ES_TEST_DB_URL'),
    CHECK_ONLY: secret.fromEnv('ES_TEST_DB_URL', { to: 'checks' }),
  },
  setup: [{ run: 'sleep 6 && printf %s "$CHECK_ONLY" > /tmp/check-only', timeout: '30s' }],
}))
evaluate('layered', { environment: tools, sandbox: docker({ install: ${JSON.stringify(install)} }), timeout: '5s' }, async (t) => {
  await t.send('x')
  expect((await t.exec('cat /opt/es-layer')).stdout).toBe('layer\\n')
  expect((await t.exec('cat /opt/es-cwd')).stdout).toBe('/\\n')
  expect((await t.exec('cat /opt/es-workspace')).stdout).toBe('0\\n')
  expect((await t.exec('cat /opt/es-secret')).stdout).toBe('none\\n')
  expect((await t.exec('printf %s "$DB_URL"')).stdout).toBe('postgres://u:pw-long-enough@db')
  expect((await t.exec('cat ~/.config/es/hint.txt')).stdout).toBe('from home')
  await t.exec('cat /opt/es-built')
  expect((await t.exec('cat /tmp/check-only')).stdout).toBe('postgres://u:pw-long-enough@db')
  const pid1 = (await t.exec("tr '\\\\0' '\\\\n' < /proc/1/environ")).stdout
  expect(pid1).toContain('DB_URL=')
  expect(pid1).not.toContain('CHECK_ONLY')
})
`
      const p = await project('docker-env', {
        'es.config.ts': config('{}'),
        'evals/d.es.ts': eval_,
      })
      const env = { ES_TEST_DB_URL: 'postgres://u:pw-long-enough@db' }
      const first = await runCli(p.dir, ['run'], { env, ...slow })
      assert.equal(first.code, 0, first.stdout + first.stderr)
      const built = (run: ReturnType<typeof readRun>) =>
        run.evals[0]?.read(run.evals[0].trial.checks[6]?.log.path ?? '') ?? ''
      const a = readRun(p.dir)
      const image = a.evals[0]?.image
      assert.match(image?.ref ?? '', /^evalsuite-install:[0-9a-f]{16}$/)
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

  test('a failing install command names itself and is an infra error', docker, async () => {
    const p = await project('docker-install-fail', {
      'es.config.ts': config('{}'),
      'evals/d.es.ts': `import { evaluate } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
evaluate('broken', { sandbox: docker({ install: ['echo one', 'exit 9', 'echo never'] }) }, async (t) => {
  await t.send('x')
})
`,
    })
    const r = await runCli(p.dir, ['run'], slow)
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(
      r.stdout + r.stderr,
      /Building the install layer \(3 commands\) failed: install 2\/3 exited 9: exit 9/,
    )
    assert.match(
      r.stdout + r.stderr,
      /full log: .+\.es\/cache\/images\/evalsuite-install-[0-9a-f]{16}\.log/,
    )
  })

  test('concurrent attempts in two workers share one build of a new layer', docker, async () => {
    const nonce = `${Date.now()}-${process.pid}`
    const env = `import { docker } from 'evalsuite/sandbox'
export const fresh = docker({
  install: ['echo ${nonce} > /opt/es-nonce && date +%s%N > /opt/es-built'],
})
`
    const file = (name: string) => `import { evaluate } from 'evalsuite'
import { fresh } from './env.ts'
evaluate('${name}', { sandbox: fresh, runs: 2 }, async (t) => {
  await t.send('x')
  await t.exec('cat /opt/es-built')
})
`
    const p = await project('docker-dedupe', {
      'es.config.ts': config('{}'),
      'evals/env.ts': env,
      'evals/a.es.ts': file('a'),
      'evals/b.es.ts': file('b'),
    })
    // BuildKit merges identical builds that overlap, so count ES's `docker build` calls instead.
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

  test('dockerfile: FROM the ES_BASE arg inherits the harness; another base gets it baked on; es image build builds them', {
    ...docker,
    timeout: 900_000,
  }, async () => {
    const nonce = `${Date.now()}-${process.pid}`
    const p = await project('docker-dockerfile', {
      'es.config.ts': config('{}'),
      'evals/tools/Dockerfile': `ARG ES_BASE\nFROM \${ES_BASE}\nCOPY greeting.txt /opt/greeting.txt\nRUN echo ${nonce} > /opt/nonce\n`,
      'evals/tools/greeting.txt': 'hello\n',
      'evals/tools/.dockerignore': 'scratch\n',
      'evals/deb.Dockerfile': `FROM debian:bookworm-slim\nRUN echo ${nonce} > /opt/deb\n`,
      'evals/d.es.ts': `import { evaluate, expect } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
evaluate('tools', { sandbox: docker({ dockerfile: './tools/Dockerfile' }) }, async (t) => {
  await t.send('x')
  const greeting = (await t.exec('cat /opt/greeting.txt')).stdout
  expect(greeting).toMatch(/^(hello|bonjour)\\n$/)
  expect((await t.exec('cat /opt/nonce')).stdout).toBe('${nonce}\\n')
  expect((await t.exec('pwd')).stdout).toBe('/es/workspace\\n')
})
evaluate('deb', { sandbox: docker({ dockerfile: './deb.Dockerfile' }) }, async (t) => {
  await t.send('x')
  expect((await t.exec('cat /opt/deb')).stdout).toBe('${nonce}\\n')
  expect((await t.exec('grep -c bookworm /etc/os-release')).exitCode).toBe(0)
  expect((await t.exec('node --version && git --version')).exitCode).toBe(0)
})
`,
    })
    const refs = new Set<string>()
    try {
      // Only the deb eval, so ES's own image (a FROM \${ES_BASE} Dockerfile needs it) isn't rebuilt.
      const planned = await runCli(p.dir, ['image', 'build', '--dry-run', 'deb'])
      assert.equal(planned.code, 0, planned.stdout + planned.stderr)
      assert.match(planned.stdout, /^images {2}1 sandbox image/m)
      const build = await runCli(p.dir, ['image', 'build', 'deb'], { timeoutMs: 600_000 })
      assert.equal(build.code, 0, build.stdout + build.stderr)
      const debRef = /^docker:deb\.Dockerfile: (\S+)/m.exec(build.stdout)?.[1] ?? ''
      assert.match(debRef, /^evalsuite-sandbox:cursor-[\d.]+-evalsuite-dockerfile-deb-dockerfile-/)
      refs.add(debRef)

      const first = await runCli(p.dir, ['run'], slow)
      assert.equal(first.code, 0, first.stdout + first.stderr)
      const a = readRun(p.dir)
      const image = (name: string) => a.evals.find((e) => e.name === name)?.image
      const tools = image('tools')
      const deb = image('deb')
      for (const i of [tools, deb]) if (i) refs.add(i.ref)
      assert.match(tools?.ref ?? '', /^evalsuite-dockerfile:tools-[0-9a-f]{16}$/)
      assert.equal(tools?.base, tools?.ref)
      assert.equal(tools?.dockerfile?.path, 'evals/tools/Dockerfile')
      assert.match(tools?.dockerfile?.sha256 ?? '', /^[0-9a-f]{64}$/)
      assert.match(tools?.agentCli ?? '', /\d/, 'the harness label comes from ES_BASE')
      assert.equal(deb?.ref, debRef, 'the run used the image es image build made')
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
      for (const ref of [...refs].filter((r) => r.startsWith('evalsuite-sandbox:'))) {
        execFileSync('docker', ['rmi', '-f', `${ref}-base`], { stdio: 'ignore' })
      }
      execFileSync(
        'sh',
        ['-c', `docker images -q 'evalsuite-dockerfile:deb-dockerfile-*' | xargs -r docker rmi -f`],
        { stdio: 'ignore' },
      )
    }
  })

  test("dockerfile + claudeCode(): ES_BASE is Claude Code's image; another base gets the claude CLI baked on", {
    ...claudeImage,
    timeout: 900_000,
  }, async () => {
    const nonce = `${Date.now()}-${process.pid}`
    const p = await project('docker-dockerfile-claude', {
      'es.config.ts': `
import { defineConfig } from 'evalsuite'
import { claudeCode } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
export default defineConfig({ harness: claudeCode({ model: 'claude-sonnet-5' }), sandbox: docker() })
`,
      'evals/tools/Dockerfile': `ARG ES_BASE\nFROM \${ES_BASE}\nRUN echo ${nonce} > /opt/nonce\n`,
      'evals/deb.Dockerfile': `FROM debian:bookworm-slim\nRUN echo ${nonce} > /opt/deb\n`,
      'evals/d.es.ts': `import { evaluate } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
evaluate('tools', { sandbox: docker({ dockerfile: './tools/Dockerfile' }) }, async () => {})
evaluate('deb', { sandbox: docker({ dockerfile: './deb.Dockerfile' }) }, async () => {})
`,
    })
    const refs = new Set<string>()
    const claudeCli = (ref: string) =>
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
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
      // No credentials: es image build never starts an agent.
      const build = await runCli(p.dir, ['image', 'build', 'tools', 'deb'], {
        timeoutMs: 800_000,
        env: { ANTHROPIC_API_KEY: '' },
      })
      assert.equal(build.code, 0, build.stdout + build.stderr)
      const toolsRef = /^docker:tools · claude-code: (\S+)/m.exec(build.stdout)?.[1] ?? ''
      const debRef = /^docker:deb\.Dockerfile · claude-code: (\S+)/m.exec(build.stdout)?.[1] ?? ''
      refs.add(toolsRef)
      refs.add(debRef)
      assert.match(toolsRef, /^evalsuite-dockerfile:tools-[0-9a-f]{16}$/, build.stdout)
      assert.match(
        debRef,
        /^evalsuite-sandbox:claude-code-[\d.]+-evalsuite-dockerfile-deb-dockerfile-/,
        build.stdout,
      )
      const claudeLabel = `${HARNESS_PACKAGES['claude-code'].name}@${HARNESS_PACKAGES['claude-code'].version}`
      for (const ref of [toolsRef, debRef]) {
        assert.equal(label(ref), claudeLabel, ref)
        assert.match(claudeCli(ref), /\/claude$/, ref)
      }
    } finally {
      for (const ref of refs) execFileSync('docker', ['rmi', '-f', ref], { stdio: 'ignore' })
      for (const ref of [...refs].filter((r) => r.startsWith('evalsuite-sandbox:'))) {
        execFileSync('docker', ['rmi', '-f', `${ref}-base`], { stdio: 'ignore' })
      }
      execFileSync(
        'sh',
        ['-c', `docker images -q 'evalsuite-dockerfile:deb-dockerfile-*' | xargs -r docker rmi -f`],
        { stdio: 'ignore' },
      )
    }
  })

  test('a timeout removes the container', docker, async () => {
    const p = await project('docker-timeout', {
      'es.config.ts': config('{ delayMs: 60_000 }'),
      'evals/d.es.ts': `import { evaluate } from 'evalsuite'
evaluate('slow', { timeout: '3s' }, async (t) => { await t.send('wait') })
`,
    })
    const r = await runCli(p.dir, ['run'], slow)
    assert.equal(r.code, 1)
    const { run, evals } = readRun(p.dir)
    assert.equal(evals[0]?.error?.kind, 'timeout')
    assert.equal(liveContainers(run.runId), '')
  })

  test(
    'Cursor attempts broker the key; without brokering the attempt fails closed',
    docker,
    async () => {
      const cursorConfig = (sandbox: string) => `
import { defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
export default defineConfig({ harness: cursor(), sandbox: ${sandbox}, timeout: '60s' })
`
      const eval_ = `import { evaluate } from 'evalsuite'
evaluate('hi', async (t) => { await t.send('hi') })
`
      const warning = /CURSOR_API_KEY is passed into the sandbox container/
      // A made-up key: the sandbox and the gateway start, then the Cursor API refuses the key.
      const env = { CURSOR_API_KEY: 'crsr_not_a_real_key_0000000000000000' }
      const brokered = await project('docker-brokered', {
        'es.config.ts': cursorConfig('docker()'),
        'evals/d.es.ts': eval_,
      })
      const a = await runCli(brokered.dir, ['run'], { env })
      assert.doesNotMatch(a.stdout + a.stderr, warning)
      assert.equal(liveContainers(readRun(brokered.dir).run.runId), '')

      try {
        execFileSync('docker', ['pull', '-q', 'busybox:1.37'], { stdio: 'ignore' })
      } catch {
        return
      }
      // No node in the image, so the gateway can't start: by default that's an infra error, and
      // the key never enters the container.
      const refused = await project('docker-no-broker', {
        'es.config.ts': cursorConfig("docker({ image: 'busybox:1.37' })"),
        'evals/d.es.ts': eval_,
      })
      const b = await runCli(refused.dir, ['run'], { env })
      assert.equal(b.code, 3, b.stdout + b.stderr)
      assert.doesNotMatch(b.stdout + b.stderr, warning)
      const refusedRun = readRun(refused.dir)
      assert.equal(refusedRun.evals[0]?.error?.kind, 'infra')
      assert.match(
        refusedRun.evals[0]?.error?.message ?? '',
        /^Can't keep CURSOR_API_KEY out of the sandbox: credential brokering could not start \(the forwarder exited \(\d+\)[^)]*\)\. The egress gateway needs Node in the image: start from a Debian or Ubuntu image with docker\(\{ from: 'busybox:1\.37' \}\) or docker\(\{ dockerfile \}\), and ES adds it\.$/,
      )
      assert.equal(liveContainers(refusedRun.run.runId), '')

      // There's no opt-in to pass the real key: the option doesn't exist.
      const optIn = await project('docker-no-opt-in', {
        'es.config.ts': cursorConfig(
          "docker({ image: 'busybox:1.37', credentials: 'allow-real-key' } as never)",
        ),
        'evals/d.es.ts': eval_,
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
      const value = 'es-docker-user-secret-5e4d3c2b1a'
      const p = await project('docker-secret-no-broker', {
        'es.config.ts': config('{}').replace('docker()', "docker({ image: 'busybox:1.37' })"),
        'evals/d.es.ts': `import { defineEnvironment, evaluate } from 'evalsuite'
const keys = defineEnvironment('keys', ({ secret }) => ({
  env: { GEMINI_API_KEY: secret.fromEnv('ES_DOCKER_SECRET', { hosts: secret.hosts.gemini }) },
}))
evaluate('hi', { environment: keys }, async (t) => { await t.sandbox() })
`,
      })
      const r = await runCli(p.dir, ['run'], { env: { ES_DOCKER_SECRET: value } })
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
    'Claude Code attempts broker the key on its endpoints; without brokering the attempt fails closed',
    claudeImage,
    async () => {
      const claudeConfig = (sandbox: string) => `
import { defineConfig } from 'evalsuite'
import { claudeCode } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
export default defineConfig({
  harness: claudeCode({ model: 'claude-sonnet-5' }),
  sandbox: ${sandbox},
  timeout: '90s',
})
`
      const eval_ = `import { evaluate, expect } from 'evalsuite'
evaluate('hi', async (t) => {
  const turn = await t.send('Reply with the word hi.')
  expect(turn.transcript.some((e) => e.type === 'error' && /401/.test(e.message ?? ''))).toBe(true)
  const environ = await t.exec('env; cat /proc/[0-9]*/environ | tr "\\\\0" "\\\\n"')
  expect(environ.stdout).toMatch(/^ANTHROPIC_API_KEY=aisdkhc_[\\w-]{43}$/m)
  expect(environ.stdout).not.toContain('not_a_real_key')
})
`
      // A made-up key, and a host AI Gateway key the adapter must ignore: the sandbox, the
      // gateway and the CLI start, the gateway swaps the key in, and Anthropic refuses it (401).
      const env = {
        ANTHROPIC_API_KEY: 'sk-ant-not_a_real_key_000000000000000000',
        AI_GATEWAY_API_KEY: 'gw-not-used',
        ES_DEBUG: '1',
      }
      const brokered = await project('docker-claude-brokered', {
        'es.config.ts': claudeConfig('docker()'),
        'evals/d.es.ts': eval_,
      })
      const started = Date.now()
      const a = await runCli(brokered.dir, ['run', '--ui', 'plain'], { env, timeoutMs: 240_000 })
      const out = a.stdout + a.stderr
      assert.equal(a.code, 0, out)
      assert.ok(Date.now() - started < 200_000, 'a refused key ends the turn; nothing hangs')
      assert.match(
        out,
        /es:egress POST https:\/\/api\.anthropic\.com\/v1\/messages HTTP\/[\d.]+ \(set x-api-key\)/,
      )
      // The twin of the check below: the same search finds the gateway's lines.
      assert.match(out, /es:egress /)
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
        'es.config.ts': claudeConfig("docker({ image: 'busybox:1.37' })"),
        'evals/d.es.ts': eval_,
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
