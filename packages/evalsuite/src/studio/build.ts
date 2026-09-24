import { existsSync, lstatSync } from 'node:fs'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { scratchDir } from '../history/files.ts'
import { indexFiles, type StudioInfo } from '../view/model.ts'
import { recordPath, studioPath } from '../view/paths.ts'
import { listHeaders, type StudioSource } from './source.ts'

export class StudioBuildError extends Error {
  override name = 'StudioBuildError'
}

export type BuildOptions = {
  source: StudioSource
  appDir: string
  out: string
  /** Copy transcripts, diffs, logs and judge inputs; false writes records and the index only. */
  artifacts: boolean
  es: string
  project: string
}

export type BuildResult = { runs: number; files: number; bytes: number }

async function sizeOf(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    files++
    bytes += (await stat(join(entry.parentPath, entry.name))).size
  }
  return { files, bytes }
}

/**
 * Writes the studio as a static site: the prebuilt app, `studio.json`, the index shards, and every
 * run under `data/runs/` at the same paths `es studio` serves. The app uses hash routing and
 * relative URLs, so the folder works from any host and subpath.
 */
export async function buildStudio(options: BuildOptions): Promise<BuildResult> {
  const { out, source } = options
  if (!existsSync(join(options.appDir, 'index.html'))) {
    throw new StudioBuildError(`The studio web app is missing from ${options.appDir}`)
  }
  if (existsSync(out)) {
    const names = await readdir(out)
    if (names.length > 0 && !names.includes(studioPath)) {
      throw new StudioBuildError(
        `${out} isn't empty and isn't a previous studio build; choose another --out`,
      )
    }
    await rm(out, { recursive: true, force: true })
  }
  await mkdir(out, { recursive: true })
  await cp(options.appDir, out, { recursive: true })

  const headers = await listHeaders(source)
  const generatedAt = new Date().toISOString()
  const info: StudioInfo = {
    mode: 'static',
    es: options.es,
    project: options.project,
    generatedAt,
    features: { live: false, scratch: source.scratch, artifacts: options.artifacts },
  }
  await writeFile(join(out, studioPath), `${JSON.stringify(info, null, 2)}\n`)
  for (const [path, body] of indexFiles(headers, generatedAt)) {
    await mkdir(dirname(join(out, path)), { recursive: true })
    await writeFile(join(out, path), JSON.stringify(body))
  }
  for (const header of headers) {
    const dir = header.recorded ? source.historyDir : scratchDir(source.root)
    const target = join(out, recordPath(header.runId))
    await mkdir(dirname(target), { recursive: true })
    await cp(join(dir, `${header.runId}.json`), target)
    const artifacts = join(dir, header.runId)
    if (options.artifacts && existsSync(artifacts)) {
      await cp(artifacts, join(dirname(target), header.runId), {
        recursive: true,
        // Symlinks could point outside the history folder, so they're never published.
        filter: (src) => !/[\\/]\.tmp-/.test(src) && !lstatSync(src).isSymbolicLink(),
      })
    }
  }
  return { runs: headers.length, ...(await sizeOf(out)) }
}
