# Launcher conformance

Every language SDK ships a `reeval` command that finds the reeval binary for its version
(`REEVAL_BINARY`, the cache, else a download), checks it, caches it and runs it. This suite holds
each of those launchers to the same behavior: one case list, a fake release server it points
each launcher at with `REEVAL_DOWNLOAD`, and a small runner module per language.

```bash
cd packages/reeval
node --experimental-strip-types test/conformance/launcher/run.ts python
```

It needs Go on the `PATH` (it builds `fake-reeval/`, the stand-in binary, so the launcher execs a
real executable on every platform), and on Windows `python` and `pwsh` (for Ctrl-C and to read the
CPU's AVX2 support). CI runs it in `ci.yml`'s `launchers` job on Linux, macOS and Windows.

```text
cases.json        the cases: each step's release, environment, arguments and what must happen
targets.json      which release target each set of machine facts picks
server.ts         the fake release server (HTTP and HTTPS on 127.0.0.1, its own CA)
fake-reeval/      the stand-in binary: reports its argv and REEVAL_* environment, exits as told
run.ts            runs every case and row against one runner, with node:test
runner.ts         the interface a runner implements
runners/<lang>.ts one per language: how to install its launcher, and its hooks
```

## cases.json

```json
{
  "id": "checksum-mismatch",
  "about": "An asset whose sha256 isn't the one SHA256SUMS lists is refused with exit 3, …",
  "steps": [
    {
      "release": "bad-checksum",
      "expect": {
        "exit": 3,
        "ran": false,
        "stderr": ["{base}/{asset}", "{wrongSha256}"],
        "cache": "absent"
      }
    }
  ]
}
```

Each case starts with an empty cache (`XDG_CACHE_HOME`), `REEVAL_VERSION` and `REEVAL_DOWNLOAD` set
from the top-level `env`, and no other `REEVAL_*` variable. Its steps run in order.

| Field | Meaning |
|---|---|
| `version` | The version the case downloads (default the top-level `version`) |
| `seed` | A file put at the cache path first: the `binary`, an `empty` file, `junk` (a script of another size), `tampered` (that script padded to the binary's size) or `garbage` (not an executable) |
| `record` | The hashes the launcher holds as released with: `match`, `wrong` or `no-target` (for this host's target) |
| `https` | Serve the release over HTTPS, with the runner's `trust` environment |
| `only`, `needs` | Run on `posix` or `windows` only; skip unless the runner has `interpreterEnv` |
| step `release` | The server's mode (see `server.ts`), or `unreachable` for a port nothing listens on |
| step `env`, `args` | Added to the environment; the binary's arguments (default `["run"]`) |
| step `parallel` | Start this many launchers at once |
| step `interrupt` | `ctrl-c` (the process group on POSIX, the console on Windows through `scripts/ctrl-c.py`) or `sigterm` (the launcher's pid alone) once the binary is waiting |

`expect` is checked for every launcher a step started:

| Field | Meaning |
|---|---|
| `exit` | The exit code |
| `stderr` | Substrings stderr must contain. Every stderr line must start with `reeval: ` |
| `quiet` | stderr is empty |
| `ran` | `true`: stdout is exactly the binary's report, with the step's arguments verbatim. `false`: stdout is empty |
| `env` | Variables the binary must have been given (`*`: set to anything) |
| `stdout` | Substrings stdout must contain |
| `cache` | `binary`: the cache path holds the released binary, executable. `absent`: nothing is there |
| `downloads`, `httpRequests` | How many times the asset was fetched; how many plain-http requests were made |

After every step the binary's cache directory may hold only the binary and the runner's
`sidecars`: a temp file left behind fails the step. Strings take placeholders: `{version}`,
`{target}`, `{asset}`, `{base}`, `{cachePath}`, `{sha256}`, `{wrongSha256}`, `{fake}` (the binary
outside the cache), `{launcher}`, `{work}`, `{missing}`, `{ready}`, `{httpBase}`, `{fileBase}` and
`{interpreterEnv}`.

The release serves only this host's asset, whose target `run.ts` works out itself (Node's libc,
`/proc/cpuinfo`, .NET's AVX2 check), so every download case also checks the launcher picks this
machine's target. `REEVAL_CONFORMANCE_TARGET` overrides it on a machine it can't tell.
`targets.json` covers every other machine: each row's facts go to the launcher's own target
function with its detection stubbed out.

## Adding a language

A runner is a module in `runners/` exporting a `Runner` (`runner.ts`). Only `setup` is required:

```ts
const runner: Runner = {
  name: 'go',
  interpreterEnv: 'REEVAL_GO',
  async setup(work) {
    const exe = join(work, windows ? 'reeval.exe' : 'reeval')
    execFileSync('go', ['build', '-o', exe, './cmd/reeval'], { cwd: module })
    return { command: [exe], file: exe }
  },
  trust: process.platform === 'linux' ? (ca) => ({ SSL_CERT_FILE: ca }) : undefined,
  async record(released) { /* compile `released` in as the release's hashes */ },
  divergences: { 'plain-http-mirror-warns': "doesn't warn about an http: REEVAL_DOWNLOAD" },
}
```

| Hook | Without it |
|---|---|
| `interpreterEnv` | The interpreter-variable cases skip |
| `sidecars` | Any file beside the cached binary fails |
| `trust(caFile)` | The HTTPS cases skip (a launcher uses the system trust store, so only one that reads something like `SSL_CERT_FILE` can run them) |
| `record(released)` | The `recorded-*` cases skip |
| `pickTargets(facts)` | The target table skips; it needs the launcher's target choice as a function of the facts |
| `divergences` | — : a case listed here must fail (reported as a TODO with the reason); one that passes fails the run, so the list can't go stale |

Then add the language to the `launchers` job's matrix in `.github/workflows/ci.yml`, with its
toolchain, and its paths to the job's `changes` filter.

## Adding a case

Add it to `cases.json` with the exit code and the stderr substrings the
[launcher contract](../../../../../docs-archive/guide/binary.mdx) implies, then run every runner. A runner
that fails it either gets fixed in the same change or lists it under `divergences` with the reason.
