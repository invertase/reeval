// Tiers F, D and C: one directory per feature under test/features/, each with one check
// (evals/lands.eval.ts) and a canary that must fail (evals/canary.eval.ts). The same fixture runs on
// the fake sandbox, in Docker when Docker and reeval's image are there, and on real Cursor with
// REEVAL_TEST_REAL=1 and CURSOR_API_KEY. The oracle here checks the record from outside; see
// test/features/README.md for adding one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
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
import { ANTIGRAVITY_CLI_VERSION } from '@reeval/harness-antigravity'
import { CODEX_CLI_VERSION } from '@reeval/harness-codex'
import { GOOSE_CLI_VERSION } from '@reeval/harness-goose'
import { OPENCODE_CLI_VERSION } from '@reeval/harness-opencode'
import { PI_CLI_VERSION } from '@reeval/harness-pi'
import { type BakedHarness, DEFAULT_IMAGE, imageFor, LABEL } from '@reeval/sandbox-docker'
import { pngSize, stubPng } from '../src/capture/stub.ts'
import type { RunRecord } from '../src/history/types.ts'
import { liveSandboxes, readRun, runCli, spawnTool } from './helpers.ts'
import { fixture, testDir } from './support/fixture.ts'
import { type GitHttp, gitHttpServer } from './support/git-http.ts'
import {
  type HarnessRow,
  harnesses,
  harnessOf,
  keyOf,
  reserveAttempts,
} from './support/harnesses.ts'
import { type EvalExpectation, expectRun } from './support/oracle.ts'
import { SEEDED_RUN_ID, writeStoppedStaging } from './support/resume.ts'

/** `real` is Docker with real Cursor (REEVAL_FIXTURE_HARNESS=cursor), one fixture at a time. */
type Tier = 'fake' | 'docker' | 'real'

type Feature = {
  /** Under `test/features/`. */
  dir: string
  tiers: Tier[]
  /** The environment the evals run in: attempt ids are `fake/<env>/<sandbox>#1`. */
  env: string
  /** Cell sandbox id, when it isn't the tier default (`fake` or `docker`). */
  sandbox?: string
  /**
   * Cell environments in plan order, when an eval runs more than one (a compare).
   * Defaults to `[env]`.
   */
  cells?: string[]
  /** Canary cell environments in plan order. Defaults to `cells`, then `[canaryEnv ?? env]`. */
  canaryCells?: string[]
  /** What the canary's failure says: proof it failed on the check, not on setup. */
  canary: RegExp
  /** The canary's environment, when it needs another one; defaults to `env`. */
  canaryEnv?: string
  /** Canary cell environments that must pass. The other canary attempts must match `canary`. */
  canaryPass?: string[]
  /** When the check is that the attempt fails, e.g. an infra error; else it must pass. */
  lands?: Pick<EvalExpectation, 'outcome' | 'error'>
  /** With `lands.error`, the cell environments whose attempts must pass instead. */
  landsPass?: string[]
  /**
   * Host variables for `reeval run`, e.g. what `secret.fromEnv` reads; a function runs at test time,
   * with the copied project's directory.
   */
  hostEnv?: NodeJS.ProcessEnv | ((dir: string) => NodeJS.ProcessEnv)
  /** Where `reeval run` starts, under the copied project; defaults to its root. */
  cwd?: string
  /** Runs on the copied project before `reeval run`. */
  prepare?: (dir: string) => void
  /** Needs POSIX file modes on the host, so the fake tier skips on Windows. */
  posixModes?: true
  /** A host-side cross-check of the record, independent of the in-sandbox check. */
  record?: (view: {
    run: RunRecord
    project: string
    runDir: string
    tier: Tier
  }) => void | Promise<void>
  /** reeval's image the Docker tier needs, when it isn't Cursor's (a fake agent with `layout`). */
  image?: BakedHarness
  /**
   * The harness the real tier runs it on, with that contract row's model and key, when it isn't
   * Cursor: a harness-specific behaviour only that agent has.
   */
  realHarness?: HarnessRow['id']
  /**
   * `reeval run` bound for this fixture (node:test gets 10s more). Defaults: fake 60s,
   * docker 240s, real 600s.
   */
  timeoutMs?: Partial<Record<Tier, number>>
  /** Extra `reeval run` arguments, e.g. `--resume`. */
  args?: string[]
}

const TOKEN = 'reeval-fixture-token-7c1d9a0b52e4'
/** With characters each encoding changes: space, `/`, `+`, `"`, `&`, `?` and `=`. */
const LEAKY = 'reeval leak/7c+1d"9a&b?0=e4f2'

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
 * for the egress fixtures: `REEVAL_EGRESS_HOST` is its address, `REEVAL_EGRESS_TARGET` adds the port.
 */
const egressTarget = { host: '', port: 0, requests: 0 }
const listener = createServer((_, res) => {
  egressTarget.requests++
  res.end('reeval-egress-ok')
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

/** The token `workspace/token` fetches with, and the git HTTP server that insists on it. */
const GIT_TOKEN = 'reeval-fixture-git-token-5e0b77c2d9a1'
let gitHttp: GitHttp
before(async () => {
  gitHttp = await gitHttpServer(GIT_TOKEN)
})
after(() => gitHttp.close())

/** Every file under `dir`, for a check that a value was written to none of them. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))

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

/** `npm pack` of `cwd` into `out`: the tarball's name. */
function npmPack(cwd: string, out: string): string {
  const r = spawnTool('npm', ['pack', '--silent', '--pack-destination', out], {
    cwd,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

/** Packs each `<dir>/<version>/` with `npm pack` into the local registry, oldest first. */
function publish(dir: string) {
  const out = join(dir, '.packed')
  mkdirSync(out, { recursive: true })
  for (const version of readdirSync(dir)
    .filter((v) => /^\d/.test(v))
    .sort()) {
    const file = npmPack(join(dir, version), out).trim().split('\n').at(-1) as string
    const { name } = JSON.parse(readFileSync(join(dir, version, 'package.json'), 'utf8'))
    const versions = npmRegistry.packages.get(name) ?? new Map<string, Buffer>()
    versions.set(version, readFileSync(join(out, file)))
    npmRegistry.packages.set(name, versions)
  }
}
const egressEnv = () => ({
  REEVAL_EGRESS_HOST: egressTarget.host,
  REEVAL_EGRESS_TARGET: `${egressTarget.host}:${egressTarget.port}`,
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

/**
 * `repo/` from `repo-src/`: `v1/` committed and tagged `v1`, then `v2/` committed on `main`. It
 * serves partial fetches, as a hosted repository does, so a `path` fetches only its blobs.
 */
const versionedRepo = (dir: string) => {
  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'uploadpack.allowFilter', 'true')
  for (const version of ['v1', 'v2']) {
    for (const entry of readdirSync(repo)) {
      if (entry !== '.git') rmSync(join(repo, entry), { recursive: true, force: true })
    }
    cpSync(join(dir, 'repo-src', version), repo, { recursive: true })
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', version)
    if (version === 'v1') git(repo, 'tag', 'v1')
  }
  return repo
}

const workspaceOf = (run: RunRecord) => run.environments.find((e) => e.workspace)?.workspace

/** The first judge call's recorded input, of the eval `name`'s first attempt. */
const judgeInputOf = (run: RunRecord, runDir: string, name = 'lands') => {
  const path = run.evals.find((e) => e.name === name)?.attempts[0]?.files.judgeInput?.path
  assert.ok(path, `${name} recorded its judge input`)
  const [input] = JSON.parse(readFileSync(join(runDir, path), 'utf8'))
  return input as {
    stateOptions?: Record<string, unknown>
    state: Record<string, unknown>
    dropped?: string[]
    artifacts?: Array<{ name: string; path: string; mediaType: string; bytes: number }>
  }
}

export const features: Feature[] = [
  {
    dir: 'config/found-from-subdirectory',
    tiers: ['fake', 'docker'],
    cwd: 'deep/nested',
    env: 'found',
    canary: /expected 'from the project root\\n' to be 'from the current directory\\n'/,
    record: ({ project }) =>
      assert.deepEqual(
        readdirSync(join(project, 'deep/nested')),
        ['marker.txt'],
        'the run is written under the config, not the current directory',
      ),
  },
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
      assert.deepEqual(skills(run)[0]?.excluded, ['.history/', 'evals/', 'greets.eval.ts']),
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
    dir: 'workspace/git-subpath',
    tiers: ['fake', 'docker'],
    env: 'app-v1',
    canary: /expected .*Hello.* to contain .*Ahoy/,
    prepare: versionedRepo,
    record: ({ run, project }) => {
      const repo = join(project, 'repo')
      assert.deepEqual(workspaceOf(run), {
        source: 'repo',
        ref: 'v1',
        path: 'app',
        commit: git(repo, 'rev-parse', 'v1'),
        tree: git(repo, 'rev-parse', 'v1:app'),
      })
      // A partial fetch: the cache has app/'s blobs, not the rest of the repository's.
      const [cache] = readdirSync(join(project, '.reeval/cache/git/repos'))
      const missing = git(
        join(project, '.reeval/cache/git/repos', cache ?? ''),
        'rev-list',
        '--objects',
        '--missing=print',
        git(repo, 'rev-parse', 'v1'),
      )
      assert.match(missing, new RegExp(`^\\?${git(repo, 'rev-parse', 'v1:README.md')}$`, 'm'))
      assert.doesNotMatch(
        missing,
        new RegExp(`^\\?${git(repo, 'rev-parse', 'v1:app/greet.js')}`, 'm'),
      )
    },
  },
  {
    dir: 'workspace/init',
    tiers: ['fake', 'docker'],
    env: 'with-git',
    canary: /expected '1\\n' to be '2\\n'/,
    prepare: versionedRepo,
    record: ({ run }) => assert.equal(workspaceOf(run)?.init, true),
  },
  {
    dir: 'workspace/token',
    tiers: ['fake', 'docker'],
    env: 'private',
    canary: /expected .*Hello.* to contain 'Ahoy'/,
    prepare: versionedRepo,
    hostEnv: (dir) => ({
      REEVAL_GIT_HTTP: gitHttp.serve(dir),
      REEVAL_FIXTURE_GIT_TOKEN: GIT_TOKEN,
    }),
    record: ({ run, project }) => {
      assert.equal(workspaceOf(run)?.ref, 'v1')
      const header = Buffer.from(`x-access-token:${GIT_TOKEN}`).toString('base64')
      for (const file of filesUnder(join(project, '.reeval'))) {
        const text = readFileSync(file, 'latin1')
        assert.ok(!text.includes(GIT_TOKEN) && !text.includes(header), `the token is in ${file}`)
      }
    },
  },
  {
    // Docker only: the fake sandbox runs on the host, whose environment has the variable.
    dir: 'workspace/token-sandbox-env',
    tiers: ['docker'],
    env: 'private',
    canary: /to contain '/,
    prepare: versionedRepo,
    hostEnv: (dir) => ({
      REEVAL_GIT_HTTP: gitHttp.serve(dir),
      REEVAL_FIXTURE_GIT_TOKEN: GIT_TOKEN,
    }),
  },
  {
    dir: 'workspace/missing-ref',
    tiers: ['fake', 'docker'],
    env: 'missing',
    canaryEnv: 'pinned',
    lands: {
      outcome: 'infra_error',
      error: {
        kind: 'infra',
        message:
          /^Workspace git\("\.\.\/repo#v9"\): the repository has no ref "v9" \(a branch, tag or commit SHA\)\.\n\(the workspace git\("\.\.\/repo#v9"\), set by environment missing, failed to prepare before the run started; every attempt that needs it fails with this\)$/,
      },
    },
    canary: /expected .*Hello.* to contain 'Ahoy'/,
    prepare: versionedRepo,
    record: ({ run }) => {
      const prepare = run.evals.flatMap((e) => e.attempts).find((a) => a.error?.prepare)
        ?.error?.prepare
      assert.deepEqual(prepare, {
        class: 'config',
        stage: 'workspace',
        ref: '../repo#v9',
        cause: null,
        log: null,
        setBy: ['environment missing'],
      })
    },
  },
  {
    dir: 'workspace/files-over-repo',
    tiers: ['fake', 'docker'],
    env: 'patched',
    canary: /to contain 'Hello'/,
    prepare: versionedRepo,
    record: ({ run }) => assert.deepEqual(envFiles(run), ['greet.js']),
  },
  {
    dir: 'workspace/setup-in-repo',
    tiers: ['fake', 'docker'],
    env: 'built',
    canary: /expected 'v1\\n' to be 'v2\\n'/,
    prepare: versionedRepo,
    record: ({ run, project }) =>
      assert.equal(workspaceOf(run)?.commit, git(join(project, 'repo'), 'rev-parse', 'v1')),
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
    dir: 'skills/npm-local-path',
    tiers: ['fake', 'docker'],
    env: 'npm-vendored',
    canary: /to contain 'Hello there, <name>\.'/,
    prepare(dir) {
      const vendor = join(dir, 'vendor')
      mkdirSync(vendor)
      for (const version of ['1.2.3', '1.2.4']) {
        npmPack(join(dir, 'packages', version), vendor)
      }
    },
    hostEnv: (dir) => ({ npm_config_cache: join(dir, '.npm-cache') }),
    record: ({ run }) =>
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.source]),
        [['house-greeting', 'npm:vendor/acme-skills-1.2.3.tgz:skills']],
      ),
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
    hostEnv: { REEVAL_FIXTURE_TOKEN: TOKEN },
    canary: /expected 'unset\\n' to be '\[REDACTED\]\\n'/,
    record: ({ runDir }) => assert.equal(filesContaining(runDir, TOKEN), ''),
  },
  {
    dir: 'secrets/checks-visible-to-checks',
    tiers: ['fake', 'docker'],
    env: 'tokens',
    hostEnv: { REEVAL_FIXTURE_TOKEN: TOKEN },
    canary: /expected '\[REDACTED\]' to be ''/,
    record: ({ runDir }) => assert.equal(filesContaining(runDir, TOKEN), ''),
  },
  {
    dir: 'secrets/brokered-agent-sees-placeholder',
    tiers: ['fake', 'docker'],
    env: 'keys',
    hostEnv: { REEVAL_FIXTURE_TOKEN: TOKEN },
    canary: /expected 'reeval_secret_[0-9A-Za-z]+…' to be '\[REDACTED\]'/,
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
    hostEnv: { REEVAL_FIXTURE_TOKEN: TOKEN },
    canary: /expected 'reeval_secret_[0-9A-Za-z]+…' to be '\[REDACTED\]'/,
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
    canary: /expected '' to match \/\^reeval_secret_\//,
  },
  {
    dir: 'secrets/redaction-coverage',
    tiers: ['fake', 'docker'],
    env: 'leaky',
    hostEnv: { REEVAL_FIXTURE_LEAKY: LEAKY },
    canary: /not to contain '\[REDACTED\]'/,
    async record({ project, runDir, tier }) {
      const env = { REEVAL_FIXTURE_LEAKY: LEAKY, REEVAL_FIXTURE_SANDBOX: tier }
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
    canary: /expected 'blocked by the reeval egress policy: …' to be 'reeval-egress-ok'/,
    record: ({ run }) => {
      const egress = landed(run)?.egress
      assert.deepEqual(egress?.policy, { allow: [egressTarget.host] })
      assert.deepEqual(egress?.allowed, [egressTarget.host])
      const [reached, ...more] = egress?.contacted ?? []
      assert.deepEqual(
        [reached?.host, reached?.port, reached?.connections, more],
        [egressTarget.host, egressTarget.port, 1, []],
      )
      assert.ok((reached?.sent ?? 0) > 0 && (reached?.received ?? 0) > 'reeval-egress-ok'.length)
      assert.deepEqual(egress?.blocked, [])
    },
  },
  {
    dir: 'egress/blocked-host-recorded',
    tiers: ['docker'],
    env: 'listed',
    canary:
      /expected 'blocked by the reeval egress policy: …' not to contain 'blocked by the reeval egress policy'/,
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
    hostEnv: () => ({ ...egressEnv(), REEVAL_FIXTURE_TOKEN: TOKEN }),
    canary: /expected 'blocked by the reeval egress policy: …' to be 'reeval-egress-ok'/,
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
    dir: 'sandbox/unprivileged',
    tiers: ['docker'],
    env: 'plain',
    canaryEnv: 'rooted',
    canary: /expected '0 00000000000000cb \/ 0' to be '10001 0000000000000000 \/ 10001'/,
  },
  {
    dir: 'sandbox/read-before-send',
    tiers: ['fake', 'docker'],
    env: 'notes',
    canary: /expected 'from the environment\\n' to be 'from the agent\\n'/,
    record: ({ run }) => {
      const [attempt] = run.evals.find((e) => e.name === 'lands')?.attempts ?? []
      assert.deepEqual(attempt?.turns, [], 'no turn was sent')
      assert.ok((attempt?.timings.setupMs ?? 0) > 0, 'the start is timed as setup')
    },
  },
  {
    dir: 'sandbox/concurrent-first-use',
    tiers: ['fake', 'docker'],
    env: 'notes',
    canary: /expected 'written' to be 'from the agent\\n'/,
    record: ({ run }) => {
      const [attempt] = run.evals.find((e) => e.name === 'lands')?.attempts ?? []
      assert.deepEqual(
        attempt?.checks.map((x) => [x.command, x.exitCode]),
        [['test -f notes.txt', 0]],
      )
    },
  },
  {
    dir: 'sandbox/write-file',
    tiers: ['fake', 'docker'],
    env: 'greeting',
    canary: /to deeply equal \[ 'greet\.js', 'notes\.md' \]/,
  },
  {
    dir: 'sandbox/write-file-edit',
    tiers: ['fake', 'docker'],
    env: 'greeting',
    canary: /expected \[ 'modified', 'modified' \] to deeply equal \[ 'added', 'modified' \]/,
  },
  {
    dir: 'sandbox/login-shell-path',
    tiers: ['docker'],
    env: 'plain',
    canaryEnv: 'stock',
    canary: /expected '' to be '\/opt\/reeval-fixture\/bin\/reeval-fixtur…'/,
    prepare: (dir) =>
      execFileSync(
        'docker',
        ['build', '--quiet', '--tag', 'reeval-fixture-login-path:latest', join(dir, 'image')],
        { stdio: 'ignore' },
      ),
  },
  {
    dir: 'sandbox/login-shell-path-dockerfile',
    tiers: ['docker'],
    env: 'plain',
    canaryEnv: 'stock',
    canary: /expected '' to be '\/opt\/reeval-fixture\/bin\/reeval-fixtur…'/,
  },
  {
    dir: 'sandbox/limits',
    tiers: ['docker'],
    env: 'plain',
    canaryEnv: 'unlimited',
    canary:
      /expected '4294967296\\n\d+ 100000\\n1024\\n' to be '536870912\\n100000 100000\\n256\\n'/,
  },
  {
    dir: 'sandbox/swap',
    tiers: ['docker'],
    env: 'plain',
    canaryEnv: 'doubled',
    canary: /expected '536870912\\n' to be '268435456\\n'/,
  },
  {
    dir: 'sandbox/oom-is-infra',
    tiers: ['docker'],
    env: 'small',
    lands: {
      outcome: 'infra_error',
      error: {
        kind: 'infra',
        message:
          /^out of memory: \d+ process(es)? killed at the 128m limit \(\+128m swap\); raise docker\(\{ memory \}\)$/,
      },
    },
    canary: /expected command to succeed, exit code 137/,
    record: ({ run }) => {
      const [lands, canary] = ['lands', 'canary'].map(
        (name) => run.evals.find((e) => e.name === name)?.attempts[0]?.error,
      )
      assert.equal(lands?.resource?.cause, 'oom')
      assert.ok((lands?.resource?.kills ?? 0) > 0, JSON.stringify(lands))
      assert.equal(canary?.resource, undefined)
    },
  },
  {
    dir: 'env/files-home',
    tiers: ['fake', 'docker'],
    env: 'home-files',
    canary: /expected null to be 'from home'/,
  },
  {
    dir: 'env/sandbox-image',
    tiers: ['fake', 'docker'],
    env: 'python',
    sandbox: 'python',
    canary: /expected 'python' to be 'docker'/,
  },
  {
    dir: 'env/sandbox-extend-replace',
    tiers: ['fake', 'docker'],
    env: 'child',
    sandbox: 'child',
    canary: /expected 'child' to be 'parent'/,
  },
  {
    dir: 'env/sandbox-inherit',
    tiers: ['fake', 'docker'],
    env: 'plain',
    sandbox: 'from-root',
    cells: ['plain', 'skilled'],
    canary: /expected 'from-root' to be 'from-config-env'/,
  },
  {
    dir: 'compare/independent',
    tiers: ['fake', 'docker'],
    env: 'variant',
    cells: ['baseline', 'variant'],
    canaryPass: ['baseline'],
    canary: /expected null to be 'baseline-only'/,
    record: ({ run }) => {
      assert.deepEqual(run.environments.map((e) => e.name).sort(), ['baseline', 'variant'])
      const variant = run.environments.find((e) => e.name === 'variant')
      assert.equal(variant?.parent, null)
      assert.deepEqual(
        variant?.files.map((f) => f.path),
        ['from-variant.txt'],
      )
      assert.ok(
        run.evals.every((e) => e.compare?.baseline === 'baseline'),
        JSON.stringify(run.evals.map((e) => e.compare)),
      )
    },
  },
  {
    dir: 'compare/check-not-run',
    tiers: ['fake'],
    env: 'marked',
    cells: ['plain', 'marked'],
    lands: {
      outcome: 'pass',
      error: { kind: 'assertion', message: /has the marker: expected file marker\.txt to exist/ },
    },
    landsPass: ['marked'],
    canary: /has the marker: expected (file )?marker\.txt/,
    record: ({ run }) => {
      const lands = run.evals.find((e) => e.name === 'lands')
      assert.deepEqual(
        lands?.attempts.map((a) => a.assertions?.map((x) => x.label)),
        [['has the marker'], ['has the marker', 'reached']],
        'the control never reaches its second check',
      )
      const variant = lands?.cells.find((c) => c.role === 'variant')
      assert.deepEqual(variant?.checks, [
        {
          label: 'has the marker',
          pass: 1,
          fail: 0,
          error: 0,
          notRun: 0,
          control: { pass: 0, fail: 1, error: 0, notRun: 0 },
          verdict: 'discriminates',
        },
        {
          label: 'reached',
          pass: 1,
          fail: 0,
          error: 0,
          notRun: 0,
          control: { pass: 0, fail: 0, error: 0, notRun: 1 },
          verdict: 'discriminates',
        },
      ])
    },
  },
  {
    dir: 'compare/baseline-omitted',
    tiers: ['fake', 'docker'],
    env: 'variant',
    cells: ['inherited', 'variant'],
    canaryPass: ['variant'],
    canary: /expected null to be 'variant-only'/,
    record: ({ run }) => {
      assert.deepEqual(run.environments.map((e) => e.name).sort(), ['inherited', 'variant'])
      for (const e of run.evals) {
        assert.deepEqual(e.compare, { baseline: 'inherited', from: 'environment' })
        const control = e.cells.find((c) => c.role === 'control')
        assert.equal(control?.environment, 'inherited')
        assert.ok(e.cells.find((c) => c.role === 'variant')?.lift, JSON.stringify(e.cells))
      }
    },
  },
  {
    dir: 'compare/baseline-empty',
    tiers: ['fake', 'docker'],
    env: 'variant',
    cells: ['baseline', 'variant'],
    canaryPass: ['variant'],
    canary: /expected null to be 'variant-only'/,
    record: ({ run }) => {
      const empty = run.environments.find((e) => e.name === 'baseline')
      assert.deepEqual(empty?.files, [])
      for (const e of run.evals) {
        assert.deepEqual(e.compare, { baseline: 'baseline', from: 'empty' })
        assert.ok(e.cells.find((c) => c.role === 'variant')?.lift, JSON.stringify(e.cells))
      }
    },
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
    dir: 'env/files-directory',
    tiers: ['fake', 'docker'],
    env: 'fixture-dir',
    canary:
      /expected '\.\/README\.md\\n\.\/lib\/build\/tool\.js\\n\.\/p…' to be '\.\/README\.md\\n\.\/dist\/app\.js\\n\.\/lib\/bui…'/,
    prepare: (dir) => {
      for (const path of ['node_modules/dep/index.js', 'dist/app.js']) {
        mkdirSync(dirname(join(dir, 'fixture', path)), { recursive: true })
        writeFileSync(join(dir, 'fixture', path), 'ignored by default')
      }
    },
    record: ({ run }) => {
      const env = run.environments.find((e) => e.name === 'fixture-dir')
      assert.deepEqual(
        env?.files.map((f) => f.path),
        ['README.md', 'lib/build/tool.js', 'package.json', 'src/index.js'],
      )
      const readme = env?.files.find((f) => f.path === 'README.md')
      assert.equal(readme?.sha256, createHash('sha256').update('overridden').digest('hex'))
    },
  },
  {
    dir: 'env/files-directory-executable',
    tiers: ['fake', 'docker'],
    env: 'executables',
    posixModes: true,
    canary: /expected 'bin\/run\.sh x\\nnotes\.txt -\\n' to be 'bin\/run\.sh x\\nnotes\.txt x\\n'/,
    prepare: (dir) => {
      chmodSync(join(dir, 'fixture/bin/run.sh'), 0o755)
      chmodSync(join(dir, 'fixture/notes.txt'), 0o644)
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
    dir: 'harness/opencode-web-search',
    tiers: ['real'],
    realHarness: 'opencode',
    env: 'closed',
    canary: /expected no web searches, got \[/,
    record: ({ run }) => {
      const attempt = landed(run)
      assert.ok((attempt?.activity.webSearches ?? 0) >= 1, 'the search is in the record')
      assert.ok(
        attempt?.egress?.contacted.some((h) => h.host === 'mcp.exa.ai'),
        JSON.stringify(attempt?.egress),
      )
      assert.deepEqual(attempt?.egress?.blocked, [], 'nothing it needed was refused')
    },
  },
  {
    dir: 'harness/opencode-provider-key',
    tiers: ['real'],
    realHarness: 'opencode-anthropic',
    env: 'closed',
    canary: /to have a length of 2 but got 1/,
    record: ({ run }) => {
      const attempt = landed(run)
      assert.ok(
        attempt?.servedModels?.some((m) => /^claude-haiku-4-5/.test(m)),
        JSON.stringify(attempt?.servedModels),
      )
      assert.ok(
        attempt?.egress?.contacted.some((h) => h.host === 'api.anthropic.com'),
        JSON.stringify(attempt?.egress),
      )
      // The agent sometimes also hits registry.npmjs.org; that is curiosity, not a
      // missing brokered host.
      assert.deepEqual(
        (attempt?.egress?.blocked ?? []).filter((h) => h.host === 'api.anthropic.com'),
        [],
        'the provider host was not refused',
      )
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
    dir: 'harness/codex-rules',
    tiers: ['fake', 'docker'],
    image: 'codex',
    env: 'house-rules',
    canary: /expected null to be 'Always write tests\.'/,
    record: ({ run }) => assert.deepEqual(envFiles(run), ['AGENTS.md']),
  },
  {
    dir: 'harness/codex-workspace-skills',
    tiers: ['fake', 'docker'],
    image: 'codex',
    env: 'greeting',
    canary: /expected \[ '' \] to deeply equal \[ '\.\/SKILL\.md' \]/,
  },
  {
    dir: 'harness/codex-home-skills',
    tiers: ['fake', 'docker'],
    image: 'codex',
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
      assert.match(image?.base ?? '', /^reeval-dockerfile:docker-[0-9a-f]{16}$/)
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
      assert.match(image?.base ?? '', /^reeval-dockerfile:docker-[0-9a-f]{16}$/)
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
      assert.match(image?.base ?? '', /^reeval-dockerfile:docker-[0-9a-f]{16}$/)
      assert.equal(image?.agentCli, `opencode v${OPENCODE_CLI_VERSION}`)
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
      assert.match(image?.base ?? '', /^reeval-dockerfile:docker-[0-9a-f]{16}$/)
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
      assert.match(image?.base ?? '', /^reeval-dockerfile:docker-[0-9a-f]{16}$/)
      assert.equal(image?.agentCli, PI_CLI_VERSION)
    },
  },
  {
    dir: 'harness/codex-dockerfile',
    tiers: ['docker'],
    image: 'codex',
    env: 'plain',
    canary: /expected '' to match \/\\\/@cursor\\\/sdk\$\//,
    record: ({ run }) => {
      const [image] = run.stack.images
      assert.match(image?.base ?? '', /^reeval-dockerfile:docker-[0-9a-f]{16}$/)
      assert.equal(image?.agentCli, `codex-cli ${CODEX_CLI_VERSION}`)
    },
  },
  {
    dir: 'harness/effort-requested-and-served',
    tiers: ['fake', 'docker'],
    env: 'plain',
    canary: /expected 'fake-1\[effort=medium\]' to be 'fake-1\[effort=high\]'/,
    record: ({ run }) => {
      const attempt = landed(run)
      const cell = run.evals.find((e) => e.name === 'lands')?.cells[0]
      const harness = run.stack.harnesses[0]
      assert.equal(cell?.effort, 'high')
      assert.equal(attempt?.effort, 'high')
      assert.equal(attempt?.servedEffort, 'medium')
      assert.equal(harness?.effort, 'high')
      assert.deepEqual(harness?.resolvedEffort, ['medium'])
    },
  },
  {
    dir: 'harness/turn-aborted-on-timeout',
    tiers: ['fake', 'docker', 'real'],
    env: 'plain',
    lands: {
      outcome: 'fail',
      error: { kind: 'timeout', message: /^The eval timed out$/ },
    },
    canary: /expected 'completed' to be 'aborted'/,
    record: ({ run }) => assert.equal(landed(run)?.turns[0]?.status, 'aborted'),
    // Lands waits a 4s eval timeout; the canary waits the 10s fake delay, on top of
    // FAKE_TIMEOUT_MS's Windows load.
    timeoutMs: { fake: 180_000 },
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
  {
    dir: 'env/setup-missing-cwd',
    tiers: ['fake', 'docker'],
    env: 'missing',
    canaryEnv: 'present',
    lands: {
      outcome: 'infra_error',
      error: {
        kind: 'infra',
        message:
          /^setup step 1\/1 "touch ran" in environment missing exited [1-9]\d* after \d+m?s \(see setup\.log\):\n.*nope\/dir/,
      },
    },
    canary: /expected '' to be null/,
  },
  {
    dir: 'judge/build-output',
    tiers: ['fake'],
    env: 'built-app',
    canary: /expected '.*' to contain 'var bundle'/s,
    record: ({ run, runDir }) =>
      assert.deepEqual(judgeInputOf(run, runDir).dropped, [
        'dist/ (1 file): build output',
        'public/vendor.js: minified, a line of 1616 characters',
      ]),
  },
  {
    dir: 'judge/state-diff',
    tiers: ['fake'],
    env: 'scoped-app',
    canary: /expected \[ 'added src\/app\.ts' \] to deeply equal/,
    record: ({ run, runDir }) =>
      assert.deepEqual(judgeInputOf(run, runDir).dropped, [
        'notes.md: not in state.diff',
        'src/app.test.ts: not in state.diff',
      ]),
  },
  {
    dir: 'judge/state-contents-glob',
    tiers: ['fake'],
    env: 'glob-app',
    canary: /expected \[ 'src\/app\.ts', 'src\/util\.ts' \] to deeply equal/,
    record: ({ run, runDir }) => {
      const { state } = judgeInputOf(run, runDir)
      assert.doesNotMatch(
        String(state.diff),
        /export const twice/,
        'shown in full, not in the diff',
      )
    },
  },
  {
    dir: 'judge/state-off',
    tiers: ['fake'],
    env: 'off-app',
    canary: /expected \[ 'output' \] to deeply equal \[ 'output', 'diff' \]/,
    record: ({ run, runDir }) =>
      assert.deepEqual(judgeInputOf(run, runDir).stateOptions, {
        task: false,
        output: true,
        files: false,
        diff: false,
        contents: [],
        transcript: false,
        turns: 'last',
        checks: false,
      }),
  },
  {
    dir: 'judge/state-transcript',
    tiers: ['fake'],
    env: 'transcript-app',
    canary: /expected '.*' to contain 'thinking it over'/s,
    record: ({ run, runDir }) =>
      assert.equal(judgeInputOf(run, runDir).stateOptions?.transcript, 'tools'),
  },
  {
    dir: 'judge/state-turns',
    tiers: ['fake'],
    env: 'turns-app',
    canary: /expected \[ 'write the app', 'now add tests' \] to deeply equal \[ 'now add tests' \]/,
    record: ({ run, runDir }) => {
      const { state } = judgeInputOf(run, runDir)
      assert.equal(state.task, undefined, 'the task is under turns')
    },
  },
  {
    dir: 'judge/state-checks',
    tiers: ['fake'],
    env: 'checks-app',
    canary: /to deeply equal \[ { command: 'echo first'/,
  },
  {
    dir: 'judge/state-cascade',
    tiers: ['fake'],
    env: 'cascade-app',
    canary: /expected \{ files: \[ 'added src\/app\.ts' \], …\(1\) \} to deeply equal/,
    record: ({ run }) => assert.deepEqual(run.stack.judge.state?.diff, ['src/']),
  },
  {
    dir: 'assert/labelled',
    tiers: ['fake', 'docker'],
    env: 'plain',
    canary: /writes the marker: expected marker\.txt to match \/nope\//,
    record: ({ run }) => {
      const recorded = (name: string) =>
        run.evals
          .find((e) => e.name === name)
          ?.attempts[0]?.assertions?.map(({ durationMs, ...x }) => {
            assert.equal(typeof durationMs, 'number', 'an async matcher is timed')
            return x
          })
      assert.deepEqual(recorded('lands'), [
        {
          label: 'writes the marker',
          labelled: true,
          matcher: 'toHaveFile',
          status: 'pass',
          soft: false,
        },
      ])
      assert.equal(recorded('canary')?.[0]?.status, 'fail')
    },
  },
  {
    dir: 'assert/called-skill',
    tiers: ['fake'],
    env: 'plain',
    canary: /expected skill-like calls matching other/,
  },
  {
    dir: 'assert/called-skill-path',
    tiers: ['fake'],
    env: 'skilled',
    canary: /expected skill-like calls matching other/,
  },
  {
    dir: 'assert/called-mcp',
    tiers: ['fake'],
    env: 'plain',
    canary: /expected MCP calls matching stamp\/other/,
  },
  {
    dir: 'assert/called-tool-mcp',
    tiers: ['fake'],
    env: 'plain',
    canary: /expected tool calls matching mcp__stamp__other/,
  },
  {
    dir: 'assert/ran',
    tiers: ['fake'],
    env: 'plain',
    canary: /expected shell commands matching \/deploy\//,
  },
  {
    dir: 'assert/edited',
    tiers: ['fake'],
    env: 'plain',
    canary: /expected file edits matching other\.txt/,
  },
  {
    dir: 'assert/changed',
    tiers: ['fake', 'docker'],
    env: 'seeded',
    canary: /expected no changes to test\/\*\*, got \["test\/greet\.test\.js" \(modified\)\]/,
  },
  {
    dir: 'judge/state-contents',
    tiers: ['fake'],
    env: 'readme-app',
    canary: /to deeply equal \{ 'README\.md': 'Run npm test\\n'/,
    record: ({ run, runDir }) => {
      const { state } = judgeInputOf(run, runDir)
      assert.deepEqual(Object.keys(state.contents as object), [
        'README.md',
        'missing.md',
        'src/app.ts',
      ])
      assert.doesNotMatch(String(state.diff), /export const app/, 'shown in full, not in the diff')
    },
  },
  {
    dir: 'judge/artifacts',
    tiers: ['fake', 'docker'],
    env: 'ui',
    canary: /expected 'image\/png' to be 'image\/jpeg'/,
    record: ({ run, runDir }) => {
      const input = judgeInputOf(run, runDir)
      assert.equal(input.artifacts?.[0]?.name, 'form')
      assert.equal(input.artifacts?.[0]?.mediaType, 'image/png')
      assert.equal(input.artifacts?.[0]?.path, 'artifacts/form.png')
      assert.ok(input.artifacts?.[0]?.bytes, 'ref names the PNG size')
      assert.doesNotMatch(JSON.stringify(input.state), /"type":"file"/)
      const judged = run.evals.find((e) => e.name === 'lands')?.attempts[0]?.judgements[0]
      assert.equal(judged?.artifacts?.[0]?.name, 'form')
    },
  },
  {
    dir: 'ui/capture',
    tiers: ['fake', 'docker'],
    env: 'ui',
    canary: /expected 'artifacts\/home\.png' to be 'artifacts\/wrong\.png'/,
    record: ({ run, runDir, tier }) => {
      const art = landed(run)?.files.artifacts?.[0]
      assert.ok(art, 'files.artifacts names the PNG')
      assert.match(art.path, /artifacts\/home\.png$/)
      assert.equal(art.name, 'home')
      assert.equal(art.mediaType, 'image/png')
      const bytes = readFileSync(join(runDir, art.path))
      const viewport = art.capture?.viewport ?? { width: 1280, height: 720 }
      const port = art.capture?.port ?? 0
      if (tier === 'fake') {
        assert.deepEqual(bytes, stubPng('home', port, '/', viewport))
      } else {
        assert.deepEqual(pngSize(bytes), viewport)
      }
    },
  },
  {
    dir: 'ui/capture-concurrent',
    tiers: ['fake', 'docker'],
    env: 'ui',
    canary: /expected 'artifacts\/home\.png' to be 'artifacts\/wrong\.png'/,
    record: ({ run, runDir, tier }) => {
      const arts = landed(run)?.files.artifacts ?? []
      assert.equal(arts.length, 2, 'both concurrent captures land')
      assert.deepEqual(arts.map((a) => a.name).sort(), ['about', 'home'])
      for (const art of arts) {
        assert.match(art.path, new RegExp(`artifacts/${art.name}\\.png$`))
        const bytes = readFileSync(join(runDir, art.path))
        const viewport = art.capture?.viewport ?? { width: 1280, height: 720 }
        const port = art.capture?.port ?? 0
        const path = art.capture?.path ?? '/'
        if (tier === 'fake') {
          assert.deepEqual(bytes, stubPng(art.name, port, path, viewport))
        } else {
          assert.deepEqual(pngSize(bytes), viewport)
        }
      }
    },
  },
  {
    dir: 'ui/capture-unreachable',
    tiers: ['fake', 'docker'],
    env: 'plain',
    lands: {
      outcome: 'fail',
      error: {
        kind: 'assertion',
        message: /nothing listening on port 59999/,
      },
    },
    canary: /expected 'nothing listening on port 59999' to be 'port is closed'/,
  },
  {
    dir: 'ui/background-compound',
    tiers: ['fake', 'docker'],
    env: 'plain',
    canary: /expected 'started' to be 'stopped'/,
  },
  {
    dir: 'ui/serve-redirect',
    tiers: ['fake', 'docker'],
    env: 'ui',
    canary: /expected 'listening on \d+' to be 'listening on 1'/,
  },
  {
    dir: 'ui/serve-kill',
    tiers: ['fake', 'docker'],
    env: 'ui',
    canary: /expected 'down' to be 'up'/,
  },
  {
    dir: 'ui/capture-browser-false',
    tiers: ['fake', 'docker'],
    env: 'plain',
    lands: {
      outcome: 'fail',
      error: {
        kind: 'assertion',
        message: /c\.capture\(\) is refused: capture\.browser is false/,
      },
    },
    canary: /expected 'c\.capture\(\) is refused: capture\.brows…' to match \/skipped\//,
    record: ({ run }) => {
      assert.equal(landed(run)?.files.artifacts, undefined)
    },
  },
  {
    dir: 'ui/capture-browser-env',
    tiers: ['fake', 'docker'],
    env: 'plain',
    hostEnv: { REEVAL_CAPTURE_BROWSER: '0' },
    lands: {
      outcome: 'fail',
      error: {
        kind: 'assertion',
        message: /c\.capture\(\) is refused: REEVAL_CAPTURE_BROWSER=0/,
      },
    },
    canary: /expected 'c\.capture\(\) is refused: REEVAL_CAPTUR…' to match \/skipped\//,
    record: ({ run }) => {
      assert.equal(landed(run)?.files.artifacts, undefined)
    },
  },
  {
    dir: 'ui/capture-no-download',
    tiers: ['fake', 'docker'],
    env: 'plain',
    hostEnv: (dir) => ({ XDG_CACHE_HOME: join(dir, '.cache') }),
    canary: /expected null to be 'present'/,
    record: ({ project }) => {
      const cache = join(project, '.cache', 'reeval')
      assert.equal(existsSync(join(cache, 'chrome-headless-shell')), false)
    },
  },
  {
    dir: 'ui/capture-wait-idle',
    tiers: ['fake', 'docker'],
    env: 'ui',
    canary: /expected 'artifacts\/home\.png' to be 'artifacts\/wrong\.png'/,
    record: ({ run, runDir, tier }) => {
      const art = landed(run)?.files.artifacts?.[0]
      assert.ok(art, 'files.artifacts names the PNG')
      assert.match(art.path, /artifacts\/home\.png$/)
      const bytes = readFileSync(join(runDir, art.path))
      const viewport = art.capture?.viewport ?? { width: 1280, height: 720 }
      const port = art.capture?.port ?? 0
      if (tier === 'fake') {
        assert.deepEqual(bytes, stubPng('home', port, '/', viewport))
      } else {
        assert.deepEqual(pngSize(bytes), viewport)
      }
    },
  },
  {
    // Docker only: the fake sandbox stubs the PNG and never waits on CDP.
    dir: 'ui/capture-wait-timeout',
    tiers: ['docker'],
    env: 'ui',
    lands: {
      outcome: 'fail',
      error: {
        kind: 'assertion',
        message: /c\.capture\(\) timed out waiting for networkAlmostIdle/,
      },
    },
    canary: /expected 'c\.capture\(\) timed out waiting for net…' to be 'still loading'/,
    record: ({ run }) => {
      assert.equal(landed(run)?.files.artifacts, undefined)
    },
  },
  {
    dir: 'ui/capture-use',
    tiers: ['fake'],
    env: 'ui',
    canary: /expected 'artifacts\/after-submit\.png' to be 'artifacts\/wrong\.png'/,
    record: ({ run, runDir }) => {
      const art = landed(run)?.files.artifacts?.[0]
      assert.ok(art, 'files.artifacts names the PNG')
      assert.match(art.path, /artifacts\/after-submit\.png$/)
      assert.deepEqual(art.capture?.instructions, ['Fill in the sign-in form and submit'])
      const bytes = readFileSync(join(runDir, art.path))
      const viewport = art.capture?.viewport ?? { width: 1280, height: 720 }
      const port = art.capture?.port ?? 0
      assert.deepEqual(bytes, stubPng('after-submit', port, '/', viewport))
    },
  },
  {
    dir: 'ui/capture-full-page',
    tiers: ['fake', 'docker'],
    env: 'ui',
    canary: /expected 'full-page' to deeply equal \{ width: 1280, height: 720 \}/,
    record: ({ run, runDir, tier }) => {
      const art = landed(run)?.files.artifacts?.[0]
      assert.ok(art, 'files.artifacts names the PNG')
      assert.equal(art.capture?.fullPage, true)
      assert.deepEqual(art.capture?.viewport, { width: 1280, height: 720 })
      const bytes = readFileSync(join(runDir, art.path))
      const port = art.capture?.port ?? 0
      if (tier === 'fake') {
        assert.deepEqual(bytes, stubPng('tall', port, '/', 'full-page'))
      } else {
        assert.ok(pngSize(bytes).height > 720)
      }
    },
  },
  {
    dir: 'ui/capture-use-click',
    tiers: ['docker'],
    env: 'ui',
    canary: /expected 'no' to be 'yes'/,
    record: ({ run }) => {
      const art = landed(run)?.files.artifacts?.[0]
      assert.ok(art)
      assert.equal(art.capture?.use?.model, 'fake')
      assert.ok((art.capture?.use?.moves ?? 0) >= 1)
    },
  },
  {
    dir: 'ui/capture-use-wait',
    tiers: ['docker'],
    env: 'ui',
    canary: /expected 'no' to be 'yes'/,
    record: ({ run }) => {
      assert.deepEqual(landed(run)?.files.artifacts?.[0]?.capture?.instructions, [
        'fake[0]',
        'fake[1]',
      ])
    },
  },
  {
    dir: 'ui/capture-use-timeout',
    tiers: ['docker'],
    env: 'ui',
    lands: {
      outcome: 'fail',
      error: {
        kind: 'assertion',
        message: /c\.capture\(\) timed out on "fake\[0\]"/,
      },
    },
    canary: /expected 'c\.capture\(\) timed out on "fake\[0\]"' to be 'still loading'/,
    record: ({ run }) => {
      assert.equal(landed(run)?.files.artifacts, undefined)
    },
  },
  {
    dir: 'run/each-case',
    tiers: ['fake'],
    env: 'each-case',
    canary: /expected 'ahoy' to be 'hello'/,
    record: ({ run }) => {
      assert.equal(run.evals.find((e) => e.name === 'lands')?.family, undefined)
      assert.equal(run.families, undefined, 'one case is not a family')
    },
  },
  {
    dir: 'run/resume',
    tiers: ['fake'],
    env: 'resume',
    args: ['--resume'],
    canary: /expected 'resume' to be 'new-run'/,
    prepare: (dir) => writeStoppedStaging(dir, SEEDED_RUN_ID),
    record: ({ run, project }) => {
      assert.equal(run.runId, SEEDED_RUN_ID)
      assert.equal(readFileSync(join(project, '.reeval/current'), 'utf8').trim(), SEEDED_RUN_ID)
    },
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
const requireDocker = process.env.REEVAL_TEST_REQUIRE_DOCKER === '1'
/** Real Cursor, for the attempt ledger (support/harnesses.ts). */
const cursorRow = harnesses.find((h) => h.id === 'cursor') as (typeof harnesses)[number]
/** The contract row a fixture's real tier runs on: Cursor, or its `realHarness`. */
const realRowOf = (f: Feature) =>
  f.realHarness ? (harnesses.find((h) => h.id === f.realHarness) as HarnessRow) : cursorRow
/** Cursor's is REEVAL_REAL_MODEL's (default composer-2.5); another row's is its contract model. */
const realModelOf = (row: HarnessRow) => (row === cursorRow ? realModel : (row.model ?? ''))
/** The real tier runs only when asked, since it spends money; asked, it needs the key. */
const real = process.env.REEVAL_TEST_REAL === '1'
const realModel = process.env.REEVAL_REAL_MODEL ?? 'composer-2.5'
/** `REEVAL_FIXTURE_TIERS=docker` (or `fake`) runs one tier only. */
const only = process.env.REEVAL_FIXTURE_TIERS?.split(',')

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

function skipTier(tier: Tier, image?: BakedHarness, posixModes?: true): string | false {
  if (only && !only.includes(tier)) return `REEVAL_FIXTURE_TIERS=${only.join(',')}`
  if (tier === 'fake' && posixModes && process.platform === 'win32')
    return 'Windows has no executable bit'
  if (tier === 'real')
    return real ? false : 'set REEVAL_TEST_REAL=1 (and CURSOR_API_KEY) for real Cursor'
  if (tier === 'docker' && !requireDocker) {
    if (!dockerReady) return `needs Docker and ${DEFAULT_IMAGE}`
    if (image && !imageBuilt(imageFor(image))) return `needs ${imageFor(image)}`
  }
  return false
}

// Windows CI runs four fake fixtures at once on a slower runner: a typical one takes 20s
// there, and the slowest reach 60s.
const FAKE_TIMEOUT_MS = process.platform === 'win32' ? 150_000 : 60_000

function fixtureTests(tiers: Tier[]) {
  for (const f of features) {
    for (const tier of f.tiers.filter((t) => tiers.includes(t))) {
      const timeout =
        f.timeoutMs?.[tier] ?? { fake: FAKE_TIMEOUT_MS, docker: 240_000, real: 600_000 }[tier]
      test(`${f.dir} [${tier}]`, {
        skip: skipTier(tier, f.image, f.posixModes),
        timeout,
      }, async () => {
        const row = realRowOf(f)
        if (tier === 'real') {
          reserveAttempts(row, 2, `fixture ${f.dir}`)
        }
        const p = await fixture(`features/${f.dir}`)
        f.prepare?.(p.dir)
        const cwd = join(p.dir, f.cwd ?? '')
        const r = await runCli(
          cwd,
          ['run', ...(tier === 'real' ? ['--concurrency', '1'] : []), ...(f.args ?? [])],
          {
            env: {
              ...(typeof f.hostEnv === 'function' ? f.hostEnv(p.dir) : f.hostEnv),
              REEVAL_FIXTURE_SANDBOX: tier === 'fake' ? 'fake' : 'docker',
              ...(tier === 'real'
                ? {
                    REEVAL_FIXTURE_HARNESS: harnessOf(row),
                    REEVAL_REAL_MODEL: realModelOf(row),
                    ...(row.key ? { [row.key.name]: keyOf(row) } : {}),
                  }
                : {}),
            },
            timeoutMs: timeout - 10_000,
          },
        )
        const sandbox = f.sandbox ?? (tier === 'fake' ? 'fake' : 'docker')
        const harness =
          tier === 'real' ? `${harnessOf(row)}:${realModelOf(row).split('/').at(-1)}` : 'fake'
        const ids = (names: string[]) => names.map((env) => `${harness}/${env}/${sandbox}#1`)
        const { run, dir: runDir } = readRun(p.dir)
        expectRun(r, run, {
          code: 1,
          evals: {
            lands: {
              outcome: 'pass',
              ...f.lands,
              attempts: ids(f.cells ?? [f.env]),
              ...(f.landsPass ? { clean: ids(f.landsPass) } : {}),
            },
            canary: {
              outcome: 'fail',
              attempts: ids(f.canaryCells ?? f.cells ?? [f.canaryEnv ?? f.env]),
              error: { kind: 'assertion', message: f.canary },
              ...(f.canaryPass ? { clean: ids(f.canaryPass) } : {}),
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
// Real attempts run one at a time, each within its own timeout.
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
    const evals = readdirSync(join(root, dir, 'evals')).filter((f) => f.endsWith('.eval.ts'))
    assert.deepEqual(evals.sort(), ['canary.eval.ts', 'lands.eval.ts'], dir)
    assert.ok(existsSync(join(root, dir, 'reeval.config.ts')), dir)
  }
})
