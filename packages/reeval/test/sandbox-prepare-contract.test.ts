// The sandbox prepare contract (src/sandbox/provider.ts), checked the same way on every provider:
// a scripted fake one that fails in each class on demand (a bad API token, a 503, running out of
// memory or disk), and Docker, which gets each case from a real build. reeval's generic layer
// (src/sandbox/preflight.ts) does the retrying, caching and stopping; a provider only prepares
// and classes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { DEFAULT_IMAGE } from '@reeval/sandbox-docker'
import { fakeHarness } from '../src/harness.ts'
import {
  type PrepareUse,
  prepareAll,
  prepareTargets,
  RunStopError,
} from '../src/sandbox/preflight.ts'
import { PrepareError, type SandboxProvider } from '../src/sandbox/provider.ts'
import { dockerProvider } from '../src/sandbox/providers.ts'
import type { SandboxDescriptor } from '../src/types.ts'
import { tempDir } from './helpers.ts'

type Case = 'ok' | 'bad-token' | 'transient' | 'flaky' | 'broken' | 'oom' | 'disk'
/** Cases both provider rows run. `flaky` is scripted-only. */
type SharedCase = Exclude<Case, 'bad-token' | 'flaky'>

/** What a provider row gives the suite: a sandbox for each case, and how to fail its check. */
type Row = {
  name: string
  skip: string | false
  provider: () => SandboxProvider
  /** A sandbox that prepares, or fails, as the case says. */
  sandbox: (c: SharedCase, n?: number) => SandboxDescriptor
  /** Runs `body` while the provider's credentials or connection are bad. */
  badCredentials: <T>(body: () => Promise<T>) => Promise<T>
}

/** A provider with a remote API, scripted: each sandbox says how it fails. */
function scriptedProvider(state: { token: string; calls: Map<string, number> }): SandboxProvider {
  return {
    kind: 'scripted' as SandboxDescriptor['kind'],
    async check() {
      if (state.token !== 'good-token') throw new Error('401 Unauthorized: invalid API token')
    },
    key: (sandbox, _harness, plugins = []) => JSON.stringify([sandbox, plugins]),
    async prepare(sandbox, _harness, ctx) {
      const { script, n } = sandbox as unknown as { script: Case; n: number }
      const key = `${script}:${n}`
      // One network step, retried by reeval when it fails transiently.
      return await ctx.retry(async () => {
        const call = (state.calls.get(key) ?? 0) + 1
        state.calls.set(key, call)
        if (script === 'transient') throw new Error('503 Service Unavailable')
        if (script === 'flaky' && call === 1) throw new Error('ECONNRESET talking to the API')
        if (script === 'broken') throw new Error('template "x" failed: step 2 exited 1')
        if (script === 'oom') throw new Error('provisioning killed: out of memory (exit 137)')
        if (script === 'disk') throw new Error('provisioning failed: ENOSPC, no space left')
        return { template: key }
      })
    },
    classify(error) {
      const message = error instanceof Error ? error.message : String(error)
      const resource = /out of memory|exit 137/.test(message)
        ? 'oom'
        : /ENOSPC/.test(message)
          ? 'enospc'
          : null
      return {
        class: resource
          ? 'resource'
          : /503|ECONNRESET|quota/.test(message)
            ? 'transient'
            : 'config',
        stage: 'template',
        ref: null,
        cause: resource,
        log: null,
        message,
        ...(/401/.test(message) ? { usage: true } : {}),
      }
    },
  }
}

const scripted = (() => {
  const state = { token: 'good-token', calls: new Map<string, number>() }
  return {
    state,
    row: {
      name: 'scripted',
      skip: false,
      provider: () => scriptedProvider(state),
      sandbox: (script, n = 0) => ({ kind: 'scripted', script, n }) as unknown as SandboxDescriptor,
      async badCredentials(body) {
        state.token = 'bad-token'
        try {
          return await body()
        } finally {
          state.token = 'good-token'
        }
      },
    } satisfies Row,
  }
})()

const dockerReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const requireDocker = process.env.REEVAL_TEST_REQUIRE_DOCKER === '1'
const nonce = `${Date.now()}-${process.pid}`

const dockerRow: Row = {
  name: 'docker',
  skip: !dockerReady && !requireDocker && `needs Docker and ${DEFAULT_IMAGE}`,
  provider: () => dockerProvider(),
  sandbox: (c, n = 0) => {
    const run = (cmd: string) => ({ kind: 'docker' as const, install: [`# ${nonce}-${n}`, cmd] })
    switch (c) {
      case 'ok':
        return run('echo ok')
      case 'transient':
        return { kind: 'docker', from: `registry.invalid.example:5000/reeval/none-${n}:1` }
      case 'broken':
        return run('echo broken && exit 5')
      case 'oom':
        return run('echo dying && kill -9 $$')
      case 'disk':
        return run('dd if=/dev/zero of=/dev/shm/fill bs=1M count=200')
    }
  },
  async badCredentials(body) {
    const before = process.env.DOCKER_HOST
    process.env.DOCKER_HOST = 'unix:///nonexistent/reeval-contract.sock'
    try {
      return await body()
    } finally {
      if (before === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = before
    }
  },
}

const harness = fakeHarness()
const use = (sandbox: SandboxDescriptor, where = 'evaluate("x")'): PrepareUse => ({
  harness,
  sandbox,
  setBy: { sandbox: where, harness: 'reeval.config.ts' },
})

for (const row of [scripted.row, dockerRow]) {
  describe(`sandbox prepare contract: ${row.name}`, { skip: row.skip, timeout: 600_000 }, () => {
    const prepare = (uses: PrepareUse[], provider = row.provider()) => {
      const providers = { [provider.kind]: provider }
      const targets = prepareTargets(uses, providers, (u) => JSON.stringify(u.sandbox))
      const retries: string[] = []
      return {
        targets,
        retries,
        run: () =>
          prepareAll(targets, {
            providers,
            root: tempDir(`prepare-${row.name}`),
            delays: [1, 1],
            log: (line) => retries.push(line),
          }),
      }
    }

    test('one handle per distinct sandbox, however many attempts use it', async () => {
      const p = prepare([use(row.sandbox('ok')), use(row.sandbox('ok')), use(row.sandbox('ok', 1))])
      assert.equal(p.targets.length, 2)
      const outcomes = await p.run()
      assert.deepEqual(
        outcomes.map((o) => o.ok),
        [true, true],
      )
      assert.ok(
        outcomes.every((o) => o.ok && o.handle),
        'each has a handle to start from',
      )
    })

    test('bad credentials fail the check: a usage error, and nothing is prepared', async () => {
      const p = prepare([use(row.sandbox('ok'))])
      const error = await row.badCredentials(() =>
        p.run().then(
          () => null,
          (e) => e,
        ),
      )
      assert.ok(error instanceof PrepareError, String(error))
      assert.equal(error.failure.class, 'config')
      assert.equal(error.failure.usage, true)
    })

    test('a transient failure is retried, bounded, and stays transient', async () => {
      const p = prepare([use(row.sandbox('transient', 2))])
      const [outcome] = await p.run()
      assert.equal(outcome?.ok, false)
      assert.equal(!outcome?.ok && outcome?.failure.class, 'transient')
      assert.equal(p.retries.filter((l) => l.startsWith('retrying')).length, 2)
    })

    test('canary: a deterministic failure is tried once, and fails only its own sandbox', async () => {
      const p = prepare([use(row.sandbox('broken', 3)), use(row.sandbox('ok', 3))])
      const outcomes = await p.run()
      assert.equal(outcomes[0]?.ok, false)
      assert.equal(!outcomes[0]?.ok && outcomes[0]?.failure.class, 'config')
      assert.equal(p.retries.filter((l) => l.startsWith('retrying')).length, 0, 'not retried')
      assert.equal(outcomes[1]?.ok, true, 'the other sandbox still prepares')
    })

    test('out of memory and out of disk are resource failures, named', async () => {
      const p = prepare([use(row.sandbox('oom', 4)), use(row.sandbox('disk', 4))])
      const [oom, disk] = await p.run()
      assert.equal(!oom?.ok && oom?.failure.class, 'resource')
      assert.equal(!oom?.ok && oom?.failure.cause, 'oom')
      assert.equal(!disk?.ok && disk?.failure.class, 'resource')
      assert.equal(!disk?.ok && disk?.failure.cause, 'enospc')
    })

    test('a config-level sandbox that fails stops the run', async () => {
      const p = prepare([
        use(row.sandbox('broken', 5), 'reeval.config.ts'),
        use(row.sandbox('ok', 5)),
      ])
      assert.equal(p.targets[0]?.runWide, true)
      assert.equal(p.targets[1]?.runWide, false)
      await assert.rejects(p.run(), RunStopError)
    })
  })
}

describe('sandbox prepare contract: the generic layer', () => {
  test('a flaky step is retried until it passes', async () => {
    const provider = scriptedProvider(scripted.state)
    const providers = { [provider.kind]: provider }
    const targets = prepareTargets(
      [use({ kind: 'scripted', script: 'flaky', n: 9 } as unknown as SandboxDescriptor)],
      providers,
      () => 'flaky',
    )
    const [outcome] = await prepareAll(targets, {
      providers,
      root: tempDir('prepare-generic'),
      delays: [1, 1],
    })
    assert.equal(outcome?.ok, true)
    assert.equal(scripted.state.calls.get('flaky:9'), 2)
  })

  test("a plugin build is set by its environment, and never stops the run: the config's sandbox isn't what failed", () => {
    const provider = scriptedProvider(scripted.state)
    const sandbox = { kind: 'scripted', script: 'ok', n: 10 } as unknown as SandboxDescriptor
    const built = {
      ...use(sandbox, 'reeval.config.ts'),
      plugins: [{ source: 'local', path: 'plugins/review', build: 'npm ci' }],
      setBy: {
        sandbox: 'reeval.config.ts',
        harness: 'reeval.config.ts',
        pluginBuilds: 'environment reviewed in evals/review.eval.ts',
      },
    } as PrepareUse
    const targets = prepareTargets(
      [use(sandbox, 'reeval.config.ts'), built],
      { [provider.kind]: provider },
      () => 'scripted',
    )
    assert.deepEqual(
      targets.map((t) => [t.setBy, t.runWide]),
      [
        [['reeval.config.ts'], true],
        [['environment reviewed in evals/review.eval.ts'], false],
      ],
    )
  })
})
