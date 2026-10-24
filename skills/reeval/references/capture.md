# Web UIs: serve, capture and artifacts

```ts
evaluate('builds the sign-in page', async (c) => {
  await c.send('Build a sign-in page served by `npm start` on $PORT.')
  const app = await c.serve('npm start', 3000)
  await c.capture(app, { name: 'sign-in', path: '/login', wait: 'idle' })
  const q = 'Does the screenshot show an email field and a password field?'
  expect(await c.judge(q, { artifacts: ['sign-in'] })).toPass()
})
```

- `await c.serve(cmd, port?)` starts `cmd` in the background and returns a `ServeHandle` with a
  port (`PORT` / `$PORT` on a bash string). `c.exec(cmd, { background: true })` is the same
  without a port and returns `{ kill() }`.
- `await c.capture(port | server, { name?, path?,
  wait?, instructions?, viewport?, model? })` screenshots the tunneled port into
  `artifacts/<name>.png`. The first argument is the container port or a `ServeHandle`;
  default `path` is `/`, default `name` comes from the path. `wait` is once, before the
  first model shot or the saved PNG (`'load'`, `'idle'`, or `{ ms }`). `instructions` is
  a journey of goal strings and `{ wait }` beats (`{ wait: 'idle' }` waits for the
  network to go quiet from that beat, so it covers a click that only fetches) — no
  selectors; the model clicks pixels. `viewport: 'full-page'` is the saved shot (default window + tall PNG).
- `capture.model` cascades like `question`; the call may override. Default is
  `analysis.model`, else the attempt's judge model (a profile's included) when it's a
  language model; never Jev. Gemini's 0–1000 points are scaled to the screenshot. Fixture evals import
  `fakeInstructions` from `reeval/testing` and pass it as `instructions`.
  The same `timeout` is the budget: if the event never arrives the capture fails and there
  is no PNG. `capture.browser: false` or `REEVAL_CAPTURE_BROWSER=0` makes `c.capture()` throw.
- The `capture` option shallow-merges camera defaults (`viewport`, `timeout`, `browser`,
  `model`, the vision model) down the cascade; `viewport` replaces the value, and the port is
  not an option.
- On a judge, `artifacts` is call-only: `true` for every capture so far, or `c.capture()`
  handles or names, sent as file parts. Ask about facts in the picture, not whether it "looks
  great". Jev (`typesafe-ai/jev-1.14.0`) takes PNG captures; a provider that cannot take files
  fails that call.
- On a compare question, `artifacts: ['sign-in']` (or `true`) sends each side's own capture of
  that name as an image (see [compare.md](compare.md)).
