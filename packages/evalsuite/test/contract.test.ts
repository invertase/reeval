// The harness contract: every real harness passes the same behaviours against a real agent, in
// Docker, from one ES project (test/contract/) run once per harness. The rows are in
// support/harnesses.ts, the behaviours below; each behaviour is its eval's outcome, its canary's
// failure, and a host-side check of the record. The fake row runs the same suite key-free, so the
// suite's own checks are proven on every PR's Docker job. See test/contract/README.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { LABEL } from '@evalsuite/sandbox-docker'
import type { AttemptRecord, RunRecord } from '../src/history/types.ts'
import { BLOCKED_HOST, PLANTED } from './contract/evals/constants.ts'
import { type CliRun, readRun, runCli } from './helpers.ts'
import { fixture } from './support/fixture.ts'
import {
  cellOf,
  type HarnessRow,
  harnesses,
  keyOf,
  rowEnv,
  scanTargets,
  skipRow,
} from './support/harnesses.ts'

type Ran = { cli: CliRun; run: RunRecord; runDir: string }
type Check = (ran: Ran, row: HarnessRow) => void | Promise<void>
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

/** Containers are removed by a detached `docker rm`, which may finish after the CLI exits. */
async function containersLeft(runId: string, deadlineMs = 20_000): Promise<string> {
  const until = Date.now() + deadlineMs
  let left = ''
  do {
    left = execFileSync('docker', ['ps', '-aq', '--filter', `label=${LABEL.run}=${runId}`], {
      encoding: 'utf8',
    }).trim()
    if (!left) return ''
    await new Promise((r) => setTimeout(r, 250))
  } while (Date.now() < until)
  return left
}

/** Every attempt that ran an agent turn: what a real row spends. */
const withTurns = (run: RunRecord) =>
  run.evals.flatMap((e) => e.attempts).filter((a) => a.turns.length > 0)

type TurnRecord = AttemptRecord['turns'][number] & {
  usage?: { input: number; output: number; cacheRead: number } | null
  model?: string | null
}

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
      const turns = withTurns(ran.run).flatMap((a) => a.turns as TurnRecord[])
      assert.ok(turns.length > 0, 'no turns ran')
      for (const t of turns) {
        if (!row.servedModel) continue
        assert.match(t.model ?? '', row.servedModel, `turn: ${JSON.stringify(t).slice(0, 300)}`)
      }
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
        const p = await fixture('contract')
        const cli = await runCli(p.dir, ['run', '--concurrency', row.key ? '2' : '4'], {
          env: {
            ...rowEnv(row),
            ES_CONTRACT_KEY_TARGETS: scanTargets(keyOf(row) ?? `no key ${Date.now()}`),
            ES_CONTRACT_PLANTED_TARGETS: scanTargets(PLANTED),
          },
          timeoutMs: 25 * 60_000,
        })
        const { run, dir } = readRun(p.dir)
        ran = { cli, run, runDir: dir }
        spent.set(row.id, withTurns(run).length)
      },
      { timeout: 26 * 60_000 },
    )

    test('the run: every eval ran once, only the canaries failed (exit 1)', () => {
      assert.ok(ran)
      const out = `${ran.cli.stdout}\n${ran.cli.stderr}`
      assert.equal(ran.run.evals.length, 12, out)
      assert.equal(ran.cli.code, 1, out)
    })
    for (const b of behaviours) {
      test(b.name, async () => {
        try {
          assert.ok(ran, 'es run didn’t finish')
          await b.check(ran, row)
          mark(row, b.name, 'pass')
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
