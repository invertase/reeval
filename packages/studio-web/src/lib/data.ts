import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  artifactPath,
  type DebugView,
  debugApiPath,
  type HistoryEntry,
  type IndexManifest,
  manifestPath,
  type RunRecord,
  recordPath,
  type StudioInfo,
  shardPath,
  studioPath,
  traceApiPath,
} from 'evalsuite/view'
import { useEffect } from 'react'

export class NotFoundError extends Error {
  override name = 'NotFoundError'
}

/**
 * Every read goes through here: a path relative to the page, the same in `es studio` (served by
 * the local server) and `es studio build` (files next to index.html).
 */
async function get(path: string): Promise<Response> {
  const res = await fetch(new URL(path, document.baseURI), { credentials: 'same-origin' })
  if (res.status === 404) throw new NotFoundError(`${path} not found`)
  if (res.status === 401)
    throw new Error('The studio session expired. Reopen the URL printed by es studio.')
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

export const manifestQuery = queryOptions({
  queryKey: ['index', manifestPath],
  queryFn: () => fetchJson<IndexManifest>(manifestPath),
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
    queryFn: () => fetchJson<RunRecord>(recordPath(runId)),
  })

export const artifactQuery = (runId: string, path: string | undefined) =>
  queryOptions({
    queryKey: ['artifact', runId, path],
    queryFn: () => fetchText(artifactPath(runId, path as string)),
    enabled: !!path,
    staleTime: Number.POSITIVE_INFINITY,
    retry: (count, error) => !(error instanceof NotFoundError) && count < 2,
  })

/** An attempt's local debug data; `null` when there is none (a 404), so the tab stays hidden. */
export const debugQuery = (runId: string, attemptKey: string, enabled: boolean) =>
  queryOptions({
    queryKey: ['debug', runId, attemptKey],
    queryFn: async (): Promise<DebugView | null> => {
      try {
        return await fetchJson<DebugView>(debugApiPath(runId, attemptKey))
      } catch (error) {
        if (error instanceof NotFoundError) return null
        throw error
      }
    },
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

/** In `es studio`, refetch the index (and records) when a run lands or is recorded. */
export function useLiveUpdates(enabled: boolean) {
  const client = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const events = new EventSource(new URL('api/events', document.baseURI))
    events.addEventListener('history.changed', () => {
      void client.invalidateQueries({ queryKey: ['index'] })
      void client.invalidateQueries({ queryKey: ['record'] })
    })
    return () => events.close()
  }, [enabled, client])
}
