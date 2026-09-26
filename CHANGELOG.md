# Changelog

## [0.1.0](https://github.com/invertase/evalsuite/compare/v0.0.1...v0.1.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* **harness:** cursor() runs on the Cursor SDK and records tokens for every harness ([#14](https://github.com/invertase/evalsuite/issues/14))
* **egress:** add the egress option, enforced in Docker and recorded per attempt ([#5](https://github.com/invertase/evalsuite/issues/5))
* **query:** ES needs Node 22.13 or later (was 22.6), where node:sqlite arrives, rather than keeping a JSON fallback.
* **sandbox:** make images, ES_BASE and default hosts per harness, and allowlist brokered endpoints
* records written before this aren't readable by the studio or es compare; delete them and re-record.
* **sandbox:** Cursor attempts in an image without Node fail instead of receiving the real key.
* defineEnvironment({ image }) is removed. Move baked steps to docker({ install }) or a Dockerfile via docker({ dockerfile }).

### Features

* **analysis:** facts views, effort next to lift, and es analyze ([#12](https://github.com/invertase/evalsuite/issues/12)) ([88ee8f7](https://github.com/invertase/evalsuite/commit/88ee8f780c861afff1bdc985fc9280b61b1eec28))
* bake images on the sandbox with docker({ install, dockerfile }) ([7a358c2](https://github.com/invertase/evalsuite/commit/7a358c28f96307ad4e77701dee2e5dbe58f1ce65))
* **cli:** -v/--verbose and -vv/--trace with local debug logs and a studio Debug tab ([#9](https://github.com/invertase/evalsuite/issues/9)) ([7b114a6](https://github.com/invertase/evalsuite/commit/7b114a631de46cedc9d56bacc34c1995688eb92e))
* **cli:** print the plan as JSON with es run --dry-run --json ([1e41cf4](https://github.com/invertase/evalsuite/commit/1e41cf45f65a4a7dfb9bdcf8b1d3c24fc3aba3ff))
* **egress:** add the egress option, enforced in Docker and recorded per attempt ([#5](https://github.com/invertase/evalsuite/issues/5)) ([144ba4e](https://github.com/invertase/evalsuite/commit/144ba4e319fafd5aa168a0da32468cc23cfd3141))
* **evaluate:** start the sandbox without a turn with t.sandbox() ([a7c2394](https://github.com/invertase/evalsuite/commit/a7c23941564423f3e656a5e3cbf383948abe5ff4))
* gate policies, lift intervals, traced fingerprints and the observability record ([477d0e9](https://github.com/invertase/evalsuite/commit/477d0e9770a5eb90eeaa8e4813cedc9e813c75ac))
* **harness:** add a Claude Code harness ([a99cd2b](https://github.com/invertase/evalsuite/commit/a99cd2b8c8aaf7d4a29789f8743b7b9a094b9500))
* **harness:** add an Antigravity harness ([#3](https://github.com/invertase/evalsuite/issues/3)) ([91f2fcc](https://github.com/invertase/evalsuite/commit/91f2fcc6624218d18449d981e0c49f020bd28615))
* **harness:** cursor() runs on the Cursor SDK and records tokens for every harness ([#14](https://github.com/invertase/evalsuite/issues/14)) ([25e3ce7](https://github.com/invertase/evalsuite/commit/25e3ce770b7850cbe1cd93e0184937901edaa44f))
* **harness:** script the fake agent with real sandbox actions ([dc913ed](https://github.com/invertase/evalsuite/commit/dc913ed0da13cd57570aa233c8da6533b7ee4fac))
* **query:** es query, read-only SQL over a local history projection ([a37de5f](https://github.com/invertase/evalsuite/commit/a37de5f032c9d6d0ca98bc7844c590eaf5f52282))
* **sandbox-docker:** broker user secrets by placeholder substitution ([894b447](https://github.com/invertase/evalsuite/commit/894b447d1c87dc7545eedcf04b323800fb520891))
* **sandbox-docker:** report placeholders left where their secret isn't substituted ([9e4f42b](https://github.com/invertase/evalsuite/commit/9e4f42b49e20ad2cb0fdc174363fa48459154bb9))
* **sandbox:** fail closed when Cursor credential brokering can't start ([02cae74](https://github.com/invertase/evalsuite/commit/02cae7455d186a74673826eda8af99eabfb2c6c2))
* **sandbox:** make images, ES_BASE and default hosts per harness, and allowlist brokered endpoints ([60f4275](https://github.com/invertase/evalsuite/commit/60f4275950d10b19f2c8faf2b5c3c19b33e98d93))
* **secrets:** broker user secrets by host ([69fe881](https://github.com/invertase/evalsuite/commit/69fe881b8b34cb40c1b895fae313980bf62db8dc))
* **transcript:** normalise Claude Code's tool shapes ([573be97](https://github.com/invertase/evalsuite/commit/573be9794588c6b9556eceebda2540b47a24a147))
* waves 4–5 — real-agent checks, session-token brokering, evaluate.ts split ([#2](https://github.com/invertase/evalsuite/issues/2)) ([7fc131a](https://github.com/invertase/evalsuite/commit/7fc131a655893560a960e253c8d2311f2ad76485))


### Bug Fixes

* **cursor:** recover the web search and fetch calls the Cursor SDK drops, and flag any it can't ([#15](https://github.com/invertase/evalsuite/issues/15)) ([ceb547e](https://github.com/invertase/evalsuite/commit/ceb547ef342c8e3ebb01c773c817c2a99e390ff8))
* **deps:** depend on vitest ~5.0.2 so peers resolve to one version ([#16](https://github.com/invertase/evalsuite/issues/16)) ([2091cb5](https://github.com/invertase/evalsuite/commit/2091cb58bbec3e545a3e7f33d436af0b0ce19517))
* dogfood bugs — stable Cursor fingerprints, binary env files, sandbox npm, studio run status, tool-call counts ([#8](https://github.com/invertase/evalsuite/issues/8)) ([11fba45](https://github.com/invertase/evalsuite/commit/11fba4569e30d0bd531ccf7f0783b387e25b9fde))
* harness dogfood bugs — expected telemetry hosts, broker log line, cell filters, drift after filtered runs, partial compare ([#10](https://github.com/invertase/evalsuite/issues/10)) ([64a3014](https://github.com/invertase/evalsuite/commit/64a301475651b1f541482cb683c9d5af6280e014))
* **history:** give every run id a random suffix ([05a442a](https://github.com/invertase/evalsuite/commit/05a442a9840597b3bc8b4ecfa4617c3f79de4f84))
* pin vitest 5.0.2 so the packed package installs on npm 10 (Node 22 default) ([#13](https://github.com/invertase/evalsuite/issues/13)) ([2b04a0d](https://github.com/invertase/evalsuite/commit/2b04a0d141e7007fa1869307ddb4c2e19c1e9574))
* **results:** keep a setup step's own timeout an infra error ([34698dc](https://github.com/invertase/evalsuite/commit/34698dcfa9e755efe6e27b9c4074fbee15ecb63b))
* **sandbox-docker:** remove a container whose docker run was aborted ([e468e16](https://github.com/invertase/evalsuite/commit/e468e1668dfce89f22455811a2f971b10d3aaaee))
* **sandbox-docker:** report a forwarder that dies mid-session ([3108230](https://github.com/invertase/evalsuite/commit/3108230fda63954bcb2d64a2672ebd2ae9a7afac))
* **sandbox-docker:** stop an aborted or killed exec inside the container ([19ae4cc](https://github.com/invertase/evalsuite/commit/19ae4cc7462b16ead069c2d6c2862a2d30ce9967))
* **sandbox:** let the fake sandbox read ~/ paths, as it writes them ([6b0cdd0](https://github.com/invertase/evalsuite/commit/6b0cdd058bb706eb84602bc3fd030830b24cc0db))
