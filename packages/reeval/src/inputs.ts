// The host files an attempt's environment and sandbox name, as the plan sees them: what a copy of
// the project elsewhere would need. Paths are already absolute (the helpers resolve them where
// they're written); a folder is walked as reeval walks it to place it, so the list is its files.
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { contextFiles } from '@reeval/sandbox-docker'
import {
  localPlugin,
  PLUGIN_MANIFEST,
  PluginProblem,
  pluginKeeps,
  skillName,
} from './environment/plugins.ts'
import { excludeMatcher } from './environment/resolve.ts'
import { DEFAULT_SKILL_EXCLUDE, isHostFile, isLocalPath } from './environment.ts'
import { relativeFile } from './ids.ts'
import { asOwnReads } from './own-reads.ts'
import type {
  EnvironmentLayer,
  LocalInput,
  LocalInputKind,
  PluginSource,
  SandboxDescriptor,
} from './types.ts'

type Found = { inputs: LocalInput[]; warnings: string[] }

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
const inside = (dir: string, path: string) => path === dir || path.startsWith(dir + sep)

/**
 * A skill's or plugin's files, by absolute path, less what `skip` leaves out and `.git`. A symlink
 * is listed itself, with its target, and followed: its target is listed too, through the link
 * when it leads outside `dir`. reeval places
 * regular files only, so such a link warns, unless it's a file in `readThrough`, which placement
 * reads by path (a skill's `SKILL.md`, a plugin's manifest). A link to `dir` or one of its
 * parents isn't followed.
 */
function walkFolder(
  dir: string,
  kind: LocalInputKind,
  what: string,
  root: string,
  skip: (path: string, isDir: boolean) => boolean,
  out: Found,
  readThrough: readonly string[] = [],
) {
  const real = realpathSync(dir)
  const seen = new Set<string>()
  const walk = (on: string, rel: string, via: string | undefined) => {
    const at = realpathSync(on)
    if (seen.has(at)) return
    seen.add(at)
    let entries: Dirent[]
    try {
      entries = readdirSync(on, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === '.git') continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(on, entry.name)
      const through = via === undefined ? undefined : `${via}/${entry.name}`
      if (entry.isSymbolicLink()) {
        let target: string
        try {
          target = realpathSync(full)
        } catch {
          out.warnings.push(
            `${what}: ${relativeFile(root, full)} is a broken symlink, and reeval doesn't place it`,
          )
          continue
        }
        const targetIsDir = isDir(target)
        if (skip(path, targetIsDir)) continue
        const shown = `${relativeFile(root, full)} is a symlink to ${relativeFile(root, target) || '.'}`
        if (targetIsDir && inside(target, real)) {
          out.warnings.push(`${what}: ${shown}, which holds its folder, so it isn't followed`)
          continue
        }
        const outside = !inside(real, target)
        if (outside && !(via === undefined && !targetIsDir && readThrough.includes(path))) {
          out.warnings.push(
            `${what}: ${shown}, outside its folder; reeval places only regular files, so the attempt doesn't get it`,
          )
        }
        out.inputs.push({ path: through ?? full, kind, symlinkTo: target })
        const link = through ?? (outside ? full : undefined)
        if (targetIsDir) walk(target, path, link)
        else out.inputs.push({ path: target, kind, ...(link ? { via: link } : {}) })
        continue
      }
      if (skip(path, entry.isDirectory())) continue
      if (entry.isDirectory()) walk(full, path, through)
      else if (entry.isFile())
        out.inputs.push({ path: full, kind, ...(through ? { via: through } : {}) })
    }
  }
  walk(dir, '', undefined)
}

/** The skill directories a local source places: itself, or its children with a `SKILL.md`. */
function skillDirs(dir: string, only: readonly string[] | undefined): string[] {
  if (!isDir(dir)) return []
  if (existsSync(join(dir, 'SKILL.md'))) return [dir]
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
    .map((e) => join(dir, e.name))
    .filter((d) => !only || only.includes(skillName(d)))
    .sort()
}

/**
 * A plugin-relative file placement leaves out: a part the plugin's `kept` (as `readPlugin` reads
 * it) doesn't have. A plugin the plan can't read leaves nothing out.
 */
function pluginSkip(p: PluginSource, root: string) {
  const read = localPlugin(p, root)
  if (!read || read instanceof PluginProblem) return () => false
  const keeps = pluginKeeps(read.kept)
  return (path: string, dir: boolean) => !dir && !keeps(path)
}

/**
 * A local npm spec's files, which the helpers made absolute: a tarball, or a package directory
 * less `.git` and `node_modules`. A registry spec has none.
 */
function npmInputs(spec: string, root: string, out: Found) {
  const path = spec.startsWith('file:') ? spec.slice('file:'.length) : spec
  if (!isLocalPath(path)) return
  if (!isDir(path)) {
    if (existsSync(path)) out.inputs.push({ path, kind: 'npm' })
    return
  }
  const skip = (p: string, dir: boolean) => dir && p.split('/').includes('node_modules')
  walkFolder(path, 'npm', `npm package ${relativeFile(root, path)}`, root, skip, out)
}

const cache = new Map<string, Found>()

/**
 * The host files the layers and sandbox read, every layer's (a later layer's `files` can replace
 * an earlier one's, so this is a superset), and the plan's warnings about them. A path that
 * doesn't exist is left out: the attempt reports it.
 */
export function environmentInputs(
  layers: readonly EnvironmentLayer[],
  sandbox: SandboxDescriptor | undefined,
  root: string,
): Found {
  const key = JSON.stringify([layers.map((l) => l.spec), sandbox, root])
  let found = cache.get(key)
  if (!found) {
    found = asOwnReads(() => readInputs(layers, sandbox, root))
    cache.set(key, found)
  }
  return found
}

function readInputs(
  layers: readonly EnvironmentLayer[],
  sandbox: SandboxDescriptor | undefined,
  root: string,
): Found {
  const out: Found = { inputs: [], warnings: [] }
  const file = (path: string, kind: LocalInputKind) => {
    if (existsSync(path)) out.inputs.push({ path, kind })
  }
  for (const { spec } of layers) {
    for (const value of Object.values(spec.files ?? {})) {
      if (isHostFile(value)) file(value.path, 'file')
    }
    if (isHostFile(spec.rules)) file(spec.rules.path, 'rules')
    if (spec.workspace && isLocalPath(spec.workspace.url)) file(spec.workspace.url, 'workspace')
    for (const s of spec.skills ?? []) {
      if (s.source === 'local') {
        const skip = excludeMatcher(s.exclude ?? DEFAULT_SKILL_EXCLUDE)
        for (const dir of skillDirs(s.path, s.only)) {
          walkFolder(dir, 'skill', `skill ${relativeFile(root, dir)}`, root, skip, out, [
            'SKILL.md',
          ])
        }
      } else if (s.source === 'git' && isLocalPath(s.repo)) file(s.repo, 'skill')
      else if (s.source === 'npm') npmInputs(s.spec, root, out)
    }
    for (const p of spec.plugins ?? []) {
      if (p.source === 'local') {
        if (!isDir(p.path)) continue
        const what = `plugin ${relativeFile(root, p.path)}`
        walkFolder(p.path, 'plugin', what, root, pluginSkip(p, root), out, [PLUGIN_MANIFEST])
        if (p.build !== undefined) {
          for (const path of contextFiles(p.path, null)) {
            if (path !== '.git' && !path.startsWith('.git/')) {
              out.inputs.push({ path: join(p.path, path), kind: 'plugin-build' })
            }
          }
        }
      } else if (p.source === 'git' && isLocalPath(p.repo)) file(p.repo, 'plugin')
      else if (p.source === 'npm') npmInputs(p.spec, root, out)
      else if (p.source === 'marketplace') {
        const m = p.marketplace
        if (m.source === 'git' && isLocalPath(m.repo)) file(m.repo, 'marketplace')
        else if (m.source === 'npm') npmInputs(m.spec, root, out)
      }
    }
  }
  if (sandbox?.kind === 'docker' && sandbox.dockerfile && existsSync(sandbox.dockerfile)) {
    const context = dirname(sandbox.dockerfile)
    for (const path of contextFiles(context, sandbox.dockerfile)) {
      const full = join(context, path)
      out.inputs.push({
        path: full,
        kind: full === sandbox.dockerfile ? 'dockerfile' : 'docker-context',
      })
    }
  }
  out.warnings = [...new Set(out.warnings)]
  return out
}

/** A path as the plan prints it: project-relative, or absolute outside the project. */
export function inputPath(root: string, path: string): string {
  const rel = relative(root, path)
  const outside = rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  return outside ? path.split(sep).join('/') : relativeFile(root, path)
}
