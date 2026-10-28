// Every docker (or podman) command an attempt runs, into its trace (`-vv`, and trace.ndjson). Imported for its
// side effect by the modules that drive Docker; commands outside an attempt aren't traced.
import { AsyncLocalStorage } from 'node:async_hooks'
import { onDockerCommand } from '@reeval/sandbox-docker'
import { redactSecrets } from '../redact.ts'
import { attemptDebug } from './attempt.ts'

const word = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

const quiet = new AsyncLocalStorage<true>()

/** Runs `fn` with its docker commands left out of the trace: a poll that would flood it. */
export const untraced = <T>(fn: () => Promise<T>): Promise<T> => quiet.run(true, fn)

onDockerCommand((command) => {
  const debug = attemptDebug()
  if (!debug || quiet.getStore()) return
  const line = [command.bin, ...command.args].map(word).join(' ')
  const result = command.error ? `failed: ${command.error}` : `exit ${command.exitCode}`
  const detail = [
    command.stdin ? `stdin: ${command.stdin} bytes` : '',
    command.stdout ? `stdout: ${command.stdout.trimEnd()}` : '',
    command.stderr ? `stderr: ${command.stderr.trimEnd()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  debug.traceLine('docker', 'command', command, `$ ${line} → ${result} · ${command.ms}ms`, detail)
}, redactSecrets)
