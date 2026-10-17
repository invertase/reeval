# The engine protocol

How reeval's main process (`node.ts`, `pool.ts`) and a worker (`worker.ts`) talk. The types are in
[`protocol.ts`](./protocol.ts); their JSON Schemas, generated from those types, are in
`schema/plan/` (`to-worker`, `from-worker`, `wire-test` and `declaration`). This is internal: reeval
starts its own workers, and nothing outside this repository speaks it yet.

## Transport and framing

```text
main process                                  worker: reeval __worker, cwd = project root
  spawn(node, [--enable-source-maps, <cli>, __worker], stdio: [ignore, pipe, pipe, ipc])
  ── ToWorker ─────────────────────────────▶
  ◀──────────────────────────── FromWorker ──
```

- One worker per eval file and phase, started as `reeval __worker` from the copy of reeval the project
  resolves (a compiled `reeval` starts itself). Its stdout and stderr are piped: text a worker writes
  there outside reeval's console routing is shown as the file's output.
- Messages go over Node's IPC channel with `serialization: 'json'`: each message is one JSON
  value followed by a newline. Every message is a JSON object with a string `t`; nothing in one
  may be a value JSON can't carry (`undefined`, a function, a `Map`, `NaN`, a class instance), and
  a key JSON would drop isn't sent.
- Messages in each direction arrive in order. A worker's last messages can arrive after its
  `exit`; the main process waits up to a second for them.

## Handshake

```jsonc
// worker → main, before anything else
{"t":"hello","protocol":2}
// main → worker, once the protocol matches
{"t":"init","run":{…RunContext},"file":"/abs/evals/greet.eval.ts","select":null}
```

The worker says `hello` first, whatever it was sent. If `protocol` isn't the main process's
`PROTOCOL`, the main process kills the worker and stops with a usage error naming the other reeval.
Only then does it send `init`: `select: null` to collect the file, or the indexes of the tests to
run.

## Collecting and running

```jsonc
{"t":"collected","tests":[{"index":0,"name":"greets [cursor/-/docker#1]","groups":[],"mode":"run","attempt":{…}}]}
{"t":"request","id":"l1","limits":{"attempts":4},"rank":{"eval":"…","file":"…","order":0,"n":1,"cell":0}}
{"t":"grant","id":"l1"}
{"t":"start","index":0,"at":1790000000000}
{"t":"progress","index":0,"progress":{…}}
{"t":"result","index":0,"result":{"state":"passed","errors":[],"durationMs":8123,"meta":{…}}}
{"t":"release","id":"l1"}
{"t":"done"}
```

- Collecting, the worker loads the file, sends `collected` (or `load-error`) and `done`, and
  exits. Running, it collects again, asks for each selected attempt's lease with `request`, sends
  `ready` once every one has asked (or finished without one), and runs each when it gets its
  `grant`.
- `cancel` (main → worker) aborts every attempt. A worker whose channel closes cancels too, lets
  its attempts clean up, and exits.
- `log` carries console output, by attempt `index` when an attempt wrote it; `debug` carries the
  `-v` trace; `meta` a record written after the attempt's result (after a timeout or cancel).

## Errors

```jsonc
{"t":"load-error","error":{"name":"SyntaxError","message":"Unexpected token (evals/a.eval.ts:3:7)"}}
{"t":"unhandled","error":{"name":"Error","message":"boom","stack":"Error: boom\n    at …"}}
```

A `SerializedError` is `name`, `message` and optionally `stack`, `expected`, `actual` and
`diff` (for the diff printer), and `errors` (an AggregateError's). `load-error` fails the file's
evals; `unhandled` fails the run; a failed attempt is a `result` with `state: "failed"`.

## The contract beside it

`declaration` in `schema/plan/` takes its node shapes from the Zod schemas in
`src/contract/declaration.ts`, and `declareTree` checks a tree against them before declaring it.
The calls an eval's body makes on its attempt (`c.send`, `c.exec`, `c.readFile`, `c.writeFile`
and each matcher) have their own schemas in `src/contract/attempt.ts`, with JSON Schemas in
`schema/protocol/` (`attempt-request`, `attempt-reply`). Those calls run inside the worker today,
so none of them crosses this channel; a runner in another language would send them, numbered by
`id`, and read reeval's replies.

## Versions

`PROTOCOL` in `protocol.ts` is one integer, bumped whenever a message changes shape or meaning,
or the framing changes; there's no negotiation. A worker from another reeval must speak the same
number. `pnpm schema:check` fails when `schema/plan/` isn't what the types generate, so a change
to a message shows up in review with its snapshot.

| Version | Change |
|---|---|
| 1 | Node's structured-clone (`advanced`) serialization |
| 2 | JSON serialization; every message JSON-clean |
