import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import {
  type AnalysisIndex,
  analysisDataPath,
  artifactPath,
  type DebugView,
  debugApiPath,
  type HistoryEntry,
  type IndexManifest,
  type LiveIndex,
  liveApiPath,
  liveTranscriptPath,
  manifestPath,
  type RunRecord,
  readableRecord,
  recordPath,
  type StudioInfo,
  shardPath,
  studioPath,
  traceApiPath,
} from 'reeval/view'

export class NotFoundError extends Error {
  override name = 'NotFoundError'
}

/**
 * Every read goes through here: a path relative to the page, the same in `reeval studio` (served by
 * the local server) and `reeval studio build` (files next to index.html).
 */
async function get(path: string): Promise<Response> {
  const res = await fetch(new URL(path, document.baseURI), { credentials: 'same-origin' })
  if (res.status === 404) throw new NotFoundError(`${path} not found`)
  if (res.status === 401)
    throw new Error('The studio session expired. Reopen the URL printed by reeval studio.')
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res
}

export const fetchJson = async <T>(path: string): Promise<T> =>
  (await get(path)).json() as Promise<T>
export const fetchText = async (path: string): Promise<string> => (await get(path)).text()

export const studioQuery = queryOptions({
  queryKey: ['index', studioPath],
  queryFn: () => fetchJson<StudioInfo>(studioPath),
  staleTime: 60_000,
})

/** Every run header, newest first, from all month shards. */
export const headersQuery = queryOptions({
  queryKey: ['index', 'headers'],
  queryFn: async () => {
    const manifest = await fetchJson<IndexManifest>(manifestPath)
    const shards = await Promise.all(
      manifest.shards.map((s) => fetchJson<HistoryEntry[]>(shardPath(s.id))),
    )
    return { manifest, headers: shards.flat() }
  },
})

export const recordQuery = (runId: string) =>
  queryOptions({
    queryKey: ['record', runId],
    queryFn: async () => readableRecord(await fetchJson<RunRecord>(recordPath(runId))),
  })

export const artifactQuery = (runId: string, path: string | undefined) =>
  queryOptions({
    queryKey: ['artifact', runId, path],
    queryFn: () => fetchText(artifactPath(runId, path as string)),
    enabled: !!path,
    staleTime: Number.POSITIVE_INFINITY,
    retry: (count, error) => !(error instanceof NotFoundError) && count < 2,
  })

/** A run's analyses; none (not an error) when the run has no file for them. */
export const analysisQuery = (runId: string) =>
  queryOptions({
    queryKey: ['record', 'analysis', runId],
    queryFn: async (): Promise<AnalysisIndex> => {
      try {
        return await fetchJson<AnalysisIndex>(analysisDataPath(runId))
      } catch (error) {
        if (error instanceof NotFoundError) return { runId, entries: [] }
        throw error
      }
    },
  })

/** An attempt's local debug data; `null` when there is none, so the tab stays hidden. */
export const debugQuery = (runId: string, attemptKey: string, enabled: boolean) =>
  queryOptions({
    queryKey: ['debug', runId, attemptKey],
    queryFn: () => fetchJson<DebugView | null>(debugApiPath(runId, attemptKey)),
    enabled,
    retry: false,
  })

export const traceQuery = (runId: string, attemptKey: string, enabled: boolean) =>
  queryOptions({
    queryKey: ['debug-trace', runId, attemptKey],
    queryFn: () => fetchText(traceApiPath(runId, attemptKey)),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  })

export const useStudio = () => useQuery(studioQuery)

/** Runs in progress; `reeval studio` only (a static build has none), kept current over SSE. */
export const liveQuery = queryOptions({
  queryKey: ['live'],
  queryFn: () => fetchJson<LiveIndex>(liveApiPath),
  staleTime: Number.POSITIVE_INFINITY,
})

export function useLiveRuns() {
  const { data: studio } = useStudio()
  const enabled = !!studio?.features.live
  const query = useQuery({ ...liveQuery, enabled })
  return { ...query, runs: enabled ? (query.data?.runs ?? []) : [] }
}

/** A finished attempt's transcript while its run is still going. */
export const liveTranscriptQuery = (runId: string, attemptKey: string) =>
  queryOptions({
    queryKey: ['live-transcript', runId, attemptKey],
    queryFn: () => fetchText(liveTranscriptPath(runId, attemptKey)),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/**
 * In `reeval studio`, refetch the index (and records) when a run lands or is recorded, and take each
 * live-run update as it comes. A run that left the live list has landed: the index is refetched
 * before the list changes, so the real run takes its place without a gap.
 */
export function useLiveUpdates(enabled: boolean) {
  const client = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const events = new EventSource(new URL('api/events', document.baseURI))
    events.addEventListener('history.changed', () => {
      void client.invalidateQueries({ queryKey: ['index'] })
      void client.invalidateQueries({ queryKey: ['record'] })
    })
    let queue = Promise.resolve()
    events.addEventListener('run.progress', (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as LiveIndex
      queue = queue.then(async () => {
        const before = client.getQueryData<LiveIndex>(liveQuery.queryKey)?.runs ?? []
        const ids = new Set(next.runs.map((r) => r.runId))
        if (before.some((r) => !ids.has(r.runId))) {
          await client.refetchQueries({ queryKey: ['index'] }).catch(() => {})
        }
        client.setQueryData(liveQuery.queryKey, next)
      })
    })
    // Whatever moved while the stream was down.
    events.addEventListener('ready', () => {
      void client.invalidateQueries({ queryKey: liveQuery.queryKey })
    })
    return () => events.close()
  }, [enabled, client])
}
