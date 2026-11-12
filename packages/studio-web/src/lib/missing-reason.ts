/** Why a file the attempt would have isn't here, in the user's terms. */
export function missingReason(
  record: { artifacts: 'all' | 'evidence' | 'failures' | 'none' },
  staticNoArtifacts: boolean,
  recordedPath = false,
): string {
  if (staticNoArtifacts)
    return 'This studio was built with --no-artifacts, so only records are included.'
  if (record.artifacts === 'none')
    return 'This run was recorded with --artifacts none, so no files were kept.'
  if (record.artifacts === 'failures')
    return "This run kept files for failing attempts only (history.artifacts' default, failures)."
  if (record.artifacts === 'evidence')
    return 'This run kept a reduced set of files for passing attempts (history.artifacts evidence).'
  if (recordedPath) return 'recorded, but not on disk (often a `*.log` gitignore)'
  return "The run didn't write this file."
}
