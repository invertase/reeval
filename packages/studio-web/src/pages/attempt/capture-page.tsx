import { useQuery } from '@tanstack/react-query'
import {
  type ArtifactRef,
  type CapturePageFile,
  failedRequestLine,
  readableCapturePage,
} from 'reeval/view'
import { artifactQuery, useStudio } from '@/lib/data'
import { plural } from '@/lib/format'

/** What the browser saw on a capture, from its `.capture.json`, under its screenshot. */
export function CapturePageFacts({ runId, art }: { runId: string; art: ArtifactRef }) {
  const { data: studio } = useStudio()
  const path = studio?.features.artifacts === false ? undefined : art.capture?.page?.path
  const query = useQuery(artifactQuery(runId, path))
  if (!query.data) return null
  let page: CapturePageFile
  try {
    page = readableCapturePage(JSON.parse(query.data) as CapturePageFile)
  } catch {
    return null
  }
  const lines = [
    ...page.errors.map((text) => ({ text, className: 'whitespace-pre-wrap text-fail' })),
    ...page.console.map((m) => ({
      text: `console ${m.level} (${m.source}): ${m.text}`,
      className: m.level === 'error' ? 'whitespace-pre-wrap text-fail' : 'whitespace-pre-wrap',
    })),
    ...page.failedRequests.map((r) => ({ text: failedRequestLine(r), className: 'break-all' })),
  ].map((line, n) => ({ ...line, id: `${n}` }))
  const summary = [
    plural(page.errors.length, 'page error'),
    plural(page.console.length, 'console message'),
    plural(page.failedRequests.length, 'failed request'),
  ].join(' · ')
  return (
    <details className="text-xs text-muted-foreground" open={page.errors.length > 0}>
      <summary className="cursor-pointer">
        <span className="font-mono">{page.finalUrl}</span>
        {page.status ? ` (${page.status})` : ''}: {summary}
        {page.dropped ? ` (+${page.dropped} more)` : ''}
      </summary>
      {lines.length ? (
        <ul className="mt-2 space-y-1 font-mono">
          {lines.map((line) => (
            <li key={line.id} className={line.className}>
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  )
}
