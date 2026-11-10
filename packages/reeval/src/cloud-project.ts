// `.reeval/project.json`: the cloud project this project is linked to, which `reeval link`
// writes and the cloud run and `reeval cloud secrets` and `provider` read, and the org and project
// `--org` and `--project` name instead, by slug or id.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { CloudError } from './cloud-run.ts'
import { UsageError } from './errors.ts'

export type LinkedProject = { orgId: string; projectId: string }

/** The project's directory, where `.reeval/project.json` is: beside the config, else here. */
export const projectDirFor = (configPath: string | undefined) =>
  configPath ? dirname(configPath) : resolve('.')

/** Where the link is: `.reeval/project.json` in the project's directory. */
export const projectFile = (projectDir: string) => join(projectDir, '.reeval', 'project.json')

/** The linked project, or null when there's no link; exit 2 for a file that isn't one. */
export async function linkedProject(projectDir: string): Promise<LinkedProject | null> {
  const file = projectFile(projectDir)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new UsageError(`couldn't read ${file}: ${(error as Error).message}`)
  }
  let linked: { orgId?: unknown; projectId?: unknown } | null = null
  try {
    linked = JSON.parse(text)
  } catch {}
  if (
    typeof linked?.orgId !== 'string' ||
    !linked.orgId ||
    typeof linked.projectId !== 'string' ||
    !linked.projectId
  ) {
    throw new UsageError(
      `${file} isn't JSON with an orgId and a projectId: reeval link writes it again`,
    )
  }
  return { orgId: linked.orgId, projectId: linked.projectId }
}

/** Writes the link, replacing any other, through a temporary file so a reader never sees half. */
export async function writeLinkedProject(projectDir: string, link: LinkedProject): Promise<string> {
  const file = projectFile(projectDir)
  await mkdir(join(projectDir, '.reeval'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const { orgId, projectId } = link
  try {
    await writeFile(tmp, `${JSON.stringify({ orgId, projectId }, null, 2)}\n`)
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
  return file
}

export type Org = { id: string; slug: string; name: string }
export type Project = { id: string; slug: string; name: string }

/** A GET of the platform's JSON at `path`, refusing as the command does. */
export type PlatformGet = (path: string, what: string) => Promise<unknown>

export const label = (x: { name: string; slug: string }) =>
  x.name && x.name !== x.slug ? `${x.name} (${x.slug})` : x.slug

/** The one with this id, else this slug (in any case). */
export const byName = <T extends Org | Project>(items: T[], value: string) =>
  items.find((x) => x.id === value) ??
  items.find((x) => x.slug.toLowerCase() === value.toLowerCase())

/** The one `value` names, else exit 2 listing them. */
export function named<T extends Org | Project>(
  items: T[],
  flag: 'org' | 'project',
  value: string,
  where: string,
): T {
  const found = byName(items, value)
  if (found) return found
  if (!items.length) throw new UsageError(`${where} has no ${flag}s`)
  // The value isn't shown: it may be a key given after the flag.
  throw new UsageError(
    `${where} has no ${flag} by that name: pass --${flag} with one of ${items.map((x) => x.slug).join(', ')}`,
  )
}

/** The platform's list, keeping the entries with an id; a slug or name it lacks is the id. */
function listOf<T extends Org | Project>(body: unknown, key: 'orgs' | 'projects', what: string) {
  const list = (body as Record<string, unknown> | null)?.[key]
  if (!Array.isArray(list)) throw new CloudError(`the cloud platform didn't list ${what}`)
  return list.flatMap((x: { id?: unknown; slug?: unknown; name?: unknown }) =>
    typeof x?.id === 'string' && x.id
      ? [
          {
            id: x.id,
            slug: typeof x.slug === 'string' && x.slug ? x.slug : x.id,
            name: typeof x.name === 'string' ? x.name : '',
          } as T,
        ]
      : [],
  )
}

/** The orgs the sign-in is a member of. */
export const listOrgs = async (get: PlatformGet) =>
  listOf<Org>(await get('api/orgs', 'list your orgs'), 'orgs', 'your orgs')

/** The projects in `org`. */
export async function listProjects(get: PlatformGet, org: Org) {
  const what = `the projects in ${org.slug}`
  const body = await get(`api/orgs/${encodeURIComponent(org.id)}/projects`, `list ${what}`)
  return listOf<Project>(body, 'projects', what)
}

/**
 * The org, and the project when `project` is `'required'` or `--project` names one, a cloud
 * command acts on: `--org` and `--project` by slug or id, else the link. `--project` alone takes
 * the linked org; `--org` alone takes the linked project only when the link is in that org.
 */
export async function cloudScope(options: {
  flags: { org?: string; project?: string }
  linked: LinkedProject | null
  get: PlatformGet
  command: string
  project: 'required' | 'optional'
}): Promise<{ orgId: string; projectId?: string }> {
  const { flags, linked, get, command } = options
  const required = options.project === 'required'
  if (flags.org === '') throw new UsageError("--org needs a value: the org's slug or id")
  if (flags.project === '')
    throw new UsageError("--project needs a value: the project's slug or id")
  if (flags.org === undefined && flags.project === undefined) {
    if (linked) return required ? linked : { orgId: linked.orgId }
    throw new UsageError(
      `reeval ${command} acts on the linked ${required ? 'project' : 'org'}, and nothing is linked here: run reeval link, or pass ${required ? '--org and --project' : '--org'}`,
    )
  }
  if (flags.org === undefined && !linked) {
    throw new UsageError(
      `--project needs --org in reeval ${command}: nothing is linked here to take the org from`,
    )
  }
  if (required && flags.project === undefined && !linked) {
    throw new UsageError(
      `--org needs --project in reeval ${command}: nothing is linked here to take the project from`,
    )
  }
  const orgs = await listOrgs(get)
  const org =
    flags.org === undefined
      ? orgs.find((o) => o.id === linked?.orgId)
      : named(orgs, 'org', flags.org, 'The cloud platform')
  if (!org) {
    throw new UsageError(
      `The linked org ${linked?.orgId} isn't one of yours on the cloud platform: pass --org, or run reeval link again`,
    )
  }
  if (flags.project === undefined) {
    if (!required) return { orgId: org.id }
    if (linked?.orgId === org.id) return { orgId: org.id, projectId: linked.projectId }
    throw new UsageError(
      `--org needs --project in reeval ${command}: the link isn't in ${org.slug}`,
    )
  }
  const project = named(await listProjects(get, org), 'project', flags.project, label(org))
  return { orgId: org.id, projectId: project.id }
}
