// Compile-time checks of `c.judge()`'s and `questions`' at-least-one-input rule, run by
// `pnpm typecheck` (`tsc -p test/types`). Each `@ts-expect-error` fails the build if the line
// below it compiles.
import type { AttemptContext, Capture, EvalOptions, Question, Turn } from '../../src/index.ts'

declare const c: AttemptContext
declare const capture: Capture
declare const turn: Turn

export async function judgeCalls() {
  await c.judge('Is there a sign up flow?', { contents: ['src/**/*.tsx'] })
  await c.judge('Does the screen show a form?', { artifacts: [capture] })
  await c.judge('Did it run the tests?', { transcript: 'tools', turns: 'all' })
  await c.judge('Did the first turn say why?', { on: turn, output: true, task: true })
  await c.judge('Is it valid JSON?', { on: { ok: true }, output: true })
  await c.judge('Did it change only src?', { diff: ['src/**'], files: false, threshold: 0.9 })
  await c.judge('Do the tests pass?', { checks: ['npm test'], model: 'google/gemini-3.8-flash' })

  // @ts-expect-error no options: the judge would be shown nothing
  await c.judge('Is there a sign up flow?')
  // @ts-expect-error no input turned on
  await c.judge('Is there a sign up flow?', {})
  // @ts-expect-error only judge settings, no input
  await c.judge('Is there a sign up flow?', { model: 'google/gemini-3.8-flash', threshold: 0.8 })
  // @ts-expect-error `on` and `turns` pick what the inputs read; they aren't inputs
  await c.judge('Is there a sign up flow?', { on: turn, turns: 'all' })
  // @ts-expect-error every input turned off
  await c.judge('Is there a sign up flow?', { task: false, diff: false, transcript: false })
  // @ts-expect-error the nested `state` object is gone
  await c.judge('Is there a sign up flow?', { state: { diff: true } })
}

export const questions: Question[] = [
  { question: 'How did the agent find the failing test?', transcript: true },
  { question: 'Which is cleaner?', across: 'environment', diff: true, task: true },
  { question: 'Which screen is clearer?', across: 'harness', artifacts: ['home'] },
  // @ts-expect-error a question shows at least one input
  { question: 'How did the agent find the failing test?' },
  // @ts-expect-error a bare string shows nothing
  'How did the agent find the failing test?',
  // @ts-expect-error only non-input keys
  { question: 'Which is cleaner?', across: 'environment', model: 'google/gemini-3.8-flash' },
]

export const options: EvalOptions = {
  question: { model: 'google/gemini-3.8-flash' },
  // @ts-expect-error eval-level judge options set no inputs
  judge: { threshold: 0.8, diff: true },
}
