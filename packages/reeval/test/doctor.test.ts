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
  checkDocker,
  checkEgress,
  checkEnvFiles,
  checkGitignore,
  checkImages,
  checkJudge,
  checkKeys,
  checkRuntime,
  type DoctorDeps,
  defaultDeps,
  filledSecrets,
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
  imageTags: async () => [],
  podmanConfinement: async () => null,
  gitIgnored: async (_, paths) => paths.map(() => true),
  gitVisibleEnvFiles: async () => [],
  fetch: async () => new Response('{}', { status: 200 }),
  ...over,
})

/** A resolved config from `reeval.config.ts` source that imports from `reeval`. */
async function configOf(name: string, body: string) {
  const p = await project(`doctor-${name}`, {
    'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { claudeCode, codex, cursor, fakeHarness, pi } from 'reeval/harness'
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
    assert.deepEqual(statuses(await checkJudge(none, deps(), false, '.env.local')), ['skip'])
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
    assert.match(missing[0]?.summary ?? '', /GOOGLE_GENERATIVE_AI_API_KEY or AI_GATEWAY_API_KEY/)
    const gateway = await checkJudge(
      google,
      deps({ env: { AI_GATEWAY_API_KEY: SECRET } }),
      false,
      '.env.local',
    )
    assert.equal(gateway[0]?.status, 'ok')
    noSecret(gateway)
  })

  test('egress: the policy, and one the sandbox can’t enforce', async () => {
    const open = await configOf('egress-open', "{ harness: cursor({ model: 'composer-2.5' }) }")
    assert.match(checkEgress(open)[0]?.summary ?? '', /^allow-all: .* \(the default\)/)
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

  test('env files git sees: found with git ls-files, honouring .gitignore and its ! rules', async () => {
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
