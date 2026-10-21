import { type AttemptContext, defineEnvironment } from 'reeval'
import { docker, fakeSandbox, podman } from 'reeval/sandbox'

/** The Docker and Podman tiers run the same containers. */
const container = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman : docker

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker' || process.env.REEVAL_FIXTURE_SANDBOX === 'podman'
    ? container()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** A workspace file, a harness-placed skill and a setup step, each making a directory and a file. */
const placing = (name: string, setup: string) =>
  defineEnvironment(name, ({ skill }) => ({
    sandbox,
    files: { 'conf/app.json': '{}\n' },
    skills: [skill.local('../skills/house-greeting')],
    setup: [{ run: setup }],
  }))

export const placed = placing('placed', 'mkdir -p out && touch out/log')

/** Its setup step clears the umask itself, as every exec would under Docker 29.6+ without one. */
export const unmasked = placing('unmasked', 'umask 0000 && mkdir -p out && touch out/log')

const SKILL = '~/.agents/skills/house-greeting'

/** Each path's mode: the workspace, then what `files`, the skill, setup and the agent made. */
const listModes = `stat -c '%a %n' . conf conf/app.json ${SKILL} ${SKILL}/SKILL.md out out/log made made/by-agent notes notes/today.md`

/** `<mode> <path>` of each of those that's group- or world-writable. */
export async function writable(c: AttemptContext): Promise<string[]> {
  const r = await c.exec(listModes)
  if (r.exitCode !== 0) throw new Error(`stat failed: ${r.stderr}`)
  return r.stdout
    .trim()
    .split('\n')
    .filter((line) => Number.parseInt(line, 8) & 0o022)
}
