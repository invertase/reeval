// The side-by-side comparison of ES's engine with the Vitest engine it replaces. With
// ES_DIFFERENTIAL_DIR set, every `es` the tests run (`runCli`) appends what it did to
// <dir>/<test file>.jsonl: exit code, output and run record, with the parts that vary run to run
// (times, run ids, temp paths, the order concurrent attempts print in) normalised away.
// scripts/differential.mjs runs the suites once per engine and compares the captures.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export type Capture = {
  key: string
  code: number | null
  /** Lines before the summary: concurrent attempts interleave, so sorted. */
  live: string[]
  /** The summary and everything after it, in order. */
  summary: string
  stderr: string
  record: unknown
}

const runsIn = (cwd: string) => {
  const dir = join(cwd, '.es/runs')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
}

/** Call before the CLI runs; the returned function captures it once it has exited. */
export function startCapture(cwd: string, args: string[], name: string) {
  const dir = process.env.ES_DIFFERENTIAL_DIR
  if (!dir) return () => {}
  const before = new Set(runsIn(cwd))
  return (result: { code: number | null; stdout: string; stderr: string }, roots: string[]) => {
    const created = runsIn(cwd).filter((f) => !before.has(f))
    const record = created.length
      ? normaliseRecord(
          JSON.parse(readFileSync(join(cwd, '.es/runs', created.sort().at(-1) as string), 'utf8')),
          roots,
        )
      : null
    const clean = (text: string) => normaliseText(text, roots)
    const stdout = clean(result.stdout)
    const at = stdout.search(/^Summary$/m)
    const capture: Capture = {
      key: clean(`${name} ${args.join(' ')}`),
      code: result.code,
      live: (at < 0 ? stdout : stdout.slice(0, at)).split('\n').filter(Boolean).sort(),
      summary: at < 0 ? '' : stdout.slice(at),
      stderr: clean(result.stderr),
      record,
    }
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, `${basename(process.argv[1] ?? 'unknown')}.jsonl`),
      `${JSON.stringify(capture)}\n`,
    )
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function normaliseText(text: string, roots: string[]): string {
  let out = text
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(escapeRegExp(root), 'g'), '<dir>')
  return (
    out
      .replace(/\d{8}T\d{6}Z_[0-9a-z]+_[a-z0-9-]+_[0-9a-z]{4}/g, '<run>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d|\+<t>)/g, '<time>')
      .replace(/\d{8}T\d{6}Z_[a-z0-9-]+_[0-9a-f]{8}/g, '<analysis>')
      .replace(/\S*\/es-test-[A-Za-z0-9]{6}\//g, '<dir>/')
      .replace(/<dir>\/[^/\s]*\[REDACTED\][^/\s]*\//g, '<dir>/')
      .replace(/(<dir>\/[\w-]+?)-[A-Za-z0-9]{6}(?=\/)/g, '$1')
      .replace(/\+\d+:\d\d\b/g, '+<t>')
      .replace(/\b\d\d:\d\d:\d\d(\.\d+)?\b/g, '<clock>')
      .replace(/\(node:\d+\)/g, '(node:<pid>)')
      // What varies by machine: Node's version, the default concurrency (from the CPUs), and
      // where the build and the package store put things.
      .replace(/\bnode (v?)\d+\.\d+\.\d+/gi, 'node $1<version>')
      .replace(/"node": ?"\d+\.\d+\.\d+"/g, '"node": "<version>"')
      .replace(/ · concurrency \d+ · /g, ' · concurrency <n> · ')
      .replace(/"(author|hostHash)": ?"[^"]*"/g, '"$1": <x>')
      .replace(/\blocal · \S+/g, 'local · <user>')
      // Node 22 warns about NO_COLOR beside FORCE_COLOR; newer Node doesn't.
      .replace(
        /^.*(Warning: The 'NO_COLOR' env is ignored|node --trace-warnings \.\.\.).*(\n|$)/gm,
        '',
      )
      .replace(/"concurrency": ?\d+/g, '"concurrency": <n>')
      .replace(/\S*\/node_modules\/\.pnpm\/[^\s)]+/g, '<pnpm>')
      .replace(/(file:\/\/)?<dir>dist\/[^\s):]+(:\d+:\d+)?/g, '<dist>')
      .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
      .replace(/(Executed at \|?) ?[0-9a-f]{12}\b/g, '$1 <sha>')
      .replace(/\(([0-9a-f]{7})(?=[,)])/g, '(<sha>')
      .replace(/"(sha256|bytes|configHash|commit)": ?("[0-9a-f]+"|\d+)/g, '"$1": <x>')
      .replace(/\b\d+(\.\d+)? (B|KB|MB|GB)\b/g, '<size>')
      // Which engine ran is a fact of the record, not a behaviour: Vitest, or @vitest/expect and jiti.
      .replace(/@vitest\/expect [\d.]+ · jiti [\d.]+|\bvitest [\d.]+/g, '<engine>')
      .replace(/^ *"(vitest|@vitest\/expect|jiti)": "[\d.]+",?(\n|$)/gm, '')
      .replace(/es-sandbox-[A-Za-z0-9]{6}/g, 'es-sandbox-<x>')
      .replace(/es_secret_[A-Za-z0-9]+/g, 'es_secret_<x>')
      .replace(/"(\w*(?:Ms|At|_ms)|median|mean|q1|q3|min|max|p\d+)": ?-?[\d.]+/g, '"$1": <n>')
      .replace(/×(\d+(\.\d+)?|–)/g, '×<r>')
      .replace(/\b\d+(\.\d+)?(ms|s|m)\b/g, '<n>')
      .replace(/<n>(ms|s|m)\b/g, '<n>')
      .replace(/~<n>( serial)?( \(~<n> at concurrency \d+\))?/g, '~<estimate>')
      .replace(/ +<n>(?!\w)/g, ' <n>')
      .replace(/^Duration .*$/gm, 'Duration <d>')
  )
}

/** Keys that are times, ids or hashes of what ran rather than what happened. */
const VOLATILE =
  /^(runId|startedAt|endedAt|seq|hostHash|author|git|packages|version|estimateMs|sha256|bytes|configHash|commit|node|concurrency)$|Ms$|fingerprint/i

export function normaliseRecord(value: unknown, roots: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => normaliseRecord(v, roots))
  if (typeof value === 'string') return normaliseText(value, roots)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !VOLATILE.test(k))
      .map(([k, v]) => [k, normaliseRecord(v, roots)]),
  )
}

/** A capture normalised again with today's rules, so tightening them needs no re-recording. */
export function renormalise(capture: Capture): Capture {
  return {
    ...capture,
    key: normaliseText(capture.key, []),
    live: capture.live
      .map((l) => normaliseText(l, []))
      // The Vitest engine sent progress over an async RPC, so an attempt's last line could land
      // after its result, where the renderer drops it; ES's IPC keeps them in order.
      .filter((l) => l && !/\] {2}\+<t> cleaning up$/.test(l))
      .sort(),
    summary: normaliseText(capture.summary, []),
    stderr: normaliseText(capture.stderr, []),
    record: normaliseRecord(capture.record, []),
  }
}
