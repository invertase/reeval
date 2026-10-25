export type PatchFile = {
  path: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary'
  added: number
  removed: number
  text: string
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }

/** A path as git wrote it in a patch: C-quoted (`"caf\303\251.txt"`) when it has to be. */
function unquoteGitPath(name: string): string {
  if (name.length < 2 || !name.startsWith('"') || !name.endsWith('"')) return name
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (const [, escaped, run] of name.slice(1, -1).matchAll(/\\([0-7]{3}|[\s\S])|([^\\]+)/g)) {
    if (run !== undefined) bytes.push(...encoder.encode(run))
    else if (escaped && /^[0-7]{3}$/.test(escaped)) bytes.push(Number.parseInt(escaped, 8))
    else if (escaped) bytes.push(ESCAPES[escaped] ?? escaped.charCodeAt(0))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

const QUOTED = /^"(?:[^"\\]|\\.)*"/

/** A `--- a/…`, `+++ b/…`, `rename to …` or `copy to …` name, without its prefix. */
function headerName(name: string, prefix: string): string | null {
  // git ends an unquoted name that has a space in it with a tab.
  const path = name.startsWith('"') ? unquoteGitPath(name) : name.replace(/\t$/, '')
  if (path === '/dev/null') return null
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

/** The new path in `diff --git a/<old> b/<new>`, either of them maybe quoted. */
function diffGitPath(line: string): string | null {
  const rest = line.slice('diff --git '.length)
  const quotedOld = QUOTED.exec(rest)
  if (quotedOld) return headerName(rest.slice(quotedOld[0].length + 1), 'b/')
  const quotedNew = / ("(?:[^"\\]|\\.)*")$/.exec(rest)
  if (quotedNew?.[1]) return headerName(quotedNew[1], 'b/')
  // Unquoted, ` b/` can be inside either name; the old and new are the same unless renamed.
  const n = (rest.length - 5) / 2
  if (
    Number.isInteger(n) &&
    rest.slice(0, 2) === 'a/' &&
    rest.slice(2, 2 + n) === rest.slice(n + 5)
  ) {
    return rest.slice(n + 5)
  }
  return /^a\/.+? b\/(.+)$/.exec(rest)?.[1] ?? null
}

/**
 * The path one file's part of a git patch changes: the new path, or the old one for a deletion.
 * Read from its header lines, before the first `@@`, where git C-quotes an awkward name.
 */
export function patchPath(part: string): string | null {
  const head = part.split(/\n@@/, 1)[0]?.split('\n') ?? []
  const after = (prefix: string, strip: string) => {
    const line = head.find((l) => l.startsWith(prefix))
    return line === undefined ? null : headerName(line.slice(prefix.length), strip)
  }
  const diffGit = head[0]?.startsWith('diff --git ') ? diffGitPath(head[0]) : null
  return (
    after('+++ ', 'b/') ??
    after('--- ', 'a/') ??
    after('rename to ', '') ??
    after('copy to ', '') ??
    diffGit
  )
}

/** Splits a git patch into one entry per file, with line counts. */
export function splitPatch(patch: string): PatchFile[] {
  if (!patch.trim()) return []
  return patch
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith('diff --git '))
    .map((text) => {
      const path = patchPath(text) ?? 'unknown'
      let added = 0
      let removed = 0
      // Only the `---` and `+++` before the first `@@` are headers: in a hunk, `--- x` removes `-- x`.
      let inHunks = false
      for (const line of text.split('\n')) {
        if (line.startsWith('@@')) inHunks = true
        else if (!inHunks) continue
        else if (line.startsWith('+')) added++
        else if (line.startsWith('-')) removed++
      }
      const status: PatchFile['status'] = /^new file mode/m.test(text)
        ? 'added'
        : /^deleted file mode/m.test(text)
          ? 'deleted'
          : /^rename from/m.test(text)
            ? 'renamed'
            : /^(Binary files|GIT binary patch)/m.test(text)
              ? 'binary'
              : 'modified'
      return { path, status, added, removed, text }
    })
}
