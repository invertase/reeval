import { useQuery } from '@tanstack/react-query'
import { FileQuestion } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FileRef, RunRecord } from 'reeval/view'
import { EmptyState, ErrorState, RowsSkeleton } from '@/components/states'
import { artifactQuery, NotFoundError, useStudio } from '@/lib/data'

/** Why a file the attempt would have isn't here, in the user's terms. */
export function missingReason(record: RunRecord, staticNoArtifacts: boolean): string {
  if (staticNoArtifacts)
    return 'This studio was built with --no-artifacts, so only records are included.'
  if (record.artifacts === 'none')
    return 'This run was recorded with --artifacts none, so no files were kept.'
  if (record.artifacts === 'failures')
    return 'This run kept files for failing evals only (--artifacts failures).'
  return "The run didn't write this file."
}

export function Artifact({
  record,
  file,
  what,
  children,
}: {
  record: RunRecord
  file: FileRef | undefined
  what: string
  children: (text: string) => ReactNode
}) {
  const { data: studio } = useStudio()
  const noArtifacts = studio?.features.artifacts === false
  const query = useQuery(artifactQuery(record.runId, noArtifacts ? undefined : file?.path))
  if (!file || noArtifacts || query.error instanceof NotFoundError) {
    return (
      <EmptyState icon={FileQuestion} title={`No ${what}`}>
        {missingReason(record, noArtifacts)}
      </EmptyState>
    )
  }
  if (query.error) return <ErrorState error={query.error} />
  if (query.isPending) return <RowsSkeleton rows={5} />
  return <>{children(query.data)}</>
}
