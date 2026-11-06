import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Gateway } from '../src/egress/gateway.ts'
import type { RunResult } from '../src/process.ts'
import { darwinShell, execScript, linuxShell } from '../src/shells.ts'
import {
  type SessionShell,
  type TransportSessionOptions,
  transportSession,
} from '../src/transport-session.ts'

type Call = { argv: string[]; input: string; signal: AbortSignal | undefined }

const ok = (stdout = ''): RunResult<Buffer> => ({
  exitCode: 0,
  stdout: Buffer.from(stdout),
  stderr: '',
})

/** A host runner that records each call and answers with `answer`. */
function recorder(answer: (argv: string[]) => Promise<RunResult<Buffer>> = async () => ok()) {
  const calls: Call[] = []
  const run: SessionShell['run'] = (argv, o) => {
    calls.push({
      argv: [...argv],
      input: Buffer.from(o.input ?? '').toString('utf8'),
      signal: o.signal,
    })
    return answer([...argv])
  }
  return { calls, run }
}

/** A shell whose commands say what they are: `user <exec> <cwd> <command>`, and so on. */
function namedShell(run: SessionShell['run']): SessionShell {
  return {
    run,
    user: ({ command, cwd, env, exec }) => ({
      argv: ['user', String(exec), cwd, command],
      input: JSON.stringify(env),
    }),
    privileged: ({ command, exec }) => ({ argv: ['root', String(exec), command], input: '' }),
    kill: (exec) => ({ argv: ['kill', String(exec)], input: '' }),
    direct: (argv) => ['direct', ...argv],
  }
}

const session = (shell: SessionShell, o: Partial<TransportSessionOptions> = {}) =>
  transportSession({
    id: 'm-1',
    description: 'test machine m-1',
    defaultWorkingDirectory: '/w',
    shell,
    env: (extra) => ({ BASE: '1', ...extra }),
    gateway: undefined,
    egress: undefined,
    portWithoutGateway: async (port, scheme) => `${scheme}://direct:${port}`,
    destroy: async () => {},
    ...o,
  })

describe('transportSession', () => {
  test("runs a command as the agent's user, in the workspace, with the session's variables", async () => {
    const { calls, run } = recorder(async () => ok('out'))
    const s = session(namedShell(run))
    assert.deepEqual(await s.run({ command: 'ls', workingDirectory: 'sub', env: { A: 'a' } }), {
      exitCode: 0,
      stdout: 'out',
      stderr: '',
    })
    await s.runPrivileged({ command: 'id' })
    assert.deepEqual(
      calls.map((c) => c.argv),
      [
        ['user', '1', '/w/sub', 'ls'],
        ['root', '2', 'id'],
      ],
    )
    assert.deepEqual(JSON.parse(calls[0]?.input ?? ''), { BASE: '1', A: 'a' })
  })

  test('an aborted command kills what that command started', async () => {
    const abort = new AbortController()
    const { calls, run } = recorder(async (argv) => {
      if (argv.at(-1) !== 'sleep 9') return ok()
      abort.abort()
      throw new Error('aborted')
    })
    const s = session(namedShell(run))
    await s.run({ command: 'true' })
    await assert.rejects(s.run({ command: 'sleep 9', abortSignal: abort.signal }), /aborted/)
    assert.deepEqual(calls.at(-1)?.argv, ['kill', '2'])
  })

  test('a read is null when the file is missing or the host program fails', async () => {
    const answers: Record<string, () => Promise<RunResult<Buffer>>> = {
      '/w/there': async () => ok('content'),
      '/w/missing': async () => ({ exitCode: 1, stdout: Buffer.from(''), stderr: 'no such file' }),
      '/w/unreachable': async () => {
        throw new Error('spawn ssh ENOENT')
      },
    }
    const { calls, run } = recorder((argv) => (answers[argv.at(-1) ?? ''] ?? answers['/w/there'])())
    const s = session(namedShell(run))
    assert.equal(await s.readTextFile({ path: 'there' }), 'content')
    assert.equal(await s.readTextFile({ path: 'missing' }), null)
    assert.equal(await s.readBinaryFile({ path: '/w/unreachable' }), null)
    assert.deepEqual(calls[0]?.argv, ['direct', '/bin/cat', '--', '/w/there'])
  })

  test('a write makes its directory, and a failed one names the machine', async () => {
    const { calls, run } = recorder(async () => ({
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: 'read-only\n',
    }))
    await assert.rejects(
      session(namedShell(run)).writeTextFile({ path: 'a/f', content: 'x' }),
      /^Error: Couldn't write \/w\/a\/f in test machine m-1: read-only$/,
    )
    await assert.rejects(
      session(namedShell(run), { name: 'reeval-vm' }).writeTextFile({ path: 'f', content: 'x' }),
      /^Error: Couldn't write \/w\/f in reeval-vm: read-only$/,
    )
    assert.deepEqual(calls[0]?.argv, [
      'direct',
      '/bin/sh',
      '-c',
      'umask 022 && mkdir -p "$(dirname "$1")" && cat > "$1"',
      'sh',
      '/w/a/f',
    ])
    assert.equal(calls[0]?.input, 'x')
  })

  test("a spawned process whose host program can't start exits 127", async () => {
    const shell = namedShell(recorder().run)
    const s = session({
      ...shell,
      user: () => ({ argv: ['/nonexistent/reeval-ssh', 'x'], input: '' }),
    })
    const child = await s.spawn({ command: 'true' })
    assert.deepEqual(await child.wait(), { exitCode: 127 })
  })

  test('a port goes through the running gateway, and another way without one', async () => {
    const gateway = {
      stopped: undefined,
      env: {},
      portUrl: async (port: number, scheme: string) => `${scheme}://gateway:${port}`,
    } as unknown as Gateway
    const shell = namedShell(recorder().run)
    assert.equal(
      await session(shell, { gateway, egress: { active: true } }).getPortUrl({ port: 9 }),
      'ws://gateway:9',
    )
    assert.equal(await session(shell).getPortUrl({ port: 9 }), 'ws://direct:9')
    const stopped = { ...gateway, stopped: 'the forwarder exited (1)' } as unknown as Gateway
    const s = session(shell, { gateway: stopped, egress: { active: true } })
    assert.deepEqual(s.egress, { active: false, reason: 'the forwarder exited (1)' })
    assert.equal(await s.getPortUrl({ port: 9 }), 'ws://direct:9')
  })
})

describe('linuxShell', () => {
  const linux = (run: SessionShell['run'], signal?: AbortSignal) =>
    linuxShell({
      run,
      remote: (command) => ['ssh', 'vm', command],
      id: 'bx_1',
      user: { PATH: '/usr/bin', HOME: '/home/reeval' },
      signal,
    })

  test("runs the agent's commands as the sandbox user, with variables and a marker on stdin", () => {
    const c = linux(recorder().run).user({
      command: 'ls',
      cwd: '/reeval',
      env: { A: 'a' },
      exec: 3,
    })
    assert.equal(c.argv.slice(0, 2).join(' '), 'ssh vm')
    assert.match(
      c.argv[2] ?? '',
      /^sudo -n -H -u reeval -- env -i 'PATH=\/usr\/bin' 'HOME=\/home\/reeval' bash -c '.*' bash '\/reeval' 'ls'$/,
    )
    assert.equal(c.input, 'A=a\0REEVAL_EXEC_ID=bx_1-3\0')
  })

  test("runs reeval's own commands as root in the state directory, and kills by marker", () => {
    const shell = linux(recorder().run)
    assert.match(
      shell.privileged({ command: 'id', exec: 4 }).argv[2] ?? '',
      /^sudo -n -- env -i PATH=\S+ HOME=\/root REEVAL_EXEC_ID=bx_1-4 \/bin\/sh -c 'cd \/var\/lib\/reeval \|\| exit 1; umask 022; id'$/,
    )
    assert.match(shell.kill(4).argv[2] ?? '', /grep -qsxzF .*REEVAL_EXEC_ID=bx_1-4/)
  })

  test('reads, writes and path scripts run /bin programs by absolute path as the sandbox user', async () => {
    const { calls, run } = recorder()
    const s = session(linux(run))
    await s.readTextFile({ path: 'f' })
    await s.writeTextFile({ path: 'f', content: 'x' })
    assert.equal(calls[0]?.argv[2], "sudo -n -u reeval -- '/bin/cat' '--' '/w/f'")
    assert.match(calls[1]?.argv[2] ?? '', /^sudo -n -u reeval -- '\/bin\/sh' '-c' /)
  })

  test('a read is null when ssh fails', async () => {
    const s = session(
      linux(async () => {
        throw new Error('ssh: connect to host vm port 22: Connection refused')
      }),
    )
    assert.equal(await s.readTextFile({ path: 'f' }), null)
  })

  test("a spawned process exits 127 when ssh can't start", async () => {
    const s = session(
      linuxShell({
        run: recorder().run,
        remote: (command) => ['/nonexistent/ssh', command],
        id: 'bx_1',
        user: {},
      }),
    )
    const child = await s.spawn({ command: 'true' })
    assert.deepEqual(await child.wait(), { exitCode: 127 })
  })

  test("a command without a signal of its own stops on the session's", async () => {
    const attempt = new AbortController()
    const own = new AbortController()
    const { calls, run } = recorder()
    const s = session(linux(run, attempt.signal))
    await s.run({ command: 'a' })
    await s.run({ command: 'b', abortSignal: own.signal })
    await s.readTextFile({ path: 'f' })
    assert.deepEqual(
      calls.map((c) => c.signal),
      [attempt.signal, own.signal, attempt.signal],
    )
  })
})

describe('darwinShell', () => {
  const darwin = () =>
    darwinShell({
      run: recorder().run,
      guest: (argv) => ['tart', 'exec', '-i', 'vm', ...argv],
      stateDir: '/Users/admin/.reeval-state',
      path: '/Users/admin/pnpm/bin:/opt/homebrew/bin',
    })

  test('runs every command as a script on stdin that records its pid', () => {
    const shell = darwin()
    const c = shell.user({ command: 'ls', cwd: '/Users/admin', env: { A: 'a' }, exec: 2 })
    assert.deepEqual(c.argv.slice(0, 5), ['tart', 'exec', '-i', 'vm', '/bin/bash'])
    assert.equal(
      c.input,
      execScript({
        command: 'ls',
        cwd: '/Users/admin',
        env: { A: 'a' },
        pidFile: '/Users/admin/.reeval-state/exec-2.pid',
        path: '/Users/admin/pnpm/bin:/opt/homebrew/bin',
      }),
    )
    const own = shell.privileged({ command: 'id', exec: 3 })
    assert.match(String(own.input), /cd '\/Users\/admin\/.reeval-state' \|\| exit 1\nid$/)
    assert.doesNotMatch(String(own.input), /export A=/)
    assert.match(shell.kill(3).argv.at(-1) ?? '', /^f='\/Users\/admin\/.reeval-state\/exec-3.pid'/)
    assert.deepEqual(shell.direct(['/bin/cat', 'f']), ['tart', 'exec', '-i', 'vm', '/bin/cat', 'f'])
  })

  test("a command's script quotes each value and drops names a shell can't export", () => {
    const script = execScript({
      command: 'npm test',
      cwd: "/Users/admin/it's",
      env: { A: "x'y", 'NOT-A-NAME': 'z' },
      pidFile: '/s/1.pid',
      path: '/opt/homebrew/bin',
    })
    const [setup, command] = script.split('\n')
    assert.equal(command, 'npm test')
    assert.match(setup ?? '', /export A='x'\\''y'/)
    assert.match(setup ?? '', /cd '\/Users\/admin\/it'\\''s' \|\| exit 1/)
    assert.doesNotMatch(setup ?? '', /NOT-A-NAME/)
  })
})
