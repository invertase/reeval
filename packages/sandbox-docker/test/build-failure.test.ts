// Reading a failed build: real `docker build --progress plain` output (Docker 29, BuildKit),
// captured from the failures reeval hits, each with a canary that must not match.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  failureCause,
  failureMessage,
  ImageBuildError,
  isTransient,
  parseBuildOutput,
  retryTransient,
} from '../src/build-failure.ts'
import { dockerfileTag } from '../src/build-image.ts'

const ENOSPC = `#4 [1/2] FROM docker.io/library/debian:bookworm-slim@sha256:3783
#4 DONE 0.0s

#5 [2/2] RUN echo Y2QgLwplY2hvIGhp | base64 -d > /tmp/reeval-install.sh && bash /tmp/reeval-install.sh
#5 0.101 reeval: install 1/1: 'dd if=/dev/zero of=/dev/shm/fill bs=1M count=200'
#5 0.122 about to fail
#5 0.140 dd: error writing '/dev/shm/fill': No space left on device
#5 0.140 65+0 records in
#5 0.141 reeval: install 1/1 exited 1: 'dd if=/dev/zero of=/dev/shm/fill bs=1M count=200'
#5 ERROR: process "/bin/sh -c echo Y2QgLwplY2hvIGhp | base64 -d > /tmp/reeval-install.sh && bash /tmp/reeval-install.sh" did not complete successfully: exit code: 1
------
 > [2/2] RUN echo Y2QgLwplY2hvIGhp | base64 -d > /tmp/reeval-install.sh && bash /tmp/reeval-install.sh:
0.122 about to fail
------
Dockerfile:3
--------------------
   3 | >>> RUN echo Y2QgLwplY2hvIGhp | base64 -d > /tmp/reeval-install.sh \\
--------------------
ERROR: failed to build: failed to solve: process "/bin/sh -c echo Y2QgLwplY2hvIGhp | base64 -d > /tmp/reeval-install.sh && bash /tmp/reeval-install.sh" did not complete successfully: exit code: 1
`
const KILLED = `#5 [2/2] RUN bash -c 'echo dying; kill -9 $$'
#5 0.127 dying
#5 ERROR: process "/bin/sh -c bash -c 'echo dying; kill -9 $$'" did not complete successfully: exit code: 137
ERROR: failed to build: failed to solve: process "/bin/sh -c bash -c 'echo dying; kill -9 $$'" did not complete successfully: exit code: 137
`
const SYNTAX = `#1 [internal] load build definition from syn.Dockerfile
#1 DONE 0.0s
syn.Dockerfile:2
--------------------
   2 | >>> COPYY a b
--------------------
ERROR: failed to build: failed to solve: dockerfile parse error on line 2: unknown instruction: COPYY (did you mean COPY?)
`
const DENIED = `ERROR: failed to build: failed to solve: nonexistent-reeval-image-xyz:1: failed to resolve source metadata for docker.io/library/nonexistent-reeval-image-xyz:1: pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`
const NO_HOST = `ERROR: failed to build: failed to solve: registry.invalid.example:5000/x:1: failed to resolve source metadata for registry.invalid.example:5000/x:1: failed to do request: Head "https://registry.invalid.example:5000/v2/x/manifests/1": dial tcp: lookup registry.invalid.example on 10.0.0.2:53: no such host`
const REGISTRY_503 = `ERROR: failed to build: failed to solve: node:22: failed to resolve source metadata for docker.io/library/node:22: unexpected status from HEAD request to https://registry-1.docker.io/v2/library/node/manifests/22: 503 Service Unavailable`
const BOOTSTRAP_NET = `Bootstrap command failed for harness 'cursor-sdk' (exit 1): sh install.sh
npm error code EAI_AGAIN
npm error syscall getaddrinfo
npm error errno EAI_AGAIN
npm error request to https://registry.npmjs.org/@cursor%2fsdk failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org`

describe('reading a failed build', () => {
  test("the failing step's own lines, without BuildKit's echo of the RUN line", () => {
    const parsed = parseBuildOutput(ENOSPC)
    assert.equal(parsed.exitCode, 1)
    assert.deepEqual(parsed.output.slice(1, 3), [
      'about to fail',
      "dd: error writing '/dev/shm/fill': No space left on device",
    ])
    assert.equal(parsed.output.join('\n').includes('Y2Qg'), false, 'no base64 script')
    // Canary: the step header and the error block aren't output.
    assert.equal(parsed.output.includes('0.122 about to fail'), false)
  })

  test('a parse error has no step output, only the error', () => {
    const parsed = parseBuildOutput(SYNTAX)
    assert.deepEqual(parsed.output, [])
    assert.equal(
      parsed.error,
      'dockerfile parse error on line 2: unknown instruction: COPYY (did you mean COPY?)',
    )
  })

  test('ENOSPC and exit 137 are named; a plain failure is not', () => {
    const enospc = parseBuildOutput(ENOSPC)
    assert.equal(failureCause(enospc.output.join('\n'), enospc.exitCode), 'enospc')
    const killed = parseBuildOutput(KILLED)
    assert.equal(failureCause(killed.output.join('\n'), killed.exitCode), 'oom')
    assert.equal(failureCause('install 1/1 exited 137: make', null), 'oom')
    assert.equal(failureCause('exit code: 1', 1), null)
    assert.equal(failureCause('exit code: 1370', 1370), null)
  })

  test('network and registry 5xx errors are transient; failing steps, syntax and denied pulls are not', () => {
    for (const text of [
      NO_HOST,
      REGISTRY_503,
      BOOTSTRAP_NET,
      'i/o timeout',
      'TLS handshake timeout',
    ]) {
      assert.equal(isTransient(text), true, text)
    }
    for (const text of [ENOSPC, KILLED, SYNTAX, DENIED, 'exit code: 42']) {
      assert.equal(isTransient(text), false, text)
    }
    // A RUN step that failed on the network is still the user's step: never retried.
    assert.equal(
      isTransient(
        'process "/bin/sh -c npm ci" did not complete successfully: exit code: 1\nEAI_AGAIN',
      ),
      false,
    )
  })

  test('the message: headline first, the cause, the output, the log', () => {
    const message = failureMessage({
      headline: 'Building the install layer (1 command) failed: install 1/1 exited 1: dd …',
      cause: 'enospc',
      output: ['about to fail'],
      log: '.reeval/cache/images/x.log',
    })
    assert.deepEqual(message.split('\n'), [
      'Building the install layer (1 command) failed: install 1/1 exited 1: dd …',
      'out of disk space (ENOSPC): free space for Docker (docker system df, reeval clean --images) and rerun',
      '  | about to fail',
      '(full log: .reeval/cache/images/x.log)',
    ])
  })
})

// `podman build` (Podman 4.9, buildah), rootless: the same failures as buildah prints them.
const WARN = (cap: string) =>
  `time="2026-10-20T06:20:31Z" level=warning msg="can't raise ambient capability CAP_${cap}: operation not permitted"`
const BUILDAH_RUN = `STEP 1/5: FROM docker.io/library/busybox
STEP 2/5: RUN echo hello
${WARN('CHOWN')}
hello
--> c5e4b8d3facc
STEP 3/5: RUN echo out-line-1 && echo err-line >&2 && exit 7
${WARN('CHOWN')}
${WARN('SETUID')}
out-line-1
err-line
Error: building at STEP "RUN echo out-line-1 && echo err-line >&2 && exit 7": while running runtime: exit status 7
`
const BUILDAH_KILLED = `STEP 1/2: FROM docker.io/library/busybox
STEP 2/2: RUN exit 137
${WARN('SYS_CHROOT')}
Error: building at STEP "RUN exit 137": while running runtime: exit status 137
`
const BUILDAH_SYNTAX = `STEP 1/2: FROM docker.io/library/busybox
STEP 2/2: COPYY a b
time="2026-10-20T06:20:31Z" level=error msg="+(UNHANDLED LOGLEVEL) &imagebuilder.Step{Command:"copyy"}"
Error: building at STEP "COPYY ": Build error: Unknown instruction: "COPYY" &imagebuilder.Step{Env:[]string{"PATH=/usr/local/sbin"}, Command:"copyy", Original:"COPYY a b"}
`
const BUILDAH_SHORT_NAME = `STEP 1/1: FROM nonexistent:1
Error: creating build container: short-name "nonexistent:1" did not resolve to an alias and no unqualified-search registries are defined in "/etc/containers/registries.conf"
`
const BUILDAH_UNREACHABLE = `STEP 1/1: FROM 127.0.0.1:5999/x/y:1
Error: creating build container: initializing source docker://127.0.0.1:5999/x/y:1: pinging container registry 127.0.0.1:5999: Get "https://127.0.0.1:5999/v2/": dial tcp 127.0.0.1:5999: connect: connection refused
`

describe('reading a failed podman build (buildah)', () => {
  test("the failing step's own lines, without buildah's warnings or the earlier steps", () => {
    const parsed = parseBuildOutput(BUILDAH_RUN)
    assert.equal(parsed.error, 'while running runtime: exit status 7')
    assert.equal(parsed.exitCode, 7)
    // Canary: step 2's `hello`, the warnings and the layer id aren't the failing step's output.
    assert.deepEqual(parsed.output, ['out-line-1', 'err-line'])
  })

  test('a syntax error is the instruction, without the builder struct', () => {
    const parsed = parseBuildOutput(BUILDAH_SYNTAX)
    assert.equal(parsed.error, 'Build error: Unknown instruction: "COPYY"')
    assert.deepEqual(parsed.output, [])
    assert.equal(parsed.exitCode, null)
  })

  test('exit 137 is named; failing steps, syntax and short names are not retried; a refused registry is', () => {
    const killed = parseBuildOutput(BUILDAH_KILLED)
    assert.equal(failureCause(killed.error ?? '', killed.exitCode), 'oom')
    for (const text of [BUILDAH_RUN, BUILDAH_KILLED, BUILDAH_SYNTAX, BUILDAH_SHORT_NAME]) {
      assert.equal(isTransient(text), false, text)
    }
    assert.equal(isTransient(BUILDAH_UNREACHABLE), true)
  })

  test('canary: BuildKit output still reads as BuildKit', () => {
    assert.equal(parseBuildOutput(KILLED).exitCode, 137)
    assert.equal(parseBuildOutput(KILLED).output[0], 'dying')
  })

  test('the cause names the engine the build ran on', () => {
    const message = failureMessage({
      headline: 'x',
      cause: 'enospc',
      output: [],
      engine: 'podman',
    })
    assert.match(message, /free space for Podman \(podman system df/)
  })
})

describe('retrying transient failures', () => {
  const failure = (transient: boolean) =>
    new ImageBuildError('x', { stage: 'from', ref: 'r', transient, cause: null, log: null })

  test('a transient failure is retried, then succeeds', async () => {
    let calls = 0
    const retries: string[] = []
    const result = await retryTransient(
      async () => {
        if (++calls < 3) throw failure(true)
        return 'built'
      },
      { delays: [1, 1], onRetry: (e) => retries.push(e.message) },
    )
    assert.equal(result, 'built')
    assert.equal(calls, 3)
    assert.equal(retries.length, 2)
  })

  test('retries are bounded', async () => {
    let calls = 0
    await assert.rejects(
      retryTransient(
        async () => {
          calls++
          throw new Error(NO_HOST)
        },
        { delays: [1, 1] },
      ),
      /no such host/,
    )
    assert.equal(calls, 3)
  })

  test('canary: a deterministic failure is tried once', async () => {
    let calls = 0
    await assert.rejects(
      retryTransient(
        async () => {
          calls++
          throw failure(false)
        },
        { delays: [1, 1] },
      ),
    )
    assert.equal(calls, 1)
  })
})

describe('Dockerfile tags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-tag-'))
  const reevalBase = join(dir, 'reeval', 'Dockerfile')
  const plain = join(dir, 'plain', 'Dockerfile')
  mkdirSync(join(dir, 'reeval'))
  mkdirSync(join(dir, 'plain'))
  writeFileSync(reevalBase, 'ARG REEVAL_BASE\nFROM $REEVAL_BASE\n')
  writeFileSync(plain, 'FROM debian:bookworm-slim\n')

  test("FROM $REEVAL_BASE: a rebuilt reeval image (a new id) is a new tag; the same id isn't", () => {
    const a = dockerfileTag(reevalBase, 'cursor', 'sha256:aaa').tag
    assert.notEqual(dockerfileTag(reevalBase, 'cursor', 'sha256:bbb').tag, a)
    assert.equal(dockerfileTag(reevalBase, 'cursor', 'sha256:aaa').tag, a)
  })

  test("canary: another base ignores reeval's image id", () => {
    assert.equal(
      dockerfileTag(plain, 'cursor', 'sha256:aaa').tag,
      dockerfileTag(plain, 'cursor', 'sha256:bbb').tag,
    )
  })
})
