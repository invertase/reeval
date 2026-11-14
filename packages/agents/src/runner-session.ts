import { constants } from 'node:os'
import { posix } from 'node:path'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { Proc, Runner } from './runner.ts'

type Session = HarnessV1NetworkSandboxSession
type BareSession = ReturnType<Session['restricted']>
type SandboxProcess = Awaited<ReturnType<BareSession['spawn']>>

export type RunnerSessionOptions = {
  /** The session's id; a random one by default. */
  id?: string
  /** What the agent's instructions may say about where it runs. */
  description?: string
  /** Ports the adapter may reach through {@link Runner.forwardPort}. */
  ports?: number[]
}

/** The exit code of the path scripts below when the path doesn't exist. */
const MISSING = 3
/** POSIX `sh`, with GNU or BusyBox `stat -c` and BSD `stat -f` for the size. */
const STAT = `[ -e "$1" ] || exit ${MISSING}
if [ -d "$1" ]; then t=directory; elif [ -f "$1" ]; then t=file; else t=other; fi
s=$(stat -L -c %s -- "$1" 2>/dev/null || stat -L -f %z -- "$1") || exit 1
printf '%s %s' "$t" "$s"`
/**
 * One `<type>\\t<name>` per entry, NUL-separated, since a name can hold a newline. An unreadable
 * directory's glob matches nothing, so it's refused rather than listed as empty.
 */
const LIST = `[ -e "$1" ] || exit ${MISSING}
[ -d "$1" ] || { echo "not a directory" >&2; exit 1; }
ls -a -- "$1" > /dev/null || exit 1
for f in "$1"/* "$1"/.*; do
  n=\${f##*/}
  [ "$n" = . ] || [ "$n" = .. ] && continue
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then t=symlink; elif [ -d "$f" ]; then t=directory; elif [ -f "$f" ]; then t=file; else t=other; fi
  printf '%s\\t%s\\0' "$t" "$n"
done`
const DELETE = `[ -e "$1" ] || [ -L "$1" ] || exit ${MISSING}
[ -d "$1" ] && [ ! -L "$1" ] && { echo "is a directory" >&2; exit 1; }
rm -f -- "$1"`

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const decode = (bytes: Uint8Array, encoding = 'utf-8') => new TextDecoder(encoding).decode(bytes)

function encode(text: string, encoding = 'utf-8'): Uint8Array {
  if (!Buffer.isEncoding(encoding)) throw new Error(`can't encode text as ${encoding}`)
  return Buffer.from(text, encoding)
}

/** The shell's convention for a process a signal ended: 128 plus the signal's number. */
function exitCode({ code, signal }: { code: number | null; signal: string | null }): number {
  if (code !== null) return code
  const number = signal ? constants.signals[signal as NodeJS.Signals] : undefined
  return number === undefined ? 1 : 128 + number
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/** A {@link Proc} as the AI SDK's sandbox process, `wait()` rejecting when `abortSignal` aborts. */
function sandboxProcess(proc: Proc, stdin: boolean, abortSignal?: AbortSignal): SandboxProcess {
  const wait = async () => {
    const exit = await proc.exited
    if (abortSignal?.aborted) throw abortError(abortSignal)
    return { exitCode: exitCode(exit) }
  }
  const handle = {
    stdout: proc.stdout,
    stderr: proc.stderr,
    wait,
    kill: () => proc.kill('SIGKILL'),
  }
  if (!stdin) return handle
  return {
    ...handle,
    stdin: new WritableStream<Uint8Array>({
      write: (chunk) => proc.write(chunk),
      close: () => proc.end(),
    }),
  }
}

/**
 * The runner as the network sandbox session the AI SDK harness adapters drive. Files go through
 * its `readFile` and `writeFile`, commands through `spawn` (`stat`, `listDirectory` and
 * `deleteFile` as POSIX `sh` scripts), ports through `forwardPort`, and its `network` passes
 * through untouched. The session doesn't own the runner: `stop` and `destroy` close only the
 * ports it forwarded, and whoever made the runner closes it. It reads the runner's `cwd` once, when
 * it starts.
 */
export async function runnerSession(
  runner: Runner,
  options: RunnerSessionOptions = {},
): Promise<Session> {
  const info = await runner.info()
  const at = (path: string) => posix.resolve(info.cwd, path)

  const spawn = (o: {
    command: string
    workingDirectory?: string
    env?: Record<string, string>
    abortSignal?: AbortSignal
    stdin?: boolean
  }) => {
    if (o.abortSignal?.aborted) return Promise.reject(abortError(o.abortSignal))
    const proc = runner.spawn(o.command, {
      ...(o.workingDirectory && { cwd: at(o.workingDirectory) }),
      ...(o.env && { env: o.env }),
      stdin: o.stdin ? 'pipe' : 'ignore',
      ...(o.abortSignal && { signal: o.abortSignal }),
    })
    return Promise.resolve(sandboxProcess(proc, o.stdin === true, o.abortSignal))
  }

  const onPath = async (script: string, o: { path: string; abortSignal?: AbortSignal }) => {
    const path = at(o.path)
    const proc = runner.spawn(['sh', '-c', script, 'sh', path], {
      ...(o.abortSignal && { signal: o.abortSignal }),
    })
    const [stdout, stderr, exit] = await Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.exited,
    ])
    if (o.abortSignal?.aborted) throw abortError(o.abortSignal)
    if (exit.code === MISSING) return null
    if (exit.code !== 0) {
      throw new Error(`${path}: ${decode(stderr).trim() || `exit ${exitCode(exit)}`}`)
    }
    return decode(stdout)
  }

  const readBinaryFile = (o: { path: string }) => runner.readFile(at(o.path))
  const writeBinaryFile = (o: { path: string; content: Uint8Array }) =>
    runner.writeFile(at(o.path), o.content)

  const bare: BareSession = {
    description: options.description ?? `Commands start in ${info.cwd}.`,
    readFile: async (o) => {
      const bytes = await readBinaryFile(o)
      if (bytes === null) return null
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    },
    readBinaryFile,
    readTextFile: async (o) => {
      const bytes = await readBinaryFile(o)
      if (bytes === null) return null
      const text = decode(bytes, o.encoding)
      if (o.startLine === undefined && o.endLine === undefined) return text
      const lines = text.split('\n')
      return lines.slice((o.startLine ?? 1) - 1, o.endLine ?? lines.length).join('\n')
    },
    writeFile: async (o) => writeBinaryFile({ path: o.path, content: await collect(o.content) }),
    writeBinaryFile,
    writeTextFile: (o) => writeBinaryFile({ path: o.path, content: encode(o.content, o.encoding) }),
    stat: async (o) => {
      const out = await onPath(STAT, o)
      if (out === null) return null
      const [type, size] = out.trim().split(' ')
      return { type: type as 'file' | 'directory' | 'other', size: Number(size) }
    },
    listDirectory: async (o) => {
      const out = await onPath(LIST, o)
      if (out === null) return null
      return out
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf('\t')
          return {
            type: line.slice(0, tab) as 'file' | 'directory' | 'symlink' | 'other',
            name: line.slice(tab + 1),
          }
        })
    },
    deleteFile: async (o) => (await onPath(DELETE, o)) !== null,
    spawn: spawn as BareSession['spawn'],
    run: async (o) => {
      const proc = await spawn(o)
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collect(proc.stdout),
        collect(proc.stderr),
        proc.wait(),
      ])
      return { exitCode, stdout: decode(stdout), stderr: decode(stderr) }
    },
  }

  const forwarded = new Map<
    number,
    Promise<{ host: string; port: number; close(): Promise<void> }>
  >()
  const getPortEndpoint: Session['getPortEndpoint'] = async ({ port, protocol = 'http' }) => {
    if (!runner.forwardPort) throw new Error(`this runner can't forward port ${port}`)
    let forward = forwarded.get(port)
    if (!forward) {
      forward = runner.forwardPort(port)
      forwarded.set(port, forward)
    }
    const { host, port: hostPort } = await forward
    return { url: `${protocol}://${host}:${hostPort}` }
  }
  const release = async () => {
    const forwards = [...forwarded.values()]
    forwarded.clear()
    await Promise.all(forwards.map(async (f) => (await f).close()))
  }

  const { network } = runner
  return {
    ...bare,
    id: options.id ?? crypto.randomUUID(),
    defaultWorkingDirectory: info.cwd,
    ports: options.ports ?? [],
    getPortEndpoint,
    getPortUrl: async (o) => (await getPortEndpoint(o)).url,
    stop: release,
    destroy: release,
    ...(network?.setNetworkPolicy && { setNetworkPolicy: network.setNetworkPolicy }),
    ...(network?.setRequestTransformations && {
      setRequestTransformations: network.setRequestTransformations,
    }),
    ...(network?.addRequestTransformations && {
      addRequestTransformations: network.addRequestTransformations,
    }),
    restricted: () => bare,
  }
}
