import { spawn as spawnChild } from 'node:child_process'
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { Proc, ProcExit, Runner, RunnerInfo, SpawnOptions } from './runner.ts'

export type LocalOptions = {
  /** Where commands start and relative paths resolve: the agent's workspace. */
  cwd: string
  /** Set on every command, over what `inherit` passes on. */
  env?: Record<string, string>
  /**
   * Whether commands get this process's environment (the default). With `false` they get only
   * `PATH`, `HOME` and `env`, so no key in it reaches the agent unless it's passed in `env`.
   */
  inherit?: boolean
}

function platformOf(): RunnerInfo['platform'] {
  const os = process.platform
  const arch = process.arch
  if ((os !== 'linux' && os !== 'darwin') || (arch !== 'x64' && arch !== 'arm64')) {
    throw new Error(`local() runs on Linux and macOS on x64 or arm64, not ${os}-${arch}`)
  }
  return `${os}-${arch}`
}

function libcOf(): RunnerInfo['libc'] {
  if (process.platform !== 'linux') return undefined
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
  return report.header?.glibcVersionRuntime ? 'glibc' : 'musl'
}

/** Signals a process group, which is gone once its last process has exited. */
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/**
 * Runs commands on this machine, as this user, with this user's permissions: an agent run on it
 * can read and change anything you can. Each command leads its own process group, so a kill
 * takes everything it started.
 */
export function local(options: LocalOptions): Runner {
  const cwd = resolve(options.cwd)
  const base: Record<string, string | undefined> =
    options.inherit === false ? { PATH: process.env.PATH, HOME: homedir() } : { ...process.env }
  const groups = new Set<number>()
  const running = new Set<Promise<ProcExit>>()
  let closed = false
  const at = (path: string) => resolve(cwd, path)

  return {
    async info() {
      return {
        platform: platformOf(),
        ...(libcOf() && { libc: libcOf() }),
        home: homedir(),
        cwd,
        user: userInfo().username,
        shell: '/bin/sh',
      }
    },

    spawn(cmd: string | string[], spawnOptions: SpawnOptions = {}): Proc {
      if (closed) throw new Error('local() runner is closed')
      const [file, ...args] = typeof cmd === 'string' ? ['/bin/sh', '-c', cmd] : cmd
      if (!file) throw new Error('spawn needs a command')
      const child = spawnChild(file, args, {
        cwd: spawnOptions.cwd ? at(spawnOptions.cwd) : cwd,
        env: { ...base, ...options.env, ...spawnOptions.env },
        stdio: [spawnOptions.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: true,
      })
      const pid = child.pid
      if (pid !== undefined) groups.add(pid)
      const kill = async (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') => {
        if (pid !== undefined) signalGroup(pid, signal)
      }
      const exited = new Promise<ProcExit>((done) => {
        child.on('error', () => done({ code: 127, signal: null }))
        child.on('exit', (code, signal) => done({ code, signal }))
      })
      running.add(exited)
      void exited.then(() => running.delete(exited))
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
          new Promise<void>((done, fail) => {
            if (!stdin) return fail(new Error("stdin isn't piped: spawn with stdin: 'pipe'"))
            stdin.write(chunk, (error) => (error ? fail(error) : done()))
          }),
        end: () =>
          new Promise<void>((done) => {
            if (!stdin || stdin.writableEnded) return done()
            stdin.end(done)
          }),
        kill,
        exited,
      }
    },

    async readFile(path) {
      try {
        return new Uint8Array(await readFile(at(path)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },

    async writeFile(path, data, writeOptions) {
      const file = at(path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(
        file,
        data,
        writeOptions?.mode === undefined ? {} : { mode: writeOptions.mode },
      )
      if (writeOptions?.mode !== undefined) await chmod(file, writeOptions.mode)
    },

    async upload(hostDir, boxDir) {
      await cp(resolve(hostDir), at(boxDir), { recursive: true })
    },

    async download(boxDir, hostDir) {
      await cp(at(boxDir), resolve(hostDir), { recursive: true })
    },

    async forwardPort(port) {
      return { host: '127.0.0.1', port, close: async () => {} }
    },

    async close() {
      closed = true
      for (const pid of groups) signalGroup(pid, 'SIGKILL')
      groups.clear()
      await Promise.all(running)
    },
  }
}
