import { spawn as spawnChild } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { run } from '@reeval/sandbox-docker/process'
import type { Proc, ProcExit, Runner, RunnerInfo, SpawnOptions } from '../runner.ts'

export type DockerOptions = {
  /** The image the container runs, pulled when this machine doesn't have it. */
  image: string
  /** Where commands start and relative paths resolve, in the container: `/workspace` by default. */
  workdir?: string
  /** A host directory bound at {@link workdir}, so the agent's work lands there. */
  mount?: string
  /** Who commands run as: the image's user by default. */
  user?: string
  /** Set on every command. */
  env?: Record<string, string>
  /** Container ports published on the host's loopback, for {@link Runner.forwardPort}. */
  ports?: number[]
  name?: string
  /** Leave the container when the runner closes, rather than removing it. */
  keep?: boolean
}

/** Where each command's process group id goes, so a kill can take its whole tree. */
const PIDS = '/tmp/.reeval-agents'
/** The exit code of the path scripts below when the path doesn't exist. */
const MISSING = 3

async function cli(
  args: string[],
  o: { input?: string | Uint8Array; env?: Record<string, string> } = {},
) {
  const r = await run('docker', args, { ...o, binary: true })
  return { code: r.exitCode, stdout: new Uint8Array(r.stdout), stderr: r.stderr.trim() }
}

async function dockerOk(args: string[], what: string, input?: string | Uint8Array) {
  const r = await cli(args, input === undefined ? {} : { input })
  if (r.code !== 0) throw new Error(`${what}: ${r.stderr || `docker exited ${r.code}`}`)
  return r.stdout
}

/** `-e NAME` for each variable, whose value the docker CLI reads from its own environment. */
const envArgs = (env: Record<string, string>) => Object.keys(env).flatMap((k) => ['-e', k])

function platformOf(machine: string): RunnerInfo['platform'] {
  if (machine === 'x86_64' || machine === 'amd64') return 'linux-x64'
  if (machine === 'aarch64' || machine === 'arm64') return 'linux-arm64'
  throw new Error(`docker() runs x64 and arm64 Linux images, not ${machine}`)
}

/**
 * Runs commands in a container of `image`, started now and removed by `close()` unless `keep`.
 * It's a plain container: the network is Docker's default, nothing stands between the agent and
 * the internet, and a harness's key reaches its CLI in the environment, as on `local()`.
 * Commands run with `docker exec`, each leading its own process group, so a kill takes its tree.
 */
export async function docker(options: DockerOptions): Promise<Runner> {
  const workdir = options.workdir ?? '/workspace'
  const env = options.env ?? {}
  const created = await dockerOk(
    [
      'run',
      '--detach',
      '--init',
      ...(options.name ? ['--name', options.name] : []),
      ...(options.user ? ['--user', options.user] : []),
      '--workdir',
      workdir,
      ...(options.mount ? ['--volume', `${resolve(options.mount)}:${workdir}`] : []),
      ...(options.ports ?? []).flatMap((p) => ['--publish', `127.0.0.1::${p}`]),
      '--label',
      'ai.reeval.agents=docker',
      '--entrypoint',
      'tail',
      options.image,
      '-f',
      '/dev/null',
    ],
    `docker run ${options.image}`,
  )
  const id = new TextDecoder().decode(created).trim()
  const at = (path: string) => posix.resolve(workdir, path)
  const exec = (args: string[], o: { input?: string | Uint8Array; root?: boolean } = {}) =>
    cli(
      [
        'exec',
        ...(o.input === undefined ? [] : ['--interactive']),
        ...(o.root ? ['--user', '0'] : options.user ? ['--user', options.user] : []),
        id,
        ...args,
      ],
      o.input === undefined ? {} : { input: o.input },
    )
  try {
    if (options.user && !options.mount) {
      const r = await exec(['chown', options.user, workdir], { root: true })
      if (r.code !== 0) throw new Error(`chown ${workdir}: ${r.stderr}`)
    }
  } catch (error) {
    await cli(['rm', '--force', id])
    throw error
  }

  let info: Promise<RunnerInfo> | undefined
  let closed = false
  let spawned = 0
  const running = new Set<{ exited: Promise<ProcExit>; killed: () => void }>()

  /** Signals the group of the command whose id file is `tag`, when it has one yet. */
  const signalGroup = async (tag: string, signal: 'SIGTERM' | 'SIGKILL') =>
    exec([
      'sh',
      '-c',
      `p=$(cat "${PIDS}/$1" 2>/dev/null) || exit ${MISSING}; kill -s ${signal.slice(3)} -- "-$p" 2>/dev/null; exit 0`,
      'sh',
      tag,
    ])

  return {
    info() {
      info ??= exec([
        'sh',
        '-c',
        'uname -m; printf "%s\\n" "$HOME"; id -un 2>/dev/null || echo; ls /lib/ld-musl-* > /dev/null 2>&1 && echo musl || echo glibc',
      ]).then(({ code, stdout, stderr }) => {
        if (code !== 0) throw new Error(`docker exec ${id}: ${stderr}`)
        const [machine = '', home = '', user = '', libc] = new TextDecoder()
          .decode(stdout)
          .split('\n')
        return {
          platform: platformOf(machine),
          libc: libc === 'musl' ? 'musl' : 'glibc',
          home,
          cwd: workdir,
          ...(user && { user }),
          shell: '/bin/sh',
        }
      })
      return info
    },

    spawn(cmd: string | string[], spawnOptions: SpawnOptions = {}): Proc {
      if (closed) throw new Error('docker() runner is closed')
      const argv = typeof cmd === 'string' ? ['/bin/sh', '-c', cmd] : cmd
      if (!argv[0]) throw new Error('spawn needs a command')
      const tag = `${++spawned}`
      const vars = { ...env, ...spawnOptions.env }
      const piped = spawnOptions.stdin === 'pipe'
      const child = spawnChild(
        'docker',
        [
          'exec',
          ...(piped ? ['--interactive'] : []),
          ...(options.user ? ['--user', options.user] : []),
          '--workdir',
          spawnOptions.cwd ? at(spawnOptions.cwd) : workdir,
          ...envArgs(vars),
          id,
          'sh',
          '-c',
          `mkdir -p ${PIDS} && echo $$ > ${PIDS}/$0 && exec "$@"`,
          tag,
          ...argv,
        ],
        {
          env: { ...process.env, ...vars },
          stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        },
      )
      child.stdin?.on('error', () => {})
      let killedWith: 'SIGTERM' | 'SIGKILL' | undefined
      let done = false
      const exited = new Promise<ProcExit>((settle) => {
        child.on('error', () => settle({ code: 127, signal: null }))
        child.on('close', (code) => {
          done = true
          settle(
            killedWith && code !== 0 ? { code: null, signal: killedWith } : { code, signal: null },
          )
        })
      })
      const kill = async (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') => {
        if (done) return
        killedWith = killedWith === 'SIGKILL' ? 'SIGKILL' : signal
        for (const until = Date.now() + 5000; !done && Date.now() < until; ) {
          const r = await signalGroup(tag, signal)
          if (r.code !== MISSING) return
          await new Promise((r) => setTimeout(r, 20))
        }
      }
      const entry = { exited, killed: () => (killedWith = 'SIGKILL') }
      running.add(entry)
      void exited.then(() => running.delete(entry))
      const { signal } = spawnOptions
      if (signal) {
        const onAbort = () => void kill('SIGKILL')
        if (signal.aborted) onAbort()
        else {
          signal.addEventListener('abort', onAbort, { once: true })
          void exited.then(() => signal.removeEventListener('abort', onAbort))
        }
      }
      const stdin = child.stdin
      return {
        stdout: Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr as Readable) as ReadableStream<Uint8Array>,
        write: (chunk) =>
          new Promise<void>((ok, fail) => {
            if (!stdin) return fail(new Error("stdin isn't piped: spawn with stdin: 'pipe'"))
            stdin.write(chunk, (error) => (error ? fail(error) : ok()))
          }),
        end: () =>
          new Promise<void>((ok) => {
            if (!stdin || stdin.writableEnded) return ok()
            stdin.end(ok)
          }),
        kill,
        exited,
      }
    },

    async readFile(path) {
      const r = await exec([
        'sh',
        '-c',
        `[ -e "$1" ] || exit ${MISSING}; exec cat -- "$1"`,
        'sh',
        at(path),
      ])
      if (r.code === MISSING) return null
      if (r.code !== 0) throw new Error(`read ${path}: ${r.stderr}`)
      return r.stdout
    },

    async writeFile(path, data, writeOptions) {
      const mode = writeOptions?.mode
      const r = await exec(
        [
          'sh',
          '-c',
          `mkdir -p -- "$(dirname -- "$1")" && cat > "$1"${mode === undefined ? '' : ` && chmod ${mode.toString(8)} "$1"`}`,
          'sh',
          at(path),
        ],
        { input: data },
      )
      if (r.code !== 0) throw new Error(`write ${path}: ${r.stderr}`)
    },

    async upload(hostDir, boxDir) {
      const dir = at(boxDir)
      const made = await exec(['mkdir', '-p', '--', dir])
      if (made.code !== 0) throw new Error(`upload into ${boxDir}: ${made.stderr}`)
      await dockerOk(['cp', `${resolve(hostDir)}/.`, `${id}:${dir}`], `upload into ${boxDir}`)
      if (options.user) {
        const owned = await exec(['chown', '-R', options.user, '--', dir], { root: true })
        if (owned.code !== 0) throw new Error(`upload into ${boxDir}: ${owned.stderr}`)
      }
    },

    async download(boxDir, hostDir) {
      await mkdir(resolve(hostDir), { recursive: true })
      await dockerOk(['cp', `${id}:${at(boxDir)}/.`, resolve(hostDir)], `download ${boxDir}`)
    },

    async forwardPort(port) {
      const r = await cli(['port', id, `${port}/tcp`])
      const published = new TextDecoder().decode(r.stdout).split('\n')[0]?.trim() ?? ''
      const match = /^(.*):(\d+)$/.exec(published)
      if (r.code !== 0 || !match) {
        throw new Error(`docker() didn't publish port ${port}: list it in its ports option`)
      }
      return { host: match[1] ?? '127.0.0.1', port: Number(match[2]), close: async () => {} }
    },

    async close() {
      if (closed) return
      closed = true
      for (const proc of running) proc.killed()
      if (options.keep) {
        await exec([
          'sh',
          '-c',
          `for f in ${PIDS}/*; do [ -f "$f" ] && kill -s KILL -- "-$(cat "$f")" 2>/dev/null; done; exit 0`,
        ])
      } else {
        await cli(['rm', '--force', id])
      }
      await Promise.all([...running].map((p) => p.exited))
    },
  }
}
