// Every docker command an attempt runs, into its trace (`-vv`, and trace.ndjson). Imported for its
// side effect by the modules that drive Docker; commands outside an attempt aren't traced.
import { onDockerCommand } from '@reeval/sandbox-docker'
import { attemptDebug } from './attempt.ts'

const word = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

onDockerCommand((command) => {
  const debug = attemptDebug()
  if (!debug) return
  const line = ['docker', ...command.args].map(word).join(' ')
  const result = command.error ? `failed: ${command.error}` : `exit ${command.exitCode}`
  const detail = [
    command.stdin ? `stdin: ${command.stdin} bytes` : '',
    command.stdout ? `stdout: ${command.stdout.trimEnd()}` : '',
    command.stderr ? `stderr: ${command.stderr.trimEnd()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  debug.traceLine('docker', 'command', command, `$ ${line} → ${result} · ${command.ms}ms`, detail)
})
