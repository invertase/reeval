// Tiers F, D and C: one directory per feature under test/features/, each with one check
// (evals/lands.es.ts) and a canary that must fail (evals/canary.es.ts). The same fixture runs on
// the fake sandbox, in Docker when Docker and ES's image are there, and on real Cursor with
// ES_TEST_REAL=1 and CURSOR_API_KEY. The oracle here checks the record from outside; see
// test/features/README.md for adding one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { ANTIGRAVITY_CLI_VERSION } from '@evalsuite/harness-antigravity'
import { GOOSE_CLI_VERSION } from '@evalsuite/harness-goose'
import { OPENCODE_CLI_VERSION } from '@evalsuite/harness-opencode'
import { PI_CLI_VERSION } from '@evalsuite/harness-pi'
import { type BakedHarness, DEFAULT_IMAGE, imageFor, LABEL } from '@evalsuite/sandbox-docker'
import type { RunRecord } from '../src/history/types.ts'
import { liveSandboxes, readRun, runCli } from './helpers.ts'
import { fixture, testDir } from './support/fixture.ts'
import { harnesses, reserveAttempts } from './support/harnesses.ts'
import { type EvalExpectation, expectRun } from './support/oracle.ts'

/** `real` is Docker with real Cursor (ES_FIXTURE_HARNESS=cursor), one fixture at a time. */
type Tier = 'fake' | 'docker' | 'real'

type Feature = {
  /** Under `test/features/`. */
  dir: string
  tiers: Tier[]
  /** The environment the evals run in: attempt ids are `fake/<env>/<sandbox>#1`. */
  env: string
  /** What the canary's failure says: proof it failed on the check, not on setup. */
  canary: RegExp
  /** The canary's environment, when it needs another one; defaults to `env`. */
  canaryEnv?: string
  /** When the check is that the attempt fails, e.g. an infra error; else it must pass. */
  lands?: Pick<EvalExpectation, 'outcome' | 'error'>
  /**
   * Host variables for `es run`, e.g. what `secret.fromEnv` reads; a function runs at test time,
   * with the copied project's directory.
   */
  hostEnv?: NodeJS.ProcessEnv | ((dir: string) => NodeJS.ProcessEnv)
  /** Runs on the copied project before `es run`. */
  prepare?: (dir: string) => void
  /** A host-side cross-check of the record, independent of the in-sandbox check. */
  record?: (view: {
    run: RunRecord
    project: string
    runDir: string
    tier: Tier
  }) => void | Promise<void>
  /** ES's image the Docker tier needs, when it isn't Cursor's (a fake agent with `layout`). */
  image?: BakedHarness
}

const TOKEN = 'es-fixture-token-7c1d9a0b52e4'
/** With characters each encoding changes: space, `/`, `+`, `"`, `&`, `?` and `=`. */
const LEAKY = 'es leak/7c+1d"9a&b?0=e4f2'

/** Each way the redaction-coverage agent prints LEAKY, and each of those inside a JSON string. */
const leakyForms = () => {
  const printed = [
    LEAKY,
    Buffer.from(LEAKY).toString('base64'),
    encodeURIComponent(LEAKY),
    JSON.stringify(LEAKY).slice(1, -1),
  ]
  return [...new Set(printed.flatMap((f) => [f, JSON.stringify(f).slice(1, -1)]))]
}

/**
 * A listener on the host at an address that isn't loopback (the gateway never reaches loopback),
 * for the egress fixtures: `ES_EGRESS_HOST` is its address, `ES_EGRESS_TARGET` adds the port.
 */
const egressTarget = { host: '', port: 0, requests: 0 }
const listener = createServer((_, res) => {
  egressTarget.requests++
  res.end('es-egress-ok')
})
before(async () => {
  const addresses = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, ...a })),
  )
  const bridge = /^(docker|br-|veth)/
  egressTarget.host =
    (addresses.find((a) => !bridge.test(a.name)) ?? addresses[0])?.address ?? '127.0.0.1'
  await new Promise<void>((resolve) => listener.listen(0, '0.0.0.0', resolve))
  egressTarget.port = (listener.address() as AddressInfo).port
})
after(() => listener.close())

/**
 * A local npm registry for `skill.npm`: `prepare` packs a fixture's package versions into it, and
 * `npm pack` on the host reaches it through `npm_config_registry`.
 */
const npmRegistry = {
  url: '',
  packages: new Map<string, Map<string, Buffer>>(),
  fetched: [] as string[],
}
const registry = createServer((req, res) => {
  const path = decodeURIComponent(req.url ?? '/').slice(1)
  const tarball = /^(.+)\/-\/([^/]+)\.tgz$/.exec(path)
  const versions = npmRegistry.packages.get(tarball?.[1] ?? path)
  if (!versions) {
    res.statusCode = 404
    res.end('{}')
    return
  }
  if (tarball) {
    const body = versions.get(tarball[2] ?? '')
    if (body) npmRegistry.fetched.push(`${tarball[1]}@${tarball[2]}`)
    res.statusCode = body ? 200 : 404
    res.end(body ?? '')
    return
  }
  const name = path
  const entries = [...versions].map(([version, body]) => [
    version,
    {
      name,
      version,
      dist: {
        tarball: `${npmRegistry.url}${name}/-/${version}.tgz`,
        shasum: createHash('sha1').update(body).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
      },
    },
  ])
  res.setHeader('content-type', 'application/json')
  res.end(
    JSON.stringify({
      name,
      'dist-tags': { latest: entries.at(-1)?.[0] },
      versions: Object.fromEntries(entries),
    }),
  )
})
before(async () => {
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
  npmRegistry.url = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`
})
after(() => registry.close())

/** Packs each `<dir>/<version>/` with `npm pack` into the local registry, oldest first. */
function publish(dir: string) {
  const out = join(dir, '.packed')
  mkdirSync(out, { recursive: true })
  for (const version of readdirSync(dir)
    .filter((v) => /^\d/.test(v))
    .sort()) {
    const file = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], {
      cwd: join(dir, version),
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .at(-1) as string
    const { name } = JSON.parse(readFileSync(join(dir, version, 'package.json'), 'utf8'))
    const versions = npmRegistry.packages.get(name) ?? new Map<string, Buffer>()
    versions.set(version, readFileSync(join(out, file)))
    npmRegistry.packages.set(name, versions)
  }
}
const egressEnv = () => ({
  ES_EGRESS_HOST: egressTarget.host,
  ES_EGRESS_TARGET: `${egressTarget.host}:${egressTarget.port}`,
})

/** The `lands` eval's first attempt. */
const landed = (run: RunRecord) => run.evals.find((e) => e.name === 'lands')?.attempts[0]

const skills = (run: RunRecord) => run.environments.flatMap((e) => e.skills)
const envFiles = (run: RunRecord) => run.environments.flatMap((e) => e.files.map((f) => f.path))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

// biome-ignore lint/suspicious/noExportsInTest: the feature matrix reads this table (support/feature-matrix.ts)
export const features: Feature[] = [
  {
    dir: 'skills/workspace-placement',
    tiers: ['fake', 'docker'],
    env: 'greeting',
    canary: /expected \[ '' \] to deeply equal \[ '\.\/SKILL\.md', '\.\/docs\/tone\.md' \]/,
    record: ({ run }) =>
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.placement, s.source]),
        [['house-greeting', 'workspace', 'local:skills/house-greeting']],
      ),
  },
  {
    dir: 'skills/workspace-content',
    tiers: ['fake', 'docker'],
    env: 'greeting',
    canary: /to contain 'license: MIT'/,
  },
  {
    dir: 'skills/exclude-default',
    tiers: ['fake', 'docker'],
    env: 'greeting',
    canary: /to include '\.\/evals\/prompts\.md'/,
    record: ({ run }) =>
      assert.deepEqual(skills(run)[0]?.excluded, ['.history/', 'evals/', 'greets.es.ts']),
  },
  {
    dir: 'skills/exclude-custom',
    tiers: ['fake', 'docker'],
    env: 'greeting',
    canary: /to not include '\.\/evals\/prompts\.md'/,
    record: ({ run }) => assert.deepEqual(skills(run)[0]?.excluded, ['drafts/', 'notes.tmp']),
  },
  {
    dir: 'skills/git-ref',
    tiers: ['fake', 'docker'],
    env: 'greeting-v1',
    canary: /to contain 'Hello there, <name>\.'/,
    prepare(dir) {
      const repo = join(dir, 'repo')
      const commit = (version: string) => {
        rmSync(join(repo, 'skills'), { recursive: true, force: true })
        cpSync(join(dir, 'skill-repo', version), repo, { recursive: true })
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '-m', version)
      }
      execFileSync('git', ['init', '-q', '-b', 'main', repo])
      commit('v1')
      git(repo, 'tag', 'v1')
      commit('v2')
    },
    record: ({ run, project }) => {
      const [s] = skills(run)
      assert.equal(s?.commit, git(join(project, 'repo'), 'rev-parse', 'v1'))
      assert.match(s?.source ?? '', /#v1:skills$/)
    },
  },
  {
    dir: 'skills/registry-version',
    tiers: ['fake', 'docker'],
    env: 'registry-v1',
    canary: /to contain 'Hello there, <name>\.'/,
    prepare(dir) {
      const repo = join(dir, 'registry/acme/skills.git')
      const commit = (version: string) => {
        rmSync(join(repo, 'skills'), { recursive: true, force: true })
        cpSync(join(dir, 'skill-repo', version), repo, { recursive: true })
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '-m', version)
      }
      execFileSync('git', ['init', '-q', '-b', 'main', repo])
      commit('v1')
      git(repo, 'tag', 'v1')
      commit('v2')
    },
    // skill.registry clones https://github.com/acme/skills.git; git sends that to the fixture's repo.
    hostEnv: (dir) => ({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${join(dir, 'registry')}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
    }),
    record: ({ run, project }) => {
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.source, s.commit]),
        [
          [
            'house-greeting',
            'registry:acme/skills@house-greeting#v1',
            git(join(project, 'registry/acme/skills.git'), 'rev-parse', 'v1'),
          ],
        ],
        'only the named skill, at the tagged commit',
      )
    },
  },
  {
    dir: 'skills/npm-package',
    tiers: ['fake', 'docker'],
    env: 'npm-1.2.3',
    canary: /to contain 'Hello there, <name>\.'/,
    prepare: (dir) => publish(join(dir, 'packages')),
    hostEnv: (dir) => ({
      npm_config_registry: npmRegistry.url,
      npm_config_cache: join(dir, '.npm-cache'),
    }),
    record: ({ run }) => {
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.source]),
        [['house-greeting', 'npm:@acme/skills@1.2.3:skills']],
      )
      assert.ok(npmRegistry.fetched.includes('@acme/skills@1.2.3'), 'fetched from the registry')
      assert.ok(!npmRegistry.fetched.includes('@acme/skills@1.2.4'), 'never the latest')
    },
  },
  {
    dir: 'skills/only-missing',
    tiers: ['fake', 'docker'],
    env: 'typo',
    canaryEnv: 'picked',
    lands: {
      outcome: 'infra_error',
      error: {
        kind: 'infra',
        message:
          /^only: \["house-greting"\] not found in local:skills \(found: house-farewell, house-greeting\)$/,
      },
    },
    canary:
      /expected \[ 'house-greeting' \] to deeply equal \[ 'house-farewell', 'house-greeting' \]/,
  },
  {
    dir: 'skills/harness-placement',
    tiers: ['fake', 'docker', 'real'],
    env: 'greeting',
    canary: /expected '' to contain 'Greet people with "Ahoy, <name>!"\.'/,
    record: ({ run, tier }) => {
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.placement]),
        [['house-greeting', 'harness']],
      )
      if (tier === 'fake') return
      // In the agent's home, taken after the turn: the fake's ~/.agents, or Cursor's adapter home.
      // Adapters write SKILL.md afresh from its frontmatter and body, so the hash isn't the file's.
      const seen = landed(run)?.context ?? []
      assert.ok(
        seen.some((c) => /^~\/(.+\/)?\.agents\/skills\/house-greeting\/SKILL\.md$/.test(c.path)),
        JSON.stringify(seen),
      )
    },
  },
  {
    dir: 'mcp/stdio-reaches-harness',
    tiers: ['docker', 'real'],
    env: 'stamp',
    canary: /expected '.*' to contain 'tools\/call'/,
    record: ({ run }) =>
      assert.deepEqual(
        run.environments.map((e) => [e.name, e.mcp]),
        [['stamp', ['stamp']]],
      ),
  },
  {
    dir: 'secrets/checks-hidden-from-agent',
    tiers: ['fake', 'docker'],
    env: 'tokens',
    hostEnv: { ES_FIXTURE_TOKEN: TOKEN },
    canary: /expected 'unset\\n' to be '\[REDACTED\]\\n'/,
    record: ({ runDir }) => assert.equal(filesContaining(runDir, TOKEN), ''),
  },
  {
    dir: 'secrets/checks-visible-to-checks',
    tiers: ['fake', 'docker'],
    env: 'tokens',
    hostEnv: { ES_FIXTURE_TOKEN: TOKEN },
    canary: /expected '\[REDACTED\]' to be ''/,
    record: ({ runDir }) => assert.equal(filesContaining(runDir, TOKEN), ''),
  },
  {
    dir: 'secrets/brokered-agent-sees-placeholder',
    tiers: ['fake', 'docker'],
    env: 'keys',
    hostEnv: { ES_FIXTURE_TOKEN: TOKEN },
    canary: /expected 'es_secret_[0-9A-Za-z]+…' to be '\[REDACTED\]'/,
    record: ({ run, runDir }) => {
      assert.deepEqual(landed(run)?.env.brokered, ['API_KEY'])
      assert.equal(filesContaining(runDir, TOKEN), '')
      assert.notEqual(filesContaining(runDir, 'API_KEY'), '', 'twin: the search finds the name')
    },
  },
  {
    dir: 'secrets/brokered-checks-see-placeholder',
    tiers: ['fake', 'docker'],
    env: 'keys',
    hostEnv: { ES_FIXTURE_TOKEN: TOKEN },
    canary: /expected 'es_secret_[0-9A-Za-z]+…' to be '\[REDACTED\]'/,
    record: ({ run, runDir }) => {
      assert.deepEqual(landed(run)?.env, {
        vars: [],
        secrets: ['CHECK_TOKEN'],
        brokered: ['CHECK_TOKEN'],
      })
      assert.equal(filesContaining(runDir, TOKEN), '')
      assert.notEqual(filesContaining(runDir, 'CHECK_TOKEN'), '', 'twin: the search finds the name')
    },
  },
  {
    dir: 'secrets/cursor-session-tokens',
    tiers: ['real'],
    env: 'plain',
    canary: /expected '' to match \/\^es_secret_\//,
  },
  {
    dir: 'secrets/redaction-coverage',
    tiers: ['fake', 'docker'],
    env: 'leaky',
    hostEnv: { ES_FIXTURE_LEAKY: LEAKY },
    canary: /not to contain '\[REDACTED\]'/,
    async record({ project, runDir, tier }) {
      const env = { ES_FIXTURE_LEAKY: LEAKY, ES_FIXTURE_SANDBOX: tier }
      const recorded = await runCli(project, ['record'], { env })
      assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr)
      const site = join(project, 'site')
      const built = await runCli(project, ['studio', 'build', '--out', site], { env })
      assert.equal(built.code, 0, built.stdout + built.stderr)
      const [judgeInput, ...more] = filesNamed(runDir, 'judge-input.json')
      assert.ok(judgeInput && more.length === 0, 'one judge call')
      const input = JSON.parse(readFileSync(judgeInput, 'utf8')) as Array<{
        state: { diff?: { $ref?: string } }
      }>
      assert.equal(input[0]?.state.diff?.$ref, 'diff.patch', 'the judge saw the diff')
      const judged = join(dirname(judgeInput), 'diff.patch')
      for (const [where, paths] of [
        ['the run', [runDir]],
        ['the history folder', [join(project, 'evals', '.history')]],
        ['the studio build', [site]],
        ['the judge input', [judgeInput, judged]],
      ] as const) {
        for (const form of leakyForms()) {
          const hits = paths.map((p) => filesContaining(p, form)).join('')
          assert.equal(hits, '', `${where} has ${JSON.stringify(form)}`)
        }
        // Twin: the same search finds what was left in place of the forms.
        const masked = paths.map((p) => filesContaining(p, '[REDACTED]')).join('')
        assert.notEqual(masked, '', `${where} has no [REDACTED]`)
      }
    },
  },
  {
    dir: 'egress/allowed-host-reachable',
    tiers: ['docker'],
    env: 'listed',
    canaryEnv: 'closed',
    hostEnv: egressEnv,
    canary: /expected 'blocked by the ES egress policy: the …' to be 'es-egress-ok'/,
    record: ({ run }) => {
      const egress = landed(run)?.egress
      assert.deepEqual(egress?.policy, { allow: [egressTarget.host] })
      assert.deepEqual(egress?.allowed, [egressTarget.host])
      const [reached, ...more] = egress?.contacted ?? []
      assert.deepEqual(
        [reached?.host, reached?.port, reached?.connections, more],
        [egressTarget.host, egressTarget.port, 1, []],
      )
      assert.ok((reached?.sent ?? 0) > 0 && (reached?.received ?? 0) > 'es-egress-ok'.length)
      assert.deepEqual(egress?.blocked, [])
    },
  },
  {
    dir: 'egress/blocked-host-recorded',
    tiers: ['docker'],
    env: 'listed',
    canary:
      /expected 'blocked by the ES egress policy: bloc…' not to contain 'blocked by the ES egress policy'/,
    record: ({ run }) =>
      assert.deepEqual(landed(run)?.egress, {
        policy: { allow: ['api.example.com'] },
        allowed: ['api.example.com'],
        recorded: true,
        contacted: [],
        blocked: [
          {
            host: 'blocked.invalid',
            port: 80,
            connections: 1,
            reason: "blocked.invalid isn't in the allowlist",
          },
        ],
        expectedBlocked: [],
      }),
  },
  {
    dir: 'egress/expected-blocked',
    tiers: ['docker'],
    env: 'closed',
    image: 'antigravity',
    canary: /expected '403 000' to match/,
    record: ({ run }) => {
      const egress = landed(run)?.egress
      assert.deepEqual(
        egress?.blocked.map((h) => [h.host, h.port, h.connections]),
        [['blocked.invalid', 80, 1]],
        'only the host nothing expects is listed as blocked',
      )
      assert.deepEqual(
        egress?.expectedBlocked?.map((h) => [h.host, h.port, h.connections, h.reason]),
        [
          ['antigravity-unleash.goog', 443, 1, "antigravity-unleash.goog isn't in the allowlist"],
          ['play.googleapis.com', 443, 1, "play.googleapis.com isn't in the allowlist"],
        ],
      )
    },
  },
  {
    dir: 'egress/deny-all',
    tiers: ['docker'],
    env: 'closed',
    canaryEnv: 'open',
    hostEnv: egressEnv,
    canary: /expected '200 exit=0 dns=0' to match/,
    record: ({ run }) => {
      const egress = landed(run)?.egress
      assert.equal(egress?.policy, 'deny-all')
      assert.deepEqual(egress?.allowed, [])
      assert.deepEqual(egress?.contacted, [])
      assert.deepEqual(egress?.blocked, [
        {
          host: egressTarget.host,
          port: egressTarget.port,
          connections: 1,
          reason: 'the policy denies all egress',
        },
      ])
    },
  },
  {
    dir: 'egress/secret-hosts-allowed',
    tiers: ['docker'],
    env: 'keyed',
    canaryEnv: 'closed',
    hostEnv: () => ({ ...egressEnv(), ES_FIXTURE_TOKEN: TOKEN }),
    canary: /expected 'blocked by the ES egress policy: the …' to be 'es-egress-ok'/,
    record: ({ run, runDir }) => {
      const egress = landed(run)?.egress
      assert.equal(egress?.policy, 'deny-all')
      assert.deepEqual(
        egress?.allowed,
        [egressTarget.host],
        "the secret's host, allowed automatically",
      )
      assert.deepEqual(
        egress?.contacted.map((h) => h.host),
        [egressTarget.host],
      )
      assert.equal(filesContaining(runDir, TOKEN), '')
    },
  },
  {
    dir: 'egress/harness-under-deny-all',
    tiers: ['docker', 'real'],
    env: 'closed',
    canary: /expected '403 000' to match/,
    record: ({ run, tier }) => {
      const egress = landed(run)?.egress
      assert.equal(egress?.policy, 'deny-all')
      assert.deepEqual(egress?.allowed, ['api2.cursor.sh', '*.cursor.sh'])
      assert.ok(
        egress?.contacted.some((h) => h.host === 'api2.cursor.sh'),
        JSON.stringify(egress),
      )
      const canary = run.evals.find((e) => e.name === 'canary')?.attempts[0]?.egress
      assert.deepEqual(
        canary?.blocked.map((h) => [h.host, h.reason]),
        [['registry.npmjs.org', "registry.npmjs.org isn't in the allowlist"]],
      )
      if (tier === 'real') {
        // Real Cursor talks to more than its API: whatever else it tried is refused and recorded.
        assert.ok(
          egress?.blocked.every((h) => !/cursor\.(sh|com)$/.test(h.host)),
          JSON.stringify(egress),
        )
      }
    },
  },
  {
    dir: 'env/files-home',
    tiers: ['fake', 'docker'],
    env: 'home-files',
    canary: /expected null to be 'from home'/,
  },
  {
    dir: 'env/files-binary',
    tiers: ['fake', 'docker'],
    env: 'binary-file',
    canary: /expected '[0-9a-f]+…' to be '[0-9a-f]+…'/,
    // Every byte value, gzipped: invalid as UTF-8, and a real archive.
    prepare: (dir) =>
      writeFileSync(
        join(dir, 'blob.tgz'),
        gzipSync(Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 7) % 256))),
      ),
    record: ({ run, project }) => {
      const sha = createHash('sha256')
        .update(readFileSync(join(project, 'blob.tgz')))
        .digest('hex')
      const env = run.environments.find((e) => e.name === 'binary-file')
      assert.deepEqual(env?.files, [{ path: 'blob.tgz', sha256: sha }])
    },
  },
  {
    dir: 'env/rules',
    tiers: ['fake', 'docker'],
    env: 'house-rules',
    canary: /expected null to be 'Always write tests\.'/,
  },
  {
    dir: 'harness/claude-code-rules',
    tiers: ['fake', 'docker'],
    image: 'claude-code',
    env: 'house-rules',
    canary: /expected null to be 'Always write tests\.'/,
    record: ({ run }) => assert.deepEqual(envFiles(run), ['CLAUDE.md']),
  },
  {
    dir: 'harness/cursor-rules',
    tiers: ['fake', 'docker'],
    env: 'house-rules',
    canary: /expected null to be 'Always write tests\.'/,
    record: ({ run }) => assert.deepEqual(envFiles(run), ['AGENTS.md']),
  },
  {
    dir: 'harness/claude-code-workspace-skills',
    tiers: ['fake', 'docker'],
    image: 'claude-code',
    env: 'greeting',
    canary: /expected \[ '' \] to deeply equal \[ '\.\/SKILL\.md' \]/,
  },
  {
    dir: 'harness/cursor-rules-reach-agent',
    tiers: ['real'],
    env: 'house-rules',
    canaryEnv: 'no-rules',
    canary: /to contain 'MARMALADE'/,
  },
  {
    dir: 'harness/cursor-reports-usage',
    tiers: ['real'],
    env: 'plain',
    canary: /expected \{ input: \d+.* to be null/,
    record: ({ run }) => {
      const attempt = landed(run)
      const turns = attempt?.turns ?? []
      assert.equal(turns.length, 2)
      for (const t of turns) {
        assert.ok(t.usage && t.usage.input + t.usage.cacheRead > 1000, 'the system prompt counts')
        // The model the SDK resolved, with the parameters it filled in.
        assert.match(t.model ?? '', new RegExp(`^${realModel.replace(/\./g, '\\.')}\\[.*=`))
      }
      assert.equal(
        attempt?.usage?.output,
        turns.reduce((n, t) => n + (t.usage?.output ?? 0), 0),
        "the attempt's total is its turns'",
      )
      assert.equal(run.cost.source, 'reported')
      assert.ok((run.cost.inputTokens ?? 0) > 0 && (run.cost.outputTokens ?? 0) > 0)
    },
  },
  {
    dir: 'harness/cursor-web-fetch',
    tiers: ['real'],
    env: 'plain',
    canary: /not to match \/Root=1-/,
    record: ({ run }) => {
      const attempt = landed(run)
      assert.deepEqual(attempt?.turns[0]?.unreported, [])
      assert.ok((attempt?.activity.webFetches ?? 0) >= 1, 'the fetch is in the record')
    },
  },
  {
    dir: 'harness/claude-code-harness-skills',
    tiers: ['fake', 'docker'],
    image: 'claude-code',
    env: 'greeting',
    canary: /expected '' to contain 'Greet people with "Ahoy, <name>!"\.'/,
    record: ({ run, tier }) => {
      if (tier === 'fake') return
      const seen = landed(run)?.context ?? []
      assert.ok(
        seen.some((c) => c.path === '~/.claude/skills/house-greeting/SKILL.md'),
        JSON.stringify(seen),
      )
    },
  },
  {
    dir: 'harness/antigravity-rules',
    tiers: ['fake', 'docker'],
    image: 'antigravity',
    env: 'house-rules',
    canary: /expected null to be 'Always write tests\.'/,
    record: ({ run }) => assert.deepEqual(envFiles(run), ['AGENTS.md']),
  },
  {
    dir: 'harness/antigravity-workspace-skills',
    tiers: ['fake', 'docker'],
    image: 'antigravity',
    env: 'greeting',
    canary: /expected \[ '' \] to deeply equal \[ '\.\/SKILL\.md' \]/,
  },
  {
    dir: 'harness/antigravity-home-skills',
    tiers: ['fake', 'docker'],
    image: 'antigravity',
    env: 'greeting',
    canary: /expected '' to contain 'Greet people with "Ahoy, <name>!"\.'/,
    record: ({ run }) =>
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.placement]),
        [['house-greeting', 'harness']],
      ),
  },
  {
    dir: 'harness/opencode-rules',
    tiers: ['fake', 'docker'],
    image: 'opencode',
    env: 'house-rules',
    canary: /expected null to be 'Always write tests\.'/,
    record: ({ run }) => assert.deepEqual(envFiles(run), ['AGENTS.md']),
  },
  {
    dir: 'harness/opencode-workspace-skills',
    tiers: ['fake', 'docker'],
    image: 'opencode',
    env: 'greeting',
    canary: /expected \[ '' \] to deeply equal \[ '\.\/SKILL\.md' \]/,
  },
  {
    dir: 'harness/opencode-home-skills',
    tiers: ['fake', 'docker'],
    image: 'opencode',
    env: 'greeting',
    canary: /expected '' to contain 'Greet people with "Ahoy, <name>!"\.'/,
    record: ({ run }) =>
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.placement]),
        [['house-greeting', 'harness']],
      ),
  },
  {
    dir: 'harness/goose-rules',
    tiers: ['fake', 'docker'],
    image: 'goose',
    env: 'house-rules',
    canary: /expected null to be 'Always write tests\.'/,
    record: ({ run }) => assert.deepEqual(envFiles(run), ['AGENTS.md']),
  },
  {
    dir: 'harness/goose-workspace-skills',
    tiers: ['fake', 'docker'],
    image: 'goose',
    env: 'greeting',
    canary: /expected \[ '' \] to deeply equal \[ '\.\/SKILL\.md' \]/,
  },
  {
    dir: 'harness/goose-home-skills',
    tiers: ['fake', 'docker'],
    image: 'goose',
    env: 'greeting',
    canary: /expected '' to contain 'Greet people with "Ahoy, <name>!"\.'/,
    record: ({ run }) =>
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.placement]),
        [['house-greeting', 'harness']],
      ),
  },
  {
    dir: 'harness/pi-rules',
    tiers: ['fake', 'docker'],
    image: 'pi',
    env: 'house-rules',
    canary: /expected null to be 'Always write tests\.'/,
    record: ({ run }) => assert.deepEqual(envFiles(run), ['AGENTS.md']),
  },
  {
    dir: 'harness/pi-workspace-skills',
    tiers: ['fake', 'docker'],
    image: 'pi',
    env: 'greeting',
    canary: /expected \[ '' \] to deeply equal \[ '\.\/SKILL\.md' \]/,
  },
  {
    dir: 'harness/pi-home-skills',
    tiers: ['fake', 'docker'],
    image: 'pi',
    env: 'greeting',
    canary: /expected '' to contain 'Greet people with "Ahoy, <name>!"\.'/,
    record: ({ run }) =>
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.placement]),
        [['house-greeting', 'harness']],
      ),
  },
  {
    dir: 'harness/cursor-workspace-skills',
    tiers: ['fake', 'docker'],
    env: 'greeting',
    canary: /expected \[ '' \] to deeply equal \[ '\.\/SKILL\.md' \]/,
  },
  {
    dir: 'harness/claude-code-dockerfile',
    tiers: ['docker'],
    image: 'claude-code',
    env: 'plain',
    canary: /expected '' to match \/\\\/@cursor\\\/sdk\$\//,
    record: ({ run }) => {
      const [image] = run.stack.images
      assert.match(image?.base ?? '', /^evalsuite-dockerfile:docker-[0-9a-f]{16}$/)
      assert.match(image?.agentCli ?? '', /\(Claude Code\)$/)
    },
  },
  {
    dir: 'harness/antigravity-dockerfile',
    tiers: ['docker'],
    image: 'antigravity',
    env: 'plain',
    canary: /expected '' to match \/\\\/@cursor\\\/sdk\$\//,
    record: ({ run }) => {
      const [image] = run.stack.images
      // Not baked again: the Dockerfile's base carries Antigravity's harness label.
      assert.match(image?.base ?? '', /^evalsuite-dockerfile:docker-[0-9a-f]{16}$/)
      assert.equal(image?.agentCli, ANTIGRAVITY_CLI_VERSION)
    },
  },
  {
    dir: 'harness/opencode-dockerfile',
    tiers: ['docker'],
    image: 'opencode',
    env: 'plain',
    canary: /expected '' to match \/\\\/@cursor\\\/sdk\$\//,
    record: ({ run }) => {
      const [image] = run.stack.images
      assert.match(image?.base ?? '', /^evalsuite-dockerfile:docker-[0-9a-f]{16}$/)
      assert.equal(image?.agentCli, OPENCODE_CLI_VERSION)
    },
  },
  {
    dir: 'harness/goose-dockerfile',
    tiers: ['docker'],
    image: 'goose',
    env: 'plain',
    canary: /expected '' to match \/\\\/@cursor\\\/sdk\$\//,
    record: ({ run }) => {
      const [image] = run.stack.images
      assert.match(image?.base ?? '', /^evalsuite-dockerfile:docker-[0-9a-f]{16}$/)
      assert.match(
        image?.agentCli ?? '',
        new RegExp(`${GOOSE_CLI_VERSION.replaceAll('.', '\\.')}$`),
      )
    },
  },
  {
    dir: 'harness/pi-dockerfile',
    tiers: ['docker'],
    image: 'pi',
    env: 'plain',
    canary: /expected '' to match \/\\\/@cursor\\\/sdk\$\//,
    record: ({ run }) => {
      const [image] = run.stack.images
      assert.match(image?.base ?? '', /^evalsuite-dockerfile:docker-[0-9a-f]{16}$/)
      assert.equal(image?.agentCli, PI_CLI_VERSION)
    },
  },
  {
    dir: 'env/setup-order',
    tiers: ['fake', 'docker'],
    env: 'ordered',
    canary: /expected 'one\\ntwo\\n' to be 'two\\none\\n'/,
  },
  {
    dir: 'env/setup-timeout',
    tiers: ['fake', 'docker'],
    env: 'slow',
    canaryEnv: 'quick',
    lands: {
      outcome: 'infra_error',
      error: {
        kind: 'infra',
        message:
          /^setup step 1\/1 "sleep 30 && touch slept" in environment slow timed out after 1s \(see setup\.log\)$/,
      },
    },
    canary: /expected '' to be null/,
  },
]

/** Paths under `dir` whose content includes `needle`, one per line; '' when none do. */
function filesContaining(dir: string, needle: string): string {
  try {
    return execFileSync('grep', ['-rlF', needle, dir], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** Paths under `dir` named `name`. */
function filesNamed(dir: string, name: string): string[] {
  return execFileSync('find', [dir, '-name', name], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

const imageBuilt = (ref: string) => {
  try {
    execFileSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const dockerReady = imageBuilt(DEFAULT_IMAGE)
const requireDocker = process.env.ES_TEST_REQUIRE_DOCKER === '1'
/** Real Cursor, for the attempt ledger (support/harnesses.ts). */
const cursorRow = harnesses.find((h) => h.id === 'cursor') as (typeof harnesses)[number]
/** The real tier runs only when asked, since it spends money; asked, it needs the key. */
const real = process.env.ES_TEST_REAL === '1'
const realModel = process.env.ES_REAL_MODEL ?? 'composer-2.5'
/** `ES_FIXTURE_TIERS=docker` (or `fake`) runs one tier only. */
const only = process.env.ES_FIXTURE_TIERS?.split(',')

/** Containers are removed by a detached `docker rm`, which may finish after the CLI exits. */
async function containersGone(runId: string, deadlineMs = 20_000): Promise<void> {
  const until = Date.now() + deadlineMs
  let left = ''
  do {
    left = execFileSync('docker', ['ps', '-aq', '--filter', `label=${LABEL.run}=${runId}`], {
      encoding: 'utf8',
    }).trim()
    if (!left) return
    await new Promise((r) => setTimeout(r, 250))
  } while (Date.now() < until)
  assert.equal(left, '', `containers of run ${runId} still exist after ${deadlineMs / 1000}s`)
}

function skipTier(tier: Tier, image?: BakedHarness): string | false {
  if (only && !only.includes(tier)) return `ES_FIXTURE_TIERS=${only.join(',')}`
  if (tier === 'real')
    return real ? false : 'set ES_TEST_REAL=1 (and CURSOR_API_KEY) for real Cursor'
  if (tier === 'docker' && !requireDocker) {
    if (!dockerReady) return `needs Docker and ${DEFAULT_IMAGE}`
    if (image && !imageBuilt(imageFor(image))) return `needs ${imageFor(image)}`
  }
  return false
}

function fixtureTests(tiers: Tier[]) {
  for (const f of features) {
    for (const tier of f.tiers.filter((t) => tiers.includes(t))) {
      const timeout = { fake: 60_000, docker: 240_000, real: 600_000 }[tier]
      test(`${f.dir} [${tier}]`, { skip: skipTier(tier, f.image), timeout }, async () => {
        if (tier === 'real') {
          assert.ok(process.env.CURSOR_API_KEY, 'the real tier needs CURSOR_API_KEY')
          reserveAttempts(cursorRow, 2, `fixture ${f.dir}`)
        }
        const p = await fixture(`features/${f.dir}`)
        f.prepare?.(p.dir)
        const r = await runCli(p.dir, tier === 'real' ? ['run', '--concurrency', '1'] : ['run'], {
          env: {
            ...(typeof f.hostEnv === 'function' ? f.hostEnv(p.dir) : f.hostEnv),
            ES_FIXTURE_SANDBOX: tier === 'fake' ? 'fake' : 'docker',
            ...(tier === 'real'
              ? {
                  ES_FIXTURE_HARNESS: 'cursor',
                  ES_REAL_MODEL: realModel,
                  CURSOR_API_KEY: process.env.CURSOR_API_KEY,
                }
              : {}),
          },
          timeoutMs: timeout - 10_000,
        })
        const sandbox = tier === 'fake' ? 'fake' : 'docker'
        const harness = tier === 'real' ? `cursor:${realModel}` : 'fake'
        const { run, dir: runDir } = readRun(p.dir)
        expectRun(r, run, {
          code: 1,
          evals: {
            lands: { outcome: 'pass', ...f.lands, attempts: [`${harness}/${f.env}/${sandbox}#1`] },
            canary: {
              outcome: 'fail',
              attempts: [`${harness}/${f.canaryEnv ?? f.env}/${sandbox}#1`],
              error: { kind: 'assertion', message: f.canary },
            },
          },
        })
        await f.record?.({ run, project: p.dir, runDir, tier })
        assert.deepEqual(liveSandboxes(p), [], 'every sandbox is removed')
        if (tier !== 'fake') await containersGone(run.runId)
      })
    }
  }
}

describe('feature fixtures', { concurrency: 4 }, () => fixtureTests(['fake', 'docker']))
// Real attempts run one at a time (test-strategy §5), each within its own timeout.
describe('feature fixtures on real Cursor', { concurrency: 1 }, () => fixtureTests(['real']))

test('every feature fixture is in the table, with one check and a canary', () => {
  const root = join(testDir, 'features')
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((group) =>
      readdirSync(join(root, group.name), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `${group.name}/${d.name}`),
    )
    .sort()
  assert.deepEqual(dirs, features.map((f) => f.dir).sort())
  for (const dir of dirs) {
    const evals = readdirSync(join(root, dir, 'evals')).filter((f) => f.endsWith('.es.ts'))
    assert.deepEqual(evals.sort(), ['canary.es.ts', 'lands.es.ts'], dir)
    assert.ok(existsSync(join(root, dir, 'es.config.ts')), dir)
  }
})
