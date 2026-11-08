// The remote engine: the docker CLI over a machine's SSH. A fake `ssh` runs the remote command
// with `sh -c` here, as the login shell would there, so the CLI it reaches is this machine's: a
// fake `docker` for the wire format, the real one for builds and a session.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { docker, removeContainerDetached, sweepLabelDetached } from '../src/docker-cli.ts'
import { containerTransport } from '../src/egress/transport.ts'
import type { RemoteEngine } from '../src/engine.ts'
import { DEFAULT_IMAGE } from '../src/image.ts'
import { hostCommand, isSshFailure, remoteBuild } from '../src/remote-engine.ts'
import { createDockerSession } from '../src/session.ts'
import { readTar } from '../src/tarball.ts'
import { ENGINE, REQUIRE_ENGINE } from './engine.ts'

const dir = mkdtempSync(join(tmpdir(), 'reeval-remote-engine-'))
const tmp = () => mkdtempSync(join(dir, 'case-'))
const bin = join(dir, 'bin')
mkdirSync(bin)
const sshLog = join(dir, 'ssh.log')
const failures = join(dir, 'ssh-failures')
// Its last argument is the remote command line; FAKE_SSH_FAILURES makes the first calls fail to
// connect.
writeFileSync(
  join(bin, 'ssh'),
  `#!/bin/sh
printf '%s\\n' "$*" >> ${sshLog}
n=$(cat ${failures} 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then echo $((n - 1)) > ${failures}; echo "ssh: connect to host vm.test port 2222: Connection refused" >&2; exit 255; fi
for last; do :; done
exec sh -c "$last"
`,
  { mode: 0o755 },
)
const fakeDockerDir = join(dir, 'fake-docker')
mkdirSync(fakeDockerDir)
writeFileSync(
  join(fakeDockerDir, 'docker'),
  `#!/usr/bin/env node
const input = require('node:fs').readFileSync(0)
const args = process.argv.slice(2)
process.stdout.write(JSON.stringify({ args, secret: process.env.REEVAL_SECRET ?? null,
  stdin: require('node:crypto').createHash('sha256').update(input).digest('hex'), bytes: input.length }))
if (args[0] === 'fail') { process.stderr.write('Error: it failed\\n'); process.exit(3) }
if (args[0] === 'exec') {
  require('node:fs').appendFileSync(process.env.FAKE_DOCKER_RUNS, 'ran\\n')
  process.stderr.write(args.at(-1) + '\\n')
  process.exit(255)
}
`,
  { mode: 0o755 },
)
const PATH = process.env.PATH
after(() => {
  process.env.PATH = PATH
})

const target = {
  host: 'vm.test',
  port: 2222,
  user: 'user',
  identityFile: join(dir, 'id'),
  knownHostsFile: join(dir, 'known_hosts'),
  hostKeyAlias: 'vm-test',
}
const remote: RemoteEngine = { kind: 'ssh', target, description: 'the test VM' }

describe('hostCommand', () => {
  test('locally it is the CLI; remotely ssh to it, the environment on stdin and never in argv', () => {
    assert.deepEqual(hostCommand('docker', ['ps'], { A: '1' }), {
      bin: 'docker',
      args: ['ps'],
      env: { A: '1' },
      preamble: null,
    })
    const plain = hostCommand(remote, ['image', 'inspect', "it's $HOME"])
    assert.equal(plain.bin, 'ssh')
    assert.equal(plain.args.at(-1), `exec 'docker' 'image' 'inspect' 'it'\\''s $HOME'`)
    assert.equal(plain.preamble, null)
    const secret = 'hunter2 \'"$(x)'
    const withEnv = hostCommand(remote, ['run', '--env', 'TOKEN', 'img'], { TOKEN: secret })
    assert.ok(!withEnv.args.join(' ').includes('hunter2'), 'no value in argv')
    assert.deepEqual(withEnv.env, {})
    const line = withEnv.preamble?.toString('utf8') ?? ''
    assert.match(line, /^[A-Za-z0-9+/=]+\n$/)
    assert.equal(
      Buffer.from(line.trim(), 'base64').toString('utf8'),
      `export TOKEN='hunter2 '\\''"$(x)'`,
    )
    assert.throws(() => hostCommand(remote, ['ps'], { 'A;B': '1' }), /isn't a variable name/)
  })

  test('only ssh failing to connect to the machine is ssh failing before the command ran', () => {
    const refused = 'ssh: connect to host vm.test port 2222: Connection refused\n'
    assert.equal(isSshFailure({ exitCode: 255, stderr: refused }, target), true)
    const reset =
      'kex_exchange_identification: read: Connection reset by peer\nConnection reset by 10.0.0.2 port 2222'
    assert.equal(isSshFailure({ exitCode: 255, stderr: reset }, target), true)
    // Canary: the remote command's own 255, a connection that dropped after it started, another
    // machine's refusal, and ssh's message among the command's own output.
    assert.equal(isSshFailure({ exitCode: 255, stderr: '' }, target), false)
    assert.equal(
      isSshFailure(
        { exitCode: 255, stderr: 'Connection to vm.test closed by remote host.' },
        target,
      ),
      false,
    )
    const other = 'ssh: connect to host github.com port 22: Connection refused\n'
    assert.equal(isSshFailure({ exitCode: 255, stderr: other }, target), false)
    assert.equal(isSshFailure({ exitCode: 255, stderr: `pushing\n${refused}` }, target), false)
    assert.equal(isSshFailure({ exitCode: 1, stderr: refused }, target), false)
  })
})

describe('remoteBuild', () => {
  const context = () => {
    const root = tmp()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\nCOPY . /ctx/\n')
    writeFileSync(join(root, 'src', 'kept.txt'), 'kept')
    writeFileSync(join(root, 'src', 'tool.sh'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(root, 'secret.env'), 'no')
    writeFileSync(join(root, '.dockerignore'), 'secret.env\n')
    return root
  }
  const entries = (input: unknown) =>
    readTar(Buffer.from(input as Uint8Array)).map((e) => ({
      path: e.path,
      type: e.type,
      ...(e.type === 'file' ? { text: e.data.toString('utf8'), mode: e.mode } : {}),
    }))

  test('a context here goes as a tar on stdin, less what .dockerignore leaves out', () => {
    const root = context()
    const r = remoteBuild(
      ['build', '--tag', 't', '--file', join(root, 'Dockerfile'), root],
      undefined,
    )
    assert.deepEqual(r.args, ['build', '--tag', 't', '--file', 'Dockerfile', '-'])
    const sent = entries(r.input)
    assert.deepEqual(
      sent.map((e) => e.path),
      ['src', '.dockerignore', 'Dockerfile', 'src/kept.txt', 'src/tool.sh'],
    )
    assert.equal(sent[0]?.type, 'dir')
    assert.equal(sent.find((e) => e.path === 'src/tool.sh')?.mode, 0o755, 'modes kept')
    // No --file: the context's own Dockerfile, as docker reads it.
    assert.deepEqual(
      remoteBuild(['build', `--file=${join(root, 'Dockerfile')}`, root], undefined).args,
      ['build', '--file=Dockerfile', '-'],
    )
    assert.deepEqual(remoteBuild(['build', root], undefined).args, ['build', '-'])
    assert.deepEqual(
      remoteBuild(['build', `-f${join(root, 'Dockerfile')}`, root], undefined).args,
      ['build', '-fDockerfile', '-'],
    )
    assert.deepEqual(remoteBuild(['build', '--memory', '1g', root], undefined).args, [
      'build',
      '--memory',
      '1g',
      '-',
    ])
  })

  test('a flag naming a path on this machine is refused', () => {
    const root = context()
    for (const flags of [
      ['--iidfile', '/tmp/id'],
      ['--metadata-file=/tmp/m'],
      ['--secret', 'id=npm,src=/home/me/.npmrc'],
      ['--ssh', 'default'],
      ['--build-context', 'lib=/src/lib'],
      ['--output', 'type=local,dest=out'],
      ['-o', 'out'],
      ['--cache-to', 'type=local,dest=/cache'],
    ]) {
      assert.throws(
        () => remoteBuild(['build', ...flags, root], undefined),
        /names a path on this machine/,
        flags.join(' '),
      )
    }
    // Canary: values that name nothing here.
    for (const flags of [
      ['--secret', 'id=token,env=TOKEN'],
      ['--build-context', 'base=docker-image://alpine'],
      ['--output', 'type=registry'],
      ['--cache-from', 'type=registry,ref=r/cache'],
    ]) {
      assert.doesNotThrow(() => remoteBuild(['build', ...flags, root], undefined), flags.join(' '))
    }
  })

  test('a Dockerfile outside the context, or on stdin, goes in the tar under its own name', () => {
    const root = context()
    const outside = join(tmp(), 'Other.Dockerfile')
    writeFileSync(outside, 'FROM scratch\n')
    writeFileSync(`${outside}.dockerignore`, 'src/tool.sh\n')
    const r = remoteBuild(['build', '-f', outside, root], undefined)
    const name = r.args[2] as string
    assert.match(name, /^\.reeval-[0-9a-f]{12}\.Dockerfile$/)
    assert.deepEqual(r.args, ['build', '-f', name, '-'])
    const sent = entries(r.input)
    assert.equal(sent.find((e) => e.path === name)?.text, 'FROM scratch\n')
    assert.equal(sent.find((e) => e.path === `${name}.dockerignore`)?.text, 'src/tool.sh\n')
    // The Dockerfile's own ignore file replaces the context's, as the builder applies it.
    const paths = sent.map((e) => e.path)
    assert.ok(paths.includes('secret.env'), 'the context .dockerignore no longer applies')
    assert.ok(!paths.includes('src/tool.sh'))
    assert.ok(!paths.some((p) => p.startsWith('..')))
    const stdin = remoteBuild(['build', '--progress', 'plain', '-f', '-', root], 'FROM busybox\n')
    assert.deepEqual(stdin.args, [
      'build',
      '--progress',
      'plain',
      '-f',
      '.reeval-stdin.Dockerfile',
      '-',
    ])
    assert.equal(
      entries(stdin.input).find((e) => e.path === '.reeval-stdin.Dockerfile')?.text,
      'FROM busybox\n',
    )
  })

  test('a build from stdin, a URL or git, and any other command are as they are', () => {
    for (const url of ['https://github.com/o/r.git#main', 'git@github.com:o/r.git']) {
      assert.deepEqual(remoteBuild(['build', url], undefined).args, ['build', url])
    }
    assert.deepEqual(remoteBuild(['build', '--tag', 't', '-'], 'FROM x'), {
      args: ['build', '--tag', 't', '-'],
      input: 'FROM x',
    })
    assert.deepEqual(remoteBuild(['run', '--rm', 'img', '.'], 'in'), {
      args: ['run', '--rm', 'img', '.'],
      input: 'in',
    })
  })
})

describe('docker() on a remote engine', () => {
  test('arguments, the environment and binary stdin reach the remote CLI as they were', async () => {
    process.env.PATH = `${bin}:${fakeDockerDir}:${PATH}`
    const input = Buffer.from([0, 10, 255, 13, 10, 0, 1])
    const args = ['inspect', 'a b', "it's", '$HOME', '`id`', '']
    const r = await docker(args, { engine: remote, input, env: { REEVAL_SECRET: "s3 cr'et" } })
    assert.equal(r.exitCode, 0, r.stderr)
    const seen = JSON.parse(r.stdout.toString('utf8'))
    assert.deepEqual(seen.args, args)
    assert.equal(seen.secret, "s3 cr'et")
    assert.equal(seen.stdin, createHash('sha256').update(input).digest('hex'))
    assert.ok(!readFileSync(sshLog, 'utf8').includes('s3 cr'), 'the value never went in argv')
    const failed = await docker(['fail'], { engine: remote })
    assert.equal(failed.exitCode, 3)
    assert.match(failed.stderr, /it failed/)
  })

  test('a failure to connect is tried again; the remote command runs once', async (t) => {
    process.env.PATH = `${bin}:${fakeDockerDir}:${PATH}`
    t.after(() => writeFileSync(failures, '0'))
    writeFileSync(failures, '2')
    const r = await docker(['ps'], { engine: remote })
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(readFileSync(failures, 'utf8').trim(), '0')
    // Canary: more failures than tries leaves ssh's.
    writeFileSync(failures, '9')
    const refused = await docker(['ps'], { engine: remote })
    assert.equal(refused.exitCode, 255)
  })

  test("a container's process failing like ssh is never run again", async (t) => {
    process.env.PATH = `${bin}:${fakeDockerDir}:${PATH}`
    const runs = join(tmp(), 'runs')
    process.env.FAKE_DOCKER_RUNS = runs
    t.after(() => {
      delete process.env.FAKE_DOCKER_RUNS
    })
    const message = 'ssh: connect to host vm.test port 2222: Connection refused'
    const r = await docker(['exec', 'c', 'sh', '-c', message], { engine: remote })
    assert.equal(r.exitCode, 255)
    assert.equal(readFileSync(runs, 'utf8'), 'ran\n', 'ran once')
    const transport = containerTransport('c', remote)
    await transport.run?.([message], { input: Buffer.alloc(0) })
    assert.equal(readFileSync(runs, 'utf8'), 'ran\nran\n')
  })

  test('removing and sweeping containers run on the machine', async () => {
    process.env.PATH = `${bin}:${fakeDockerDir}:${PATH}`
    writeFileSync(sshLog, '')
    await removeContainerDetached('abc', remote, { delays: [] })
    assert.match(readFileSync(sshLog, 'utf8'), /exec 'docker' 'rm' '-f' 'abc'/)
    sweepLabelDetached('reeval.run=r1', 1, remote)
    for (let i = 0; i < 50 && !readFileSync(sshLog, 'utf8').includes('label=reeval.run=r1'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.match(readFileSync(sshLog, 'utf8'), /docker ps -aq --filter .*label=reeval\.run=r1/)
  })
})

const answers = (args: string[]) => {
  try {
    execFileSync('docker', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const realDocker = ENGINE === 'docker' && (REQUIRE_ENGINE || answers(['info']))
const reevalImage = realDocker && (REQUIRE_ENGINE || answers(['image', 'inspect', DEFAULT_IMAGE]))

describe('the remote engine on a real Docker', {
  skip: !realDocker && "Docker isn't running",
}, () => {
  test('a build sends the context, and the builder leaves out what .dockerignore names', async (t) => {
    process.env.PATH = `${bin}:${PATH}`
    const root = tmp()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'kept.txt'), 'kept')
    writeFileSync(join(root, 'secret.env'), 'no')
    writeFileSync(join(root, '.dockerignore'), 'secret.env\n')
    const dockerfile = join(tmp(), 'Dockerfile')
    writeFileSync(dockerfile, 'FROM scratch\nCOPY . /\n')
    const outside = join(tmp(), 'Other.Dockerfile')
    writeFileSync(outside, 'FROM scratch\nCOPY . /\n')
    writeFileSync(`${outside}.dockerignore`, 'src/dropped.txt\n')
    writeFileSync(join(root, 'src', 'dropped.txt'), 'no')
    const tag = `reeval-remote-engine-test:${process.pid}`
    t.after(() => answers(['image', 'rm', '-f', tag]))
    const files = async (args: string[], input?: string) => {
      const r = await docker(['build', '--progress', 'plain', '--tag', tag, ...args], {
        engine: remote,
        ...(input !== undefined ? { input } : {}),
      })
      assert.equal(r.exitCode, 0, r.stderr)
      const id = execFileSync('docker', ['create', tag, '/none'], { encoding: 'utf8' }).trim()
      try {
        const tar = execFileSync('docker', ['export', id], { maxBuffer: 64 << 20 })
        return new Map(
          readTar(tar).flatMap((e) => (e.type === 'file' ? [[e.path, e.data.toString()]] : [])),
        )
      } finally {
        answers(['rm', '-f', id])
      }
    }
    const built = await files(['--file', dockerfile, root])
    assert.equal(built.get('src/kept.txt'), 'kept')
    assert.equal(built.has('secret.env'), false, 'left out by .dockerignore')
    // A Dockerfile outside the context with its own ignore file, which replaces the context's.
    const own = await files(['-f', outside, root])
    assert.equal(own.get('secret.env'), 'no')
    assert.equal(own.has('src/dropped.txt'), false)
    // A Dockerfile on stdin with a context.
    const viaStdin = await files(['-f', '-', root], 'FROM scratch\nCOPY src/ /from-stdin/\n')
    assert.equal(viaStdin.get('from-stdin/kept.txt'), 'kept')
  })

  test('a session runs, streams and removes its container over the remote engine', {
    skip: !reevalImage && "reeval's image isn't built",
  }, async () => {
    process.env.PATH = `${bin}:${PATH}`
    const session = await createDockerSession({ image: DEFAULT_IMAGE, engine: remote })
    try {
      const ran = await session.run({ command: 'echo "$GREETING"', env: { GREETING: 'hi there' } })
      assert.equal(ran.stdout.trim(), 'hi there')
      const spawned = await session.spawn({
        command: 'echo "$GREETING"',
        env: { GREETING: 'streamed' },
      })
      const text = await new Response(spawned.stdout).text()
      assert.equal((await spawned.wait()).exitCode, 0)
      assert.equal(text.trim(), 'streamed')
    } finally {
      await session.destroy()
    }
    const left = execFileSync('docker', ['ps', '-aq', '--filter', `id=${session.id}`], {
      encoding: 'utf8',
    })
    assert.equal(left.trim(), '')
  })
})
