import { type AttemptContext, evaluate, expect, group } from 'reeval'
import { arms, type Target } from './environments.ts'

/** The pre-release reeval the sandbox has; the user would install it from npm. */
const INSTALL =
  ' (reeval is pre-release here: install it with `npm i -D ~/reeval.tgz`, or the same with the ' +
  "project's package manager, instead of from npm. This machine has no Docker.)"

type Plan = {
  totals: { evals: number; cells: number }
  evals: { name: string; cells: { role: string }[] }[]
}

async function plan(c: AttemptContext): Promise<Plan | null> {
  const r = await c.exec('./node_modules/.bin/reeval run --dry-run --json 2>/dev/null')
  try {
    return r.exitCode === 0 ? (JSON.parse(r.stdout) as Plan) : null
  } catch {
    return null
  }
}

const evalFiles = "find evals -name '*.eval.ts' 2>/dev/null | sort"

/** The checks every target shares, after the user has answered the agent's question. */
async function setUp(c: AttemptContext, before: string[], expected: { evals: [number, number] }) {
  const p = await plan(c)
  expect.soft(p, '`reeval run --dry-run` plans').not.toBeNull()
  const added = (p?.totals.evals ?? 0) - before.length
  expect.soft(added, 'adds at least one eval').toBeGreaterThanOrEqual(expected.evals[0])
  expect.soft(added, 'adds at most three evals').toBeLessThanOrEqual(expected.evals[1])
  expect.soft(c, 'runs reeval doctor').toHaveRun(/reeval doctor/)
  expect.soft(c, 'never forces init').not.toHaveRun(/init[^\n]*--force/)
  return p
}

function asksFirst(turn: { text: string }, created: string) {
  expect.soft(turn.text, 'asks before writing evals').toMatch(/\?/)
  expect.soft(created, 'writes no eval before the answer').toBe('')
}

const evalList = async (c: AttemptContext) => (await c.exec(evalFiles)).stdout.trim()
const names = (text: string) => text.split('\n').filter(Boolean)

const target = (t: Target) => ({ compare: { ...arms(t), gate: 'none' as const } })

group('sets up reeval', () => {
  evaluate('in a repo with skills, with a skill compare', target('supabase'), async (c) => {
    const first = await c.send(`Set up reeval here.${INSTALL}`)
    asksFirst(first, await evalList(c))
    const last = await c.send('Yes, go ahead.')
    const p = await setUp(c, [], { evals: [1, 3] })
    const roles = p?.evals.flatMap((e) => e.cells.map((cell) => cell.role)) ?? []
    expect.soft(roles, 'compares a skill').toContain('variant')
    expect
      .soft(c, 'leaves the skills and docs alone')
      .not.toHaveChanged(['skills/**', 'README.md', 'AGENTS.md', 'test/**'])
    expect.soft(last.text, 'names the Cursor key').toMatch(/CURSOR_API_KEY/)
  })

  evaluate(
    'where reeval is set up already, without re-initialising',
    target('firebase-set-up'),
    async (c) => {
      const before = names(await evalList(c))
      const greet = await c.readFile('evals/greet.eval.ts')
      const environments = (await c.readFile('evals/environments.ts')) ?? ''
      const first = await c.send(`Set up reeval here.${INSTALL}`)
      asksFirst(
        first,
        names(await evalList(c))
          .filter((f) => !before.includes(f))
          .join('\n'),
      )
      const last = await c.send('Yes, go ahead.')
      const p = await setUp(c, before, { evals: [1, 3] })
      expect
        .soft(p?.evals.map((e) => e.name) ?? [], 'keeps the existing eval')
        .toContain('creates greet.js')
      expect
        .soft(await c.readFile('evals/greet.eval.ts'), 'leaves greet.eval.ts as it was')
        .toBe(greet)
      expect
        .soft((await c.readFile('evals/environments.ts')) ?? '', 'keeps environments.ts as it was')
        .toContain(environments.trim())
      expect.soft(c, 'leaves the skills alone').not.toHaveChanged(['skills/**', 'README.md'])
      expect.soft(last.text, 'names the Cursor key').toMatch(/CURSOR_API_KEY/)
    },
  )

  evaluate('in an empty directory, after researching the subject', target('empty'), async (c) => {
    const first = await c.send(`Set up reeval here.${INSTALL}`)
    asksFirst(first, await evalList(c))
    const last = await c.send(
      "I'd like to know whether coding agents set up Tailwind CSS v4 correctly in a new project.",
    )
    await setUp(c, [], { evals: [1, 3] })
    const research = last.transcript.filter(
      (e) =>
        e.type === 'web-search' ||
        e.type === 'web-fetch' ||
        (e.type === 'tool' && /\b(curl|wget|npm (view|info))\b/.test(JSON.stringify(e.input))),
    )
    expect.soft(research.length, 'researches Tailwind v4 first').toBeGreaterThan(0)
    const sources = (await c.exec('cat evals/*.ts 2>/dev/null')).stdout
    expect.soft(sources, 'evals about Tailwind').toMatch(/tailwind/i)
    expect.soft(sources, "checks v4's CSS @import").toMatch(/@import/)
    expect.soft(last.text, 'names the Cursor key').toMatch(/CURSOR_API_KEY/)
  })
})
