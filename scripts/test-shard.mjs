// Splits test files into shards of about equal running time, for ci-os.sh's Windows and macOS
// unit shards.
// Node's --test-shard deals files round-robin in name order, and a handful of files take most of
// the time, so it can stack them in one shard and push that job past its timeout.
//
//   node scripts/test-shard.mjs <i>/<n> <file>...   prints shard i's files, one a line, slowest first
//
// Files are packed greedily, slowest first, each into the shard with the least time so far, so the
// split depends only on the set of files, never on their order (Git Bash globs in C order).
import { basename } from 'node:path'

// About how many seconds each file's tests take in a Windows unit shard (the spec reporter's
// top-level durations). A file not listed counts as DEFAULT. Refresh these from a run's logs when
// one shard's time drifts well away from the others'.
const SECONDS = {
  'options.test.ts': 480,
  'analysis.test.ts': 381,
  'corpus.test.ts': 369,
  'engine.test.ts': 341,
  'history.test.ts': 246,
  'compare-questions.test.ts': 238,
  'plan.test.ts': 208,
  'query.test.ts': 171,
  'concurrency.test.ts': 70,
  'init.test.ts': 60,
  'mcp.test.ts': 56,
  'report.test.ts': 48,
  'debug.test.ts': 46,
  'workspace.test.ts': 44,
  'conformance.test.ts': 42,
  'cli.test.ts': 38,
  'example.test.ts': 32,
  'live.test.ts': 17,
  'doctor.test.ts': 16,
  'checks.test.ts': 15,
  'resume.test.ts': 14,
  'python-sdk.test.ts': 6,
  'suite.test.ts': 5,
}
const DEFAULT = 2

// The files whose fake VMs take test/support/fake-tart.ts's loopback lock: in one shard they'd
// queue on it, so they're dealt out one per shard in turn, before the rest are packed.
const LOOPBACK = new Set([
  'tart.test.ts',
  'tart-hosts.test.ts',
  'tart-images.test.ts',
  'sandbox-provider-conformance.test.ts',
  'sandbox-contract.test.ts',
])

const [spec, ...files] = process.argv.slice(2)
const match = /^(\d+)\/(\d+)$/.exec(spec ?? '')
const [index, total] = match ? [Number(match[1]), Number(match[2])] : []
if (!match || index < 1 || index > total) {
  console.error('usage: node scripts/test-shard.mjs <i>/<n> <file>...')
  process.exit(2)
}

const seconds = (file) => SECONDS[basename(file)] ?? DEFAULT
const sorted = [...new Set(files)].sort(
  (a, b) => seconds(b) - seconds(a) || (a < b ? -1 : a > b ? 1 : 0),
)
const shards = Array.from({ length: total }, () => ({ seconds: 0, files: [] }))
const add = (shard, file) => {
  shard.seconds += seconds(file)
  shard.files.push(file)
}
const loopback = sorted.filter((file) => LOOPBACK.has(basename(file)))
for (const [i, file] of loopback.entries()) add(shards[i % total], file)
for (const file of sorted.filter((file) => !LOOPBACK.has(basename(file)))) {
  add(
    shards.reduce((least, s) => (s.seconds < least.seconds ? s : least)),
    file,
  )
}
const shard = shards[index - 1].files.sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b))
for (const file of shard) console.log(file)
