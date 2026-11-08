// The remote engine: the docker CLI over a machine's SSH. A fake `ssh` runs the remote command
// with `sh -c` here, as the login shell would there, so the CLI it reaches is this machine's: a
// fake `docker` for the wire format, the real one for builds and a session.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { docker } from '../src/docker-cli.ts'
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
if [ "$n" -gt 0 ]; then echo $((n - 1)) > ${failures}; echo "ssh: connect to host vm.test port 22: Connection refused" >&2; exit 255; fi
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

  test('only a failure to connect is ssh failing before the command ran', () => {
    const refused = 'ssh: connect to host vm.test port 22: Connection refused\n'
    assert.equal(isSshFailure({ exitCode: 255, stderr: refused }), true)
    assert.equal(
      isSshFailure({
        exitCode: 255,
        stderr: 'kex_exchange_identification: read: Connection reset by peer',
      }),
      true,
    )
    // Canary: the remote command's own 255, and a connection that dropped after it started.
    assert.equal(isSshFailure({ exitCode: 255, stderr: '' }), false)
    assert.equal(
      isSshFailure({ exitCode: 255, stderr: 'Connection to vm.test closed by remote host.' }),
      false,
    )
    assert.equal(isSshFailure({ exitCode: 1, stderr: refused }), false)
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
      ['.dockerignore', 'Dockerfile', 'src/kept.txt', 'src/tool.sh'],
    )
    assert.equal(sent.find((e) => e.path === 'src/tool.sh')?.mode, 0o755, 'modes kept')
    // No --file: the context's own Dockerfile, as docker reads it.
    assert.deepEqual(
      remoteBuild(['build', `--file=${join(root, 'Dockerfile')}`, root], undefined).args,
      ['build', '--file=Dockerfile', '-'],
    )
    assert.deepEqual(remoteBuild(['build', root], undefined).args, ['build', '-'])
  })

  test('a Dockerfile outside the context, or on stdin, goes in the tar under its own name', () => {
    const root = context()
    const outside = join(tmp(), 'Other.Dockerfile')
    writeFileSync(outside, 'FROM scratch\n')
    writeFileSync(`${outside}.dockerignore`, '*\n')
    const r = remoteBuild(['build', '-f', outside, root], undefined)
    const name = r.args[2] as string
    assert.match(name, /^\.reeval-[0-9a-f]{12}\.Dockerfile$/)
    assert.deepEqual(r.args, ['build', '-f', name, '-'])
    const sent = entries(r.input)
    assert.equal(sent.find((e) => e.path === name)?.text, 'FROM scratch\n')
    assert.equal(sent.find((e) => e.path === `${name}.dockerignore`)?.text, '*\n')
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

  test('a build from stdin and any other command are as they are', () => {
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

  test('a failure to connect is tried again; the remote command runs once', async () => {
    process.env.PATH = `${bin}:${fakeDockerDir}:${PATH}`
    writeFileSync(failures, '2')
    const r = await docker(['ps'], { engine: remote })
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(readFileSync(failures, 'utf8').trim(), '0')
    // Canary: more failures than tries leaves ssh's.
    writeFileSync(failures, '9')
    const refused = await docker(['ps'], { engine: remote })
    assert.equal(refused.exitCode, 255)
    writeFileSync(failures, '0')
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
  test('a build sends the context, and the builder leaves out what .dockerignore names', async () => {
    process.env.PATH = `${bin}:${PATH}`
    const root = tmp()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'kept.txt'), 'kept')
    writeFileSync(join(root, 'secret.env'), 'no')
    writeFileSync(join(root, '.dockerignore'), 'secret.env\n')
    const dockerfile = join(tmp(), 'Dockerfile')
    writeFileSync(dockerfile, 'FROM scratch\nCOPY . /\n')
    const out = join(tmp(), 'out')
    const r = await docker(
      [
        'build',
        '--progress',
        'plain',
        '--output',
        `type=local,dest=${out}`,
        '--file',
        dockerfile,
        root,
      ],
      { engine: remote },
    )
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(readFileSync(join(out, 'src', 'kept.txt'), 'utf8'), 'kept')
    assert.equal(existsSync(join(out, 'secret.env')), false, 'left out by .dockerignore')
    // A Dockerfile on stdin with a context.
    const viaStdin = join(tmp(), 'out')
    const s = await docker(
      ['build', '--progress', 'plain', '--output', `type=local,dest=${viaStdin}`, '-f', '-', root],
      { engine: remote, input: 'FROM scratch\nCOPY src/ /from-stdin/\n' },
    )
    assert.equal(s.exitCode, 0, s.stderr)
    assert.equal(readFileSync(join(viaStdin, 'from-stdin', 'kept.txt'), 'utf8'), 'kept')
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
