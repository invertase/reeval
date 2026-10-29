// Which subjects each of reeval's matchers takes, as the published types say: `types.test.ts`
// typechecks this file against dist/, so each `@ts-expect-error` must stay an error.
import { type AttemptContext, type ExecResult, evaluate, expect } from 'reeval'

// A subject typed by a type parameter can't be told apart: name its type on `expect`.
export function succeeds<R extends ExecResult>(result: R) {
  // @ts-expect-error a constrained type parameter is not resolved
  expect(result).toSucceed()
  expect<ExecResult>(result).toSucceed()
}

evaluate('matchers', async (c: AttemptContext) => {
  const turn = await c.send('write greet.js')
  const result = await c.exec('npm run build')
  const verdict = await c.judge('Is it polite?', { output: true })

  expect(result).toSucceed()
  expect(result).not.toSucceed()
  expect.require(result).toSucceed()
  // @ts-expect-error a settled result is checked at once: no promise to await
  void expect(result).toSucceed().then
  await expect(c.exec('npm test')).toSucceed()
  await expect(c.exec('npm test')).resolves.toSucceed()
  await expect.poll(() => c.exec('curl -f localhost')).toSucceed()
  // @ts-expect-error an exec result is not a verdict
  expect(result, 'the app builds').toPass()
  // @ts-expect-error nor a turn
  expect(result).toHaveRun('npm')
  // @ts-expect-error nor has files
  await expect(result).toHaveFile('dist/index.js')

  expect(verdict).toPass()
  expect(verdict).not.toPass()
  expect.require(verdict).toPass()
  // @ts-expect-error a verdict is not an exec result
  expect(verdict).toSucceed()
  // @ts-expect-error toPass takes the awaited verdict
  expect(c.judge('Is it polite?', { output: true })).toPass()

  await expect(c).toHaveFile('greet.js', /greet/)
  await expect(turn).not.toHaveFile('secret.txt')
  expect(c).toHaveRun(/npm test/)
  expect(turn).toHaveEdited('greet.js')
  expect(turn).toHaveChanged(['greet.js'])
  expect(c).toHaveSearched()
  expect(turn).toHaveFetched()
  expect(c).toHaveCalledSkill('greet')
  expect(c).toHaveCalledMcp('docs', 'search')
  expect(turn).toHaveCalledTool(/read/)
  const polled: Promise<void> = expect.poll(() => c).toHaveRun('npm test')
  await polled
  await expect(c.send('again')).resolves.toHaveEdited('greet.js')
  // @ts-expect-error a turn is not a verdict
  expect(turn).toPass()
  // @ts-expect-error nor an exec result
  expect(turn).toSucceed()
  // @ts-expect-error a string has no transcript
  expect(turn.text).toHaveRun('npm')
  // @ts-expect-error a possibly missing turn
  expect(c.turns[0]).toHaveEdited('greet.js')
  // @ts-expect-error a turn's promise, not the turn
  await expect(c.send('again')).toHaveFile('greet.js')

  const shot = await c.capture(3000, { path: '/sign-up' })
  expect(shot).toHaveStatus(200)
  expect(shot).not.toHaveStatus(404)
  expect(shot).toHaveStatus('2xx')
  expect(shot).not.toHaveStatus('5xx')
  // @ts-expect-error there is no 6xx
  expect(shot).toHaveStatus('6xx')
  // @ts-expect-error a range is lower-case
  expect(shot).toHaveStatus('2XX')
  // @ts-expect-error nor a number as a string
  expect(shot).toHaveStatus('200')
  expect(shot).toHaveNoPageErrors()
  expect.require(shot).toHaveNoPageErrors()
  expect(shot.console.filter((m) => m.level === 'error')).toEqual([])
  // @ts-expect-error toHaveStatus takes the awaited capture
  expect(c.capture(3000)).toHaveStatus(200)
  // @ts-expect-error an exec result is not a capture
  expect(result).toHaveStatus(200)
  // @ts-expect-error nor a turn
  expect(turn).toHaveNoPageErrors()
  // @ts-expect-error a capture is not an exec result
  expect(shot).toSucceed()

  expect(result.exitCode).toBe(0)
  expect(turn.text).toContain('greet')
  expect(result.stdout).toMatch(/built/)
  expect([1, 2]).toEqual([1, 2])
  expect(verdict.score).toBeGreaterThan(0.5)
  expect(JSON.parse(result.stdout) as unknown).toBeTruthy()
  expect(JSON.parse(result.stdout)).toPass()
})
