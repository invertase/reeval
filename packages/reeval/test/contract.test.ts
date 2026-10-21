// The harness contract: every real harness passes the same behaviours against a real agent, in
// Docker, from one reeval project (test/contract/) run once per harness. The rows are in
// support/harnesses.ts, the behaviours below; each behaviour is its eval's outcome, its canary's
// failure, and a host-side check of the record. The fake row runs the same suite key-free, so the
// suite's own checks are proven on every PR's Docker job. See test/contract/README.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { isRuntimeState } from '../src/attempt/context.ts'
import type { AttemptRecord, RunRecord } from '../src/history/types.ts'
import type { PluginPart } from '../src/types.ts'
import { BLOCKED_HOST, PLANTED, PLUGIN_PROOF } from './contract/evals/constants.ts'
import { type CliRun, readRun, runCli } from './helpers.ts'
import { containersLeft } from './support/containers.ts'
import { fixture, testDir } from './support/fixture.ts'
import {
  cellOf,
  EVERY_PART,
  type HarnessRow,
  harnesses,
  harnessOf,
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

type Ran = { cli: CliRun; run: RunRecord; runDir: string; project: string }
/** Returns 'n/a' when the behaviour doesn't apply to the row. */
type Check = (ran: Ran, row: HarnessRow) => void | 'n/a' | Promise<void>
/**
 * `canary`: whether the check includes a canary that must fail (a record-only check has none).
 * `skips`: why the row skips the behaviour (its evals weren't in its run), or undefined.
 */
type Behaviour = {
  name: string
  canary: boolean
  check: Check
  skips?: (row: HarnessRow) => string | undefined
}

const evalsNamed = (run: RunRecord, name: RegExp) => run.evals.filter((e) => name.test(e.name))

/**
 * The tags a row's run leaves out: the MCP evals on a harness with no MCP client, the plugin
 * evals on one reeval places no plugins on, and the hook and subagent ones on one whose plugin
 * parts lack them.
 */
function tagsLeftOut(row: HarnessRow): string[] {
  const out = row.mcp === false ? ['mcp'] : []
  if (!row.plugin) return [...out, 'plugin']
  if (!row.plugin.parts.includes('hooks')) out.push('plugin-hooks')
  if (!row.plugin.parts.includes('agents')) out.push('plugin-agents')
  return out
}

/** The evals (eval and canary) each tag a row can leave out has. */
const TAGGED = { mcp: 2, plugin: 8, 'plugin-hooks': 2, 'plugin-agents': 2 } as const

/** What a row's run starts: the contract's evals, less those its tags leave out. */
const attemptsFor = (row: HarnessRow) =>
  CONTRACT_ATTEMPTS -
  tagsLeftOut(row).reduce((sum, tag) => sum + TAGGED[tag as keyof typeof TAGGED], 0)

/** Why a row skips the plugin behaviours: reeval places no plugins on its harness yet. */
const noPlugins = (row: HarnessRow) =>
  row.plugin
    ? undefined
    : `reeval places no plugins on ${harnessOf(row)} yet (its row has no plugin)`

/** Why a row skips a plugin behaviour for a part its harness doesn't load. */
const withoutPart = (part: PluginPart, what: string) => (row: HarnessRow) =>
  noPlugins(row) ??
  (row.plugin?.parts.includes(part) ? undefined : `${harnessOf(row)} loads no plugin ${what}`)

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
      // A turn's error names a provider outage (Gemini's 503) that the eval's assertion can't.
      turns: a.turns.map((t) => ({ status: t.status, error: t.error, text: t.text.slice(0, 500) })),
      tools: a.activity.tools,
    },
    null,
    2,
  )

/**
 * The check passed, and its canary failed on its assertion: the check can fail. The canary runs
 * in `canaryEnv` when it isn't the check's environment.
 */
function checkAndCanary(
  ran: Ran,
  row: HarnessRow,
  name: string,
  env: string,
  canary: RegExp,
  canaryEnv = env,
) {
  const lands = attempt(ran, row, name, env)
  assert.equal(lands.outcome, 'pass', `${name}: ${detail(lands)}`)
  const c = attempt(ran, row, `${name} canary`, canaryEnv)
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
  model?: string | null
}

/** What one contract run starts: reeval.config.ts's budget.attempts, which reeval run enforces too. */
const CONTRACT_ATTEMPTS = 20

export const behaviours: Behaviour[] = [
  {
    name: 'skill placed where the agent reads it, and used',
    canary: true,
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
    canary: true,
    check: (ran, row) =>
      void checkAndCanary(ran, row, 'rules', 'ruled', /expected null to be 'TANGERINE-41'/),
  },
  {
    name: 'stdio MCP server started and called',
    canary: true,
    async check(ran, row) {
      if (row.mcp === false) {
        // Refused at plan time, naming the eval, the harness and the server: nothing runs.
        const plan = (file: string) =>
          runCli(ran.project, ['run', '--dry-run', file], { env: rowEnv(row) })
        const refused = await plan('evals/mcp.eval.ts')
        assert.equal(refused.code, 2, refused.stdout + refused.stderr)
        assert.equal(refused.stdout, '')
        assert.match(
          refused.stderr,
          new RegExp(
            `evaluate\\("mcp"\\) on ${cellOf(row).replaceAll('.', '\\.')}: \\S+ has no MCP client, so it can't use the stamp MCP server`,
          ),
        )
        // The twin: an eval without MCP servers plans on the same harness.
        const plain = await plan('evals/rules.eval.ts')
        assert.equal(plain.code, 0, plain.stdout + plain.stderr)
        assert.equal(evalsNamed(ran.run, /^mcp/).length, 0, 'the MCP evals were left out')
        return 'refused at plan time'
      }
      const a = checkAndCanary(ran, row, 'mcp', 'stamped', /expected '' to contain 'tools\/call'/)
      const env = ran.run.environments.find((e) => e.name === 'stamped')
      assert.deepEqual(env?.mcp, ['stamp'])
      // reeval's timer saw every start of the server answer initialize.
      const starts = a.turns.flatMap((t) => t.mcpStartup ?? [])
      assert.ok(
        starts.some((s) => s.server === 'stamp' && typeof s.ms === 'number'),
        `no timed start of the stamp server: ${JSON.stringify(a.turns.map((t) => t.mcpStartup))}`,
      )
      assert.ok(
        starts.every((s) => s.ms !== null),
        `a start never answered: ${JSON.stringify(starts)}`,
      )
    },
  },
  {
    name: 'file edited and command run, both in the transcript',
    canary: true,
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
    canary: false,
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
    canary: true,
    check(ran, row) {
      checkAndCanary(ran, row, 'key', 'scanned', /to deeply equal \[\]/, 'planted')
      const key = keyOf(row)
      if (key) assert.equal(filesContaining(ran.runDir, key), '', 'the key is in the run directory')
    },
  },
  {
    name: 'deny-all plus auto hosts works, a blocked host refused and recorded',
    canary: true,
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
    canary: false,
    check(ran, row) {
      const attempts = withTurns(ran.run)
      assert.ok(attempts.length > 0, 'no turns ran')
      for (const a of attempts) {
        for (const t of a.turns as TurnRecord[]) {
          const reported = t.model ?? null
          if (row.servedModel) assert.match(reported ?? '', row.servedModel, `${a.key}: turn model`)
          else assert.equal(reported, null, `${row.id} reports no model`)
          const stack = ran.run.stack.harnesses.find((h) => h.id === cellOf(row))
          if (reported) assert.ok(stack?.resolvedModels.includes(reported), `stack: ${reported}`)
        }
        const wire = row.wireModel
        if (!wire) assert.equal(a.servedModels, null, `${row.id}'s requests don't name a model`)
        else
          assert.ok(
            a.servedModels?.some((m) => wire.test(m)),
            `${a.key}: servedModels ${JSON.stringify(a.servedModels)}, expected one to match ${wire}`,
          )
      }
    },
  },
  {
    name: 'nothing silently unreported',
    canary: false,
    check(ran) {
      // A harness that couldn't report some events (the Cursor SDK's web calls, when recovering
      // them from its stored conversation fails, or finds a shape it doesn't know) says so in
      // `unreported`. Every contract turn must have reported everything.
      for (const a of withTurns(ran.run))
        for (const t of a.turns)
          assert.deepEqual(t.unreported, [], `${a.key}: ${JSON.stringify(t.unreported)}`)
    },
  },
  {
    name: 'native stream format unchanged',
    canary: false,
    check(ran, row) {
      // One format per CLI: OpenCode's rows on other providers share OpenCode's.
      const cli = harnessOf(row)
      if (!hasFormat(cli)) return 'n/a'
      const events = rawTranscripts(ran.runDir).flatMap((f) =>
        nativeEvents(readFileSync(f, 'utf8')),
      )
      assert.ok(events.length > 0, 'no native events in the raw transcripts')
      const seen = signatures(cli, events)
      if (process.env.REEVAL_UPDATE_FORMATS === '1') learnSignatures(cli, seen)
      const known = new Set(knownSignatures(cli))
      const unknown = seen.filter((s) => !known.has(s))
      assert.deepEqual(
        unknown,
        [],
        `${row.id}'s CLI sent what test/replay/formats/${cli}.json doesn't know: its output format changed. Check the adapter handles it, then accept it with REEVAL_UPDATE_FORMATS=1.`,
      )
    },
  },
  {
    name: 'plugin skill used',
    canary: true,
    skips: noPlugins,
    check(ran, row) {
      const a = checkAndCanary(
        ran,
        row,
        'plugin skill',
        'plugged',
        new RegExp(`expected null to be '${PLUGIN_PROOF}'`),
      )
      const seen = a.context.map((c) => c.path)
      const at = row.plugin?.skillContext
      assert.ok(at && seen.some((p) => at.test(p)), `no ${at} in the context: ${seen.join(', ')}`)
      const env = ran.run.environments.find((e) => e.name === 'plugged')
      assert.deepEqual(env?.plugins?.[0]?.parts.skills, ['plugin-probe'])
    },
  },
  {
    name: 'plugin MCP server called',
    canary: true,
    skips: noPlugins,
    check(ran, row) {
      assert.equal(
        readFileSync(join(testDir, 'contract/plugins/probe/stamp.mjs'), 'utf8'),
        readFileSync(join(testDir, 'contract/stamp.mjs'), 'utf8'),
        "the probe plugin's stamp.mjs is a copy of the contract's",
      )
      const a = checkAndCanary(
        ran,
        row,
        'plugin mcp',
        'plugged',
        /expected '' to contain 'tools\/call'/,
      )
      const env = ran.run.environments.find((e) => e.name === 'plugged')
      assert.deepEqual(env?.plugins?.[0]?.parts.mcp, ['stamp'])
      assert.ok(env?.mcp.includes('probe:stamp'), JSON.stringify(env?.mcp))
      // Whoever starts the plugin's server, the agent from the plugin or reeval's config, it goes
      // through reeval's timer.
      const starts = a.turns.flatMap((t) => t.mcpStartup ?? [])
      assert.ok(
        starts.some((s) => s.server === 'probe:stamp' && typeof s.ms === 'number'),
        `no timed start of the plugin's stamp server: ${JSON.stringify(starts)}`,
      )
    },
  },
  {
    name: 'plugin hook ran',
    canary: true,
    skips: withoutPart('hooks', 'hooks'),
    check: (ran, row) =>
      void checkAndCanary(
        ran,
        row,
        'plugin hook',
        'plugged',
        /expected null to be 'hook-ran'/,
        'closed',
      ),
  },
  {
    name: 'plugin subagent available',
    canary: true,
    skips: withoutPart('agents', 'subagents'),
    check: (ran, row) =>
      void checkAndCanary(
        ran,
        row,
        'plugin subagent',
        'plugged',
        /expected \[\] to not deeply equal \[\]/,
        'closed',
      ),
  },
  {
    name: 'plugin part it can’t load refused',
    canary: false,
    skips: (row) =>
      noPlugins(row) ??
      (EVERY_PART.every((p) => row.plugin?.parts.includes(p))
        ? `${harnessOf(row)} loads every plugin part`
        : undefined),
    async check(ran, row) {
      // The whole probe plugin, without the row's `only`: the plan refuses the parts it can't load.
      const plan = await runCli(ran.project, ['run', '--dry-run', 'evals/plugin-skill.eval.ts'], {
        env: { ...rowEnv(row), REEVAL_CONTRACT_PLUGIN_PARTS: '' },
      })
      assert.equal(plan.code, 2, plan.stdout + plan.stderr)
      const kept = (row.plugin?.parts ?? []).map((p) => `'${p}'`).join(', ')
      assert.match(
        plan.stderr,
        new RegExp(
          `on ${cellOf(row).replaceAll('.', '\\.')}: .+ can't load the probe plugin's .+: use only: \\[${kept}\\], or leave the plugin out of this cell`,
        ),
      )
    },
  },
  {
    name: 'plugin hermetic: nothing undeclared loaded or contacted',
    canary: false,
    skips: noPlugins,
    check(ran, row) {
      const a = attempt(ran, row, 'plugin skill', 'plugged')
      // Only the probe plugin was declared: any other skill, or a plugin item outside its copy,
      // came from somewhere else (an account's plugins, a marketplace the agent fetched).
      const undeclared = a.context
        .map((c) => c.path)
        .filter((p) => !isRuntimeState(p) && !row.plugin?.own?.test(p))
        .filter(
          (p) =>
            (p.endsWith('/SKILL.md') && !p.endsWith('/plugin-probe/SKILL.md')) ||
            (/(^|\/)plugins\//.test(p) && !p.startsWith('~/.reeval/plugins/')),
        )
      assert.deepEqual(undeclared, [], 'undeclared plugin items in the context')
      const egress = a.egress
      assert.equal(egress?.policy, 'deny-all')
      assert.deepEqual(egress?.blocked, [], 'hosts contacted under deny-all')
      const allowed = (host: string) =>
        row.autoHosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h))
      assert.deepEqual(
        egress?.contacted.map((h) => h.host).filter((h) => !allowed(h)),
        [],
        'hosts beyond the automatic ones',
      )
    },
  },
  {
    name: 'clean teardown',
    canary: false,
    async check(ran) {
      assert.equal(ran.run.status, 'complete')
      assert.equal(await containersLeft(ran.run.runId), '', 'containers left behind')
    },
  },
]

/** The evals whose streams test/replay keeps, per harness (REEVAL_UPDATE_CAPTURES=1). */
const CAPTURED = ['skill', 'mcp', 'edit and run', 'egress']

/**
 * Copies the captured evals' raw transcripts to test/replay/<harness>/, for replay.test.ts. Cursor's
 * command list is dropped: it names the account's team commands and isn't used.
 */
function capture(ran: Ran, row: HarnessRow) {
  const dir = join(testDir, 'replay', row.id)
  mkdirSync(dir, { recursive: true })
  for (const name of CAPTURED.filter((n) => n !== 'mcp' || row.mcp !== false)) {
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
        reserveAttempts(row, attemptsFor(row), 'contract')
        const p = await fixture('contract')
        const args = ['run', '--concurrency', row.key ? '2' : '4']
        for (const tag of tagsLeftOut(row)) args.push('--tag', `!${tag}`)
        const cli = await runCli(p.dir, args, {
          env: {
            ...rowEnv(row),
            // Kept for the format check and the replay captures; the files are small.
            REEVAL_RAW_TRANSCRIPT: '1',
            REEVAL_CONTRACT_KEY_TARGETS: scanTargets(keyOf(row) ?? `no key ${Date.now()}`),
            REEVAL_CONTRACT_PLANTED_TARGETS: scanTargets(PLANTED),
          },
          timeoutMs: 25 * 60_000,
        })
        const { run, dir } = readRun(p.dir)
        ran = { cli, run, runDir: dir, project: p.dir }
        spent.set(row.id, withTurns(run).length)
        // One set of captures per CLI: its row on another provider sends the same stream.
        if (process.env.REEVAL_UPDATE_CAPTURES === '1' && !row.harness) capture(ran, row)
      },
      { timeout: 26 * 60_000 },
    )

    test('the run: every eval ran once, only the canaries failed (exit 1)', () => {
      assert.ok(ran)
      const out = `${ran.cli.stdout}\n${ran.cli.stderr}`
      assert.equal(ran.run.evals.length, attemptsFor(row), out)
      assert.equal(ran.cli.code, 1, out)
    })
    for (const b of behaviours) {
      const skipped = b.skips?.(row)
      if (skipped) {
        test(b.name, { skip: skipped }, () => {})
        mark(row, b.name, `skip: ${skipped}`)
        continue
      }
      test(b.name, async () => {
        try {
          assert.ok(ran, 'reeval run didn’t finish')
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

/** The contract table, printed and appended to `REEVAL_CONTRACT_SUMMARY` (CI's job summary). */
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
  if (process.env.REEVAL_CONTRACT_SUMMARY)
    appendFileSync(process.env.REEVAL_CONTRACT_SUMMARY, `${table}\n`)
})
