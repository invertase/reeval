// The `examples/with-*` projects and what each must plan and do, for the example-*.test.ts files.
// node --test shards by file, and every example plans under a dozen profiles, so those files each
// take a quarter of the table.
import assert from 'node:assert/strict'
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { test } from 'node:test'
import { pkgRoot, readRun, runCli, tempDir } from '../helpers.ts'

export const examples = join(pkgRoot, '../../examples')

/** The harness each of `examples/profiles.ts`' profiles plans every cell on, in Docker. */
export const SHARED: Record<string, string> = {
  'claude-code': 'claude-code:claude-sonnet-5',
  cursor: 'cursor:composer-2.5',
  codex: 'codex:gpt-5.6-luna',
  opencode: 'opencode:gemini-3.8-flash',
  goose: 'goose:gemini-3.8-flash',
  pi: 'pi:gemini-3.8-flash',
  antigravity: 'antigravity:gemini-3.8-flash-medium',
  fx: 'fx:claude-sonnet-5',
  'grok-build': 'grok-build:grok-4.6',
}

/** The harnesses and sandboxes a plan's cells use, each sorted and without repeats. */
export type Plan = { harness: string[]; sandbox: string[] }

export type Example = {
  /**
   * Each cell's attempt outcomes once it has run on the fake agent, sorted; or, for an example
   * that is only planned, what running it needs (a key, Docker, Chrome or the network).
   */
  run: Record<string, string[]> | { needs: string }
  /** What it plans with no profile; default the fake agent in the fake sandbox. */
  plain?: Plan
  /**
   * What it plans under each shared profile, from the profile's harness; default every cell on
   * that harness in Docker.
   */
  shared?: (harness: string) => Plan
  /** What it plans under each of its own profiles. */
  profiles?: Record<string, Plan>
  /** `reeval run`'s exit code on the fake agent; default 0. */
  exit?: number
  /**
   * The fake agent flakes at random, so only each cell's attempt count holds, every outcome is a
   * pass or a fail, and the run may exit 0 or 1.
   */
  flaky?: true
}

const fakePlan: Plan = { harness: ['fake'], sandbox: ['fake'] }
const inDocker = (harness: string): Plan => ({ harness: [harness], sandbox: ['docker'] })

const fakeInDocker = inDocker('fake')
const pass = (n: number) => Array<string>(n).fill('pass')
const fail = (n: number) => Array<string>(n).fill('fail')
/** An example whose environment names its own sandbox, which a profile's default doesn't replace. */
const ownSandbox = (sandbox: string): Partial<Example> => ({
  plain: { harness: ['fake'], sandbox: [sandbox] },
  shared: (h) => ({ harness: [h], sandbox: [sandbox] }),
})

export const EXAMPLES: Record<string, Example> = {
  // Writing evals
  'with-checks': { run: { 'fake/math/fake': pass(1) } },
  'with-soft-checks': { run: { 'fake/math/fake': pass(1) } },
  'with-hidden-tests': { run: { 'fake/slugify/fake': pass(1) } },
  'with-guarded-files': { run: { 'fake/math/fake': pass(1) }, profiles: { canary: fakePlan } },
  'with-transcript-matchers': { run: { 'fake/math/fake': pass(1) } },
  'with-web-matchers': {
    run: { needs: 'ANTHROPIC_API_KEY, Docker and the network' },
    plain: inDocker('claude-code:claude-sonnet-5'),
  },
  'with-multi-turn': { run: { 'fake/math/fake': pass(1) } },
  'with-each': { run: { 'fake/math/fake': pass(3) } },
  'with-groups': {
    run: { 'fake/math/fake': [...pass(3), 'skipped', 'skipped'], unknown: ['skipped'] },
  },
  'with-pass-rate': { run: { 'fake/math/fake': pass(5) }, flaky: true },
  'with-background-process': { run: { 'fake/server/fake': pass(1) } },

  // Judges
  'with-judge': { run: { 'fake/math/fake': pass(1) } },
  'with-jev': { run: { needs: 'TYPESAFE_AI_API_KEY' } },
  'with-judge-state': { run: { 'fake/math/fake': pass(1) } },
  'with-judge-on-output': { run: { 'fake/orders/fake': pass(1) } },
  'with-judge-providers': {
    run: { needs: 'ANTHROPIC_API_KEY and GOOGLE_GENERATIVE_AI_API_KEY' },
  },
  'with-fake-judge': { run: { 'fake/math/fake': pass(1) } },

  // Harnesses
  'with-many-harnesses': {
    run: { 'fake-quick/math/fake': pass(1), 'fake-careful/math/fake': pass(1) },
    plain: { harness: ['fake-careful', 'fake-quick'], sandbox: ['fake'] },
    profiles: {
      agents: {
        harness: ['claude-code:claude-sonnet-5', 'codex:gpt-5.6-luna', 'cursor:composer-2.5'],
        sandbox: ['docker'],
      },
    },
  },
  'with-harness-edits': {
    run: {
      'fake-quick/math/fake': pass(2),
      'fake-careful/math/fake': pass(1),
      'oracle/math/fake': pass(1),
    },
    plain: { harness: ['fake-careful', 'fake-quick', 'oracle'], sandbox: ['fake'] },
    shared: (h) => ({ harness: [h, 'oracle'].sort(), sandbox: ['docker'] }),
  },
  'with-reasoning-effort': {
    run: { 'fake[effort=low]/math/fake': pass(1), 'fake[effort=high]/math/fake': pass(1) },
    plain: { harness: ['fake[effort=high]', 'fake[effort=low]'], sandbox: ['fake'] },
    profiles: {
      'claude-code-efforts': {
        harness: [
          'claude-code:claude-sonnet-5[effort=high]',
          'claude-code:claude-sonnet-5[effort=low]',
        ],
        sandbox: ['docker'],
      },
    },
  },
  'with-vercel-gateway': {
    run: { 'fake/math/fake': pass(1) },
    profiles: { vercel: inDocker('claude-code:claude-sonnet-5') },
  },
  'with-fake-harness': { run: { 'fake/math/fake': pass(1) } },
  'with-oracle-canary': {
    run: { needs: 'Docker' },
    plain: fakeInDocker,
    profiles: { canary: fakeInDocker },
  },

  // Environments
  'with-skill': { run: { 'fake/math/fake': pass(1) } },
  'with-skill-sources': { run: { 'fake/four-sources/fake': pass(1) } },
  'with-rules': { run: { 'fake/math/fake': pass(1) } },
  'with-fixture': { run: { 'fake/csv/fake': pass(1) } },
  'with-git-workspace': { run: { 'fake/reeval-math/fake': pass(1) } },
  'with-setup': { run: { 'fake/users/fake': pass(1) } },
  'with-extend-environment': { run: { 'fake/math-with-docs/fake': pass(1) } },
  'with-env': { run: { 'fake/shop-eur/fake': pass(1) } },
  'with-mcp': { run: { 'fake/acme-cli/fake': pass(1) } },
  'with-plugin': { run: { 'fake/acme-math/fake': pass(1) } },

  // Sandboxes
  'with-docker-install': { run: { needs: 'Docker' }, ...ownSandbox('docker+<install>') },
  'with-dockerfile': { run: { needs: 'Docker' }, ...ownSandbox('docker:sqlite') },
  'with-python-image': { run: { needs: 'Docker' }, ...ownSandbox('python') },
  'with-podman': { run: { needs: 'Podman' }, ...ownSandbox('podman') },
  'with-resource-limits': { run: { needs: 'Docker' }, plain: fakeInDocker },

  // Secrets and egress
  'with-brokered-secret': {
    run: { needs: 'Docker and GOOGLE_GENERATIVE_AI_API_KEY' },
    plain: fakeInDocker,
  },
  'with-secret-for-checks': { run: { needs: 'Docker' }, plain: fakeInDocker },
  'with-strict-secrets': { run: { needs: 'Docker and the network' }, plain: fakeInDocker },
  'with-egress-deny-all': { run: { needs: 'Docker' }, plain: fakeInDocker },
  'with-egress-allowlist': { run: { needs: 'Docker and the network' }, plain: fakeInDocker },
  'with-egress-allow-all': { run: { needs: 'Docker and the network' }, plain: fakeInDocker },

  // Compare
  'with-skill-lift': { run: { 'fake/math/fake': fail(4), 'fake/changelog/fake': pass(4) } },
  'with-compare-control': { run: { 'fake/math/fake': fail(1), 'fake/testing/fake': pass(1) } },
  'with-min-lift': { run: { 'fake/math/fake': fail(4), 'fake/jsdoc/fake': pass(4) } },
  'with-two-variants': {
    run: {
      'fake/math/fake': fail(1),
      'fake/errors-skill/fake': pass(1),
      'fake/errors-doc/fake': pass(1),
    },
  },
  'with-rules-ab': {
    run: { 'fake/short-rules/fake': fail(1), 'fake/detailed-rules/fake': pass(1) },
  },
  'with-compare-questions': { run: { 'fake/math/fake': pass(1), 'fake/errors/fake': pass(1) } },
  'with-compare-harness': {
    run: { needs: 'ANTHROPIC_API_KEY, OPENAI_API_KEY and Docker' },
    plain: { harness: ['claude-code:claude-sonnet-5', 'codex:gpt-5.6-luna'], sandbox: ['docker'] },
    shared: () => ({
      harness: ['claude-code:claude-sonnet-5', 'codex:gpt-5.6-luna'],
      sandbox: ['docker'],
    }),
  },
  'with-family-lift': { run: { 'fake/math/fake': fail(6), 'fake/jsdoc/fake': pass(6) } },
  'with-effort': { run: { 'fake/math/fake': pass(4), 'fake/project-layout/fake': pass(4) } },
  'with-skill-reads': { run: { needs: 'Docker' }, plain: fakeInDocker },

  // Web UIs
  'with-capture': { run: { 'fake/site/fake': pass(1) }, profiles: { docker: fakeInDocker } },
  'with-capture-journey': {
    run: { 'fake/pricing/fake': pass(1) },
    profiles: { docker: fakeInDocker },
  },
  'with-capture-compare': {
    run: { 'fake/site/fake': pass(1), 'fake/brand/fake': pass(1) },
    profiles: { docker: fakeInDocker },
  },

  // Running
  'with-profiles': {
    run: { 'fake/math/fake': pass(2) },
    profiles: { pr: fakePlan, nightly: fakePlan },
  },
  'with-budget': { run: { 'fake/math/fake': [...pass(1), 'skipped', 'skipped'] }, exit: 1 },
  'with-tags': { run: { 'fake/math/fake': pass(2) }, profiles: { smoke: fakePlan } },
  'with-history': { run: { 'fake/math/fake': pass(1) } },
  'with-github-pr-gate': {
    run: { 'fake/math/fake': pass(1) },
    profiles: { pr: inDocker('claude-code:claude-sonnet-5') },
  },
  'with-concurrency': { run: { 'fake/math/fake': pass(8) } },

  // Results
  'with-query': { run: { 'fake/math/fake': fail(4), 'fake/changelog/fake': pass(4) } },
  'with-studio': { run: { 'fake/math/fake': pass(1) } },
  'with-analysis': { run: { 'fake/math/fake': pass(1) } },
  'with-reeval-mcp': { run: { 'fake/math/fake': fail(1) }, exit: 1 },

  // Real-world
  'with-bug-fix': { run: { 'fake/stats/fake': pass(1) } },
  'with-refactor': { run: { 'fake/records/fake': pass(1) } },
  'with-test-writing': { run: { 'fake/duration/fake': pass(1) }, profiles: { canary: fakePlan } },
  'with-framework-migration': { run: { 'fake/commonjs/fake': pass(1) } },
  'with-dependency-upgrade': { run: { 'fake/strfmt-1/fake': pass(1) } },
  'with-docs-adherence': { run: { 'fake/notes/fake': pass(1) } },
  'with-sdk-usage': { run: { 'fake/acme-app/fake': pass(1) } },
  'with-library-skill-lift': {
    run: { 'fake/page/fake': fail(4), 'fake/brand-guidelines/fake': pass(4) },
  },
  'with-recommendation': { run: { 'fake/-/fake': pass(4) } },
  'with-existing-codebase': { run: { 'fake/camelcase/fake': pass(1) } },
  'with-feedback-loop': { run: { 'fake/notes/fake': pass(1) } },
  'with-code-review': { run: { 'fake/search/fake': pass(1) }, profiles: { canary: fakePlan } },
  'with-security-fix': { run: { 'fake/users/fake': pass(1) } },
}

/** A copy of `examples/<name>` outside the repo, with `reeval` linked to this package. */
export async function copyOut(name: string): Promise<string> {
  const from = join(examples, name)
  const dir = tempDir(`${name}-copy`)
  // Another drive, on Windows, is outside too: relative() is then absolute.
  const fromRepo = relative(join(pkgRoot, '../..'), dir)
  assert.ok(fromRepo.startsWith('..') || isAbsolute(fromRepo), 'the copy is outside the repo')
  cpSync(from, dir, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|\.reeval)([/\\]|$)/.test(src.slice(from.length)),
  })
  // The README's way out: the example takes its own copy of the shared profiles.
  cpSync(join(examples, 'profiles.ts'), join(dir, 'profiles.ts'))
  const config = join(dir, 'reeval.config.ts')
  writeFileSync(config, readFileSync(config, 'utf8').replace("'../profiles.ts'", "'./profiles.ts'"))
  await mkdir(join(dir, 'node_modules'))
  await symlink(pkgRoot, join(dir, 'node_modules/reeval'), 'dir')
  // examples/tsconfig.json is for the editor and `pnpm typecheck`; a copy runs without one.
  assert.equal(existsSync(join(dir, 'tsconfig.json')), false, `${name} has no tsconfig.json`)
  return dir
}

/** Runs `jobs` at most `n` at a time, in order. */
async function pooled<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = []
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++
      out[i] = await (jobs[i] as () => Promise<T>)()
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker))
  return out
}

type Cell = { harness: string; sandbox: string }
const sorted = (xs: string[]) => [...new Set(xs)].sort()

/** What `dir` plans under `profile` ('' for none): its eval files and its cells' harnesses and sandboxes. */
async function planOf(dir: string, profile: string): Promise<{ files: string[]; plan: Plan }> {
  const args = ['run', '--dry-run', '--json', ...(profile ? ['--profile', profile] : [])]
  const r = await runCli(dir, args)
  assert.equal(r.code, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`)
  const evals: { file: string; cells: Cell[] }[] = JSON.parse(r.stdout).evals
  const cells = evals.flatMap((e) => e.cells)
  return {
    files: sorted(evals.map((e) => e.file)),
    plan: {
      harness: sorted(cells.map((c) => c.harness)),
      // An install layer's sandbox id ends in a hash of its commands.
      sandbox: sorted(
        cells.map((c) => c.sandbox.replace(/^docker\+[0-9a-f]+$/, 'docker+<install>')),
      ),
    },
  }
}

/** Every profile `name` plans under, with what it should plan there. */
function expected(e: Example): Record<string, Plan> {
  const shared = Object.entries(SHARED).map(([p, h]) => [p, (e.shared ?? inDocker)(h)] as const)
  return { '': e.plain ?? fakePlan, ...Object.fromEntries(shared), ...e.profiles }
}

/** Plans and, where it's key-free, runs `name` copied out of the repo, against its row. */
export async function checkExample(name: string, e: Example): Promise<void> {
  const dir = await copyOut(name)
  const want = expected(e)
  const got = await pooled(
    Object.keys(want).map((p) => () => planOf(dir, p)),
    Math.max(2, availableParallelism()),
  )
  Object.keys(want).forEach((p, i) => {
    const { files, plan } = got[i] as { files: string[]; plan: Plan }
    assert.deepEqual(files, [`${name}.eval.ts`], `${name} --profile ${p || '(none)'}`)
    assert.deepEqual(plan, want[p], `${name} --profile ${p || '(none)'}`)
  })
  if ('needs' in e.run) return
  const run = await runCli(dir, ['run'], { timeoutMs: 300_000 })
  const ran: Record<string, string[]> = {}
  for (const a of readRun(dir).evals.flatMap((x) => x.attempts)) {
    ran[a.cell] = [...(ran[a.cell] ?? []), a.outcome].sort()
  }
  if (!e.flaky) {
    assert.equal(run.code, e.exit ?? 0, run.stdout + run.stderr)
    assert.deepEqual(ran, e.run, run.stdout)
    return
  }
  assert.ok([0, 1].includes(run.code), run.stdout + run.stderr)
  const counts = (r: Record<string, string[]>) =>
    Object.fromEntries(Object.entries(r).map(([cell, outcomes]) => [cell, outcomes.length]))
  assert.deepEqual(counts(ran), counts(e.run), run.stdout)
  for (const outcome of Object.values(ran).flat()) assert.match(outcome, /^(pass|fail)$/)
}

/** The `shard`th of `of` slices of the table, each example a test. */
export function exampleTests(shard: number, of: number): void {
  const names = Object.keys(EXAMPLES).sort()
  for (const [i, name] of names.entries()) {
    if (i % of !== shard - 1) continue
    const e = EXAMPLES[name] as Example
    const what =
      'needs' in e.run ? `plans (running it needs ${e.run.needs})` : 'plans and runs key-free'
    test(`examples/${name} copied out of the repo ${what}`, { timeout: 600_000 }, () =>
      checkExample(name, e),
    )
  }
}

export const exampleDirs = () =>
  readdirSync(examples, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('with-'))
    .map((d) => d.name)
    .sort()
