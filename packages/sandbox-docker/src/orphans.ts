import { hostname } from 'node:os'
import { docker } from './docker-cli.ts'
import { ENGINES, type LocalEngine } from './engine.ts'
import { LABEL } from './image.ts'

/** The {@link LABEL.owner} a container this process creates carries. */
export const ownerLabel = (host = hostname()) => `${process.pid}@${host}`

/** Whether `pid` is a process on this machine; one another user owns (`EPERM`) is. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Whether a container whose {@link LABEL.owner} is `owner` was left behind: its owner is a process
 * on `host` that has exited. Another host's process can't be probed, so its containers stay.
 */
export function ownerGone(
  owner: string,
  host: string,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  const match = /^(\d+)@(.+)$/.exec(owner)
  if (!match || match[2] !== host) return false
  const pid = Number(match[1])
  return pid > 0 && !alive(pid)
}

const field = (labels: string) => `{{index ${labels} "${LABEL.owner}"}}`

/**
 * Removes the containers on `engine` whose owner process on this host has exited: what a reeval
 * killed outright (`SIGKILL`, the OOM killer, a CI job's cancel) left running until its lifetime
 * ran out. A label the container only inherited from its image (reeval commits its baked images
 * from a session's container) names no owner. Returns the ids it removed.
 */
export async function removeOrphans(
  engine: LocalEngine = 'docker',
  options: { host?: string; alive?: (pid: number) => boolean } = {},
): Promise<string[]> {
  const { host = hostname(), alive = pidAlive } = options
  const listed = await docker(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL.owner}`], {
    engine,
  })
  const ids = listed.exitCode === 0 ? listed.stdout.toString('utf8').split(/\s+/) : []
  if (!ids.some(Boolean)) return []
  // A container removed since the listing fails its inspect; the rest still print.
  const inspected = await docker(
    [
      'inspect',
      '--format',
      `{{.Id}}\t{{.Image}}\t${field('.Config.Labels')}`,
      ...ids.filter(Boolean),
    ],
    { engine },
  )
  const gone = inspected.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split('\t'))
    .filter(([id, image, owner]) => id && image && owner && ownerGone(owner, host, alive))
  const inherited = new Map<string, string>()
  for (const image of new Set(gone.map(([, image]) => image as string))) {
    const r = await docker(['image', 'inspect', '--format', field('.Config.Labels'), image], {
      engine,
    })
    inherited.set(image, r.exitCode === 0 ? r.stdout.toString('utf8').trim() : '')
  }
  const orphans = gone
    .filter(([, image, owner]) => inherited.get(image as string) !== owner)
    .map(([id]) => id as string)
  if (!orphans.length) return []
  const removed = await docker([...ENGINES[engine].rmForce, ...orphans], { engine })
  if (removed.exitCode === 0) return orphans
  const left = await docker(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL.owner}`], {
    engine,
  })
  const still = new Set(left.stdout.toString('utf8').split(/\s+/))
  return orphans.filter((id) => !still.has(id))
}
