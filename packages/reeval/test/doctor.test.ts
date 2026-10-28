// `reeval doctor`: every check passing and failing on a machine the tests describe (DoctorDeps), then
// the command end to end. No key's value appears in any output, text or JSON.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, test } from 'node:test'
import { loadConfig } from '../src/config.ts'
import {
  type Check,
  checkAnalysis,
  checkDocker,
  checkEgress,
  checkEnvFiles,
  checkGateways,
  checkGitignore,
  checkImages,
  checkJudge,
  checkKeys,
  checkRuntime,
  checkVertex,
  configuredUses,
  type DoctorDeps,
  defaultDeps,
  dockerReadiness,
  filledSecrets,
  judgeCallers,
  probeKey,
} from '../src/doctor.ts'
import { runtimeInfo } from '../src/history/provenance.ts'
import { dockerProblem, podmanInfoProblem } from '../src/sandbox/providers.ts'
import { fakeConfig, project, runCli } from './helpers.ts'

const SECRET = 'sk-live-doctor-9f8e7d6c5b4a'

const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  env: {},
  runtime: { name: 'node', version: '22.13.0' },
  nodeVersion: '22.13.0',
  platform: 'linux',
  dockerState: async () => 'running',
  dockerCapacity: async () => ({ cpus: 8, memoryBytes: 16 * 1024 ** 3 }),
  imageExists: async () => true,
  // What planning finds when no eval picks a harness: the config's own, on its sandbox.
  plannedUses: async (config) =>
    configuredUses(config)
      .filter((u) => !u.profile)
      .map((u) => ({ id: '', harness: u.harness, sandbox: u.sandbox })),
  imageTags: async () => [],
  podmanConfinement: async () => null,
  gitIgnored: async (_, paths) => paths.map(() => true),
  gitVisibleEnvFiles: async () => [],
  fetch: async () => new Response('{}', { status: 200 }),
  cloudHost: async () => null,
  vertexToken: async () => SECRET,
  ...over,
})

/** A resolved config from `reeval.config.ts` source that imports from `reeval`. */
async function configOf(name: string, body: string) {
  const p = await project(`doctor-${name}`, {
    'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { direct, vercel, vertex } from 'reeval/gateway'
import { antigravity, claudeCode, codex, cursor, fakeHarness, goose, opencode, pi } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { docker, fakeSandbox, podman } from 'reeval/sandbox'
export default defineConfig(${body})
`,
  })
  return loadConfig(join(p.dir, 'reeval.config.ts'))
}

const statuses = (checks: Check[]) => checks.map((c) => c.status)
const noSecret = (checks: Check[]) =>
  assert.doesNotMatch(JSON.stringify(checks), new RegExp(SECRET.slice(8)))

describe('reeval doctor checks', () => {
  test('a run stops on Docker it cannot use, naming the fix for the platform', () => {
    assert.equal(dockerProblem('running'), null)
    assert.equal(
      dockerProblem('down', 'linux'),
      'Docker is not running. Start Docker and try again.',
    )
    assert.match(
      dockerProblem('down', 'win32') ?? '',
      /Docker Desktop \(with the WSL 2 backend and Linux containers\)/,
    )
    assert.match(
      dockerProblem('windows-containers', 'win32') ?? '',
      /running Windows containers, but reeval's sandboxes are Linux containers\. Switch Docker Desktop to Linux containers/,
    )
    assert.match(
      dockerProblem('missing', 'darwin') ?? '',
      /^Docker isn't installed: there's no docker command on the PATH\. Install Docker Desktop \(https:\/\/docs\.docker\.com\/desktop\/setup\/install\/mac-install\/\).*, and try again\.$/,
    )
  })

  test("reeval init's Docker line: ready, or what's wrong, the fix, then the next command", async () => {
    const line = (
      state: 'running' | 'down' | 'missing' | 'windows-containers',
      platform = 'linux',
    ) =>
      dockerReadiness(
        { dockerState: async () => state, platform: platform as NodeJS.Platform },
        'npx reeval image build',
      )
    assert.equal(await line('running'), 'Docker is running: ready for npx reeval image build')
    assert.equal(
      await line('down'),
      "Docker isn't running: start Docker Desktop, or the Docker service (sudo systemctl start docker), then run npx reeval image build",
    )
    assert.match(await line('down', 'darwin'), /^Docker isn't running: start Docker Desktop \(/)
    assert.equal(
      await line('missing'),
      "Docker isn't installed: install Docker Engine (https://docs.docker.com/engine/install/) or Docker Desktop, then run npx reeval image build",
    )
    assert.match(
      await line('windows-containers', 'win32'),
      /^Docker is running Windows containers, .*Switch to Linux containers\), then run npx reeval image build$/,
    )
  })

  test('the runtime, held to engines by its Node version', () => {
    const node = (version: string) => checkRuntime({ name: 'node', version }, version)
    assert.deepEqual(node('22.13.0'), {
      id: 'runtime',
      status: 'ok',
      summary: 'node 22.13.0 (reeval needs Node >=22.13)',
    })
    assert.equal(node('24.1.0').status, 'ok')
    const old = node('22.12.9')
    assert.equal(old.status, 'fail')
    assert.equal(old.summary, 'node 22.12.9, but reeval needs Node >=22.13')
    assert.equal(old.fix, 'install Node 22.13 or later (https://nodejs.org)')
    assert.equal(node('20.19.0').status, 'fail')

    const bun = checkRuntime({ name: 'bun', version: '1.4.2' }, '26.3.0')
    assert.equal(bun.status, 'ok')
    assert.equal(bun.summary, 'bun 1.4.2, compatible with node 26.3.0 (reeval needs Node >=22.13)')
    const oldBun = checkRuntime({ name: 'bun', version: '1.0.0' }, '20.8.0')
    assert.equal(oldBun.status, 'fail')
    assert.equal(
      oldBun.summary,
      'bun 1.0.0, compatible with node 20.8.0, but reeval needs Node >=22.13',
    )
    assert.equal(oldBun.fix, 'upgrade bun, or install Node 22.13 or later (https://nodejs.org)')
  })

  test('the runtime is told apart from the Node version Bun and Deno report', () => {
    assert.deepEqual(runtimeInfo({ node: '22.14.0' }), { name: 'node', version: '22.14.0' })
    assert.deepEqual(runtimeInfo({ node: '26.3.0', bun: '1.4.2' }), {
      name: 'bun',
      version: '1.4.2',
    })
    assert.deepEqual(runtimeInfo({ node: '22.0.0', deno: '2.5.0' }), {
      name: 'deno',
      version: '2.5.0',
    })
    assert.deepEqual(runtimeInfo(), { name: 'node', version: process.versions.node })
  })

  test('docker: skipped without a Docker sandbox, fails when down, warns on little memory', async () => {
    const fake = await configOf(
      'fake',
      `{ harness: fakeHarness(), environment: defineEnvironment('fake', { sandbox: fakeSandbox() }) }`,
    )
    const down = async () => 'down' as const
    assert.deepEqual(statuses((await checkDocker(fake, deps({ dockerState: down }))).checks), [
      'skip',
    ])
    const real = await configOf('docker', "{ harness: cursor({ model: 'composer-2.5' }) }")
    const ok = await checkDocker(real, deps())
    assert.equal(ok.running, true)
    assert.match(ok.checks[0]?.summary ?? '', /running · 8 CPUs, 16\.0 GB memory/)
    const off = await checkDocker(real, deps({ dockerState: down }))
    assert.equal(off.running, false)
    assert.equal(off.checks[0]?.status, 'fail')
    assert.match(off.checks[0]?.fix ?? '', /start Docker/)
    const absent = await checkDocker(real, deps({ dockerState: async () => 'missing' }))
    assert.equal(absent.running, false)
    assert.match(absent.checks[0]?.summary ?? '', /^isn't installed \(no docker command/)
    assert.match(absent.checks[0]?.fix ?? '', /^install Docker Engine/)
    const small = await checkDocker(
      real,
      deps({ dockerCapacity: async () => ({ cpus: 2, memoryBytes: 2 * 1024 ** 3 }) }),
    )
    assert.equal(small.checks[0]?.status, 'warn')
    // Windows needs Docker Desktop on WSL 2, running Linux containers: the fixes say so.
    const winOff = await checkDocker(real, deps({ dockerState: down, platform: 'win32' }))
    assert.equal(winOff.checks[0]?.status, 'fail')
    assert.match(
      winOff.checks[0]?.fix ?? '',
      /Docker Desktop with the WSL 2 backend and Linux containers/,
    )
    const winContainers = await checkDocker(
      real,
      deps({ dockerState: async () => 'windows-containers', platform: 'win32' }),
    )
    assert.equal(winContainers.running, false)
    assert.equal(winContainers.checks[0]?.status, 'fail')
    assert.match(
      winContainers.checks[0]?.summary ?? '',
      /is running Windows containers, but reeval's sandboxes are Linux containers/,
    )
    assert.match(winContainers.checks[0]?.fix ?? '', /Switch to Linux containers/)
    // A profile's Docker sandbox counts too.
    const profiled = await configOf(
      'profile-docker',
      `{ harness: fakeHarness(), environment: defineEnvironment('fake', { sandbox: fakeSandbox() }), profiles: { real: { defaults: { environment: defineEnvironment('real', { sandbox: docker() }) } } } }`,
    )
    assert.equal(
      (await checkDocker(profiled, deps({ dockerState: down }))).checks[0]?.status,
      'fail',
    )
    const defaulted = await configOf(
      'profile-default-sandbox',
      `{ harness: fakeHarness(), sandbox: fakeSandbox(), profiles: { real: { defaults: { sandbox: docker() } } } }`,
    )
    assert.equal(
      (await checkDocker(defaulted, deps({ dockerState: down }))).checks[0]?.status,
      'fail',
      "a profile's defaults.sandbox counts too",
    )
  })

  test('podman: down, too old, missing cgroup controllers, and running beside Docker', async () => {
    assert.match(
      dockerProblem('down', 'linux', 'podman') ?? '',
      /Podman isn't answering: `podman info` failed\. Install Podman 4/,
    )
    assert.match(dockerProblem('down', 'darwin', 'podman') ?? '', /podman machine start/)
    const linux = (version: string, rootless: boolean, controllers: string[] | null) =>
      podmanInfoProblem({ version, rootless, controllers })
    assert.equal(linux('4.9.3', true, ['cpuset', 'cpu', 'io', 'memory', 'pids']), null)
    assert.match(
      linux('3.4.4', true, ['cpu', 'memory', 'pids'])?.problem ?? '',
      /Podman 3\.4\.4 is too old/,
    )
    const delegated = linux('5.4.0', true, ['memory', 'pids'])
    assert.equal(
      delegated?.problem,
      "rootless Podman can't limit a sandbox's cpu: your user's cgroup doesn't have the cpu controller",
    )
    assert.match(delegated?.fix ?? '', /Delegate=cpu cpuset io memory pids/)
    assert.equal(linux('5.4.0', false, ['memory']), null, 'rootful Podman has every controller')

    const config = await configOf(
      'podman',
      `{ harness: cursor({ model: 'composer-2.5' }), environment: defineEnvironment('p', { sandbox: podman() }) }`,
    )
    const ok = await checkDocker(config, deps())
    assert.deepEqual(
      ok.checks.map((c) => [c.id, c.status]),
      [['podman', 'ok']],
    )
    assert.match(ok.checks[0]?.summary ?? '', /^running · 8 CPUs/)
    const down = await checkDocker(
      config,
      deps({ dockerState: async (engine) => (engine === 'podman' ? 'down' : 'running') }),
    )
    assert.equal(down.running, false)
    assert.match(down.checks[0]?.summary ?? '', /config's podman\(\) sandboxes need it/)
    const confined = await checkDocker(
      config,
      deps({ podmanConfinement: async () => ({ problem: 'no cpu', fix: 'delegate it' }) }),
    )
    assert.deepEqual(confined.checks[0], {
      id: 'podman',
      status: 'fail',
      summary: 'no cpu',
      fix: 'delegate it',
    })

    const both = await configOf(
      'podman-and-docker',
      `{ harness: cursor({ model: 'composer-2.5' }), environment: defineEnvironment('p', { sandbox: podman() }), profiles: { d: { defaults: { environment: defineEnvironment('d', { sandbox: docker() }) } } } }`,
    )
    assert.deepEqual(
      (await checkDocker(both, deps())).checks.map((c) => c.id),
      ['docker', 'podman'],
    )
    const images = await checkImages(config, deps({ imageExists: async () => false }))
    assert.match(images.checks[0]?.summary ?? '', /in Podman/)
  })

  test('images: present, missing (with the build fix), and left from another version', async () => {
    const config = await configOf(
      'images',
      "{ harness: [cursor({ model: 'composer-2.5' }), claudeCode({ model: 'claude-sonnet-5' })] }",
    )
    const present = await checkImages(config, deps())
    assert.deepEqual(statuses(present.checks), ['ok', 'ok'])
    assert.deepEqual(present.missing, [])
    const missing = await checkImages(
      config,
      deps({ imageExists: async (ref) => !ref.includes('claude-code') }),
    )
    assert.deepEqual(statuses(missing.checks), ['ok', 'fail'])
    assert.equal(missing.checks[1]?.fix, 'reeval image build')
    assert.equal(missing.missing.length, 1)
    const [current] = present.checks[0]?.summary.split(' ') ?? []
    const stale = await checkImages(
      config,
      deps({
        imageTags: async () => [
          current as string,
          'reeval-sandbox:cursor-0.0.1',
          `${current}-python-3-12-slim-1d044754`,
        ],
      }),
    )
    const warn = stale.checks.find((c) => c.status === 'warn')
    assert.match(warn?.summary ?? '', /^reeval-sandbox:cursor-0\.0\.1: built by another reeval/)
    assert.equal(warn?.fix, 'docker image rm reeval-sandbox:cursor-0.0.1')

    const own = await configOf(
      'own-image',
      "{ harness: cursor({ model: 'composer-2.5' }), environment: defineEnvironment('own', { sandbox: docker({ image: 'mine:1' }) }) }",
    )
    const ownMissing = await checkImages(own, deps({ imageExists: async () => false }))
    assert.deepEqual(statuses(ownMissing.checks), ['fail'])
    assert.match(ownMissing.checks[0]?.fix ?? '', /docker pull mine:1/)
  })

  test("images: Docker that can't answer is a failed check naming its error, not a missing image", async () => {
    const config = await configOf(
      'images-unanswered',
      "{ harness: cursor({ model: 'composer-2.5' }) }",
    )
    const result = await checkImages(
      config,
      deps({
        imageExists: async (ref) => {
          throw new Error(`docker image inspect ${ref} failed: Cannot connect to the Docker daemon`)
        },
      }),
    )
    assert.deepEqual(statuses(result.checks), ['fail'])
    assert.match(
      result.checks[0]?.summary ?? '',
      /^reeval-sandbox:cursor-\S+ \(cursor\) couldn't be checked: docker image inspect .* Cannot connect/,
    )
    assert.doesNotMatch(result.checks[0]?.summary ?? '', /isn't built/)
    assert.deepEqual(result.missing, [], 'nothing to offer to build')
  })

  test('images: the ones reeval image build plans, so a profile-only harness lists no default cursor', async () => {
    // The config names only claudeCode, in its default profile: cursor is reeval's default harness,
    // which no eval runs.
    const p = await project('doctor-planned-images', {
      'reeval.config.ts': `import { defineConfig } from 'reeval'
import { claudeCode } from 'reeval/harness'
export default defineConfig({
  profiles: { dev: { defaults: { harness: claudeCode({ model: 'claude-sonnet-5' }) } } },
  defaultProfile: { local: 'dev', ci: 'dev' },
})
`,
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
evaluate('a', async () => {})
`,
    })
    const config = await loadConfig(join(p.dir, 'reeval.config.ts'))
    const planned = await checkImages(config, deps({ plannedUses: defaultDeps().plannedUses }))
    const refs = planned.checks.map((c) => c.summary.split(' ')[0])
    assert.equal(refs.length, 1, JSON.stringify(planned.checks))
    assert.match(refs[0] ?? '', /^reeval-sandbox:claude-code-/)
    // The config alone (what doctor read before) lists the default cursor image too.
    const fromConfig = await checkImages(config, deps())
    assert.ok(fromConfig.checks.some((c) => c.summary.startsWith('reeval-sandbox:cursor-')))

    const dry = await runCli(p.dir, ['image', 'build', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(dry.stdout, /^images {2}1 sandbox image /m)
    assert.ok(dry.stdout.includes(refs[0] as string), dry.stdout)
  })

  test('keys: the harnesses the evals plan, so a profile-only harness asks for no CURSOR_API_KEY', async () => {
    const config = `import { defineConfig } from 'reeval'
import { claudeCode, codex } from 'reeval/harness'
export default defineConfig({
  profiles: {
    dev: { defaults: { harness: claudeCode({ model: 'claude-sonnet-5' }) } },
    openai: { defaults: { harness: codex({ model: 'gpt-5.4-mini' }) } },
  },
  defaultProfile: { local: 'dev', ci: 'dev' },
})
`
    const p = await project('doctor-planned-keys', {
      'reeval.config.ts': config,
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
evaluate('a', async () => {})
`,
    })
    const loaded = await loadConfig(join(p.dir, 'reeval.config.ts'))
    const keys = await checkKeys(
      loaded,
      deps({ plannedUses: defaultDeps().plannedUses }),
      false,
      '.env.local',
    )
    assert.deepEqual(
      keys.map((c) => `${c.status} ${c.summary}`),
      [
        'fail ANTHROPIC_API_KEY for claude-code:claude-sonnet-5: not set',
        'warn OPENAI_API_KEY for codex:gpt-5.4-mini in profile openai: not set',
      ],
    )

    // Evals that don't load leave the config's harnesses, reeval's default included, and say so.
    const broken = await project('doctor-planned-keys-broken', {
      'reeval.config.ts': config,
      '.gitignore': '.reeval/\n.env*\n',
      'evals/a.eval.ts': `throw new Error('broken eval file')\n`,
    })
    const r = await runCli(broken.dir, ['doctor', '--json'], {
      env: { ANTHROPIC_API_KEY: '', CURSOR_API_KEY: '', OPENAI_API_KEY: '' },
    })
    const report = JSON.parse(r.stdout)
    const evals = report.checks.find((c: Check) => c.id === 'evals')
    assert.equal(evals?.status, 'warn', r.stdout)
    assert.match(
      evals?.summary ?? '',
      /^didn't load, so the images and keys checked are the config's: /,
    )
    assert.ok(
      report.checks.some(
        (c: Check) => c.id === 'key' && c.summary.startsWith('CURSOR_API_KEY for cursor:'),
      ),
      r.stdout,
    )
  })

  test("keys: each harness's, required unless only a profile uses it, never printed", async () => {
    const config = await configOf(
      'keys',
      `{ harness: cursor({ model: 'composer-2.5' }),
         profiles: { alt: { defaults: { harness: pi({ model: 'gemini-3.8-flash' }) } } } }`,
    )
    const none = await checkKeys(config, deps(), false, '.env.local')
    assert.deepEqual(statuses(none), ['fail', 'warn'])
    assert.match(none[0]?.summary ?? '', /^CURSOR_API_KEY for cursor:composer-2\.5: not set$/)
    assert.equal(none[0]?.fix, 'add CURSOR_API_KEY=... to .env.local')
    assert.match(
      none[1]?.summary ?? '',
      /GOOGLE_GENERATIVE_AI_API_KEY for pi:gemini-3\.8-flash in profile alt/,
    )

    const env = { CURSOR_API_KEY: SECRET, GOOGLE_GENERATIVE_AI_API_KEY: SECRET }
    const set = await checkKeys(config, deps({ env }), false, '.env.local')
    assert.deepEqual(statuses(set), ['ok', 'ok'])
    noSecret(set)

    const wrapped = await checkKeys(
      config,
      deps({ env: { ...env, CURSOR_API_KEY: `${SECRET}\n  x` } }),
      false,
      '.env.local',
    )
    assert.equal(wrapped[0]?.status, 'fail')
    assert.match(wrapped[0]?.summary ?? '', /line break in it at character 28/)
    noSecret(wrapped)

    const openai = await configOf('keys-codex', `{ harness: codex({ model: 'gpt-5.4-mini' }) }`)
    const unset = await checkKeys(openai, deps(), false, '.env.local')
    assert.deepEqual(statuses(unset), ['fail'])
    assert.match(unset[0]?.summary ?? '', /^OPENAI_API_KEY for codex:gpt-5\.4-mini: not set$/)
    assert.equal(unset[0]?.fix, 'add OPENAI_API_KEY=... to .env.local')
    const codexSet = await checkKeys(
      openai,
      deps({ env: { OPENAI_API_KEY: SECRET } }),
      false,
      '.env.local',
    )
    assert.deepEqual(statuses(codexSet), ['ok'])
    noSecret(codexSet)

    const fake = await configOf(
      'keys-fake',
      `{ harness: fakeHarness(), environment: defineEnvironment('fake', { sandbox: fakeSandbox() }) }`,
    )
    assert.deepEqual(statuses(await checkKeys(fake, deps(), false, '.env.local')), ['skip'])
  })

  test('--online: accepted, rejected, unanswered; the key goes only in headers', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const answer =
      (status: number | Error): typeof fetch =>
      async (url, init) => {
        seen.push({ url: String(url), headers: init?.headers as Record<string, string> })
        if (status instanceof Error) throw status
        return new Response('{}', { status })
      }
    assert.deepEqual(await probeKey('ANTHROPIC_API_KEY', SECRET, answer(200)), {
      status: 'ok',
      summary: 'set, and api.anthropic.com accepts it',
    })
    assert.equal((await probeKey('CURSOR_API_KEY', SECRET, answer(401))).status, 'fail')
    assert.equal((await probeKey('GEMINI_API_KEY', SECRET, answer(503))).status, 'warn')
    const offline = await probeKey(
      'GOOGLE_GENERATIVE_AI_API_KEY',
      SECRET,
      answer(new Error('ENOTFOUND')),
    )
    assert.equal(offline.status, 'warn')
    assert.match(
      offline.summary,
      /couldn't reach generativelanguage\.googleapis\.com \(ENOTFOUND\)/,
    )
    assert.equal((await probeKey('TYPESAFE_AI_API_KEY', SECRET, answer(500))).status, 'ok')
    const openai = await probeKey('OPENAI_API_KEY', SECRET, answer(401))
    assert.deepEqual(openai, {
      status: 'fail',
      summary: 'set, but api.openai.com rejects it (HTTP 401)',
    })
    assert.ok(!JSON.stringify(openai).includes(SECRET))
    const openaiCall = seen.at(-1)
    assert.equal(openaiCall?.url, 'https://api.openai.com/v1/models')
    assert.equal(openaiCall?.headers.authorization, `Bearer ${SECRET}`)
    for (const { url } of seen) assert.ok(!url.includes(SECRET), url)
    assert.equal(seen[0]?.headers['x-api-key'], SECRET)
    assert.equal(
      seen[1]?.headers.authorization,
      `Basic ${Buffer.from(`${SECRET}:`).toString('base64')}`,
    )

    const config = await configOf('online', "{ harness: cursor({ model: 'composer-2.5' }) }")
    const rejected = await checkKeys(
      config,
      deps({ env: { CURSOR_API_KEY: SECRET }, fetch: answer(403) }),
      true,
      '.env.local',
    )
    assert.equal(rejected[0]?.status, 'fail')
    assert.equal(rejected[0]?.fix, 'set a valid CURSOR_API_KEY in .env.local')
    noSecret(rejected)
  })

  test("judge: none, a fake one, and a model's key", async () => {
    const none = await configOf(
      'judge-none',
      `{ harness: fakeHarness(), environment: defineEnvironment('fake', { sandbox: fakeSandbox() }) }`,
    )
    // No eval calls c.judge, so there's no line at all.
    assert.deepEqual(await checkJudge(none, deps(), false, '.env.local'), [])
    await mkdir(join(none.root, 'evals/support'), { recursive: true })
    await writeFile(join(none.root, 'evals/plain.eval.ts'), "evaluate('a', async () => {})\n")
    await writeFile(
      join(none.root, 'evals/graded.eval.ts'),
      "import { grade } from './support/grade.ts'\nevaluate('b', grade)\n",
    )
    await writeFile(
      join(none.root, 'evals/support/grade.ts'),
      "export const grade = async (c) => { await c.judge('ok?', { diff: true }) }\n",
    )
    assert.deepEqual(await judgeCallers(none), ['evals/graded.eval.ts'])
    const unset = await checkJudge(none, deps(), false, '.env.local')
    assert.deepEqual(statuses(unset), ['warn'])
    assert.equal(unset[0]?.summary, 'no judge model, and evals/graded.eval.ts calls c.judge')
    const fake = await configOf(
      'judge-fake',
      `{ harness: fakeHarness(), environment: defineEnvironment('fake', { sandbox: fakeSandbox() }), judge: { model: fakeJudge({ score: 1 }) } }`,
    )
    assert.deepEqual(statuses(await checkJudge(fake, deps(), false, '.env.local')), ['ok'])
    const google = await configOf(
      'judge-google',
      "{ harness: fakeHarness(), environment: defineEnvironment('fake', { sandbox: fakeSandbox() }), judge: { model: 'google/gemini-3.8-flash' } }",
    )
    const missing = await checkJudge(google, deps(), false, '.env.local')
    assert.equal(missing[0]?.status, 'fail')
    assert.match(
      missing[0]?.summary ?? '',
      /^GOOGLE_GENERATIVE_AI_API_KEY \(for direct\(\)\) for google\/gemini-3\.8-flash: not set$/,
    )
    const gateway = await checkJudge(
      google,
      deps({ env: { AI_GATEWAY_API_KEY: SECRET } }),
      false,
      '.env.local',
    )
    assert.equal(gateway[0]?.status, 'fail', 'no gateway list: the Gateway key never stands in')
    assert.equal(
      gateway[0]?.fix,
      "add GOOGLE_GENERATIVE_AI_API_KEY=... to .env.local, or add vercel() to gateway to use the AI_GATEWAY_API_KEY that's set",
    )
    noSecret(gateway)
    const mistral = await configOf(
      'judge-mistral',
      "{ harness: fakeHarness(), environment: defineEnvironment('fake', { sandbox: fakeSandbox() }), judge: { model: 'mistral/large' } }",
    )
    const unserved = await checkJudge(mistral, deps(), false, '.env.local')
    assert.equal(unserved[0]?.status, 'fail')
    assert.match(
      unserved[0]?.summary ?? '',
      /no gateway in the list can serve it .* Add vercel\(\) to gateway\. There a judge must be a decision model, such as 'typesafe-ai\/jev-1\.14\.0'\.$/,
    )
  })

  test("analysis: analysis.model's key, a warning only; nothing without a model", async () => {
    const none = await configOf('analysis-none', '{ harness: fakeHarness() }')
    assert.deepEqual(await checkAnalysis(none, deps(), false, '.env.local'), [])
    const model = await configOf(
      'analysis-model',
      "{ harness: fakeHarness(), analysis: { model: 'google/gemini-3.8-flash' } }",
    )
    const unset = await checkAnalysis(model, deps(), false, '.env.local')
    assert.deepEqual(statuses(unset), ['warn'])
    assert.match(
      unset[0]?.summary ?? '',
      /^GOOGLE_GENERATIVE_AI_API_KEY \(for direct\(\)\) for google\/gemini-3\.8-flash \(analysis\.model\): not set$/,
    )
    assert.equal(unset[0]?.fix, 'add GOOGLE_GENERATIVE_AI_API_KEY=... to .env.local')
    const set = await checkAnalysis(
      model,
      deps({ env: { GOOGLE_GENERATIVE_AI_API_KEY: SECRET } }),
      false,
      '.env.local',
    )
    assert.deepEqual(statuses(set), ['ok'])
    noSecret(set)
  })

  test("analysis: an anthropic/* or openai/* model takes its own key, never the Gateway's", async () => {
    for (const [model, key] of [
      ['anthropic/claude-sonnet-5', 'ANTHROPIC_API_KEY'],
      ['openai/gpt-6-luna', 'OPENAI_API_KEY'],
    ] as const) {
      const config = await configOf(
        `analysis-${key.toLowerCase()}`,
        `{ harness: fakeHarness(), analysis: { model: '${model}' } }`,
      )
      const direct = await checkAnalysis(
        config,
        deps({ env: { [key]: SECRET } }),
        false,
        '.env.local',
      )
      assert.deepEqual(statuses(direct), ['ok'])
      assert.equal(direct[0]?.summary, `${key} for ${model} (analysis.model): set`)
      const both = await checkAnalysis(
        config,
        deps({ env: { [key]: SECRET, AI_GATEWAY_API_KEY: SECRET } }),
        false,
        '.env.local',
      )
      assert.equal(both[0]?.summary, `${key} for ${model} (analysis.model): set`)
      const unset = await checkAnalysis(
        config,
        deps({ env: { AI_GATEWAY_API_KEY: SECRET } }),
        false,
        '.env.local',
      )
      assert.equal(
        unset[0]?.summary,
        `${key} (for direct()) for ${model} (analysis.model): not set`,
      )
      const bad = await checkAnalysis(
        config,
        deps({ env: { [key]: 'sk\nx' } }),
        false,
        '.env.local',
      )
      assert.equal(bad[0]?.status, 'fail')
      assert.match(bad[0]?.summary ?? '', /whitespace or a line break in it at character 3/)
    }
  })

  test('gateway: where each harness resolves, its keys, and an expired Vercel token', async () => {
    const config = await configOf(
      'gateway-vercel',
      `{ harness: [claudeCode({ model: 'claude-sonnet-4-5' }), cursor({ model: 'composer-2.5' })],
         gateway: [vercel()],
         judge: { model: 'anthropic/claude-haiku-4-5' },
         analysis: { model: 'google/gemini-3.8-flash' },
         profiles: { local: { gateway: [direct()] } } }`,
    )
    const env = { AI_GATEWAY_API_KEY: SECRET, CURSOR_API_KEY: SECRET }
    const keys = await checkKeys(config, deps({ env }), false, '.env.local')
    assert.deepEqual(
      keys.map((c) => c.summary),
      [
        'AI_GATEWAY_API_KEY for claude-code:claude-sonnet-4-5: set',
        'CURSOR_API_KEY for cursor:composer-2.5: set',
      ],
      'Claude Code on Vercel needs no ANTHROPIC_API_KEY',
    )
    const judge = await checkJudge(config, deps({ env: {} }), false, '.env.local')
    assert.match(
      judge[0]?.summary ?? '',
      /^AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN \(for vercel\(\)\)/,
    )
    const analysis = await checkAnalysis(config, deps({ env: {} }), false, '.env.local')
    assert.match(analysis[0]?.summary ?? '', /\(for vercel\(\)\)/)
    assert.deepEqual(
      checkGateways(config, deps({ env }), '.env.local').map((c) => [c.status, c.summary]),
      [
        [
          'ok',
          'gateway vercel, direct: claude-code:claude-sonnet-4-5 → vercel, cursor:composer-2.5 → direct (fallback)',
        ],
        [
          'ok',
          'gateway direct in profile local: claude-code:claude-sonnet-4-5 → direct, cursor:composer-2.5 → direct',
        ],
      ],
    )
    const exp = Math.floor(Date.now() / 1000) - 60
    const token = `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`
    const expired = checkGateways(config, deps({ env: { VERCEL_OIDC_TOKEN: token } }), '.env.local')
    assert.equal(expired[0]?.status, 'fail')
    assert.match(expired[0]?.summary ?? '', /^VERCEL_OIDC_TOKEN expired at /)
    assert.equal(
      expired[0]?.fix,
      'run vercel env pull, or add AI_GATEWAY_API_KEY=... to .env.local',
    )
    const unset = await configOf('gateway-unset', "{ harness: cursor({ model: 'composer-2.5' }) }")
    assert.deepEqual(checkGateways(unset, deps(), '.env.local'), [])
    const stuck = await configOf(
      'gateway-stuck',
      "{ harness: cursor({ model: 'composer-2.5' }), gateway: [vercel(), direct({ enabled: false })] }",
    )
    assert.equal(checkGateways(stuck, deps(), '.env.local')[0]?.status, 'fail')
  })

  test('gateway: a judge or analysis model that falls back to direct is marked', async () => {
    const config = await configOf(
      'gateway-model-fallback',
      `{ harness: claudeCode({ model: 'claude-sonnet-4-5' }),
         gateway: [vertex({ project: 'p' })],
         judge: { model: 'openai/gpt-5.4-mini' },
         analysis: { model: 'openai/gpt-5.4-mini' },
         profiles: {
           pinned: { gateway: [vertex({ project: 'p' })], judge: { gateway: 'direct' } },
           first: { gateway: [direct(), vertex({ project: 'p' })] },
         } }`,
    )
    assert.deepEqual(
      checkGateways(config, deps(), '.env.local').map((c) => c.summary),
      [
        'gateway vertex, direct: claude-code:claude-sonnet-4-5 → vertex, judge openai/gpt-5.4-mini → direct (fallback), analysis openai/gpt-5.4-mini → direct (fallback)',
        'gateway vertex, direct in profile pinned: claude-code:claude-sonnet-4-5 → vertex',
        'gateway direct, vertex in profile first: claude-code:claude-sonnet-4-5 → direct',
      ],
    )
  })

  test('vertex: each entry’s project, where its tokens come from, and online whose they are', async () => {
    const config = await configOf(
      'gateway-vertex',
      `{ harness: claudeCode({ model: 'claude-haiku-4-5@20251001' }),
         gateway: [vertex({ project: 'reeval-test' })],
         judge: { model: 'anthropic/claude-haiku-4-5' },
         profiles: { env: { gateway: [vertex()] } } }`,
    )
    const judge = await checkJudge(config, deps({ env: {} }), false, '.env.local')
    assert.deepEqual(statuses(judge), ['ok'])
    assert.match(judge[0]?.summary ?? '', /on vertex\(\), with a token from Application Default/)

    const home = await mkdtemp(join(tmpdir(), 'reeval-adc-'))
    const offline = await checkVertex(config, deps({ env: { HOME: home } }), false)
    assert.deepEqual(
      offline.map((c) => [c.status, c.summary]),
      [
        ['ok', 'vertex(): project reeval-test, global'],
        [
          'fail',
          "vertex() has no project: set vertex({ project: '<id>' }) or GOOGLE_CLOUD_PROJECT in profile env",
        ],
        [
          'warn',
          'no Application Default Credentials found (fine on a Google Cloud VM, whose metadata server serves them)',
        ],
      ],
    )
    await mkdir(join(home, '.config', 'gcloud'), { recursive: true })
    const adc = join(home, '.config', 'gcloud', 'application_default_credentials.json')
    await writeFile(adc, '{}')
    const env = { HOME: home, GOOGLE_CLOUD_PROJECT: 'from-env' }
    const found = await checkVertex(config, deps({ env }), false)
    assert.deepEqual(
      found.map((c) => [c.status, c.summary]),
      [
        ['ok', 'vertex(): project reeval-test, global'],
        ['ok', 'vertex() in profile env: project from-env (from GOOGLE_CLOUD_PROJECT), global'],
        ['ok', `access tokens from gcloud's ${adc}`],
      ],
    )
    const missing = await checkVertex(
      config,
      deps({ env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: join(home, 'nope.json') } }),
      false,
    )
    assert.equal(missing.at(-1)?.status, 'fail')
    assert.match(missing.at(-1)?.summary ?? '', /nope\.json, which doesn't exist/)

    const asked: string[] = []
    const bodies: unknown[] = []
    const online = await checkVertex(
      config,
      deps({
        env,
        fetch: async (url, init) => {
          asked.push(String(url))
          if (String(url).startsWith('https://oauth2.googleapis.com/tokeninfo'))
            return Response.json({ email: 'ci@reeval-test.iam.gserviceaccount.com' })
          const authorization = new Headers(init?.headers).get('authorization')
          assert.equal(authorization, `Bearer ${SECRET}`)
          if (String(url).startsWith('https://aiplatform.googleapis.com/')) {
            const body = JSON.parse(String(init?.body)) as { model: string }
            bodies.push(body)
            return body.model === 'claude-haiku-4-5'
              ? Response.json(
                  {
                    error: {
                      code: 404,
                      message: `Publisher Model claude-haiku-4-5 was not found or your project does not have access to it. ${SECRET}`,
                    },
                  },
                  { status: 404 },
                )
              : Response.json({ input_tokens: 8 })
          }
          return String(url).includes('/projects/reeval-test/')
            ? Response.json({ state: 'ENABLED' })
            : Response.json({ state: 'DISABLED' })
        },
      }),
      true,
    )
    assert.deepEqual(
      online.slice(2).map((c) => [c.status, c.summary]),
      [
        [
          'ok',
          `access token minted for ci@reeval-test.iam.gserviceaccount.com from gcloud's ${adc}`,
        ],
        ['ok', 'Vertex AI API enabled in reeval-test'],
        ['fail', 'Vertex AI API not enabled in from-env'],
        ['ok', 'claude-haiku-4-5@20251001 for claude-code (reeval-test, global): served'],
        [
          'warn',
          'claude-haiku-4-5 for the judge (reeval-test, global): Vertex AI answered HTTP 404 (Publisher Model claude-haiku-4-5 was not found or your project does not have access to it. [REDACTED]), so its calls may fail',
        ],
      ],
    )
    assert.equal(
      online.at(-3)?.fix,
      'run gcloud services enable aiplatform.googleapis.com --project from-env',
    )
    assert.equal(
      online.at(-1)?.fix,
      "enable claude-haiku-4-5 for reeval-test in Model Garden (https://console.cloud.google.com/vertex-ai/model-garden), or set vertex({ regions: { anthropic: '<region>' } }) to a region that serves it",
    )
    assert.deepEqual(asked.slice(3), [
      'https://aiplatform.googleapis.com/v1/projects/reeval-test/locations/global/publishers/anthropic/models/count-tokens:rawPredict',
      'https://aiplatform.googleapis.com/v1/projects/reeval-test/locations/global/publishers/anthropic/models/count-tokens:rawPredict',
    ])
    assert.deepEqual(bodies[0], {
      model: 'claude-haiku-4-5@20251001',
      messages: [{ role: 'user', content: 'ping' }],
    })
    noSecret(online)
    const refused = await checkVertex(
      config,
      deps({
        env,
        vertexToken: async () => {
          throw new Error('invalid_grant: reauth related error')
        },
      }),
      true,
    )
    assert.equal(refused.at(-1)?.status, 'fail')
    assert.match(refused.at(-1)?.summary ?? '', /gave no access token: invalid_grant/)
    const unset = await configOf('vertex-unset', "{ harness: cursor({ model: 'composer-2.5' }) }")
    assert.deepEqual(await checkVertex(unset, deps(), true), [])
  })

  test('vertex online: a Gemini model is probed in the google region, once for every caller', async () => {
    const config = await configOf(
      'gateway-vertex-gemini',
      `{ harness: cursor({ model: 'composer-2.5' }),
         judge: { model: 'google/gemini-3.8-flash' },
         analysis: { model: 'google/gemini-3.8-flash' },
         gateway: [vertex({ project: 'reeval-test', regions: { google: 'us-central1' } })] }`,
    )
    const asked: Array<[string, unknown]> = []
    const checks = await checkVertex(
      config,
      deps({
        fetch: async (url, init) => {
          if (String(url).includes('/publishers/')) {
            asked.push([String(url), JSON.parse(String(init?.body))])
            return Response.json({ totalTokens: 1 })
          }
          return Response.json({ state: 'ENABLED' })
        },
      }),
      true,
    )
    assert.deepEqual(asked, [
      [
        'https://us-central1-aiplatform.googleapis.com/v1/projects/reeval-test/locations/us-central1/publishers/google/models/gemini-3.8-flash:countTokens',
        { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      ],
    ])
    assert.deepEqual(checks.at(-1), {
      id: 'vertex',
      status: 'ok',
      summary: 'gemini-3.8-flash for the judge, analysis.model (reeval-test, us-central1): served',
    })
  })

  test('vertex online: the Gemini harnesses are probed on the id they call', async () => {
    const config = await configOf(
      'gateway-vertex-harnesses',
      `{ harness: cursor({ model: 'composer-2.5' }),
         gateway: [vertex({ project: 'reeval-test' })],
         profiles: {
           agy: { defaults: { harness: antigravity({ model: 'gemini-3.8-flash-low' }) } },
           oc: { defaults: { harness: opencode({ model: 'google-vertex/gemini-3.8-flash' }) } },
           goose: { defaults: { harness: goose({ model: 'gemini-3.8-flash' }) } },
           pi: { defaults: { harness: pi({ model: 'gemini-3.8-pro' }) } },
         } }`,
    )
    const asked: string[] = []
    const checks = await checkVertex(
      config,
      deps({
        fetch: async (url) => {
          if (String(url).includes('/publishers/')) asked.push(String(url))
          return Response.json({ state: 'ENABLED', totalTokens: 1 })
        },
      }),
      true,
    )
    const models =
      'https://aiplatform.googleapis.com/v1/projects/reeval-test/locations/global/publishers/google/models'
    assert.deepEqual(asked, [
      `${models}/gemini-3.8-flash:countTokens`,
      `${models}/gemini-3.8-pro:countTokens`,
    ])
    assert.deepEqual(
      checks.slice(-2).map((c) => c.summary),
      [
        'gemini-3.8-flash for antigravity in profile agy, opencode in profile oc, goose in profile goose (reeval-test, global): served',
        'gemini-3.8-pro for pi in profile pi (reeval-test, global): served',
      ],
    )
  })

  test('egress: the policy, and one the sandbox can’t enforce', async () => {
    const open = await configOf('egress-open', "{ harness: cursor({ model: 'composer-2.5' }) }")
    assert.match(checkEgress(open)[0]?.summary ?? '', /^proxy: .* \(the default\)/)
    const denied = await configOf(
      'egress-deny',
      "{ harness: cursor({ model: 'composer-2.5' }), egress: 'deny-all' }",
    )
    assert.deepEqual(statuses(checkEgress(denied)), ['ok'])
    const fake = await configOf(
      'egress-fake',
      `{ harness: cursor({ model: 'composer-2.5' }),
         profiles: { fake: { defaults: { harness: fakeHarness(), environment: defineEnvironment('fake', { sandbox: fakeSandbox() }), egress: { allow: ['example.com'] } } } } }`,
    )
    const checks = checkEgress(fake)
    assert.deepEqual(statuses(checks), ['ok', 'ok', 'fail'])
    assert.match(checks[1]?.summary ?? '', /profile fake: allow example\.com/)
    assert.match(checks[2]?.summary ?? '', /the fake sandbox enforces no egress policy/)
  })

  test('egress: allow-all on a cloud VM or CI runner warns; proxy there, or allow-all elsewhere, does not', async () => {
    const direct = await configOf(
      'egress-direct',
      "{ harness: cursor({ model: 'composer-2.5' }), egress: 'allow-all' }",
    )
    const runner = 'a GitHub Actions runner (GITHUB_ACTIONS)'
    const checks = checkEgress(direct, runner)
    assert.deepEqual(statuses(checks), ['ok', 'warn'])
    assert.match(checks[0]?.summary ?? '', /^allow-all: .* goes out directly, unrecorded/)
    assert.match(
      checks[1]?.summary ?? '',
      /^egress 'allow-all' on a GitHub Actions runner \(GITHUB_ACTIONS\): .*cloud metadata service \(169\.254\.169\.254/,
    )
    assert.match(checks[1]?.fix ?? '', /egress: 'proxy' \(the default\)/)
    // Twins: the same config on a machine that isn't a cloud host, and the default on one.
    assert.deepEqual(statuses(checkEgress(direct, null)), ['ok'])
    const open = await configOf('egress-proxy', "{ harness: cursor({ model: 'composer-2.5' }) }")
    assert.deepEqual(statuses(checkEgress(open, runner)), ['ok'])
  })

  test('.gitignore: from git when it can, else from the file', async () => {
    const root = (await project('doctor-gitignore', {})).dir
    assert.equal((await checkGitignore(root, deps())).status, 'ok')
    const env = await checkGitignore(root, deps({ gitIgnored: async () => [false, true, true] }))
    assert.equal(env.status, 'fail')
    assert.match(env.summary, /^\.env\* isn't ignored: a commit could include your keys$/)
    const result = await checkGitignore(root, deps({ gitIgnored: async () => [true, true, false] }))
    assert.equal(result.status, 'warn')
    const noGit = deps({ gitIgnored: async () => null })
    assert.equal((await checkGitignore(root, noGit)).status, 'fail')
    await writeFile(join(root, '.gitignore'), '.reeval\n.env*\n')
    assert.equal((await checkGitignore(root, noGit)).status, 'ok')
  })

  test('env files git sees: filled-in key values warn, empty ones and placeholders pass', async () => {
    assert.deepEqual(
      filledSecrets(
        [
          '# Harnesses',
          'CURSOR_API_KEY=',
          `GEMINI_API_KEY=${SECRET}`,
          `export OPENAI_API_KEY="${SECRET}"`,
          'ANTHROPIC_API_KEY=your-key-here',
          'TYPESAFE_AI_API_KEY=<your key>',
          `GITHUB_TOKEN=\${GITHUB_TOKEN}`,
          'DB_PASSWORD=   # set in .env.local',
          'AWS_SECRET_ACCESS_KEY=xxxx',
          'PORT=3000',
        ].join('\n'),
      ),
      ['GEMINI_API_KEY', 'OPENAI_API_KEY'],
    )
    const root = (await project('doctor-env-files', {})).dir
    await writeFile(join(root, '.env.example'), `CURSOR_API_KEY=\nGEMINI_API_KEY=${SECRET}\n`)
    await writeFile(join(root, '.env.sample'), 'CURSOR_API_KEY=\n')
    const visible = (files: string[] | null) => deps({ gitVisibleEnvFiles: async () => files })
    const warn = await checkEnvFiles(root, visible(['.env.example', '.env.sample']))
    assert.equal(warn?.status, 'warn')
    assert.equal(
      warn?.summary,
      ".env.example (GEMINI_API_KEY) has key values filled in, and git sees it: a commit, or a dirty run's worktree.patch, would carry them",
    )
    assert.match(warn?.fix ?? '', /\.env\.local/)
    noSecret(warn ? [warn] : [])
    const ok = await checkEnvFiles(root, visible(['.env.sample']))
    assert.equal(ok?.status, 'ok')
    assert.equal(await checkEnvFiles(root, visible([])), null)
    assert.equal(await checkEnvFiles(root, visible(null)), null)
  })

  test('env files git sees: found with git ls-files, honoring .gitignore and its ! rules', async () => {
    const root = (await project('doctor-env-files-git', {})).dir
    await writeFile(join(root, '.gitignore'), 'node_modules/\n.env\n.env.*\n!.env.example\n')
    await writeFile(join(root, '.env.example'), `GEMINI_API_KEY=${SECRET}\n`)
    await writeFile(join(root, '.env.local'), `GEMINI_API_KEY=${SECRET}\n`)
    await mkdir(join(root, 'app'))
    await writeFile(join(root, 'app/.env.example'), 'GEMINI_API_KEY=\n')
    const { gitVisibleEnvFiles } = defaultDeps()
    assert.equal(await gitVisibleEnvFiles(root), null, 'outside a repository')
    execFileSync('git', ['init', '-q'], { cwd: root })
    assert.deepEqual((await gitVisibleEnvFiles(root))?.sort(), ['.env.example', 'app/.env.example'])
    const check = await checkEnvFiles(root, deps({ gitVisibleEnvFiles }))
    assert.equal(check?.status, 'warn')
    assert.match(check?.summary ?? '', /^\.env\.example \(GEMINI_API_KEY\) has key values/)
  })

  test("image tags come through sandbox-docker's podman CLI, which retries a dropped SSH handshake", async () => {
    // A podman CLI whose first `image ls` loses its handshake (exit 125); a Node script behind an
    // sh and a .cmd wrapper, so it runs on every OS.
    const bin = await mkdtemp(join(tmpdir(), 'reeval-doctor-podman-'))
    const log = join(bin, 'calls.log')
    await writeFile(
      join(bin, 'podman.js'),
      `const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] !== 'image') process.exit(1)
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
if (fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length === 1) {
  process.stderr.write('Error: ssh: handshake failed: EOF\\n')
  process.exit(125)
}
console.log('localhost/reeval-sandbox:cursor-0.1.5')
`,
    )
    await writeFile(join(bin, 'podman'), `#!/bin/sh\nexec node "$(dirname "$0")/podman.js" "$@"\n`)
    await chmod(join(bin, 'podman'), 0o755)
    await writeFile(join(bin, 'podman.cmd'), '@node "%~dp0podman.js" %*\r\n')
    const path = process.env.PATH
    process.env.PATH = `${bin}${delimiter}${path}`
    try {
      const tags = await defaultDeps().imageTags('reeval-sandbox', 'podman')
      assert.deepEqual(tags, ['reeval-sandbox:cursor-0.1.5'])
      assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2, 'retried once')
    } finally {
      process.env.PATH = path
    }
  })
})

describe('reeval doctor', () => {
  test('a healthy fake project exits 0, as text and JSON', async () => {
    const p = await project('doctor-healthy', {
      'reeval.config.ts': fakeConfig(),
      '.gitignore': '.reeval/\n.env*\n',
    })
    const r = await runCli(p.dir, ['doctor'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      new RegExp(
        `^reeval doctor · reeval\\.config\\.ts\\n✓ runtime +node ${process.versions.node.replace(/\./g, '\\.')} \\(`,
      ),
    )
    assert.match(r.stdout, /No problems/)
    const json = await runCli(p.dir, ['doctor', '--json'])
    assert.equal(json.code, 0)
    const report = JSON.parse(json.stdout)
    assert.equal(report.healthy, true)
    assert.deepEqual(
      [...new Set(report.checks.map((c: Check) => c.id))],
      ['runtime', 'config', 'docker', 'key', 'judge', 'egress', 'gitignore'],
    )
  })

  test('problems exit 1 with their fixes, and never print a key', async () => {
    const p = await project('doctor-problems', {
      'reeval.config.ts': `import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'
export default defineConfig({ harness: cursor({ model: 'composer-2.5' }), judge: { model: 'google/gemini-3.8-flash' } })
`,
      '.env.local': `GOOGLE_GENERATIVE_AI_API_KEY=${SECRET}\n`,
    })
    const env = { CURSOR_API_KEY: `${SECRET}-cursor` }
    for (const args of [['doctor'], ['doctor', '--json']]) {
      const r = await runCli(p.dir, args, { env })
      assert.equal(r.code, 1, r.stdout + r.stderr)
      assert.ok(!(r.stdout + r.stderr).includes(SECRET.slice(8)), 'no key value in the output')
      assert.match(r.stdout, /CURSOR_API_KEY for cursor:composer-2\.5: set/)
      assert.match(r.stdout, /GOOGLE_GENERATIVE_AI_API_KEY for google\/gemini-3\.8-flash: set/)
      assert.match(r.stdout, /\.env\* and \.reeval\/ aren't ignored/)
    }
    const text = await runCli(p.dir, ['doctor'], { env })
    assert.match(
      text.stdout,
      /fix: add \.env\* and \.reeval\/ to \.gitignore \(reeval init adds them\)/,
    )
    assert.match(
      text.stdout,
      /problems?, \d+ warnings?\. Fix (it|them) and run reeval doctor again\./,
    )
  })

  test("Docker that answers info but not image inspect: unchecked images, never 'not built'", async () => {
    // A docker CLI whose daemon is up for `info` but fails `image inspect`, as under a burst of calls.
    const bin = await mkdtemp(join(tmpdir(), 'reeval-flaky-docker-'))
    await writeFile(
      join(bin, 'docker.js'),
      `const args = process.argv.slice(2)
if (args[0] === 'info') {
  console.log(args.join(' ').includes('NCPU') ? '8 17179869184' : '29.1.0 linux')
} else if (args[0] === 'image' && args[1] === 'inspect') {
  process.stderr.write('Error response from daemon: context deadline exceeded\\n')
  process.exit(1)
}
`,
    )
    await writeFile(join(bin, 'docker'), '#!/bin/sh\nexec node "$(dirname "$0")/docker.js" "$@"\n')
    await chmod(join(bin, 'docker'), 0o755)
    await writeFile(join(bin, 'docker.cmd'), '@node "%~dp0docker.js" %*\r\n')
    const p = await project('doctor-flaky-docker', {
      'reeval.config.ts': `import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'
export default defineConfig({ harness: cursor({ model: 'composer-2.5' }) })
`,
      'evals/a.eval.ts': "import { evaluate } from 'reeval'\nevaluate('a', async () => {})\n",
      '.gitignore': '.reeval/\n.env*\n',
    })
    const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, CURSOR_API_KEY: 'set' }

    const dry = await runCli(p.dir, ['image', 'build', '--dry-run'], { env })
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(
      dry.stdout,
      /\? base +reeval-sandbox:cursor-\S+ +\(unchecked: docker image inspect \S+ failed: Error response from daemon: context deadline exceeded\)/,
    )
    assert.doesNotMatch(dry.stdout, /not built yet/)

    const plan = await runCli(p.dir, ['run', '--dry-run'], { env })
    assert.equal(plan.code, 0, plan.stdout + plan.stderr)
    assert.match(plan.stdout, /^images {2}1 sandbox image: 1 unchecked$/m)

    const doctor = await runCli(p.dir, ['doctor'], { env })
    assert.match(
      doctor.stdout,
      /✗ image +reeval-sandbox:cursor-\S+ \(cursor\) couldn't be checked: docker image inspect .* context deadline exceeded/,
    )
    assert.doesNotMatch(doctor.stdout, /isn't built/)
  })

  test('no config, a broken config and a bad flag', async () => {
    const empty = await project('doctor-empty', {})
    const none = await runCli(empty.dir, ['doctor'])
    assert.equal(none.code, 1)
    assert.match(
      none.stdout,
      /✗ config +no reeval\.config\.ts .* here or above\n +fix: reeval init/,
    )
    const broken = await project('doctor-broken', {
      'reeval.config.ts':
        "import { defineConfig } from 'reeval'\nexport default defineConfig({ harnesses: [] })\n",
    })
    const bad = await runCli(broken.dir, ['doctor'])
    assert.equal(bad.code, 1)
    assert.match(bad.stdout, /✗ config +Unknown option "harnesses" in reeval\.config\.ts/)
    const flag = await runCli(empty.dir, ['doctor', '--runs', '2'])
    assert.equal(flag.code, 2)
    assert.match(flag.stderr, /--runs isn't an option of reeval doctor/)
  })
})
