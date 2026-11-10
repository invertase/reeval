// `reeval link`: links this project to a project on the cloud platform at `REEVAL_CLOUD_URL`
// (https://cloud.reeval.ai when that isn't set), with the sign-in `reeval login` keeps (or
// `REEVAL_TOKEN`). It asks for the org, when there's more than one, and the project, or takes them
// from `--org` and `--project`, and writes `.reeval/project.json`, which cloud runs and
// `reeval cloud secrets` and `provider` read.
import { relative } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Flags } from './cli-spec.ts'
import {
  type LinkedProject,
  linkedProject,
  projectFile,
  writeLinkedProject,
} from './cloud-project.ts'
import { CloudError, cloudUrl, platformError, refusedHint, request } from './cloud-run.ts'
import { UsageError } from './errors.ts'
import { CLOUD_TOKEN_VAR, cloudToken } from './login/credentials.ts'

type Org = { id: string; slug: string; name: string }
type Project = { id: string; slug: string; name: string }

export type LinkIo = {
  out: (line: string) => void
  /** Where the answers are read and the questions written. */
  input: Readable
  output: Writable
  /** Whether there's a terminal to ask on; without one, `--org`, `--project` and `--yes` answer. */
  interactive: boolean
  /** The project's directory, where `.reeval/project.json` goes. */
  projectDir: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

const shown = (base: URL) => base.href.replace(/\/$/, '')
const label = (x: { name: string; slug: string }) =>
  x.name && x.name !== x.slug ? `${x.name} (${x.slug})` : x.slug

/** An answer by number, id or slug; the empty answer takes the first. */
function pick<T extends { id: string; slug: string }>(items: T[], answer: string): T | undefined {
  if (!answer) return items[0]
  if (/^\d+$/.test(answer)) return items[Number(answer) - 1]
  return items.find((x) => x.id === answer) ?? items.find((x) => x.slug === answer.toLowerCase())
}

/** The one `named` by id or slug, else exit 2 listing them. */
function named<T extends Org | Project>(items: T[], flag: string, value: string, where: string): T {
  const found = items.find((x) => x.id === value) ?? items.find((x) => x.slug === value)
  if (found) return found
  throw new UsageError(
    `${where} has no ${flag} ${value}: pass --${flag} with one of ${items.map((x) => x.slug).join(', ')}`,
  )
}

/** `reeval link`: picks an org and a project on the platform and writes `.reeval/project.json`. */
export async function linkCommand(flags: Flags, io: LinkIo): Promise<number> {
  const env = io.env ?? process.env
  const base = cloudUrl(env)
  if (flags.org === '') throw new UsageError("--org needs a value: the org's slug or id")
  if (flags.project === '')
    throw new UsageError("--project needs a value: the project's slug or id")
  const token = await cloudToken(base, env)
  if (!token) {
    throw new UsageError(
      `Not signed in to ${shown(base)}: run reeval login first, or set ${CLOUD_TOKEN_VAR}.`,
    )
  }
  const auth = { headers: { authorization: `Bearer ${token.token}` }, refused: refusedHint(token) }
  const get = async <T>(path: string, what: string): Promise<T> => {
    const answer = await request(new URL(path, base), { method: 'GET', what }, auth.headers)
    if (answer.status === 401) {
      throw new UsageError(
        token.from === 'env'
          ? `The cloud platform at ${shown(base)} refused ${CLOUD_TOKEN_VAR}: check it.`
          : `The sign-in to ${shown(base)} has expired or was revoked: run reeval login again.`,
      )
    }
    if (!answer.ok) throw platformError(answer, what, auth)
    return answer.body as T
  }

  const file = projectFile(io.projectDir)
  const shownFile = relative(io.cwd ?? process.cwd(), file) || file
  let current: LinkedProject | null = null
  let unreadable = false
  try {
    current = await linkedProject(io.projectDir)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    unreadable = true
  }

  // The iterator is taken at once: one taken after the input has ended never yields.
  const readline = io.interactive ? createInterface({ input: io.input, terminal: false }) : null
  const lines = readline?.[Symbol.asyncIterator]()
  const ask = async (question: string): Promise<string> => {
    io.output.write(question)
    const next = await lines?.next()
    if (!next || next.done) {
      throw new UsageError('reeval link got no answer. Pass --org, --project and --yes.')
    }
    return String(next.value).trim()
  }
  const choose = async <T extends Org | Project>(what: string, items: T[]): Promise<T> => {
    io.output.write(
      `${[`Which ${what}?`, ...items.map((x, i) => `  ${i + 1}) ${label(x)}`)].join('\n')}\n`,
    )
    for (;;) {
      const chosen = pick(items, await ask(`${what[0]?.toUpperCase()}${what.slice(1)} [1]: `))
      if (chosen) return chosen
      io.output.write(`Answer 1 to ${items.length}, or a ${what}'s slug.\n`)
    }
  }

  try {
    const orgs = (await get<{ orgs?: Org[] }>('api/orgs', 'list your orgs'))?.orgs ?? []
    if (!orgs.length) {
      throw new UsageError(
        `You aren't in any org on ${shown(base)}: ask an admin of one to add you.`,
      )
    }
    const listed = new Map<string, Promise<Project[]>>()
    const projectsOf = (org: Org) => {
      let projects = listed.get(org.id)
      if (!projects) {
        projects = get<{ projects?: Project[] }>(
          `api/orgs/${encodeURIComponent(org.id)}/projects`,
          `list the projects in ${org.slug}`,
        ).then((body) => body?.projects ?? [])
        listed.set(org.id, projects)
      }
      return projects
    }
    const projectsIn = async (org: Org) => {
      const projects = await projectsOf(org)
      if (!projects.length) {
        throw new UsageError(
          `${label(org)} has no projects yet: create one on ${shown(base)}, then run reeval link again.`,
        )
      }
      return projects
    }
    /** The link there is, by name where this sign-in can still see it. */
    const now = async () => {
      if (!current) return `${shownFile} isn't a link reeval reads`
      const org = orgs.find((o) => o.id === current.orgId)
      const projects = org ? await projectsOf(org).catch(() => []) : []
      const project = projects.find((p) => p.id === current.projectId)
      return `${shownFile} links this project to ${project ? label(project) : current.projectId} in ${org ? label(org) : current.orgId}`
    }
    /** Whether to replace the link there is: --yes, else the answer, else exit 2 with no terminal. */
    const replace = async (): Promise<boolean> => {
      if (!(current || unreadable) || flags.yes) return true
      if (!io.interactive) throw new UsageError(`${await now()}: pass --yes to replace it.`)
      if (/^y(es)?$/i.test(await ask(`${await now()}. Replace it? [y/N] `))) return true
      io.out(`Kept ${shownFile}.`)
      return false
    }

    let org: Org
    let project: Project
    if (flags.org !== undefined && flags.project !== undefined) {
      org = named(orgs, 'org', flags.org, shown(base))
      project = named(await projectsIn(org), 'project', flags.project, label(org))
      if (current?.orgId === org.id && current.projectId === project.id) {
        io.out(`${shownFile} links this project to ${label(project)} in ${label(org)} already.`)
        return 0
      }
      if (!(await replace())) return 0
    } else {
      if (!(await replace())) return 0
      if (flags.org !== undefined) org = named(orgs, 'org', flags.org, shown(base))
      else if (orgs.length === 1) org = orgs[0] as Org
      else if (io.interactive) org = await choose('org', orgs)
      else {
        throw new UsageError(
          `You're in ${orgs.length} orgs on ${shown(base)} and there's no terminal to ask which: pass --org with one of ${orgs.map((o) => o.slug).join(', ')}`,
        )
      }
      const projects = await projectsIn(org)
      if (flags.project !== undefined) {
        project = named(projects, 'project', flags.project, label(org))
      } else if (io.interactive) project = await choose('project', projects)
      else {
        throw new UsageError(
          `There's no terminal to ask which project in ${label(org)} to link: pass --project with one of ${projects.map((p) => p.slug).join(', ')}`,
        )
      }
    }
    if (typeof project.id !== 'string' || !project.id || typeof org.id !== 'string' || !org.id) {
      throw new CloudError('the cloud platform listed an org or project without an id')
    }

    await writeLinkedProject(io.projectDir, { orgId: org.id, projectId: project.id })
    io.out(`Linked this project to ${label(project)} in ${label(org)}: wrote ${shownFile}.`)
    return 0
  } finally {
    readline?.close()
  }
}
