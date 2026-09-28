import { execFileSync } from 'node:child_process'
import { LABEL } from '@reeval/sandbox-docker'

/**
 * The containers a run left, as ids ('' when none), after waiting up to `deadlineMs`: they're
 * removed by a detached `docker rm`, which may finish after the CLI exits.
 */
export async function containersLeft(runId: string, deadlineMs = 20_000): Promise<string> {
  const until = Date.now() + deadlineMs
  let left = ''
  do {
    left = execFileSync('docker', ['ps', '-aq', '--filter', `label=${LABEL.run}=${runId}`], {
      encoding: 'utf8',
    }).trim()
    if (!left) return ''
    await new Promise((r) => setTimeout(r, 250))
  } while (Date.now() < until)
  return left
}
