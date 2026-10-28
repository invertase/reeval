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

- `await c.serve(cmd, port?)` starts `cmd` in the background with `PORT` set (`$PORT` on a bash
  string) and returns a `ServeHandle` once `cmd` listens. Without `port`, a server
  that ignores `PORT` and listens on one new port of its own (`npm run dev` on Vite's 5173, IPv4 or
  IPv6 loopback) gets that port as `handle.port`; no `--port` flags needed. Several new ports, none
  of them `PORT`, throw with the list and the URLs it printed: pass the one to use, `c.serve('npm run dev', 5173)`. An
  exit, or nothing listening in 120 s, throws with its last output. With `port`, only that
  port counts. `c.exec(cmd, { background:
  true })` starts a command without a port or the wait and returns `{ kill() }`.
- `await c.capture(port | server, { name?, path?,
  wait?, instructions?, viewport?, model? })` screenshots the tunneled port into
  `artifacts/<name>.png`. The first argument is the container port or a `ServeHandle`;
  default `path` is `/`, default `name` comes from the path. A `name` is 1 to 100 of
  `a-z`, `0-9`, `_` and `-`, starting with a letter or digit. `wait` is once, before the
  first model shot or the saved PNG (`'load'`, `'idle'`, or `{ ms }`). `instructions` is
  a journey of goal strings and `{ wait }` beats (`{ wait: 'idle' }` waits for the
  network to go quiet from that beat, so it covers a click that only fetches) — no
  selectors; the model clicks pixels. `viewport: 'full-page'` is the saved shot (default window + tall PNG).
- `capture.model` cascades like `question`; the call may override. Default is
  `analysis.model`, else the attempt's judge model (a profile's, group's or eval's),
  whichever is first a language model; never Jev. Gemini's 0–1000 points are scaled to the screenshot. Fixture evals import
  `fakeInstructions` from `reeval/testing` and pass it as `instructions`.
  The same `timeout` is the budget for the whole capture: the `wait`, every instruction's
  moves (one model call each, about 1–10 s) and its `{ wait }` beats. A sign-up form is
  about six moves, so give a multi-step journey `timeout: '2m'` or more. When it runs out,
  or a move repeats without changing the page, the capture fails, naming the instruction,
  and there is no PNG. `capture.browser: false` or `REEVAL_CAPTURE_BROWSER=0` makes
  `c.capture()` throw.
- The capture's browser runs on the host and reaches only the captured port: a page that
  calls another sandbox port (an auth emulator on `127.0.0.1:9099`, an API on a second port)
  can't reach it, so serve those through the app's port or a real host.
- The `capture` option shallow-merges camera defaults (`viewport`, `timeout`, `browser`,
  `model`, the vision model) down the cascade; `viewport` replaces the value, and the port is
  not an option.
- On a judge, `artifacts` is an input like `diff`, set on the call: `true` for every capture
  so far, or `c.capture()` handles or names, sent as file parts. Alone, the judge sees only the
  pictures. Ask about facts in the picture, not whether it "looks
  great". Jev (`typesafe-ai/jev-1.14.0`) takes PNG captures; a provider that cannot take files
  fails that call.
- On a question, `artifacts: ['sign-in']` (or `true`) sends each attempt's own capture of that
  name as an image (see [compare.md](compare.md)).
