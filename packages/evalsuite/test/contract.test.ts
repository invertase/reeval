// The harness contract: every real harness passes the same behaviours against a real agent, in
// Docker, from one ES project (test/contract/) run once per harness. The rows are in
// support/harnesses.ts, the behaviours below; each behaviour is its eval's outcome, its canary's
// failure, and a host-side check of the record. The fake row runs the same suite key-free, so the
// suite's own checks are proven on every PR's Docker job. See test/contract/README.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { AttemptRecord, RunRecord } from '../src/history/types.ts'
import { BLOCKED_HOST, PLANTED } from './contract/evals/constants.ts'
import { type CliRun, readRun, runCli } from './helpers.ts'
import { containersLeft } from './support/containers.ts'
import { fixture, testDir } from './support/fixture.ts'
import {
  cellOf,
  type HarnessRow,
  harnesses,
  keyOf,
  reserveAttempts,
  rowEnv,
  scanTargets,
  skipRow,
} from './support/harnesses.ts'
import {
  hasFormat,
  knownSignatures,
  learnSignatures,
  nativeEvents,
  rawTranscripts,
  signatures,
} from './support/stream-formats.ts'

type Ran = { cli: CliRun; run: RunRecord; runDir: string }
/** Returns 'n/a' when the behaviour doesn't apply to the row. */
type Check = (ran: Ran, row: HarnessRow) => void | 'n/a' | Promise<void>
type Behaviour = { name: string; check: Check }

const evalNamed = (run: RunRecord, name: string) => {
  const found = run.evals.find((e) => e.name === name)
  assert.ok(found, `eval "${name}" didn't run: ${run.evals.map((e) => e.name).join(', ')}`)
  return found
}

/** The eval's only attempt, after checking its id: an eval that didn't run fails here. */
function attempt(ran: Ran, row: HarnessRow, name: string, env: string): AttemptRecord {
  const e = evalNamed(ran.run, name)
  assert.deepEqual(
    e.attempts.map((a) => a.id),
    [`${cellOf(row)}/${env}/docker#1`],
  )
  return e.attempts[0] as AttemptRecord
}

const detail = (a: AttemptRecord) =>
  JSON.stringify(
    {
      outcome: a.outcome,
      error: a.error,
      turns: a.turns.map((t) => ({ status: t.status, text: t.text.slice(0, 500) })),
      tools: a.activity.tools,
    },
    null,
    2,
  )

/** The check passed, and its canary failed on its assertion: the check can fail. */
function checkAndCanary(ran: Ran, row: HarnessRow, name: string, env: string, canary: RegExp) {
  const lands = attempt(ran, row, name, env)
  assert.equal(lands.outcome, 'pass', `${name}: ${detail(lands)}`)
  const c = attempt(ran, row, `${name} canary`, env === 'scanned' ? 'planted' : env)
  assert.equal(c.outcome, 'fail', `${name} canary: ${detail(c)}`)
  assert.equal(c.error?.kind, 'assertion', `${name} canary: ${detail(c)}`)
  assert.match(c.error?.message ?? '', canary)
  return lands
}

/** Paths under `dir` whose content includes `needle`, one per line; '' when none do. */
function filesContaining(dir: string, needle: string): string {
  try {
    return execFileSync('grep', ['-rlF', needle, dir], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** Every attempt that ran an agent turn: what a real row spends. */
const withTurns = (run: RunRecord) =>
  run.evals.flatMap((e) => e.attempts).filter((a) => a.turns.length > 0)

type TurnRecord = AttemptRecord['turns'][number] & {
  usage?: { input: number; output: number; cacheRead: number } | null
}

/** What one contract run starts: es.config.ts's budget.attempts, which es run enforces too. */
const CONTRACT_ATTEMPTS = 12

const behaviours: Behaviour[] = [
  {
    name: 'skill placed where the agent reads it, and used',
    check(ran, row) {
      const a = checkAndCanary(
        ran,
        row,
        'skill',
        'skilled',
        /expected null to be 'PROBE-7F3K-QUILL'/,
      )
      const seen = a.context.map((c) => c.path)
      assert.ok(
        seen.some((p) => row.skillContext.test(p)),
        `no ${row.skillContext} in the context: ${JSON.stringify(seen)}`,
      )
    },
  },
  {
    name: 'rules read',
    check: (ran, row) =>
      void checkAndCanary(ran, row, 'rules', 'ruled', /expected null to be 'TANGERINE-41'/),
  },
  {
    name: 'stdio MCP server started and called',
    check(ran, row) {
      checkAndCanary(ran, row, 'mcp', 'stamped', /expected '' to contain 'tools\/call'/)
      const env = ran.run.environments.find((e) => e.name === 'stamped')
      assert.deepEqual(env?.mcp, ['stamp'])
    },
  },
  {
    name: 'file edited and command run, both in the transcript',
    check(ran, row) {
      const a = checkAndCanary(
        ran,
        row,
        'edit and run',
        'notes',
        /expected 'status: draft' to be 'status: final'/,
      )
      assert.ok(
        a.changedFiles.some((f) => f.path === 'notes.txt' && f.status === 'modified'),
        JSON.stringify(a.changedFiles),
      )
      assert.ok(a.activity.tools > 0, 'the record counts the tool calls')
    },
  },
  {
    name: 'tokens recorded where the harness reports them',
    check(ran, row) {
      const turns = withTurns(ran.run).flatMap((a) => a.turns as TurnRecord[])
      assert.ok(turns.length > 0, 'no turns ran')
      for (const t of turns) {
        if (!row.tokens) {
          assert.equal(t.usage ?? null, null, `${row.id} reports no tokens, so none are recorded`)
          continue
        }
        const u = t.usage
        assert.ok(u, `a turn has no usage: ${JSON.stringify(t).slice(0, 300)}`)
        assert.ok(u.input + u.cacheRead > 0 && u.output > 0, JSON.stringify(u))
        for (const [k, v] of Object.entries(u))
          assert.ok(v === null || v >= 0, `usage ${k} is ${v}`)
      }
    },
  },
  {
    name: 'real key never in the container',
    check(ran, row) {
      checkAndCanary(ran, row, 'key', 'scanned', /to deeply equal \[\]/)
      const key = keyOf(row)
      if (key) assert.equal(filesContaining(ran.runDir, key), '', 'the key is in the run directory')
    },
  },
  {
    name: 'deny-all plus auto hosts works, a blocked host refused and recorded',
    check(ran, row) {
      const a = checkAndCanary(ran, row, 'egress', 'closed', /expected '403 000' to match/)
      const egress = a.egress
      assert.equal(egress?.policy, 'deny-all')
      assert.deepEqual(egress?.allowed, row.autoHosts)
      if (row.apiHost)
        assert.ok(
          egress?.contacted.some((h) => h.host === row.apiHost),
          `${row.apiHost} wasn't reached: ${JSON.stringify(egress?.contacted)}`,
        )
      assert.deepEqual(
        egress?.blocked
          .filter((h) => h.host === BLOCKED_HOST)
          .map((h) => [h.host, h.port, h.reason]),
        [[BLOCKED_HOST, 443, `${BLOCKED_HOST} isn't in the allowlist`]],
      )
    },
  },
  {
    name: 'served model recorded',
    check(ran, row) {
      const attempts = withTurns(ran.run)
      assert.ok(attempts.length > 0, 'no turns ran')
      for (const a of attempts) {
        const served = a.servedModels
        if (!row.servedModel) {
          assert.equal(served, null, `${row.id} can't say, so the record says it's unknown`)
          continue
        }
        const pattern = row.servedModel
        assert.ok(
          served?.some((m) => pattern.test(m)),
          `${a.key}: served ${JSON.stringify(served)}, expected one to match ${pattern}`,
        )
      }
    },
  },
  {
    name: 'native stream format unchanged',
    check(ran, row) {
      if (!hasFormat(row.id)) return 'n/a'
      const events = rawTranscripts(ran.runDir).flatMap((f) =>
        nativeEvents(readFileSync(f, 'utf8')),
      )
      assert.ok(events.length > 0, 'no native events in the raw transcripts')
      const seen = signatures(row.id, events)
      if (process.env.ES_UPDATE_FORMATS === '1') learnSignatures(row.id, seen)
      const known = new Set(knownSignatures(row.id))
      const unknown = seen.filter((s) => !known.has(s))
      assert.deepEqual(
        unknown,
        [],
        `${row.id}'s CLI sent what test/replay/formats/${row.id}.json doesn't know: its output format changed. Check the adapter handles it, then accept it with ES_UPDATE_FORMATS=1.`,
      )
    },
  },
  {
    name: 'clean teardown',
    async check(ran) {
      assert.equal(ran.run.status, 'complete')
      assert.equal(await containersLeft(ran.run.runId), '', 'containers left behind')
    },
  },
]

/** The evals whose streams test/replay keeps, per harness (ES_UPDATE_CAPTURES=1). */
const CAPTURED = ['skill', 'mcp', 'edit and run', 'egress']

/**
 * Copies the captured evals' raw transcripts to test/replay/<harness>/, for replay.test.ts. Cursor's
 * command list is dropped: it names the account's team commands and isn't used.
 */
function capture(ran: Ran, row: HarnessRow) {
  const dir = join(testDir, 'replay', row.id)
  mkdirSync(dir, { recursive: true })
  for (const name of CAPTURED) {
    const a = evalNamed(ran.run, name).attempts[0]
    const raw = a?.files.rawTranscript?.path
    assert.ok(a?.outcome === 'pass' && raw, `can't capture ${name}: ${a?.outcome}, ${raw}`)
    const lines = readFileSync(join(ran.runDir, raw), 'utf8')
      .split('\n')
      .filter((l) => l && !l.includes('"sessionUpdate":"available_commands_update"'))
    writeFileSync(join(dir, `${name.replaceAll(' ', '-')}.raw.jsonl`), `${lines.join('\n')}\n`)
  }
}

/** Each row's result per behaviour, for the summary table. */
const results = new Map<string, Map<string, string>>()
const spent = new Map<string, number>()
const mark = (row: HarnessRow, behaviour: string, result: string) => {
  const r = results.get(row.id) ?? new Map<string, string>()
  r.set(behaviour, result)
  results.set(row.id, r)
}

for (const row of harnesses) {
  const skip = skipRow(row)
  describe(`contract: ${row.id}`, { skip }, () => {
    let ran: Ran | undefined
    before(
      async () => {
        reserveAttempts(row, CONTRACT_ATTEMPTS, 'contract')
        const p = await fixture('contract')
        const cli = await runCli(p.dir, ['run', '--concurrency', row.key ? '2' : '4'], {
          env: {
            ...rowEnv(row),
            // Kept for the format check and the replay captures; the files are small.
            ES_RAW_TRANSCRIPT: '1',
            ES_CONTRACT_KEY_TARGETS: scanTargets(keyOf(row) ?? `no key ${Date.now()}`),
            ES_CONTRACT_PLANTED_TARGETS: scanTargets(PLANTED),
          },
          timeoutMs: 25 * 60_000,
        })
        const { run, dir } = readRun(p.dir)
        ran = { cli, run, runDir: dir }
        spent.set(row.id, withTurns(run).length)
        if (process.env.ES_UPDATE_CAPTURES === '1') capture(ran, row)
      },
      { timeout: 26 * 60_000 },
    )

    test('the run: every eval ran once, only the canaries failed (exit 1)', () => {
      assert.ok(ran)
      const out = `${ran.cli.stdout}\n${ran.cli.stderr}`
      assert.equal(ran.run.evals.length, CONTRACT_ATTEMPTS, out)
      assert.equal(ran.cli.code, 1, out)
    })
    for (const b of behaviours) {
      test(b.name, async () => {
        try {
          assert.ok(ran, 'es run didn’t finish')
          mark(row, b.name, (await b.check(ran, row)) ?? 'pass')
        } catch (e) {
          mark(row, b.name, 'FAIL')
          throw e
        }
      })
    }
  })
  if (skip) for (const b of behaviours) mark(row, b.name, `skip: ${skip}`)
}

/** The contract table, printed and appended to `ES_CONTRACT_SUMMARY` (CI's job summary). */
after(() => {
  const rows = harnesses.map((h) => h.id)
  const lines = [
    `| behaviour | ${rows.join(' | ')} |`,
    `|---|${rows.map(() => '---').join('|')}|`,
    ...behaviours.map(
      (b) =>
        `| ${b.name} | ${rows.map((r) => results.get(r)?.get(b.name) ?? 'not run').join(' | ')} |`,
    ),
    `| attempts with an agent turn | ${rows.map((r) => spent.get(r) ?? '—').join(' | ')} |`,
  ]
  const table = `### Harness contract\n\n${lines.join('\n')}\n`
  console.log(`\n${table}`)
  if (process.env.ES_CONTRACT_SUMMARY) appendFileSync(process.env.ES_CONTRACT_SUMMARY, `${table}\n`)
})
