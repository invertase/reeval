// The engine the container tests run on: Docker, or Podman with REEVAL_TEST_ENGINE=podman. Each
// test file drives the CLI as `CLI` and the session through `createSession`, so one suite covers both.
import type { Engine } from '../src/engine.ts'
import { createDockerSession, type SessionOptions } from '../src/session.ts'

export const ENGINE: Engine = process.env.REEVAL_TEST_ENGINE === 'podman' ? 'podman' : 'docker'
/**
 * Fail instead of skipping when the engine or reeval's image isn't there: CI's docker job sets
 * REEVAL_TEST_REQUIRE_DOCKER=1, its podman job REEVAL_TEST_REQUIRE_PODMAN=1.
 */
export const REQUIRE_ENGINE =
  process.env[ENGINE === 'podman' ? 'REEVAL_TEST_REQUIRE_PODMAN' : 'REEVAL_TEST_REQUIRE_DOCKER'] ===
  '1'
/** The CLI the tests run themselves: `docker` or `podman`. */
export const CLI = ENGINE
/** The network a new container joins: Docker's default bridge, or Podman's `podman` bridge. */
export const DEFAULT_NETWORK = ENGINE === 'podman' ? 'podman' : 'bridge'

export const createSession = (options: SessionOptions) =>
  createDockerSession({ ...options, engine: ENGINE })
