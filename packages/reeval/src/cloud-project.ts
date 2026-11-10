// `.reeval/project.json`: the cloud project this project is linked to, which `reeval link`
// writes and the cloud run and `reeval cloud secrets` and `provider` read.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
  let linked: { orgId?: unknown; projectId?: unknown } | null
  try {
    linked = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    linked = null
  }
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
  await writeFile(tmp, `${JSON.stringify({ orgId, projectId }, null, 2)}\n`)
  await rename(tmp, file)
  return file
}
