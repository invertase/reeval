// Tiers F and D: one directory per feature under test/features/, each with one check
// (evals/lands.es.ts) and a canary that must fail (evals/canary.es.ts). The same fixture runs on
// the fake sandbox and, when Docker and ES's image are there, in Docker. The oracle here checks
// the record from outside; see test/features/README.md for adding one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { DEFAULT_IMAGE, LABEL } from '@evalsuite/sandbox-docker'
import type { RunRecord } from '../src/history/types.ts'
import { liveSandboxes, readRun, runCli } from './helpers.ts'
import { fixture, testDir } from './support/fixture.ts'
import { type EvalExpectation, expectRun } from './support/oracle.ts'

type Tier = 'fake' | 'docker'

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
  /** Host variables for `es run`, e.g. what `secret.fromEnv` reads. */
  hostEnv?: NodeJS.ProcessEnv
  /** Runs on the copied project before `es run`. */
  prepare?: (dir: string) => void
  /** A host-side cross-check of the record, independent of the in-sandbox check. */
  record?: (view: { run: RunRecord; project: string; runDir: string }) => void
}

const TOKEN = 'es-fixture-token-7c1d9a0b52e4'

const skills = (run: RunRecord) => run.environments.flatMap((e) => e.skills)

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

const features: Feature[] = [
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
    dir: 'skills/harness-placement',
    tiers: ['fake', 'docker'],
    env: 'greeting',
    canary: /expected '' to contain 'Greet people with "Ahoy, <name>!"\.'/,
    record: ({ run }) =>
      assert.deepEqual(
        skills(run).map((s) => [s.name, s.placement]),
        [['house-greeting', 'harness']],
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
    dir: 'env/files-home',
    tiers: ['fake', 'docker'],
    env: 'home-files',
    canary: /expected null to be 'from home'/,
  },
  {
    dir: 'env/rules',
    tiers: ['fake', 'docker'],
    env: 'house-rules',
    canary: /expected null to be 'Always write tests\.'/,
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

const dockerReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const requireDocker = process.env.ES_TEST_REQUIRE_DOCKER === '1'
/** `ES_FIXTURE_TIERS=docker` (or `fake`) runs one tier only. */
const only = process.env.ES_FIXTURE_TIERS?.split(',')

/**
 * Containers are removed by a detached `docker rm`, which may finish after the CLI exits, so this
 * waits for them. Run ids are per second and author, so concurrent temp projects can share one:
 * the label then also matches the other run's containers, which go too.
 */
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

function skipTier(tier: Tier): string | false {
  if (only && !only.includes(tier)) return `ES_FIXTURE_TIERS=${only.join(',')}`
  if (tier === 'docker' && !dockerReady && !requireDocker)
    return `needs Docker and ${DEFAULT_IMAGE}`
  return false
}

describe('feature fixtures', { concurrency: 4 }, () => {
  for (const f of features) {
    for (const tier of f.tiers) {
      const timeout = tier === 'docker' ? 240_000 : 60_000
      test(`${f.dir} [${tier}]`, { skip: skipTier(tier), timeout }, async () => {
        const p = await fixture(`features/${f.dir}`)
        f.prepare?.(p.dir)
        const r = await runCli(p.dir, ['run'], {
          env: { ...f.hostEnv, ES_FIXTURE_SANDBOX: tier },
          timeoutMs: timeout - 10_000,
        })
        const sandbox = tier === 'docker' ? 'docker' : 'fake'
        const { run, dir: runDir } = readRun(p.dir)
        expectRun(r, run, {
          code: 1,
          evals: {
            lands: { outcome: 'pass', ...f.lands, attempts: [`fake/${f.env}/${sandbox}#1`] },
            canary: {
              outcome: 'fail',
              attempts: [`fake/${f.canaryEnv ?? f.env}/${sandbox}#1`],
              error: { kind: 'assertion', message: f.canary },
            },
          },
        })
        f.record?.({ run, project: p.dir, runDir })
        assert.deepEqual(liveSandboxes(p), [], 'every sandbox is removed')
        if (tier === 'docker') await containersGone(run.runId)
      })
    }
  }
})

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
