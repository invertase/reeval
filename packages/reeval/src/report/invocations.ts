// The last `reeval` commands in a project, in `.reeval/cli.jsonl`, for `reeval report`: redacted
// arguments, the exit code and the error that ended each. Written synchronously, so a crash that
// exits straight away still logs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readableCliInvocation } from '../view/record.ts'
import { scrubber } from './scrub.ts'
import type { CliInvocation } from './types.ts'

/** How many commands the log keeps. */
export const INVOCATIONS_KEPT = 20

export const invocationsFile = (root: string) => join(root, '.reeval', 'cli.jsonl')

/** Every logged command, oldest first; lines that don't parse are skipped. */
export function readInvocations(root: string): CliInvocation[] {
  const file = invocationsFile(root)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [readableCliInvocation(JSON.parse(line) as CliInvocation)]
      } catch {
        return []
      }
    })
}

/**
 * Appends `entry` to the project's log, keeping the newest `INVOCATIONS_KEPT`. Only in a project
 * that already has `.reeval/`, so a command in a fresh directory creates nothing. Never throws.
 */
export function logInvocation(root: string, entry: CliInvocation): void {
  try {
    if (!existsSync(join(root, '.reeval'))) return
    const scrub = scrubber({ env: process.env, home: homedir(), project: root })
    const lines = [...readInvocations(root), scrub.value(entry)]
      .slice(-INVOCATIONS_KEPT)
      .map((e) => JSON.stringify(e))
    writeFileSync(invocationsFile(root), `${lines.join('\n')}\n`)
  } catch {}
}
