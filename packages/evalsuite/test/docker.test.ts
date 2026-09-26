import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { DEFAULT_IMAGE, HARNESS_PACKAGES, imageFor, LABEL } from '@evalsuite/sandbox-docker'
import { pkgRoot, project, readRun, runCli, tempDir } from './helpers.ts'

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
    // This repo's own adapters are bundled into dist, so they're pinned as dev dependencies.
    if (name.startsWith('@evalsuite/')) {
      assert.equal(pkg.devDependencies[name], `workspace:${version}`, name)
    } else assert.equal(pkg.dependencies[name], version, name)
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
const gooseImageBuilt = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', imageFor('goose')], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const gooseImage = {
  skip: !gooseImageBuilt && !requireDocker && `needs Docker and ${imageFor('goose')}`,
  timeout: 300_000,
}
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

  test('from: a toolchain image gets Node, git and the harness baked on, runs the attempt, and is cached', {
    ...docker,
    timeout: 900_000,
  }, async () => {
    const p = await project('docker-from', {
      'es.config.ts': config(
        `{ script: [[{ exec: 'node -e "process.stdout.write(process.version)"' }]] }`,
      ),
      'evals/f.es.ts': `import { evaluate, expect } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
const bookworm = docker({ from: 'debian:bookworm-slim' })
evaluate('bakes', { sandbox: bookworm }, async (t) => {
  const turn = await t.send('x')
  const shell = turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
  expect(shell.join('')).toMatch(/^v22\\./)
  expect((await t.exec('grep -c bookworm /etc/os-release')).exitCode).toBe(0)
  expect((await t.exec('git --version && curl --version && pnpm --version')).exitCode).toBe(0)
  expect((await t.exec('pwd')).stdout).toBe('/es/workspace\\n')
})
evaluate('canary', { sandbox: bookworm }, async (t) => {
  await t.sandbox()
  expect((await t.exec('grep -c trixie /etc/os-release')).stdout).toBe('1\\n')
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
      assert.match(ref, /^evalsuite-sandbox:cursor-[\d.]+-debian-bookworm-slim-[0-9a-f]{8}$/)
      assert.equal(image?.base, ref)
      assert.equal(image?.dockerfile, null)
      assert.match(image?.agentCli ?? '', /\d/, 'the harness is baked on')
      assert.deepEqual(
        byName.bakes?.cells.map((c) => c.key),
        ['fake/-/docker:debian:bookworm-slim'],
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
    'SIGTERM to the process group mid-turn exits 130 and leaves no container',
    docker,
    async () => {
      const p = await project('docker-sigterm', {
        'es.config.ts': config('{ delayMs: 60_000 }'),
        'evals/d.es.ts': `import { evaluate } from 'evalsuite'
evaluate('slow', { runs: 2 }, async (t) => { await t.send('wait') })
`,
      })
      let started = 0
      const r = await runCli(p.dir, ['run'], {
        ...slow,
        onOutput: (stdout, pid) => {
          started = stdout.match(/\] {2}\+\d+:\d\d turn 1 started$/gm)?.length ?? 0
          if (started < 2) return false
          process.kill(-pid, 'SIGTERM')
          return true
        },
      })
      assert.equal(r.code, 130, r.stdout + r.stderr)
      const runId = readdirSync(join(p.dir, '.es/runs'))
        .find((f) => f.endsWith('.json'))
        ?.replace(/\.json$/, '')
      assert.ok(runId, 'the run was written')
      assert.equal(liveContainers(runId), '')
      // The canary: both attempts had a container when the signal came.
      assert.equal(started, 2)
    },
  )

  test(
    'Cursor attempts broker the key; without brokering the attempt fails closed',
    docker,
    async () => {
      const cursorConfig = (sandbox: string) => `
import { defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
export default defineConfig({ harness: cursor({ model: 'composer-2.5' }), sandbox: ${sandbox}, timeout: '60s' })
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
    "two runs with the same agent context are comparable; a changed skill isn't",
    docker,
    async () => {
      const p = await project('docker-context', {
        'es.config.ts': config(`{ script: [[{ reply: 'done' }]] }`),
        'evals/d.es.ts': `import { defineEnvironment, evaluate } from 'evalsuite'
const house = defineEnvironment('house', ({ skill }) => ({
  skills: [skill.inline({ name: 'house', description: 'House style', content: process.env.ES_TEST_SKILL ?? 'v1' })],
}))
evaluate('context', { environment: house }, async (t) => { await t.send('go') })
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
      const third = await run({ ES_TEST_SKILL: 'v2' })
      const [row] = await compareRows(second.runId, third.runId)
      assert.equal(row?.status, 'drift')
      assert.ok(row?.changes?.includes('agent context changed'), JSON.stringify(row))
    },
  )

  test("npm installs the packed ES tarball in ES's image", {
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
      'es.config.ts': config('{}'),
      'evals/d.es.ts': `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const es = defineEnvironment('es-tarball', ({ file }) => ({
  files: { 'es.tgz': file(${JSON.stringify(join(out, tarball))}) },
}))
evaluate('installs', { environment: es, timeout: '6m' }, async (t) => {
  await t.sandbox()
  await expect(t.exec('npm install --no-audit --no-fund ./es.tgz')).toSucceed()
  expect((await t.exec('npx --no-install es --version')).stdout.trim()).toBe('${version}')
})
`,
    })
    const r = await runCli(p.dir, ['run'], { timeoutMs: 450_000 })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(liveContainers(readRun(p.dir).run.runId), '')
  })

  test(
    "-v summarises a harness's expected blocked hosts once, and -vv still lists each request",
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
        'es.config.ts': `import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
export default defineConfig({
  harness: fakeHarness({ layout: 'antigravity', script: [[{ exec: ${JSON.stringify(curl)} }]] }),
  sandbox: docker(),
  egress: 'deny-all',
})
`,
        'evals/d.es.ts': `import { evaluate } from 'evalsuite'
evaluate('calls home', async (t) => {
  await t.send('call home')
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
      const TOKEN = 'es-docker-verbose-token-5b8e2c'
      const curl = [
        'curl -s -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $API_KEY" https://example.com/',
        'curl -s -o /dev/null -w "%{http_code}" http://blocked.invalid/',
      ].join('; ')
      const p = await project('docker-verbose', {
        'es.config.ts': `import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
import { fakeJudge } from 'evalsuite/judge'
export default defineConfig(({ secret }) => ({
  harness: fakeHarness({ script: [[{ exec: ${JSON.stringify(curl)} }]] }),
  sandbox: docker(),
  egress: { allow: ['example.com'] },
  env: { API_KEY: secret.fromEnv('ES_DOCKER_TOKEN', { hosts: ['example.com'] }) },
  judge: { model: fakeJudge() },
}))
`,
        'evals/d.es.ts': `import { evaluate, expect } from 'evalsuite'
evaluate('calls out', async (t) => {
  await t.send('call the api')
  await expect(t.exec('true')).toSucceed()
})
`,
      })
      const env = { ES_DOCKER_TOKEN: TOKEN }
      const v = await runCli(p.dir, ['run', '-v'], { env, ...slow })
      assert.equal(v.code, 0, v.stdout + v.stderr)
      const line = (phase: string, text: string) =>
        new RegExp(`^\\[calls#1 fake\\]\\s+\\d{2}:\\d{2}:\\d{2} ${phase.padEnd(9)} ${text}`, 'm')
      for (const [phase, text] of [
        ['image', `cache hit ${DEFAULT_IMAGE.replace(/[.:]/g, '\\$&')} `],
        ['image', 'ready \\S+ \\([0-9a-f]{12}\\) in '],
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
      const debugDir = join(p.dir, '.es/debug', run.runId)
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
        'docker {4}\\$ docker exec --interactive [0-9a-f]{64} node -e ',
        'docker {4}\\$ docker rm -f [0-9a-f]{64} → exit 0',
        'gateway {3}dns example\\.com → ',
        'gateway {3}dns blocked\\.invalid refused: ',
        'gateway {3}headers https://example\\.com/$',
      ]) {
        assert.match(vv.stdout, traced(text), text)
      }
      // The headers are as the sandbox sent them: the placeholder, never the key.
      assert.match(vv.stdout, /"authorization":"Bearer es_secret_[0-9A-Za-z]{32}"/)
      const everything = vv.stdout + vv.stderr + v.stdout + v.stderr
      assert.equal(everything.includes(TOKEN), false, 'the key never prints')
      const leaked = spawnSync('grep', ['-rlF', TOKEN, join(p.dir, '.es')], { encoding: 'utf8' })
      assert.equal(leaked.stdout.trim(), '', 'no file under .es has the key')
      assert.equal(leaked.status, 1, leaked.stderr)
    },
  )

  test(
    'Goose gets the key on the model list it fetches each turn, and nothing is refused',
    gooseImage,
    async () => {
      const p = await project('docker-goose-endpoints', {
        'es.config.ts': `import { defineConfig } from 'evalsuite'
import { goose } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
export default defineConfig({ harness: goose({ model: 'gemini-3.8-flash' }), sandbox: docker(), timeout: '90s' })
`,
        'evals/d.es.ts': `import { evaluate } from 'evalsuite'
evaluate('hi', async (t) => { await t.send('Reply with the word hi.') })
`,
      })
      // A made-up key: Goose lists the models, then Gemini refuses the key on the model call.
      const env = {
        GOOGLE_GENERATIVE_AI_API_KEY: 'AIzaSy-not_a_real_key_0000000000000000',
        ES_DEBUG: '1',
      }
      const r = await runCli(p.dir, ['run', '--ui', 'plain'], { env, timeoutMs: 240_000 })
      const out = r.stdout + r.stderr
      assert.match(
        out,
        /es:egress GET https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models HTTP\/[\d.]+ \(set x-goog-api-key\)/,
      )
      // The twin: the model call is brokered the same way, so the search can see a brokered line.
      assert.match(
        out,
        /es:egress POST \S+:streamGenerateContent HTTP\/[\d.]+ \(set x-goog-api-key\)/,
      )
      assert.doesNotMatch(out, /refused/)
      assert.equal(liveContainers(readRun(p.dir).run.runId), '')
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
  // The failed call is one error event, not the stream's and the thrown error's both.
  expect(turn.transcript.filter((e) => e.type === 'error')).toHaveLength(1)
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
      assert.match(out, /turn 1 error: The API rejected ANTHROPIC_API_KEY: set a valid key/)
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
