import { type FSWatcher, watch } from 'node:fs'
import { readdir } from 'node:fs/promises'

/**
 * Calls `onChange` (debounced) when the set of run records in any of `dirs` changes. Records land
 * last and whole, so a new top-level `.json` means a run finished or was recorded. `fs.watch`
 * gives quick notice; a listing poll covers folders created later and filesystems without events.
 */
export function watchRuns(dirs: string[], onChange: () => void, pollMs = 1500) {
  const watchers = new Map<string, FSWatcher>()
  let signature = ''
  let timer: NodeJS.Timeout | undefined
  let closed = false

  const listing = async () => {
    const parts: string[] = []
    for (const dir of dirs) {
      try {
        const names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'))
        parts.push(`${dir}:${names.sort().join(',')}`)
      } catch {
        parts.push(`${dir}:-`)
      }
    }
    return parts.join('|')
  }

  const check = async () => {
    if (closed) return
    for (const dir of dirs) {
      if (watchers.has(dir)) continue
      try {
        const w = watch(dir, { persistent: false }, () => schedule())
        w.on('error', () => {
          w.close()
          watchers.delete(dir)
        })
        watchers.set(dir, w)
      } catch {}
    }
    const next = await listing()
    if (signature && next !== signature) onChange()
    signature = next
  }

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void check(), 150)
  }

  void check()
  const poll = setInterval(() => void check(), pollMs)
  poll.unref()
  return () => {
    closed = true
    clearInterval(poll)
    clearTimeout(timer)
    for (const w of watchers.values()) w.close()
  }
}
