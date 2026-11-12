import { readFileSync, readlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { docker } from './docker-cli.ts'
import { ENGINES, type LocalEngine } from './engine.ts'
import { LABEL } from './image.ts'

const readOr = (read: () => string) => {
  try {
    return read().trim()
  } catch {
    return ''
  }
}

/**
 * A process's start time in clock ticks since boot (`/proc/<pid>/stat`'s 22nd field), which a
 * recycled pid doesn't share; `''` off Linux or where `/proc` hides the process.
 */
function startTime(pid: number | 'self'): string {
  const stat = readOr(() => readFileSync(`/proc/${pid}/stat`, 'utf8'))
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? ''
}

let space: string | undefined
/**
 * Where this process's pids mean something: the hostname and, on Linux, the boot and the pid
 * namespace. Containers that share one daemon and a hostname (a pod's, a compose file's fixed
 * `hostname:`, two machines both named `localhost`) count a pid in different namespaces, so a
 * pid that isn't running here may be running there.
 */
export function pidSpace(): string {
  space ??= [
    hostname(),
    readOr(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')),
    readOr(() => readlinkSync('/proc/self/ns/pid')).replace(/^pid:\[(\d+)\]$/, '$1'),
  ]
    .filter(Boolean)
    .join('/')
  return space
}

/**
 * The {@link LABEL.owner} a container `pid` creates carries: `<pid>[:<start time>]@<pid space>`.
 */
export function ownerLabel(pid = process.pid): string {
  const start = startTime(pid === process.pid ? 'self' : pid)
  return `${pid}${start ? `:${start}` : ''}@${pidSpace()}`
}

/**
 * Whether `pid` is the process that started at `start` (when known): one another user owns
 * (`EPERM`) is, and so is one whose start time can't be read. A pid recycled by another process
 * isn't.
 */
export function pidAlive(pid: number, start?: string): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  if (!start) return true
  const now = startTime(pid)
  return !now || now === start
}

/**
 * Whether a container whose {@link LABEL.owner} is `owner` was left behind: its owner is a process
 * in `space` that has exited. A process in another pid space can't be probed, so its containers
 * stay.
 */
export function ownerGone(
  owner: string,
  space: string,
  alive: (pid: number, start?: string) => boolean = pidAlive,
): boolean {
  const match = /^(\d+)(?::(\d+))?@(.+)$/.exec(owner)
  if (!match || match[3] !== space) return false
  const pid = Number(match[1])
  return pid > 0 && !alive(pid, match[2])
}

const field = (labels: string) => `{{index ${labels} "${LABEL.owner}"}}`

/**
 * Removes the containers on `engine` whose owner process in this pid space has exited: what a
 * reeval killed outright (`SIGKILL`, the OOM killer, a CI job's cancel) left running until its
 * lifetime ran out. A label the container only inherited from its image (reeval commits its baked
 * images from a session's container) names no owner, and one whose image can't be read is kept.
 * Returns the ids it removed.
 */
export async function removeOrphans(
  engine: LocalEngine = 'docker',
  options: { space?: string; alive?: (pid: number, start?: string) => boolean } = {},
): Promise<string[]> {
  const { space = pidSpace(), alive = pidAlive } = options
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
    .filter(([id, image, owner]) => id && image && owner && ownerGone(owner, space, alive))
  const inherited = new Map<string, string | null>()
  for (const image of new Set(gone.map(([, image]) => image as string))) {
    const r = await docker(['image', 'inspect', '--format', field('.Config.Labels'), image], {
      engine,
    })
    inherited.set(image, r.exitCode === 0 ? r.stdout.toString('utf8').trim() : null)
  }
  const orphans = gone
    .filter(([, image, owner]) => {
      const label = inherited.get(image as string)
      return label != null && label !== owner
    })
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
