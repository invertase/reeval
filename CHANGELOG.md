# Changelog

## [0.6.1](https://github.com/invertase/reeval/compare/v0.6.0...v0.6.1) (2026-10-03)


### Bug Fixes

* **sandbox:** remove leftover fake sandboxes on Windows after c.serve ([#226](https://github.com/invertase/reeval/issues/226)) ([aec1f47](https://github.com/invertase/reeval/commit/aec1f4797cd03427328fe59ce81fcca3233abc99))

## [0.6.0](https://github.com/invertase/reeval/compare/v0.5.0...v0.6.0) (2026-10-02)


### Features

* **capture:** add c.capture screenshots as attempt artifacts ([315423d](https://github.com/invertase/reeval/commit/315423d63e6ba950634b3ce490738da1690fa421)), closes [#207](https://github.com/invertase/reeval/issues/207)


### Bug Fixes

* **analyze:** cap confidence and lead with a one-line verdict ([#222](https://github.com/invertase/reeval/issues/222)) ([9dfcb19](https://github.com/invertase/reeval/commit/9dfcb19930a2b651f9aeedcf87d76dc254c180b1))
* **analyze:** do not treat a changed eval as an effect ([#220](https://github.com/invertase/reeval/issues/220)) ([38f7887](https://github.com/invertase/reeval/commit/38f788711d3ceb394471532b94b7e403e694288b))
* **history:** treat a cell as infra only when nothing counted ([#219](https://github.com/invertase/reeval/issues/219)) ([4a39a83](https://github.com/invertase/reeval/commit/4a39a834345e6b2ca9c6fb036317bc261755b785))

## [0.5.0](https://github.com/invertase/reeval/compare/v0.4.0...v0.5.0) (2026-10-02)


### ⚠ BREAKING CHANGES

* **environment:** put sandbox only on defineEnvironment ([#196](https://github.com/invertase/reeval/issues/196))

### Features

* **environment:** put sandbox only on defineEnvironment ([#196](https://github.com/invertase/reeval/issues/196)) ([c678e11](https://github.com/invertase/reeval/commit/c678e1107ac33134b8b5e7ccaa14463e28c79e2b))
* **opencode:** record the turn's ACP token usage ([#195](https://github.com/invertase/reeval/issues/195)) ([5d72368](https://github.com/invertase/reeval/commit/5d72368f102904130c0b36ff2378443b1e0cb573))
* **ui:** show per-key judge rates, scores and tokens ([#212](https://github.com/invertase/reeval/issues/212)) ([4380067](https://github.com/invertase/reeval/commit/43800677d8b0f9d5e76be873fb41f3d14853552c))


### Bug Fixes

* **analysis:** treat lift below two attempts as insufficient ([#210](https://github.com/invertase/reeval/issues/210)) ([845e242](https://github.com/invertase/reeval/commit/845e24263e6c61a4c0d873e6a867850a4c19a6b2))
* **cursor:** keep the bootstrap the same in every build so baked images skip the install ([#188](https://github.com/invertase/reeval/issues/188)) ([2fbdf83](https://github.com/invertase/reeval/commit/2fbdf83c5bc07ac5f5caa42590e3415baa6c7d67))
* **engine:** tag timeout and cancel instead of sniffing the message ([#203](https://github.com/invertase/reeval/issues/203)) ([0417bf1](https://github.com/invertase/reeval/commit/0417bf1782703ee09fe19c7339724fa2477b40c9))
* **environment:** inherit the config sandbox when a named env omits one ([#197](https://github.com/invertase/reeval/issues/197)) ([675ff4d](https://github.com/invertase/reeval/commit/675ff4d45e5c1e4eccc92414787021ed5165c86a))
* **history:** keep recorded logs tracked under a parent *.log ([#211](https://github.com/invertase/reeval/issues/211)) ([a5f33ac](https://github.com/invertase/reeval/commit/a5f33ac771725b6683cb3c32dbea7181e66292f9))
* **opencode:** probe a provider on models.dev's catalog when OpenCode's knows none of its models ([#189](https://github.com/invertase/reeval/issues/189)) ([993995c](https://github.com/invertase/reeval/commit/993995cd86856b91caff61a06c9ec5f63a8e7d20))

## [0.4.0](https://github.com/invertase/reeval/compare/v0.3.0...v0.4.0) (2026-10-01)


### ⚠ BREAKING CHANGES

* **judge:** scope what the judge sees and size its provider errors ([#185](https://github.com/invertase/reeval/issues/185))
* **compare:** make compare.baseline optional and compare.questions a list ([#177](https://github.com/invertase/reeval/issues/177))

### Features

* **compare:** make compare.baseline optional and compare.questions a list ([#177](https://github.com/invertase/reeval/issues/177)) ([439bdde](https://github.com/invertase/reeval/commit/439bdde2fd7350d5ce40e3ede5f625f0f07e07b5))
* **environment:** add a directory helper that seeds files from a host directory ([#178](https://github.com/invertase/reeval/issues/178)) ([0dbd4e9](https://github.com/invertase/reeval/commit/0dbd4e913b3b24468ce049a165df477f65a705b0))
* **history:** record a run without a secret-looking worktree.patch, and name each match ([#186](https://github.com/invertase/reeval/issues/186)) ([6d413a0](https://github.com/invertase/reeval/commit/6d413a0878aa235cee3e63f17b808fc4eb00ef71))
* **judge:** scope what the judge sees and size its provider errors ([#185](https://github.com/invertase/reeval/issues/185)) ([c684198](https://github.com/invertase/reeval/commit/c68419810fd1f243a7ab51fed9cc387bce12131e))


### Bug Fixes

* **sandbox:** make files executable without chmod's -- for macOS ([#182](https://github.com/invertase/reeval/issues/182)) ([e854d82](https://github.com/invertase/reeval/commit/e854d82d006a09ee4e90b04dd6d97d7a03c7e51d))

## [0.3.0](https://github.com/invertase/reeval/compare/v0.2.0...v0.3.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* **api:** rename the eval context to AttemptContext and its parameter to c ([#175](https://github.com/invertase/reeval/issues/175))

### Features

* **analysis:** write per-harness analysis notes during a run ([#149](https://github.com/invertase/reeval/issues/149)) ([905b4ea](https://github.com/invertase/reeval/commit/905b4ea63670169a113fba60e300d80060d0c0b1))
* **analysis:** write the run's analysis summary after a run ([#158](https://github.com/invertase/reeval/issues/158)) ([eb3d50c](https://github.com/invertase/reeval/commit/eb3d50ca66b2afd0f4af82218773446f39318ef3))
* **cli:** add --profile to reeval image build ([#160](https://github.com/invertase/reeval/issues/160)) ([475cc42](https://github.com/invertase/reeval/commit/475cc423942062376e6798a25d9fa6d21a6efef9))
* **compare:** answer compare questions with pairwise win rates ([#152](https://github.com/invertase/reeval/issues/152)) ([abc3bbd](https://github.com/invertase/reeval/commit/abc3bbd9e94b666944127b4c202188ed7950ec07))
* **compare:** declare compare questions in the plan ([#147](https://github.com/invertase/reeval/issues/147)) ([879749e](https://github.com/invertase/reeval/commit/879749efd37e4fdc4fa44dba69e876549eadac8d))
* **harness:** support MCP servers on pi 0.99 ([#156](https://github.com/invertase/reeval/issues/156)) ([54b619e](https://github.com/invertase/reeval/commit/54b619e874a0bdf4bc0243728c08d5f24aed269c))
* **record:** record the real runtime and eval language ([#154](https://github.com/invertase/reeval/issues/154)) ([f660d33](https://github.com/invertase/reeval/commit/f660d3365839dd9689b18e9697b5adcd2b0ddb35))
* **studio:** show compare answers on the run page ([#155](https://github.com/invertase/reeval/issues/155)) ([674e2ee](https://github.com/invertase/reeval/commit/674e2ee7b0f6fedf7bc1beeb612af4de5a52858c))


### Bug Fixes

* **history:** name the profile's judge in the run record ([#159](https://github.com/invertase/reeval/issues/159)) ([5ed3fd2](https://github.com/invertase/reeval/commit/5ed3fd2bfc93591aca1c2eb9cf85abac22a8d621))
* **sandbox:** keep the image's PATH in login shells ([#157](https://github.com/invertase/reeval/issues/157)) ([d22883f](https://github.com/invertase/reeval/commit/d22883fa7223d79cc621b315aabf0db4d9508aef))


### Code Refactoring

* **api:** rename the eval context to AttemptContext and its parameter to c ([#175](https://github.com/invertase/reeval/issues/175)) ([dbc3664](https://github.com/invertase/reeval/commit/dbc36643188267d60b43df10f5421a017b61db00))

## [0.2.0](https://github.com/invertase/reeval/compare/v0.1.0...v0.2.0) (2026-09-29)


### ⚠ BREAKING CHANGES

* **compare:** run baseline and variants as independent environments ([#142](https://github.com/invertase/reeval/issues/142))

### Features

* **compare:** run baseline and variants as independent environments ([#142](https://github.com/invertase/reeval/issues/142)) ([2a8c1cf](https://github.com/invertase/reeval/commit/2a8c1cfc40dea73d324a2ceb9ca1fcf7232b8d4a))

## [0.1.0](https://github.com/invertase/reeval/compare/v0.0.1...v0.1.0) (2026-09-29)


### ⚠ BREAKING CHANGES

* **sandbox:** run as the reeval user in /reeval/workspace ([#141](https://github.com/invertase/reeval/issues/141))
* rename to reeval ([#135](https://github.com/invertase/reeval/issues/135))
* **harness:** OpenCode on any brokerable provider ([#132](https://github.com/invertase/reeval/issues/132))
* **harness:** run OpenCode v2 (@opencode/cli) ([#125](https://github.com/invertase/reeval/issues/125))
* remove vitest, vite and the vitest-era workarounds ([#98](https://github.com/invertase/reeval/issues/98))
* **engine:** run eval files in es's own fork pool ([#96](https://github.com/invertase/reeval/issues/96))
* **sandbox:** images built before this have no es user; rebuild them with es image build.
* **cli:** load .env and .env.local from the config's directory, not the current one ([#76](https://github.com/invertase/reeval/issues/76))
* **cli:** exit 143 on SIGTERM; Ctrl-C stays 130 ([#75](https://github.com/invertase/reeval/issues/75))
* **harness:** cursor() runs on the Cursor SDK and records tokens for every harness ([#14](https://github.com/invertase/reeval/issues/14))
* **egress:** add the egress option, enforced in Docker and recorded per attempt ([#5](https://github.com/invertase/reeval/issues/5))
* **query:** ES needs Node 22.13 or later (was 22.6), where node:sqlite arrives, rather than keeping a JSON fallback.
* **sandbox:** make images, ES_BASE and default hosts per harness, and allowlist brokered endpoints
* records written before this aren't readable by the studio or es compare; delete them and re-record.
* **sandbox:** Cursor attempts in an image without Node fail instead of receiving the real key.
* defineEnvironment({ image }) is removed. Move baked steps to docker({ install }) or a Dockerfile via docker({ dockerfile }).

### Features

* **analysis:** facts views, effort next to lift, and es analyze ([#12](https://github.com/invertase/reeval/issues/12)) ([88ee8f7](https://github.com/invertase/reeval/commit/88ee8f780c861afff1bdc985fc9280b61b1eec28))
* bake images on the sandbox with docker({ install, dockerfile }) ([7a358c2](https://github.com/invertase/reeval/commit/7a358c28f96307ad4e77701dee2e5dbe58f1ce65))
* **cli:** -v/--verbose and -vv/--trace with local debug logs and a studio Debug tab ([#9](https://github.com/invertase/reeval/issues/9)) ([7b114a6](https://github.com/invertase/reeval/commit/7b114a631de46cedc9d56bacc34c1995688eb92e))
* **cli:** add es doctor to check a project's setup ([#102](https://github.com/invertase/reeval/issues/102)) ([1db30e8](https://github.com/invertase/reeval/commit/1db30e80f1096e3152858f24f395d57b1edd028c))
* **cli:** add es init to scaffold a project ([#101](https://github.com/invertase/reeval/issues/101)) ([d3fbce2](https://github.com/invertase/reeval/commit/d3fbce23f783c80eecfb7387688f05140f4e4a35))
* **cli:** add es report for redacted bug reports and issues ([#110](https://github.com/invertase/reeval/issues/110)) ([4332a50](https://github.com/invertase/reeval/commit/4332a50d3926420f84564c51de7e6d2afd688b5c))
* **cli:** es image build reports every image, es run --dry-run checks them, and from tags rebuild when they move ([#109](https://github.com/invertase/reeval/issues/109)) ([bf54e73](https://github.com/invertase/reeval/commit/bf54e73d69123e62fd7bba5c4293d4b6e44a285c))
* **cli:** es mcp, an MCP server over run history ([#128](https://github.com/invertase/reeval/issues/128)) ([dfcb93c](https://github.com/invertase/reeval/commit/dfcb93c3ba062d7ae8730520406cf609562c354b))
* **cli:** find the nearest es.config.* upward from the current directory ([#86](https://github.com/invertase/reeval/issues/86)) ([537a561](https://github.com/invertase/reeval/commit/537a561727275a730de75885434b3d0a5415c3a3))
* **cli:** print the plan as JSON with es run --dry-run --json ([1e41cf4](https://github.com/invertase/reeval/commit/1e41cf45f65a4a7dfb9bdcf8b1d3c24fc3aba3ff))
* **doctor:** explain Docker Desktop's Linux containers and WSL 2 on Windows ([#116](https://github.com/invertase/reeval/issues/116)) ([5bff1cf](https://github.com/invertase/reeval/commit/5bff1cf826f37f88ca8b0db06570081c4e4e24d4))
* **egress:** add the egress option, enforced in Docker and recorded per attempt ([#5](https://github.com/invertase/reeval/issues/5)) ([144ba4e](https://github.com/invertase/reeval/commit/144ba4e319fafd5aa168a0da32468cc23cfd3141))
* **environment:** start an environment from a git repo ([#130](https://github.com/invertase/reeval/issues/130)) ([4a8ca59](https://github.com/invertase/reeval/commit/4a8ca59451fd75e238fd92674f51748cc4623fd1))
* **evaluate:** start the sandbox without a turn with t.sandbox() ([a7c2394](https://github.com/invertase/reeval/commit/a7c23941564423f3e656a5e3cbf383948abe5ff4))
* gate policies, lift intervals, traced fingerprints and the observability record ([477d0e9](https://github.com/invertase/reeval/commit/477d0e9770a5eb90eeaa8e4813cedc9e813c75ac))
* **harness:** add a Claude Code harness ([a99cd2b](https://github.com/invertase/reeval/commit/a99cd2b8c8aaf7d4a29789f8743b7b9a094b9500))
* **harness:** add a Codex harness on a brokered OpenAI key ([#104](https://github.com/invertase/reeval/issues/104)) ([cddffa5](https://github.com/invertase/reeval/commit/cddffa52baa789a34d2e6f7298b3900d78561afb))
* **harness:** add a Goose harness over ACP on a brokered Gemini key ([#29](https://github.com/invertase/reeval/issues/29)) ([d36f0a0](https://github.com/invertase/reeval/commit/d36f0a0e27380bad757843c73caec019e73d2a9d))
* **harness:** add a pi harness that runs pi --mode json in the sandbox on a brokered Gemini key ([#31](https://github.com/invertase/reeval/issues/31)) ([b6a5485](https://github.com/invertase/reeval/commit/b6a548533ce40b430a692e8da3eff581e1cf7a56))
* **harness:** add an Antigravity harness ([#3](https://github.com/invertase/reeval/issues/3)) ([91f2fcc](https://github.com/invertase/reeval/commit/91f2fcc6624218d18449d981e0c49f020bd28615))
* **harness:** add an OpenCode harness over ACP on a brokered Gemini key ([#24](https://github.com/invertase/reeval/issues/24)) ([1f2e831](https://github.com/invertase/reeval/commit/1f2e831c9a784d6fad8a73855f8d896178fc7ec5))
* **harness:** bound every harness's session start with startTimeout, retried once ([#123](https://github.com/invertase/reeval/issues/123)) ([89219c3](https://github.com/invertase/reeval/commit/89219c36512e45532d24d254b8e91f0b9680c635))
* **harness:** cursor() runs on the Cursor SDK and records tokens for every harness ([#14](https://github.com/invertase/reeval/issues/14)) ([25e3ce7](https://github.com/invertase/reeval/commit/25e3ce770b7850cbe1cd93e0184937901edaa44f))
* **harness:** OpenCode on any brokerable provider ([#132](https://github.com/invertase/reeval/issues/132)) ([49ab2fb](https://github.com/invertase/reeval/commit/49ab2fbddb5e50fb5266c93bc965e18e4a037631))
* **harness:** run OpenCode v2 (@opencode/cli) ([#125](https://github.com/invertase/reeval/issues/125)) ([3da0cf2](https://github.com/invertase/reeval/commit/3da0cf24ac5e18a66ffec6fa4f677e3ad450ef70))
* **harness:** script the fake agent with real sandbox actions ([dc913ed](https://github.com/invertase/reeval/commit/dc913ed0da13cd57570aa233c8da6533b7ee4fac))
* **history:** record and show the model variant each harness resolved ([#80](https://github.com/invertase/reeval/issues/80)) ([97dc7b5](https://github.com/invertase/reeval/commit/97dc7b58fb430ecfc73a31f05288018d6a989195))
* **query:** es query, read-only SQL over a local history projection ([a37de5f](https://github.com/invertase/reeval/commit/a37de5f032c9d6d0ca98bc7844c590eaf5f52282))
* rename to reeval ([#135](https://github.com/invertase/reeval/issues/135)) ([3e97e46](https://github.com/invertase/reeval/commit/3e97e464e9b43172f7f1bade7baf2fe85ba9d14b))
* **sandbox-docker:** broker user secrets by placeholder substitution ([894b447](https://github.com/invertase/reeval/commit/894b447d1c87dc7545eedcf04b323800fb520891))
* **sandbox-docker:** report placeholders left where their secret isn't substituted ([9e4f42b](https://github.com/invertase/reeval/commit/9e4f42b49e20ad2cb0fdc174363fa48459154bb9))
* **sandbox:** fail closed when Cursor credential brokering can't start ([02cae74](https://github.com/invertase/reeval/commit/02cae7455d186a74673826eda8af99eabfb2c6c2))
* **sandbox:** make images, ES_BASE and default hosts per harness, and allowlist brokered endpoints ([60f4275](https://github.com/invertase/reeval/commit/60f4275950d10b19f2c8faf2b5c3c19b33e98d93))
* **sandbox:** prepare every sandbox in preflight through a provider contract ([#108](https://github.com/invertase/reeval/issues/108)) ([88b94a3](https://github.com/invertase/reeval/commit/88b94a305bd4ef89113ff1cdf0765884e2cf45c9))
* **sandbox:** run as the reeval user in /reeval/workspace ([#141](https://github.com/invertase/reeval/issues/141)) ([ce1e797](https://github.com/invertase/reeval/commit/ce1e797eddab2e77bc31b55b34cbdfe9e2becb84))
* **sandbox:** run sandboxes unprivileged, with no capabilities and resource limits ([#84](https://github.com/invertase/reeval/issues/84)) ([376f2e4](https://github.com/invertase/reeval/commit/376f2e4888edd60e97baf885ad7e27d6d7887b7a))
* **sandbox:** warn when a sandbox runs as root or with added capabilities ([#100](https://github.com/invertase/reeval/issues/100)) ([fd28f1c](https://github.com/invertase/reeval/commit/fd28f1c7fb67536cf51a269ebbfd3f475472d1a8))
* **secrets:** broker user secrets by host ([69fe881](https://github.com/invertase/reeval/commit/69fe881b8b34cb40c1b895fae313980bf62db8dc))
* show group.todo, like evaluate.todo, as todo in the plan, summary, record and studio ([#82](https://github.com/invertase/reeval/issues/82)) ([5a02e18](https://github.com/invertase/reeval/commit/5a02e18ba0c7e4d8a3ce3e375f128fb0fcf37e78))
* **studio:** show runs in progress, attempt by attempt, until the record lands ([#114](https://github.com/invertase/reeval/issues/114)) ([9abe1d7](https://github.com/invertase/reeval/commit/9abe1d7f9104427962b0c95db34d5d57c0bc0747))
* **transcript:** normalise Claude Code's tool shapes ([573be97](https://github.com/invertase/reeval/commit/573be9794588c6b9556eceebda2540b47a24a147))
* waves 4–5 — real-agent checks, session-token brokering, evaluate.ts split ([#2](https://github.com/invertase/reeval/issues/2)) ([7fc131a](https://github.com/invertase/reeval/commit/7fc131a655893560a960e253c8d2311f2ad76485))


### Bug Fixes

* **attempt:** stop waiting for a turn whose agent ignores the abort ([#60](https://github.com/invertase/reeval/issues/60)) ([ccd4cc3](https://github.com/invertase/reeval/commit/ccd4cc39588c2f9ef1f09544239841acdbcc68de))
* **cli:** cancel a run on SIGTERM like Ctrl-C and remove its containers ([#40](https://github.com/invertase/reeval/issues/40)) ([137efee](https://github.com/invertase/reeval/commit/137efee96db8b97037e6f8c99c9c2f952036afc1))
* **cli:** count every masked value in es report, including upstream ones ([#120](https://github.com/invertase/reeval/issues/120)) ([befa811](https://github.com/invertase/reeval/commit/befa81125d1e56edbae8b4da8e1aed56cd9253a1))
* **cli:** exit 143 on SIGTERM; Ctrl-C stays 130 ([#75](https://github.com/invertase/reeval/issues/75)) ([50661bb](https://github.com/invertase/reeval/commit/50661bb3619f4d6d18d986f230c80267ad707f54))
* **cli:** load .env and .env.local from the config's directory, not the current one ([#76](https://github.com/invertase/reeval/issues/76)) ([484bdd8](https://github.com/invertase/reeval/commit/484bdd8327aee55a2e558c466d9e48cbf15d40f9))
* **cli:** mask secrets in the error that stops a run ([#65](https://github.com/invertase/reeval/issues/65)) ([be2715b](https://github.com/invertase/reeval/commit/be2715bfe76fca11aeb9e6a894423829428e05bd))
* **cli:** print project paths with forward slashes on every OS ([#115](https://github.com/invertase/reeval/issues/115)) ([25334bf](https://github.com/invertase/reeval/commit/25334bfbe4654af2d523a1e5a2741f243c0a64b1))
* **config:** name the config file that was read in its errors ([#93](https://github.com/invertase/reeval/issues/93)) ([36e018b](https://github.com/invertase/reeval/commit/36e018b2e092e83a5ecf447c90c83ea18e38c987))
* **config:** refuse a config file without a default export instead of running the defaults ([#46](https://github.com/invertase/reeval/issues/46)) ([711e8ac](https://github.com/invertase/reeval/commit/711e8ac50692e889406c24c85a78dae0f83fd8ad))
* **config:** refuse a zero or negative timeout, budget or setup step duration ([#44](https://github.com/invertase/reeval/issues/44)) ([9c0bef3](https://github.com/invertase/reeval/commit/9c0bef3efc41df608e58db1f511d00699a49ed2f))
* **cursor:** recover the web search and fetch calls the Cursor SDK drops, and flag any it can't ([#15](https://github.com/invertase/reeval/issues/15)) ([ceb547e](https://github.com/invertase/reeval/commit/ceb547ef342c8e3ebb01c773c817c2a99e390ff8))
* **cursor:** send the catalog's default model variant explicitly when params are unset ([#26](https://github.com/invertase/reeval/issues/26)) ([5fb1e0d](https://github.com/invertase/reeval/commit/5fb1e0d8ce12cfe661f3005b33888a0d412cb9c9))
* **deps:** depend on vite, which vitest requires as a peer ([#88](https://github.com/invertase/reeval/issues/88)) ([25cb0b1](https://github.com/invertase/reeval/commit/25cb0b1e041b6a1357b9e2414e872584323dee39))
* **deps:** depend on vitest ~5.0.2 so peers resolve to one version ([#16](https://github.com/invertase/reeval/issues/16)) ([2091cb5](https://github.com/invertase/reeval/commit/2091cb58bbec3e545a3e7f33d436af0b0ce19517))
* dogfood bugs — stable Cursor fingerprints, binary env files, sandbox npm, studio run status, tool-call counts ([#8](https://github.com/invertase/reeval/issues/8)) ([11fba45](https://github.com/invertase/reeval/commit/11fba4569e30d0bd531ccf7f0783b387e25b9fde))
* **egress:** scrub brokered secrets from websocket upgrade response headers ([#37](https://github.com/invertase/reeval/issues/37)) ([5809719](https://github.com/invertase/reeval/commit/5809719836f54fd7a9e236eccbc1b1a84336d07b))
* **engine:** attribute an eval's console output to its own attempt, and cover the output flags and exit precedence ([#36](https://github.com/invertase/reeval/issues/36)) ([9fa5099](https://github.com/invertase/reeval/commit/9fa509962b69c2d6dbee6e7562a2461272ce5684))
* **engine:** fail evals with unawaited async assertions and refuse duplicate eval names ([#22](https://github.com/invertase/reeval/issues/22)) ([f741e3c](https://github.com/invertase/reeval/commit/f741e3ca853616673dca68110cc6abff4952464f))
* **engine:** fail loudly when an eval file doesn't load or none match include ([#48](https://github.com/invertase/reeval/issues/48)) ([318f8b6](https://github.com/invertase/reeval/commit/318f8b60c67bcc1ed39a75a2ec00222c3e39ca4c))
* **engine:** filter evals by their ids and pass vitest the matched test ids ([#87](https://github.com/invertase/reeval/issues/87)) ([3174d82](https://github.com/invertase/reeval/commit/3174d8289fdca439bcf2d865d83b6f744aae53b0))
* **engine:** give a worker's last messages a second after its exit, and never exit 0 unfinished ([#127](https://github.com/invertase/reeval/issues/127)) ([0a7e2f3](https://github.com/invertase/reeval/commit/0a7e2f36614e852d6c59e91ac3d83e7759d16242))
* **engine:** remove vitest's process listeners and report uncaught errors ([#89](https://github.com/invertase/reeval/issues/89)) ([5aa7082](https://github.com/invertase/reeval/commit/5aa7082fd5d46f9edf7193e2a44730ac053f44f7))
* **engine:** run eval files on Windows: filters, frames, syntax errors and a worker's last messages ([#117](https://github.com/invertase/reeval/issues/117)) ([7490f7b](https://github.com/invertase/reeval/commit/7490f7b8cc012a7536edc7a72a0ea21627ca3434))
* **environment:** refuse file paths that leave the workspace or home, and backslashes ([#62](https://github.com/invertase/reeval/issues/62)) ([ac28d52](https://github.com/invertase/reeval/commit/ac28d5261fa5f5af9e762af6cc02c59c411cf293))
* **environment:** resolve a local skill.npm path against its file, and refuse mcp.sse on Goose and pi at plan time ([#57](https://github.com/invertase/reeval/issues/57)) ([e7c106e](https://github.com/invertase/reeval/commit/e7c106e2077b81028f61a65504cdd517a5bb725d))
* **examples:** inline the base tsconfig so examples/hello runs when copied out of the repo ([#77](https://github.com/invertase/reeval/issues/77)) ([6d3e086](https://github.com/invertase/reeval/commit/6d3e0867cf705841c44b394c265387fd48e9e7df))
* **goose:** broker the model list Goose fetches each turn, so the gateway stops refusing it ([#55](https://github.com/invertase/reeval/issues/55)) ([2d211d6](https://github.com/invertase/reeval/commit/2d211d6e7566354fbbbd1ff50906d696b21ef924))
* **goose:** fail the turn when Goose reports a failed model call as its message ([#51](https://github.com/invertase/reeval/issues/51)) ([8b1bc39](https://github.com/invertase/reeval/commit/8b1bc39dbe04fb420b00f99e8a4bbc01264f9b26))
* harness dogfood bugs — expected telemetry hosts, broker log line, cell filters, drift after filtered runs, partial compare ([#10](https://github.com/invertase/reeval/issues/10)) ([64a3014](https://github.com/invertase/reeval/commit/64a301475651b1f541482cb683c9d5af6280e014))
* **harness:** keep only the final attempt's reply when agy retries a model call ([#97](https://github.com/invertase/reeval/issues/97)) ([32ed162](https://github.com/invertase/reeval/commit/32ed1621462f541599f275bd90ac0a759d9fecdd))
* **harness:** name the credential when a harness's API rejects its key ([#52](https://github.com/invertase/reeval/issues/52)) ([96f5b34](https://github.com/invertase/reeval/commit/96f5b343ddf1c2da2c62c480300ae78097aa9321))
* **harness:** record a failed turn's error once in the transcript ([#53](https://github.com/invertase/reeval/issues/53)) ([31b348b](https://github.com/invertase/reeval/commit/31b348b031a2a29b754d1effe6480f6872ae7f62))
* **harness:** record a turn the timeout cuts off as aborted, with Cursor's step closed ([#61](https://github.com/invertase/reeval/issues/61)) ([5814209](https://github.com/invertase/reeval/commit/58142096fd609ff0cdcdb44895cf3bdc6395ff44))
* **harness:** record claude code's served model by patching its adapter's bridge ([#81](https://github.com/invertase/reeval/issues/81)) ([668fc98](https://github.com/invertase/reeval/commit/668fc98bf30d2595e0cf8b02381dc440c7055aac))
* **harness:** refuse any MCP server on pi at plan time, not only mcp.sse ([#72](https://github.com/invertase/reeval/issues/72)) ([8fcc41d](https://github.com/invertase/reeval/commit/8fcc41dee0c13b913578be31cbd708cf4565b953))
* **history:** compare without a base, fail on failing new evals, and check analyze verify selections ([#25](https://github.com/invertase/reeval/issues/25)) ([bca8f4e](https://github.com/invertase/reeval/commit/bca8f4ea5bff13171cb5accf85df84b71b2733ed))
* **history:** fail --fail-on-regression on a failing eval that changed (not comparable) ([#73](https://github.com/invertase/reeval/issues/73)) ([f6ec129](https://github.com/invertase/reeval/commit/f6ec1290ee77fa0ca28e9c1b67dbac3339ac5684))
* **history:** format the snapshots schema:update writes, so biome ci passes ([#111](https://github.com/invertase/reeval/issues/111)) ([fa4a42c](https://github.com/invertase/reeval/commit/fa4a42c9c976d3d542bdf9b6be27d4fc74393441))
* **history:** give every run id a random suffix ([05a442a](https://github.com/invertase/reeval/commit/05a442a9840597b3bc8b4ecfa4617c3f79de4f84))
* **history:** read records from before plan.sandboxWarnings, resolvedModels and todo ([#103](https://github.com/invertase/reeval/issues/103)) ([c3edbad](https://github.com/invertase/reeval/commit/c3edbadf131af1f524c797d3c8c922897ccea4fc))
* **history:** record a run budget.duration stopped, as status budget ([#27](https://github.com/invertase/reeval/issues/27)) ([c1de932](https://github.com/invertase/reeval/commit/c1de932a05b6aa43d1e577a0f7227b0ba862f926))
* **history:** record git state when the project's path isn't git's own spelling of it ([#112](https://github.com/invertase/reeval/issues/112)) ([5f2d382](https://github.com/invertase/reeval/commit/5f2d3828d3f61cb3a41b8a585a1324ec20ee93dd))
* **history:** show recorded tokens in the studio and drop the always-null usd ([#20](https://github.com/invertase/reeval/issues/20)) ([3c49d44](https://github.com/invertase/reeval/commit/3c49d4435292bd7dbb1b2d086db5b4214482ac64))
* **history:** warn about a history file that isn't a readable record instead of skipping it silently ([#56](https://github.com/invertase/reeval/issues/56)) ([d0d7efc](https://github.com/invertase/reeval/commit/d0d7efca86cc80d49747b1587958b527ae36acf6))
* **judge:** refuse an empty judge question and a threshold outside 0 to 1 on groups, evals and calls ([#58](https://github.com/invertase/reeval/issues/58)) ([ae9d094](https://github.com/invertase/reeval/commit/ae9d09477092593ff84d8dfe9d04baf2d69a6785))
* minor validation, plan and output fixes from the docs build ([#28](https://github.com/invertase/reeval/issues/28)) ([add8ede](https://github.com/invertase/reeval/commit/add8eded7424f179e4455fc1df3a641ad8d380bd))
* **output:** cap a failure's output on screen and in the record ([#59](https://github.com/invertase/reeval/issues/59)) ([e9cf6d4](https://github.com/invertase/reeval/commit/e9cf6d4809c35a6706985f9dde8e1c3f38cb7f39))
* pin vitest 5.0.2 so the packed package installs on npm 10 (Node 22 default) ([#13](https://github.com/invertase/reeval/issues/13)) ([2b04a0d](https://github.com/invertase/reeval/commit/2b04a0d141e7007fa1869307ddb4c2e19c1e9574))
* **report:** es report on Windows: gh, posix paths, and the home's 8.3 short name masked ([#122](https://github.com/invertase/reeval/issues/122)) ([2d18989](https://github.com/invertase/reeval/commit/2d18989b24143078bd6567cfdcc846db8239a363))
* **results:** keep a setup step's own timeout an infra error ([34698dc](https://github.com/invertase/reeval/commit/34698dcfa9e755efe6e27b9c4074fbee15ecb63b))
* **sandbox-docker:** remove a container whose docker run was aborted ([e468e16](https://github.com/invertase/reeval/commit/e468e1668dfce89f22455811a2f971b10d3aaaee))
* **sandbox-docker:** report a forwarder that dies mid-session ([3108230](https://github.com/invertase/reeval/commit/3108230fda63954bcb2d64a2672ebd2ae9a7afac))
* **sandbox-docker:** stop an aborted or killed exec inside the container ([19ae4cc](https://github.com/invertase/reeval/commit/19ae4cc7462b16ead069c2d6c2862a2d30ce9967))
* **sandbox:** check docker({ install }) step timeouts like every other duration ([#66](https://github.com/invertase/reeval/issues/66)) ([0c8f89f](https://github.com/invertase/reeval/commit/0c8f89f2c9b015c7ef7d7c69bc356c4af7251f19))
* **sandbox:** es run --dry-run --json on a machine without the docker CLI ([#126](https://github.com/invertase/reeval/issues/126)) ([defda0b](https://github.com/invertase/reeval/commit/defda0b4efbc1856ad3a638a54b5d772dc3a1b9b))
* **sandbox:** let the fake sandbox read ~/ paths, as it writes them ([6b0cdd0](https://github.com/invertase/reeval/commit/6b0cdd058bb706eb84602bc3fd030830b24cc0db))
* **sandbox:** readable image build failures, transient retries and no leftover images ([#105](https://github.com/invertase/reeval/issues/105)) ([7018006](https://github.com/invertase/reeval/commit/701800604f0466ab0ff279b92175cc9f8d647081))
* **sandbox:** run .cmd tools, kill process trees and run the fake sandbox on Windows hosts ([#113](https://github.com/invertase/reeval/issues/113)) ([0adb6c3](https://github.com/invertase/reeval/commit/0adb6c32015a56cccdf8487414e206a582b8c709))
* **secrets:** don't warn about an optional secret that isn't set ([#50](https://github.com/invertase/reeval/issues/50)) ([4a18c03](https://github.com/invertase/reeval/commit/4a18c03d3e152c43dcc64fa97633c2d6d810559c))
* **secrets:** mask declared secrets in an eval's logs and failures on screen ([#34](https://github.com/invertase/reeval/issues/34)) ([f9b0733](https://github.com/invertase/reeval/commit/f9b073387cfde40ab055698de09393e2dd682574))
* **secrets:** mask every variable a header's secret.template reads, not only the last ([#64](https://github.com/invertase/reeval/issues/64)) ([8618665](https://github.com/invertase/reeval/commit/86186651a0b3e6de9074dcc84cdd288f94499ca3))
* **secrets:** never print key fragments and mask any stretch of a secret ([#21](https://github.com/invertase/reeval/issues/21)) ([5fc90ba](https://github.com/invertase/reeval/commit/5fc90ba9ab41e0bb57ba7fb6b8363f810d68a269))
* **secrets:** refuse an unbrokered optional secret under unbrokered 'error' whether or not it's set ([#63](https://github.com/invertase/reeval/issues/63)) ([dc77da4](https://github.com/invertase/reeval/commit/dc77da4c286efefb6f7c7757a3b7cabb4c34085d))
* **setup:** report a setup step that can't start as failed, not timed out ([#35](https://github.com/invertase/reeval/issues/35)) ([01eea87](https://github.com/invertase/reeval/commit/01eea87f2eebce5f22d4f6a6cd56deff9bb950ac))
* **studio:** keep every live progress update on Windows, where a rename over an open file fails ([#119](https://github.com/invertase/reeval/issues/119)) ([b514136](https://github.com/invertase/reeval/commit/b5141365e405188301303adf254476b3c14c77eb))
* **studio:** list runs while a record lands on Windows ([#140](https://github.com/invertase/reeval/issues/140)) ([dcf9819](https://github.com/invertase/reeval/commit/dcf9819051087d0351cf01dcef96586e37c8c18c))
* **test:** ignore the package version in the engine differential ([#145](https://github.com/invertase/reeval/issues/145)) ([1fa0cc0](https://github.com/invertase/reeval/commit/1fa0cc0ebb5d8943fcb0be0c23dd82a509322463))
* **test:** know every failure the Cursor runner and agy report in the contract's stream format check ([#95](https://github.com/invertase/reeval/issues/95)) ([f1a1b5e](https://github.com/invertase/reeval/commit/f1a1b5ef124b26da2d3f2e5d2c4d392e033fa9c0))
* **test:** know every stop reason pi defines, and a failed call's errorMessage, in the contract's stream format check ([#92](https://github.com/invertase/reeval/issues/92)) ([f57eef1](https://github.com/invertase/reeval/commit/f57eef165cbbd5dea6bd24b083f9bf5950adc19f))
* **test:** know every value ACP defines in the contract's stream format check ([#90](https://github.com/invertase/reeval/issues/90)) ([a99bf58](https://github.com/invertase/reeval/commit/a99bf58dbcd2115583b12c764c5e87e43bf73be8))
* **ui:** label an eval's pass rate gated when some of its cells aren't ([#39](https://github.com/invertase/reeval/issues/39)) ([7d57eb8](https://github.com/invertase/reeval/commit/7d57eb8e47b1605d67350c6d7d5d393a386dad42))
* **ui:** report ungated cells' expected misses apart from failures ([#94](https://github.com/invertase/reeval/issues/94)) ([869265f](https://github.com/invertase/reeval/commit/869265fb248c57a89c3607e3f146ddb0fe0108aa))
* **ui:** show a turn's error message in the summary without -v ([#23](https://github.com/invertase/reeval/issues/23)) ([0dd09a3](https://github.com/invertase/reeval/commit/0dd09a351729f5f4e3664732e13248bab3c5a544))


### Code Refactoring

* **engine:** run eval files in es's own fork pool ([#96](https://github.com/invertase/reeval/issues/96)) ([034520e](https://github.com/invertase/reeval/commit/034520e5660eca735f91e542bd6a8176bc68b4b1))
* remove vitest, vite and the vitest-era workarounds ([#98](https://github.com/invertase/reeval/issues/98)) ([331eba3](https://github.com/invertase/reeval/commit/331eba379fbc9f22e3780f247aa747824339eb0e))
