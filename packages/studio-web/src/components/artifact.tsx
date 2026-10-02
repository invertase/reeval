import { useQuery } from '@tanstack/react-query'
import { FileQuestion } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FileRef, RunRecord } from 'reeval/view'
import { EmptyState, ErrorState, RowsSkeleton } from '@/components/states'
import { artifactQuery, NotFoundError, useStudio } from '@/lib/data'
import { missingReason } from '@/lib/missing-reason'

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
        {missingReason(record, noArtifacts, Boolean(file) && !noArtifacts)}
      </EmptyState>
    )
  }
  if (query.error) return <ErrorState error={query.error} />
  if (query.isPending) return <RowsSkeleton rows={5} />
  return <>{children(query.data)}</>
}
