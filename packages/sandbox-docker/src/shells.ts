import { posix } from 'node:path'
import { SANDBOX_STATE, SANDBOX_USER } from './image.ts'
import { shellQuote as q } from './process.ts'
import type { SessionShell } from './transport-session.ts'

export const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export const EXEC_UMASK = 'umask 022'
const EXEC_MARKER = 'REEVAL_EXEC_ID'

/** `NAME=value\0` for each variable, as the remote reader takes them on stdin. */
const envStream = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}\0`)
    .join('')

/**
 * Runs `$2` with bash in `$1` as the sandbox user, after exporting the variables stdin carries,
 * in a process group it leads. The command itself gets no stdin, as a `docker exec` without
 * `--interactive` would.
 */
const READER = `${EXEC_UMASK}; while IFS= read -r -d "" kv; do export "$kv"; done; cd -- "$1" || exit 1; exec /usr/bin/perl -e 'setpgrp(0, 0); exec @ARGV' bash -c "$2" </dev/null`

/**
 * The Linux profile: the login user has passwordless `sudo`, the agent's commands run as
 * {@link SANDBOX_USER} with only `user`'s variables, and reeval's own run as root in
 * {@link SANDBOX_STATE}. Each command carries a marker in its environment, which `kill` finds in
 * `/proc`. `remote` is the host argv that runs one command line as the login user (`ssh`).
 */
export function linuxShell(o: {
  run: SessionShell['run']
  remote(command: string): string[]
  /** Tells this machine's commands apart from another's with the same exec number. */
  id: string
  /** The sandbox user's own variables: PATH, HOME, USER and the like. */
  user: Record<string, string>
  /** What a command that gave no signal of its own stops on. */
  signal?: AbortSignal | undefined
}): SessionShell {
  const marker = (exec: number) => `${o.id}-${exec}`
  const asUser = (cwd: string, command: string) =>
    `sudo -n -H -u ${SANDBOX_USER} -- env -i ${Object.entries(o.user)
      .map(([k, v]) => q(`${k}=${v}`))
      .join(' ')} bash -c ${q(READER)} bash ${q(cwd)} ${q(command)}`
  const asRoot = (command: string, mark?: string) =>
    `sudo -n -- env -i PATH=${SYSTEM_PATH} HOME=/root${mark ? ` ${EXEC_MARKER}=${mark}` : ''} /bin/sh -c ${q(`cd ${SANDBOX_STATE} || exit 1; ${EXEC_UMASK}; ${command}`)}`
  /**
   * Killing the host's program leaves the command running on the machine, so kill what has its
   * marker, and the process group of each: a process that cleared its environment (`env -i`)
   * keeps the group of the command that started it.
   */
  const killExec = (mark: string) =>
    asRoot(
      `gs=; for e in /proc/[0-9]*/environ; do grep -qsxzF ${q(`${EXEC_MARKER}=${mark}`)} "$e" || continue; d=\${e%/environ}; g=$(sed 's/.*) //' "$d/stat" 2>/dev/null | cut -d' ' -f3); kill -9 "\${d#/proc/}" 2>/dev/null; [ "\${g:-0}" -gt 1 ] && gs="$gs $g"; done; for g in $gs; do kill -9 "-$g" 2>/dev/null; done; true`,
    )
  return {
    run: (argv, r) => o.run(argv, { ...r, signal: r.signal ?? o.signal }),
    user: ({ command, cwd, env, exec }) => ({
      argv: o.remote(asUser(cwd, command)),
      input: envStream({ ...env, [EXEC_MARKER]: marker(exec) }),
    }),
    privileged: ({ command, exec }) => ({
      argv: o.remote(asRoot(command, marker(exec))),
      input: '',
    }),
    kill: (exec) => ({ argv: o.remote(killExec(marker(exec))), input: '' }),
    direct: (argv) => o.remote(`sudo -n -u ${SANDBOX_USER} -- ${argv.map(q).join(' ')}`),
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A command as one script on stdin, so variables (and what a secret holds) never reach a
 * command line on the host or in the machine. The shell records its pid for {@link killTree}.
 */
export function execScript(o: {
  command: string
  cwd: string
  env: Record<string, string>
  pidFile: string
  /** Before the machine's own PATH. */
  path: string
}): string {
  const exports = Object.entries(o.env)
    .filter(([k]) => NAME.test(k))
    .map(([k, v]) => `export ${k}=${q(v)}`)
  return [
    [
      `echo $$ > ${q(o.pidFile)}`,
      `export PATH=${q(o.path)}:"$PATH"`,
      ...exports,
      'umask 022',
      `cd ${q(o.cwd)} || exit 1`,
    ].join('; '),
    o.command,
  ].join('\n')
}

/**
 * Reads the script {@link execScript} wrote from stdin and runs it, with stdin then empty, in a
 * process group its shell leads, so the pid the script records is also the group's.
 */
const RUN_SCRIPT = [
  '/usr/bin/perl',
  '-e',
  'setpgrp(0, 0); exec @ARGV',
  '/bin/bash',
  '-c',
  's=$(cat); eval "$s" </dev/null',
]

/**
 * Kills the command whose shell wrote `pidFile` and everything it started: macOS has no `/proc`
 * to find them by a marker, so it stops and kills the shell's process group, which keeps a
 * process its parent left behind (a double fork's), and walks the tree from the shell for one
 * that moved to a group of its own (a job-control shell's job).
 */
export const killTree = (pidFile: string) =>
  `f=${q(pidFile)}; [ -f "$f" ] || exit 0; p=$(cat "$f")
tree() { kill -STOP "$1" 2>/dev/null; for c in $(pgrep -P "$1"); do tree "$c"; done; kill -9 "$1" 2>/dev/null; }
kill -STOP "-$p" 2>/dev/null; tree "$p"; kill -9 "-$p" 2>/dev/null; rm -f "$f"; true`

/**
 * The darwin profile: macOS has no `useradd`, so every command, reeval's own included, runs as
 * the image's user, reeval's in `stateDir`. Each gets its variables in a script on stdin
 * ({@link execScript}) and writes its pid there, which `kill` walks the process tree from.
 * `guest` is the host argv that runs an argv on the machine with its stdin piped.
 */
export function darwinShell(o: {
  run: SessionShell['run']
  guest(argv: readonly string[]): string[]
  /** Where reeval's own commands run, and each command's pid file goes. */
  stateDir: string
  /** Before the machine's own PATH, for every command. */
  path: string
}): SessionShell {
  const pidFile = (exec: number) => posix.join(o.stateDir, `exec-${exec}.pid`)
  const script = (command: string, cwd: string, env: Record<string, string>, exec: number) => ({
    argv: o.guest(RUN_SCRIPT),
    input: execScript({ command, cwd, env, pidFile: pidFile(exec), path: o.path }),
  })
  return {
    run: o.run,
    user: ({ command, cwd, env, exec }) => script(command, cwd, env, exec),
    privileged: ({ command, exec }) => script(command, o.stateDir, {}, exec),
    kill: (exec) => ({ argv: o.guest(['/bin/sh', '-c', killTree(pidFile(exec))]), input: '' }),
    direct: (argv) => o.guest(argv),
  }
}
