// startSandbox's sequence on a fake machine: the gateway on its root transport, the brokering
// refusal, and the machine removed once on every way out.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DockerSession, ExecTransport } from '@reeval/sandbox-docker'
import type { SandboxOptions } from '../src/sandbox/index.ts'
import { type BootedMachine, brokeringRefusal, startSandbox } from '../src/sandbox/start.ts'

const options = (o: Partial<SandboxOptions> = {}): SandboxOptions => ({
  runId: 'run1',
  timeoutMs: 60_000,
  signal: new AbortController().signal,
  env: {},
  egress: { policy: 'allow-all', auto: [] },
  ...o,
})

/** Root that refuses every command, so the gateway can't install its CA. */
const noRoot: ExecTransport = {
  argv: (command) => [...command],
  run: async () => ({
    exitCode: 1,
    stdout: Buffer.from(''),
    stderr: 'sudo: a password is required',
  }),
}

function machine(o: { session?: () => DockerSession } = {}) {
  const seen = { destroyed: 0, noGateway: undefined as string | undefined, sessions: 0 }
  const booted: BootedMachine = {
    root: noRoot,
    async destroy() {
      seen.destroyed++
    },
    session({ noGateway, destroy }) {
      seen.sessions++
      seen.noGateway = noGateway
      if (o.session) return o.session()
      return {
        id: 'm-1',
        defaultWorkingDirectory: '/w',
        egress: { active: false, reason: noGateway ?? '' },
        run: async () => ({ exitCode: 0, stdout: '/home/agent', stderr: '' }),
        destroy,
      } as unknown as DockerSession
    },
  }
  return { booted, seen }
}

describe('startSandbox', () => {
  test("refuses brokered values the gateway can't keep out, naming the sandbox, and removes the machine", async () => {
    const { booted, seen } = machine()
    await assert.rejects(
      startSandbox(options({ brokering: { credential: 'API_KEY', endpoints: [] } }), {
        helper: 'boat()',
        hint: 'The gateway needs Node.',
        install: false,
        boot: async () => booted,
      }),
      {
        name: 'InfraError',
        message:
          "Can't keep API_KEY out of the boat() sandbox: credential brokering could not start (couldn't install the gateway CA: sudo: a password is required). The gateway needs Node.",
      },
    )
    assert.equal(seen.sessions, 0)
    assert.equal(seen.destroyed, 1)
  })

  test("refuses a restricted policy the gateway isn't there to hold the machine to", async () => {
    const { booted, seen } = machine()
    await assert.rejects(
      startSandbox(options({ egress: { policy: 'deny-all', auto: [] } }), {
        helper: 'boat()',
        install: false,
        boot: async () => booted,
      }),
      {
        name: 'InfraError',
        message:
          "Can't enforce egress deny-all: the egress gateway could not start in the boat() sandbox (couldn't install the gateway CA: sudo: a password is required)",
      },
    )
    assert.equal(seen.sessions, 0)
    assert.equal(seen.destroyed, 1)
  })

  test("without brokered values, the session says why the gateway isn't running, and its destroy removes the machine once", async () => {
    const { booted, seen } = machine()
    const box = await startSandbox(options(), {
      helper: 'tart()',
      install: false,
      boot: async () => booted,
    })
    assert.equal(seen.noGateway, "couldn't install the gateway CA: sudo: a password is required")
    assert.equal(box.workdir, '/w/workspace')
    assert.equal(box.home, '/home/agent')
    await box.destroy()
    await box.destroy()
    assert.equal(seen.destroyed, 1)
  })

  test('a failure after the boot removes the machine and is thrown as it was', async () => {
    const failure = new Error('no session')
    const { booted, seen } = machine({
      session: () => {
        throw failure
      },
    })
    await assert.rejects(
      startSandbox(options(), { helper: 'boat()', install: false, boot: async () => booted }),
      (error) => error === failure,
    )
    assert.equal(seen.destroyed, 1)
  })

  test("the refusal's text is the same for every sandbox but its name", () => {
    assert.equal(
      brokeringRefusal('docker()', ['A', 'B'], 'no node').message,
      "Can't keep A, B out of the docker() sandbox: credential brokering could not start (no node)",
    )
  })
})
