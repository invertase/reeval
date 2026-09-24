const NOISE_PATH =
  /(?:^|\/)node_modules\/|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/

/** Diff text the judge can actually grade. Source files are kept whole. */
export function patchForJudge(patch: string): string {
  if (!patch) return patch
  const parts = patch.split(/(?=^diff --git )/m).filter((part) => part.length > 0)
  const kept: string[] = []
  const omitted: string[] = []
  for (const part of parts) {
    const path = diffPath(part)
    if (path && (NOISE_PATH.test(path) || part.includes('\nGIT binary patch\n'))) {
      omitted.push(path)
      continue
    }
    kept.push(part)
  }
  const body = kept.join('')
  if (omitted.length === 0) return body
  const names = omitted.map((path) => `- ${path}`).join('\n')
  return `${body}${body.endsWith('\n') || body.length === 0 ? '' : '\n'}[omitted ${omitted.length} dependency or binary file${omitted.length === 1 ? '' : 's'} from the judge prompt]\n${names}\n`
}

function diffPath(part: string): string | null {
  const header = /^(?:diff --git a\/.+ b\/(.+))$/m.exec(part)
  return header?.[1] ?? null
}
