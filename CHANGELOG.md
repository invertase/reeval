# Changelog

## [0.17.2](https://github.com/invertase/reeval/compare/v0.17.1...v0.17.2) (2026-10-30)


### Bug Fixes

* **cli:** read a passed-on Ctrl-C as one press whichever signal arrives first ([#738](https://github.com/invertase/reeval/issues/738)) ([3c02c33](https://github.com/invertase/reeval/commit/3c02c33325dabe6d462fcc5049886054d01bf42a))
* **harness:** record unmeasured reasoning time as null and count subagent edits ([#736](https://github.com/invertase/reeval/issues/736)) ([0ee5467](https://github.com/invertase/reeval/commit/0ee5467453eac366055b9368655d534b1b9a4e25))

## [0.17.1](https://github.com/invertase/reeval/compare/v0.17.0...v0.17.1) (2026-10-30)


### Bug Fixes

* **antigravity:** map manage_task, agy 1.4.7's background-task tool ([#722](https://github.com/invertase/reeval/issues/722)) ([bf646ac](https://github.com/invertase/reeval/commit/bf646ac19acf119594e6a9d2b5059ee00810b966))
* **cli:** keep the run record when a launcher passes Ctrl-C on, and say what a second press skips ([#730](https://github.com/invertase/reeval/issues/730)) ([4898cee](https://github.com/invertase/reeval/commit/4898cee69ea759e0d6e064eefc3d2016b65c7dc9))
* **cursor:** record tool calls with no result as unfinished, not failed ([#731](https://github.com/invertase/reeval/issues/731)) ([b8d3c6e](https://github.com/invertase/reeval/commit/b8d3c6e97d3f79a13c9dfe35c7ef0937db2b9dd8))
* **egress:** record and report a refused brokered request ([#717](https://github.com/invertase/reeval/issues/717)) ([ea08bb7](https://github.com/invertase/reeval/commit/ea08bb7046111cfdc504cbd1cfa3018f8a93920d))
* **egress:** record names that don't resolve apart from policy blocks ([#729](https://github.com/invertase/reeval/issues/729)) ([0b330fe](https://github.com/invertase/reeval/commit/0b330fec298a65e472c57f22ccb01d6aa1747d50))
* **goose:** keep the image's bootstrap at every effort, so Goose isn't reinstalled at each attempt ([#721](https://github.com/invertase/reeval/issues/721)) ([a010453](https://github.com/invertase/reeval/commit/a0104532e4eb6a5ebd2dccd4582e43bf047538cd))
* **goose:** pass Vertex AI's variables through a launcher, so the eval's own reach the agent ([#725](https://github.com/invertase/reeval/issues/725)) ([2738106](https://github.com/invertase/reeval/commit/2738106146e9e96b07f091297f586433b4d720ba))
* **harness:** broker Antigravity's web search endpoint so its searches land ([#718](https://github.com/invertase/reeval/issues/718)) ([9e6a7af](https://github.com/invertase/reeval/commit/9e6a7af90ab51a4e8805c98cab561cb6f9c1f588))
* **harness:** close the open step before finish when a turn is cut short ([#726](https://github.com/invertase/reeval/issues/726)) ([0ca2a70](https://github.com/invertase/reeval/commit/0ca2a7053449409c67a0d629f226fe5587eec3fa))
* **harness:** make a key the model API rejects in a turn an infra error ([#728](https://github.com/invertase/reeval/issues/728)) ([fda3b46](https://github.com/invertase/reeval/commit/fda3b46460dace322d8ae8e07e0650fa046673cb))
* **harness:** send OpenCode no effort on a model whose API refuses one ([#724](https://github.com/invertase/reeval/issues/724)) ([f17d42f](https://github.com/invertase/reeval/commit/f17d42fff602b1e24b91a987543cb13e6a022c54))
* **install:** install the binary that never ran, not the one the start check ran ([#733](https://github.com/invertase/reeval/issues/733)) ([a1da280](https://github.com/invertase/reeval/commit/a1da2801e4ffde0a2e2a62b6138db6286c82d367))
* **opencode:** keep the image's bootstrap on every provider, so OpenCode isn't reinstalled at each attempt ([#723](https://github.com/invertase/reeval/issues/723)) ([366969f](https://github.com/invertase/reeval/commit/366969fcb6e9508f929db8f2e6debcf3fe7ce0fd))
* stop a canceled capture waiting for chrome, and keep digests whole for short secrets ([#719](https://github.com/invertase/reeval/issues/719)) ([47dbcec](https://github.com/invertase/reeval/commit/47dbcec6959757d327bdc0eb783349551d730cf6))

## [0.17.0](https://github.com/invertase/reeval/compare/v0.16.1...v0.17.0) (2026-10-30)


### Features

* **capture:** end an instruction on the move that completes it, and keep each instruction's screenshot ([#712](https://github.com/invertase/reeval/issues/712)) ([a8ea7b2](https://github.com/invertase/reeval/commit/a8ea7b2df05c771c1549a30b78fd93ade978b6e1))
* **capture:** expose page facts on c.capture() and add toHaveStatus and toHaveNoPageErrors ([#704](https://github.com/invertase/reeval/issues/704)) ([d8349e1](https://github.com/invertase/reeval/commit/d8349e1077c65fe89d68f5fc9dd6b2e18ed5a963))
* **ui:** show the run header as one block on a color terminal ([#713](https://github.com/invertase/reeval/issues/713)) ([06141de](https://github.com/invertase/reeval/commit/06141de39225b30c41169414a499760883115d3a))


### Bug Fixes

* **capture:** read a packed point's missing half from its own field ([#711](https://github.com/invertase/reeval/issues/711)) ([d7fa2d4](https://github.com/invertase/reeval/commit/d7fa2d422b9e96385f67c4c4ce5e425a473ae976))
* **harness:** broker Codex's web search endpoint so its searches land ([#715](https://github.com/invertase/reeval/issues/715)) ([355b5f5](https://github.com/invertase/reeval/commit/355b5f5793349b89dae637a28bce956e035d67cf))
* **harness:** run every harness at medium effort when unset and check Cursor's catalog at plan time ([#714](https://github.com/invertase/reeval/issues/714)) ([ee1d48a](https://github.com/invertase/reeval/commit/ee1d48a68339a314020a58a291d2cdd28639d815))

## [0.16.1](https://github.com/invertase/reeval/compare/v0.16.0...v0.16.1) (2026-10-29)


### Tests

* hold the matcher-line and readTree symlink tests to Windows paths ([#708](https://github.com/invertase/reeval/issues/708)) ([6b06352](https://github.com/invertase/reeval/commit/6b063524c2972560ede3090fcfeadf8dc4c3a211))

## [0.16.0](https://github.com/invertase/reeval/compare/v0.15.1...v0.16.0) (2026-10-29)


### ⚠ BREAKING CHANGES

* **history:** snapshot each attempt's workspace into its run directory ([#700](https://github.com/invertase/reeval/issues/700))
* **expect:** make expect soft by default and add expect.require ([#701](https://github.com/invertase/reeval/issues/701))
* **judge:** make every judge input explicit ([#702](https://github.com/invertase/reeval/issues/702))

### Features

* **capture:** route the page's loopback requests into the sandbox ([#706](https://github.com/invertase/reeval/issues/706)) ([7d4180e](https://github.com/invertase/reeval/commit/7d4180e270b9cb9579aef0676f28d14161a231e2))
* **expect:** make expect soft by default and add expect.require ([#701](https://github.com/invertase/reeval/issues/701)) ([434f1b5](https://github.com/invertase/reeval/commit/434f1b57a7a03d447524a59f6f0f14abeeb8e9dd))
* **history:** snapshot each attempt's workspace into its run directory ([#700](https://github.com/invertase/reeval/issues/700)) ([a5dfc23](https://github.com/invertase/reeval/commit/a5dfc2357c4fd9356ddd5705cc15bb8cd6eca81c))
* **judge:** make every judge input explicit ([#702](https://github.com/invertase/reeval/issues/702)) ([e2e63a5](https://github.com/invertase/reeval/commit/e2e63a525003ddc59f042f70b913f614b8653969))
* **runs:** add runs: { bestOf: n }, stopping each cell once a majority agrees ([#690](https://github.com/invertase/reeval/issues/690)) ([5518351](https://github.com/invertase/reeval/commit/5518351d308f443d330286b05b63a8b795fde105))
* **serve:** find the port c.serve's command listens on and wait for it ([#703](https://github.com/invertase/reeval/issues/703)) ([697b92e](https://github.com/invertase/reeval/commit/697b92e4a511a8af53d0651574c3be8ab0254771))


### Bug Fixes

* **capture:** make interactive c.capture finish ordinary multi-step flows ([#705](https://github.com/invertase/reeval/issues/705)) ([fe8b36a](https://github.com/invertase/reeval/commit/fe8b36adcb71a9f18882024154625da5598f5cc9))
* **expect:** type each matcher to its subject and check an awaited exec at once ([#699](https://github.com/invertase/reeval/issues/699)) ([c7e2238](https://github.com/invertase/reeval/commit/c7e2238579360b920db018979c8c4789965c4d41))
* **fx:** bind the relay test to port 0 and wait for the port it listens on ([#693](https://github.com/invertase/reeval/issues/693)) ([a8ac5d3](https://github.com/invertase/reeval/commit/a8ac5d3e9c5bd981349200ec6314797d6f9dc07c))

## [0.15.1](https://github.com/invertase/reeval/compare/v0.15.0...v0.15.1) (2026-10-27)


### Bug Fixes

* **pi:** link the fake bootstrap with a junction so the gateway tests run on Windows ([#691](https://github.com/invertase/reeval/issues/691)) ([055574b](https://github.com/invertase/reeval/commit/055574b41b25b21971302ef303b7f540963ed337))

## [0.15.0](https://github.com/invertase/reeval/compare/v0.14.0...v0.15.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **plan:** run a compare 4 times a side when runs is unset ([#687](https://github.com/invertase/reeval/issues/687))
* **gateway:** end every gateway list with direct(), with direct({ enabled: false }) for strict routing ([#676](https://github.com/invertase/reeval/issues/676))
* **expect:** fail the attempt on a caught failed expect ([#684](https://github.com/invertase/reeval/issues/684))
* spring clean: remove insights, single-source option docs and trim slow or duplicate tests ([#667](https://github.com/invertase/reeval/issues/667))
* **history:** fingerprint an eval's body, options, cases and revision ([#664](https://github.com/invertase/reeval/issues/664))

### Features

* **doctor:** check vertex() models online, with a Vertex example and recipe ([#674](https://github.com/invertase/reeval/issues/674)) ([bc75f37](https://github.com/invertase/reeval/commit/bc75f371c787e7dee72ad844aedd532d3680b032))
* **gateway:** accept the Anthropic API's dated Claude ids on Vertex AI ([#672](https://github.com/invertase/reeval/issues/672)) ([47958ee](https://github.com/invertase/reeval/commit/47958ee424c2d1e4f5631bead0d630b918ca0b77))
* **gateway:** add openrouter() routing gateway ([#547](https://github.com/invertase/reeval/issues/547)) ([0778bbc](https://github.com/invertase/reeval/commit/0778bbc43343c41d0a506df7721c09530aa1eefa))
* **gateway:** end every gateway list with direct(), with direct({ enabled: false }) for strict routing ([#676](https://github.com/invertase/reeval/issues/676)) ([be3c673](https://github.com/invertase/reeval/commit/be3c67300cc3cd5e88425d1b9f1bd8266d7cd3e5))
* **gateway:** run Antigravity, OpenCode, Goose and pi on Vertex AI ([#673](https://github.com/invertase/reeval/issues/673)) ([4d0e7c9](https://github.com/invertase/reeval/commit/4d0e7c9823fa49b9ce667a0ac22d88cbfce7ec1e))
* **gateway:** run fx on openrouter() ([#680](https://github.com/invertase/reeval/issues/680)) ([9c3b3b6](https://github.com/invertase/reeval/commit/9c3b3b6a7b3cce784f071752f77d34fa569ff6d2))
* **gateway:** run fx on Vertex AI ([#686](https://github.com/invertase/reeval/issues/686)) ([238abff](https://github.com/invertase/reeval/commit/238abff73c4e140b1cdd64f0bba813dbf1bd67af))
* **gateway:** run Grok Build on Vertex AI ([#675](https://github.com/invertase/reeval/issues/675)) ([31a8cd2](https://github.com/invertase/reeval/commit/31a8cd22085ab08260e9b1c1783248cc2f2c2484))
* **gateway:** run pi on openrouter() ([#679](https://github.com/invertase/reeval/issues/679)) ([1830a9b](https://github.com/invertase/reeval/commit/1830a9b1509fb31271d6d9ba8c627adad2d09412))
* **gateway:** run pi on vercel() and send effort through gateways where the model reads it ([#671](https://github.com/invertase/reeval/issues/671)) ([52280a5](https://github.com/invertase/reeval/commit/52280a5d983e9e9e7944c2914d54d1adee037434))
* **gateway:** vertex(), with Claude Code, judges and analysis on Vertex AI ([#505](https://github.com/invertase/reeval/issues/505)) ([b0c3690](https://github.com/invertase/reeval/commit/b0c3690f1e1f8881b63f63d2e0ce2600afc345de))
* **history:** fingerprint an eval's body, options, cases and revision ([#664](https://github.com/invertase/reeval/issues/664)) ([fdb040b](https://github.com/invertase/reeval/commit/fdb040b90c9b6aeceb6f961e094e9e3ba4cfa6dc))
* **plan:** hint the compares and families that can't get a verdict ([#685](https://github.com/invertase/reeval/issues/685)) ([b478ba9](https://github.com/invertase/reeval/commit/b478ba9acada151f23a8c6782df2c0e91b148fea))
* **plan:** run a compare 4 times a side when runs is unset ([#687](https://github.com/invertase/reeval/issues/687)) ([74df7c8](https://github.com/invertase/reeval/commit/74df7c834982c451ce5ffb1191f822a2289db4e5))
* **query:** name a mixed cell below the flaky minimum mixed ([#681](https://github.com/invertase/reeval/issues/681)) ([d3a1e78](https://github.com/invertase/reeval/commit/d3a1e78850da7a757e4ffb0cf10ed5d6614740c5))


### Bug Fixes

* accept files saved with a UTF-8 BOM wherever reeval reads user JSON, frontmatter or .env ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **attempt:** keep assertion labels unique when a given label looks numbered ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **attempt:** record a judge error only when a judge caused the failure ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **capture:** accept only capture names the studio can serve ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **cli:** check the keys of group and eval judges before the run ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **cli:** switch out of cancel mode as live.json turns finishing ([#548](https://github.com/invertase/reeval/issues/548)) ([e84168a](https://github.com/invertase/reeval/commit/e84168a1d41959337e0a61f4e2f85a3944f3b0cc))
* **diff:** keep changed paths as written and count hunk lines that start with -- or ++ ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **engine:** exit a worker at once when the CLI goes while its file is loading ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **engine:** fail a file's attempts when it fails to load in the run pass ([af665de](https://github.com/invertase/reeval/commit/af665deea97ab74c52c0b6eb28e90216e60280ff))
* **engine:** let a filter part that names a file also match names and cells ([6f763ad](https://github.com/invertase/reeval/commit/6f763adafde05847afe5359770d2a1186e224b8c))
* **engine:** run up to concurrency eval files at once, not one per cpu ([6f763ad](https://github.com/invertase/reeval/commit/6f763adafde05847afe5359770d2a1186e224b8c))
* **engine:** skip .only evals inside a skipped group in the plan ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **environment:** refuse a password or token in skill and npm source URLs ([af665de](https://github.com/invertase/reeval/commit/af665deea97ab74c52c0b6eb28e90216e60280ff))
* **evaluate:** refuse evals and pooled families that would share an id ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **expect:** fail the attempt on a caught failed expect ([#684](https://github.com/invertase/reeval/issues/684)) ([68c3447](https://github.com/invertase/reeval/commit/68c344752a0800598d3240cd93c7a0911d4fd25f))
* **harness:** record writes of unknown origin as write, not modify ([6f763ad](https://github.com/invertase/reeval/commit/6f763adafde05847afe5359770d2a1186e224b8c))
* **harness:** refuse MCP names and values opencode would substitute ([6f763ad](https://github.com/invertase/reeval/commit/6f763adafde05847afe5359770d2a1186e224b8c))
* **history:** claim a run before writeRun touches its artifact directory ([#559](https://github.com/invertase/reeval/issues/559)) ([4514416](https://github.com/invertase/reeval/commit/4514416f1ad4ef91a2d0e873cde7bc34b4f0e2e3))
* **history:** compare pooled-family gates and fail on their regressions ([#562](https://github.com/invertase/reeval/issues/562)) ([d229233](https://github.com/invertase/reeval/commit/d229233e7b33d6845e2f704701a1aa785cc98594))
* **history:** count attempts with no tool calls in effort's per-class medians ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **history:** count gateway changes as drift, not noise ([#560](https://github.com/invertase/reeval/issues/560)) ([bd7a243](https://github.com/invertase/reeval/commit/bd7a24316d50d7d65cd024c2826956eefa223211))
* **history:** keep each failed attempt's artifacts with artifacts 'failures' ([#561](https://github.com/invertase/reeval/issues/561)) ([6c4ce39](https://github.com/invertase/reeval/commit/6c4ce39241603ef7e1e64e873845e7c6c699d7a5))
* **history:** keep minLift, provenance and pairwise answers on resume ([#563](https://github.com/invertase/reeval/issues/563)) ([00b74e8](https://github.com/invertase/reeval/commit/00b74e8f7ff27b561d88a0be3f6fd9c9754d55d9))
* **history:** key environments and env_skills on name and digest ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **history:** name a gate change in compare instead of calling it a regression ([#565](https://github.com/invertase/reeval/issues/565)) ([6239b12](https://github.com/invertase/reeval/commit/6239b121620b125afbaf76136f38fe4cd8308b4e))
* **history:** settle run commits past rev-list's 20,000 with merge-base ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **judge:** grade a language runner's judge on value as the value itself ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **judge:** mask the judge's input before it's sent ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **judge:** number judgement keys by call order, not completion order ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **pi:** carry a turn on through the run pi continues after compacting ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **pi:** keep a turn pi recovered by auto-retry ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **profiles:** refuse a limit.harness id no eval runs on ([6f763ad](https://github.com/invertase/reeval/commit/6f763adafde05847afe5359770d2a1186e224b8c))
* **profiles:** turn compare off when limit.harness drops every compared harness ([6f763ad](https://github.com/invertase/reeval/commit/6f763adafde05847afe5359770d2a1186e224b8c))
* **python:** fail a call that passes NaN or Infinity instead of hanging reeval ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **python:** read REEVAL_VERSION in pep 440 spelling as reeval's version ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **python:** register each eval file's module in sys.modules while it loads ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **redact:** mask a second key of the same provider whole ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **redact:** mask a secret that spans several stream chunks in the trace and raw transcript ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **redact:** mask a token that follows a letter, digit or underscore ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **redact:** mask only JSON strings so records stay valid ([#564](https://github.com/invertase/reeval/issues/564)) ([6226b29](https://github.com/invertase/reeval/commit/6226b29ace255e7b736e9df50f051fb58227a259))
* **redact:** mask text before it's shortened ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **redact:** mask xai-, vck_ and other distinctive credential prefixes ([6f763ad](https://github.com/invertase/reeval/commit/6f763adafde05847afe5359770d2a1186e224b8c))
* refuse durations above 596h, the longest timer Node can set ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **sandbox:** answer 400 to a gateway request with a port outside 1-65535 ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **sandbox:** hash every file a .dockerignore re-include sends ([#624](https://github.com/invertase/reeval/issues/624)) ([668bc0d](https://github.com/invertase/reeval/commit/668bc0dc10416ca9759e338557644a2657d4f445))
* **sandbox:** note processes setup leaves running with a checks-only secret ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **sandbox:** substitute placeholders in websocket control frames ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **secrets:** don't broker http:// MCP header secrets, and serve plain HTTP in a CONNECT to a brokered host ([af665de](https://github.com/invertase/reeval/commit/af665deea97ab74c52c0b6eb28e90216e60280ff))
* **secrets:** record secret.template variables and name header secrets by host variable ([af665de](https://github.com/invertase/reeval/commit/af665deea97ab74c52c0b6eb28e90216e60280ff))
* **secrets:** warn on credential-like MCP headers written as plain strings ([af665de](https://github.com/invertase/reeval/commit/af665deea97ab74c52c0b6eb28e90216e60280ff))
* **studio:** serve nothing through a symlinked run directory ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))
* **studio:** show a resumed run's kept attempts with their outcome in live progress ([aefe0c6](https://github.com/invertase/reeval/commit/aefe0c645aeffff7e64e1c5c05f42f11666b5277))


### Code Refactoring

* spring clean: remove insights, single-source option docs and trim slow or duplicate tests ([#667](https://github.com/invertase/reeval/issues/667)) ([46a5000](https://github.com/invertase/reeval/commit/46a5000cc3f1037897cec89366177eade9876a3f))

## [0.14.0](https://github.com/invertase/reeval/compare/v0.13.0...v0.14.0) (2026-10-24)


### ⚠ BREAKING CHANGES

* move questions to the eval's root and ask them of each attempt ([#543](https://github.com/invertase/reeval/issues/543))
* **gateway:** vercel() for Claude Code and Codex, and gateway-routed judges ([#503](https://github.com/invertase/reeval/issues/503))
* **egress:** default to 'proxy', which sends everything through the egress gateway ([#501](https://github.com/invertase/reeval/issues/501))

### Features

* **checks:** retry c.exec on a non-zero exit with retries and interval ([#542](https://github.com/invertase/reeval/issues/542)) ([311cd92](https://github.com/invertase/reeval/commit/311cd92eb7b0afc68413cefbe58eedebace6a58d))
* **cli:** estimate cost as a range in reeval run --dry-run ([#519](https://github.com/invertase/reeval/issues/519)) ([4e18100](https://github.com/invertase/reeval/commit/4e181008384fa8b6ceaf991d2e657e51699c5dc0))
* **egress:** default to 'proxy', which sends everything through the egress gateway ([#501](https://github.com/invertase/reeval/issues/501)) ([0cc02cb](https://github.com/invertase/reeval/commit/0cc02cbd66d5092b4072346e474728db3cd52f9b))
* **gateway:** add the gateway list with direct(), plan-time resolution and pins ([#502](https://github.com/invertase/reeval/issues/502)) ([22e4d5a](https://github.com/invertase/reeval/commit/22e4d5abcb6a918082562956bf58573c57e73a80))
* **gateway:** run Goose, OpenCode, fx and Grok Build on Vercel AI Gateway ([#504](https://github.com/invertase/reeval/issues/504)) ([4d89bed](https://github.com/invertase/reeval/commit/4d89bed31ec5c35e8d2a086679381220ef1ca012))
* **gateway:** vercel() for Claude Code and Codex, and gateway-routed judges ([#503](https://github.com/invertase/reeval/issues/503)) ([9128d66](https://github.com/invertase/reeval/commit/9128d6620a18ef8c9864aca285c44d2e124c4598))
* **language-runner:** add a record call for checks made in the eval's own language ([#511](https://github.com/invertase/reeval/issues/511)) ([c0dfacf](https://github.com/invertase/reeval/commit/c0dfacf39af022ed3d3292d63f3c7a14c244c585))
* move questions to the eval's root and ask them of each attempt ([#543](https://github.com/invertase/reeval/issues/543)) ([c5f0ab7](https://github.com/invertase/reeval/commit/c5f0ab7cfecc035b4d04f14514390371dea34ef8))


### Bug Fixes

* **engine:** keep a worker up until the main process has its last message ([#524](https://github.com/invertase/reeval/issues/524)) ([cfa2fd5](https://github.com/invertase/reeval/commit/cfa2fd569c391f8b9242217959278b5bc4da1eff))
* **install:** detect musl from the libc in use ([#522](https://github.com/invertase/reeval/issues/522)) ([d9990e1](https://github.com/invertase/reeval/commit/d9990e1b7e625b339cfd3201438748bf55954e77))
* **install:** keep the user PATH REG_EXPAND_SZ on Windows ([#523](https://github.com/invertase/reeval/issues/523)) ([a12473b](https://github.com/invertase/reeval/commit/a12473bac68bec6d1be5630a18a88ece25046e7d))
* **judge:** explain decision-model refusals, follow the attempt's judge in captures and scale Gemini clicks ([#544](https://github.com/invertase/reeval/issues/544)) ([d2f9bc9](https://github.com/invertase/reeval/commit/d2f9bc9e5a2308a42c7eac2ae6e4f259d3add5d1))
* **language-runner:** keep a remote body's checks in its attempt record ([#507](https://github.com/invertase/reeval/issues/507)) ([9f094e0](https://github.com/invertase/reeval/commit/9f094e0241ba2ee19fab0f9d12248833de63c8f8))
* **python:** name the wire types' schema sources with POSIX paths on every host ([#528](https://github.com/invertase/reeval/issues/528)) ([eee7c3d](https://github.com/invertase/reeval/commit/eee7c3d305a1cf3058e2f1299157646433214942))
* **ui:** count a study as not gated, never pass ([#541](https://github.com/invertase/reeval/issues/541)) ([c2442eb](https://github.com/invertase/reeval/commit/c2442eb247898c0f8b2d4552bafa6519a6c98b9f))
* **usage:** count reasoning tokens once, as part of output ([#525](https://github.com/invertase/reeval/issues/525)) ([4029d3d](https://github.com/invertase/reeval/commit/4029d3d6cbe5e4bf7672153a563716b04ffb2771))

## [0.13.0](https://github.com/invertase/reeval/compare/v0.12.0...v0.13.0) (2026-10-23)


### Features

* **judge:** call Anthropic and OpenAI models directly ([#481](https://github.com/invertase/reeval/issues/481)) ([06529de](https://github.com/invertase/reeval/commit/06529de9b4c9ca2a8ca4858e54ba112640ab4d9c))
* **skills:** add setup skill ([#464](https://github.com/invertase/reeval/issues/464)) ([a8398c9](https://github.com/invertase/reeval/commit/a8398c968e9e772135be611f84526be7682ee628))
* **workspace:** add a PR-lift recipe and flag compare arms that run one tree ([#485](https://github.com/invertase/reeval/issues/485)) ([10c1f05](https://github.com/invertase/reeval/commit/10c1f05d62bb08a9fe941afa5bbd121bde89ac98))


### Bug Fixes

* **harness:** count Antigravity tokens per turn, not agy's running total ([#495](https://github.com/invertase/reeval/issues/495)) ([3f02ff0](https://github.com/invertase/reeval/commit/3f02ff0d54780df8171c9548f2866750676ec8c7))
* **harness:** count Codex tokens per turn, not the thread's running total ([#496](https://github.com/invertase/reeval/issues/496)) ([b032421](https://github.com/invertase/reeval/commit/b0324217f01a8cff39a2e5fb80ec57b2e4dda75d))
* **harness:** count Cursor cache reads once in token usage ([#487](https://github.com/invertase/reeval/issues/487)) ([f087172](https://github.com/invertase/reeval/commit/f087172d3132144484d48c0dcdf6393755bfedc3))
* **harness:** map the tools and subagent calls the nightly contract caught ([#469](https://github.com/invertase/reeval/issues/469)) ([246a78d](https://github.com/invertase/reeval/commit/246a78d8e71d8b12b99ec7d3d16775fe43ece981))
* **judge:** stop sending temperature to Anthropic models ([#475](https://github.com/invertase/reeval/issues/475)) ([7f1dcba](https://github.com/invertase/reeval/commit/7f1dcbacae4e95a3e08bd5f8e566b2d3c34e2c1f))
* **run:** name the planned sandbox in the run header and record ([#484](https://github.com/invertase/reeval/issues/484)) ([0468d63](https://github.com/invertase/reeval/commit/0468d632565eaa3cfcada05fbd2dc33f2182a881))
* **sandbox:** forward absolute-form https requests through the egress gateway ([#479](https://github.com/invertase/reeval/issues/479)) ([17ad0de](https://github.com/invertase/reeval/commit/17ad0de3147e2952f9eb7f2e133d8ba3b3bd9d97))
* **sandbox:** refuse private addresses under allow-all and harden the gateway ([#490](https://github.com/invertase/reeval/issues/490)) ([93ac6a3](https://github.com/invertase/reeval/commit/93ac6a3b79d160751412775d39fd27508ba8b63c))
* **sandbox:** run privileged execs without --privileged ([#489](https://github.com/invertase/reeval/issues/489)) ([08240ac](https://github.com/invertase/reeval/commit/08240ac02d05fd2423fd0879581ba5de8868e870))
* **sandbox:** stop empty file writes hanging docker exec, and fail stuck fixtures fast ([#493](https://github.com/invertase/reeval/issues/493)) ([8682621](https://github.com/invertase/reeval/commit/86826216d69771f20a1a7edb80090e6ab10cd2fd))
* **stats:** use one minimum of 4 attempts across views ([#477](https://github.com/invertase/reeval/issues/477)) ([b55cff9](https://github.com/invertase/reeval/commit/b55cff9a0253eff5e754ebb77f2f6ce92aacaa2e))

## [0.12.0](https://github.com/invertase/reeval/compare/v0.11.0...v0.12.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **insights:** classify and explain each eval at the end of reeval run ([#451](https://github.com/invertase/reeval/issues/451))
* **cli:** scaffold an environment, add --bare and a docker check to init ([#444](https://github.com/invertase/reeval/issues/444))
* **compare:** print reeval compare as the catch-regressions layout ([#425](https://github.com/invertase/reeval/issues/425))

### Features

* **cli:** scaffold an environment, add --bare and a docker check to init ([#444](https://github.com/invertase/reeval/issues/444)) ([3f97710](https://github.com/invertase/reeval/commit/3f97710cf255120745c8000bd8349fe5113af7bc))
* **compare:** print reeval compare as the catch-regressions layout ([#425](https://github.com/invertase/reeval/issues/425)) ([185eb94](https://github.com/invertase/reeval/commit/185eb943c5d65d2475ca9394a4ac5bf2e4454b91))
* **environment:** plugin builds ([#437](https://github.com/invertase/reeval/issues/437)) ([7f9e255](https://github.com/invertase/reeval/commit/7f9e255e152f47d944b9af1ecced7597a3aa2bcd))
* **environment:** plugins input ([#435](https://github.com/invertase/reeval/issues/435)) ([9186e05](https://github.com/invertase/reeval/commit/9186e051f2a3603411186e72db5148c8dd66a8a8))
* **harness:** plugins on Claude Code and Grok Build ([#439](https://github.com/invertase/reeval/issues/439)) ([687e5a8](https://github.com/invertase/reeval/commit/687e5a8897a1ecdd61e7c5930185e91c563a24a6))
* **init:** set analysis.model in the generated config, warn in doctor when it's unset, and document insights and remarks ([#459](https://github.com/invertase/reeval/issues/459)) ([f4e5d1f](https://github.com/invertase/reeval/commit/f4e5d1f8e6a366e3ee9e537596c55353c27123e9))
* **insights:** classify and explain each eval at the end of reeval run ([#451](https://github.com/invertase/reeval/issues/451)) ([5c21e46](https://github.com/invertase/reeval/commit/5c21e462a968dae7c8af4d41e382ac7e882d3d46))
* **insights:** write a recorded run's insights with reeval analyze --insights, and print them in reeval show ([#426](https://github.com/invertase/reeval/issues/426)) ([cfcd501](https://github.com/invertase/reeval/commit/cfcd501824f75e6cd6e0bcd2f4047dd09c73323b))
* **mcp:** time server start-up ([#434](https://github.com/invertase/reeval/issues/434)) ([1361bae](https://github.com/invertase/reeval/commit/1361baec822c17e2dbe2e7cbf8ae4e94e05772cb))
* **plugins:** plugin.marketplace, and plugins on Codex, Goose, Antigravity, Cursor, OpenCode, pi and fx ([#455](https://github.com/invertase/reeval/issues/455)) ([f0d9a9a](https://github.com/invertase/reeval/commit/f0d9a9a6f4b2558d3bada21950ebb536205a5354))
* **remarks:** end reeval run with deterministic remarks on the evals themselves ([#450](https://github.com/invertase/reeval/issues/450)) ([7aa8b27](https://github.com/invertase/reeval/commit/7aa8b2783ebb101b3c3b41b6a7277720319178b5))
* **remarks:** raise model remarks behind kind and quote gates, with the eval rubric, a flaky insight tier and a one-line skip ([#460](https://github.com/invertase/reeval/issues/460)) ([bd4ea8a](https://github.com/invertase/reeval/commit/bd4ea8a7ffbda4db4def98fd081e0aa71db7420c))
* **test:** enforce plan-case tier for eval options in CI ([#376](https://github.com/invertase/reeval/issues/376)) ([d0dade0](https://github.com/invertase/reeval/commit/d0dade00ebc0d69031a44cf9d6de9545a7bc0aa2))


### Bug Fixes

* **claude-code:** turn off AskUserQuestion so the next turn can start ([#466](https://github.com/invertase/reeval/issues/466)) ([25247be](https://github.com/invertase/reeval/commit/25247be68170ff5e02d4f90e7104623251a153c5))
* **cursor:** default fast to false so unpinned Cursor runs are standard-priced ([#467](https://github.com/invertase/reeval/issues/467)) ([0f3be6a](https://github.com/invertase/reeval/commit/0f3be6ac5cea190b2262f73ae44ee5889047fe89))
* **history:** serialize concurrent history.db syncs with begin immediate ([#452](https://github.com/invertase/reeval/issues/452)) ([74ae40b](https://github.com/invertase/reeval/commit/74ae40bae2f32393ad2cf648c51784f6afb37f6b))
* **insights:** refuse a headline that says all of a single result ([#465](https://github.com/invertase/reeval/issues/465)) ([f87d643](https://github.com/invertase/reeval/commit/f87d643e878b4feedc69f77657fe518707962d02))
* **release:** open a release PR per package so a reeval-only release tags ([#432](https://github.com/invertase/reeval/issues/432)) ([3464ff6](https://github.com/invertase/reeval/commit/3464ff6d53e094200e5d18383f62a83c557dbc1d))
* **remarks:** count a remark as seen only in a run that printed it, and find the default branch in ci ([#457](https://github.com/invertase/reeval/issues/457)) ([04d117c](https://github.com/invertase/reeval/commit/04d117c8e2ea8a69553dff8a821d8b1ede870567))
* **results:** fence summary.md blocks past any backticks they carry ([#454](https://github.com/invertase/reeval/issues/454)) ([99fa22b](https://github.com/invertase/reeval/commit/99fa22b7e4a32dec3c72bb8598c988faff15508d))
* **sandbox:** keep the diff's snapshot unreadable and free of pre-seed content ([#438](https://github.com/invertase/reeval/issues/438)) ([96129ee](https://github.com/invertase/reeval/commit/96129eeb76274aa79af9ac548a5369e99cb53053))
* **sandbox:** run every exec with umask 022 ([#456](https://github.com/invertase/reeval/issues/456)) ([cebf376](https://github.com/invertase/reeval/commit/cebf376eaecfe4b07f9d8a0d54561507a873376a))
* **stats:** mcnemar overflow, family rank ties, effort test direction and tied floor ([#463](https://github.com/invertase/reeval/issues/463)) ([7838776](https://github.com/invertase/reeval/commit/78387769dd56684f15139b44eabe199adf75b9a8))
* **view:** make SuiteResult agree with the exit code and list every check ([#430](https://github.com/invertase/reeval/issues/430)) ([243ad7b](https://github.com/invertase/reeval/commit/243ad7bfd7f17f34fe4631f404afd5548f33f007))

## [0.11.0](https://github.com/invertase/reeval/compare/v0.10.0...v0.11.0) (2026-10-21)


### ⚠ BREAKING CHANGES

* **ui:** print result layouts by what each eval varies ([#424](https://github.com/invertase/reeval/issues/424))

### Features

* **query:** --run &lt;id|last&gt;, tables in the unknown-name error, documented join keys ([#418](https://github.com/invertase/reeval/issues/418)) ([2e20c1b](https://github.com/invertase/reeval/commit/2e20c1bd964c01e192435d8ee4cc11b7927208d8))
* **query:** add a check_rates view ([#420](https://github.com/invertase/reeval/issues/420)) ([30d0e34](https://github.com/invertase/reeval/commit/30d0e34c4f469672122ae92d896d7f12d6c4e17c))
* **ui:** print result layouts by what each eval varies ([#424](https://github.com/invertase/reeval/issues/424)) ([02e3770](https://github.com/invertase/reeval/commit/02e3770d27ceef733924bfdc772c9d48d4cce8f5))
* **view:** add suiteResult facts view-model and reeval run --json ([#416](https://github.com/invertase/reeval/issues/416)) ([eb77e9f](https://github.com/invertase/reeval/commit/eb77e9fdd25518a84879cab09b32a10c35a12e62))


### Bug Fixes

* not-run checks, sub-50 ms durations and the --output-logs default ([#421](https://github.com/invertase/reeval/issues/421)) ([5e1c589](https://github.com/invertase/reeval/commit/5e1c5897662ffd8987bd7d132280b3143f946d79))
* **plan:** estimate sandbox setup for a fake harness on a real sandbox ([#412](https://github.com/invertase/reeval/issues/412)) ([e37d900](https://github.com/invertase/reeval/commit/e37d9008aa4cb98b7a8c8b3dc9363a5bd16415da))
* **profiles:** gate the lone control when limit turns compare off ([#413](https://github.com/invertase/reeval/issues/413)) ([aed5fb9](https://github.com/invertase/reeval/commit/aed5fb91fbab2f904bc0c5d3b4fcc1be8079a4ba))
* **query:** accept SQL that starts with a -- comment ([#414](https://github.com/invertase/reeval/issues/414)) ([5acb488](https://github.com/invertase/reeval/commit/5acb488342e4d43d831bd24b1590d7bc8520d8f4))
* **release:** PyPI publish tag and npm republish skip ([#423](https://github.com/invertase/reeval/issues/423)) ([627534e](https://github.com/invertase/reeval/commit/627534eb2c956cba880f2a85dc9f9d222347e6b7))
* **release:** use release ref for PyPI publish action ([#422](https://github.com/invertase/reeval/issues/422)) ([62847d6](https://github.com/invertase/reeval/commit/62847d6f649036885ff9ce25656c82a5e35afa6a))
* **test:** forward-slash path deps for python fixtures on Windows ([#411](https://github.com/invertase/reeval/issues/411)) ([15f0e8c](https://github.com/invertase/reeval/commit/15f0e8cddfe39f8fa7a5910a8b72fbb06b99a90d))

## [0.10.0](https://github.com/invertase/reeval/compare/v0.9.0...v0.10.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* **sdk:** start the sandbox on first use and remove c.sandbox() ([#344](https://github.com/invertase/reeval/issues/344))
* **judge:** choose what the judge is given with state ([#334](https://github.com/invertase/reeval/issues/334))
* drop leftover es names ([#332](https://github.com/invertase/reeval/issues/332))

### Features

* actionable insight for skill studies (analysis, effort, contrasts, compare pairs) ([#336](https://github.com/invertase/reeval/issues/336)) ([31b1743](https://github.com/invertase/reeval/commit/31b1743b906d8e35bf8ab8c3e49a87f00984d37f))
* **compare:** let questions choose what each side shows ([#363](https://github.com/invertase/reeval/issues/363)) ([01a9a68](https://github.com/invertase/reeval/commit/01a9a6840fe5efb6c7ce1f6741d751278ce15866))
* **compare:** save what each question's model saw ([#367](https://github.com/invertase/reeval/issues/367)) ([79f5710](https://github.com/invertase/reeval/commit/79f5710fd2bde10fcf4af18d3b3b74279be72d8f))
* **compare:** set the question model from the question option ([#366](https://github.com/invertase/reeval/issues/366)) ([1ca53dd](https://github.com/invertase/reeval/commit/1ca53dd9afa771bf4fb04b6f1b58f37f42a1cd70))
* **config:** add reeval.yaml and a config contract ([#342](https://github.com/invertase/reeval/issues/342)) ([462948d](https://github.com/invertase/reeval/commit/462948dcd4f7733858ad05e58f8d0d8add2f6194))
* **config:** one relative path rule for typescript and reeval.yaml ([#350](https://github.com/invertase/reeval/issues/350)) ([981a309](https://github.com/invertase/reeval/commit/981a309909f43bc31230f1176b9bcef1d33e2dc2))
* **config:** resolve reeval.yaml paths against its directory ([#345](https://github.com/invertase/reeval/issues/345)) ([ac97e17](https://github.com/invertase/reeval/commit/ac97e179020cf0af5493c0e234a262557f01de0b))
* **contract:** add background processes, capture and expect.poll to the attempt protocol ([#343](https://github.com/invertase/reeval/issues/343)) ([bfbda40](https://github.com/invertase/reeval/commit/bfbda4052c3c76515aa7d20648d56e79d346c083))
* **contract:** add c.judge to the attempt protocol ([#340](https://github.com/invertase/reeval/issues/340)) ([6888159](https://github.com/invertase/reeval/commit/6888159ff458baad77c2c72f9305e7ed1fd88b45))
* **contract:** add the attempt lifecycle messages to the protocol ([#341](https://github.com/invertase/reeval/issues/341)) ([5b74b94](https://github.com/invertase/reeval/commit/5b74b942f4465e1999269228707ff19ce7623ccd))
* **contract:** the declaration tree and attempt protocol as zod contracts ([#337](https://github.com/invertase/reeval/issues/337)) ([49661d5](https://github.com/invertase/reeval/commit/49661d578a3d09df765e4f2ef5fce030828d47a8))
* **contract:** validate the SDK-facing plain data against zod contracts ([#335](https://github.com/invertase/reeval/issues/335)) ([7b64f17](https://github.com/invertase/reeval/commit/7b64f17a1a9a2102faa752d026ef8d2b74c9ea73))
* **harness:** add an fx harness on AI Gateway or OpenAI over fx acp ([#372](https://github.com/invertase/reeval/issues/372)) ([2ed7226](https://github.com/invertase/reeval/commit/2ed722615fbf7e1019649b60642b186df26edd68))
* **harness:** add grokBuild() for xAI's Grok Build on an xAI API key ([#373](https://github.com/invertase/reeval/issues/373)) ([310e471](https://github.com/invertase/reeval/commit/310e471bd56133ee08d8775e40d2110bee909485))
* **harness:** surface stalled Cursor shell tools; docs for contributing agents ([#377](https://github.com/invertase/reeval/issues/377)) ([ff18bc9](https://github.com/invertase/reeval/commit/ff18bc91946cece342438883bfb87cb42ac57d7c))
* **judge:** check the judge options against a zod contract ([#339](https://github.com/invertase/reeval/issues/339)) ([6e82595](https://github.com/invertase/reeval/commit/6e82595c23e30c4d718c73e58a53924f20c2588b))
* **judge:** choose what the judge is given with state ([#334](https://github.com/invertase/reeval/issues/334)) ([16b9a97](https://github.com/invertase/reeval/commit/16b9a97e76353390091f3d0063c164683c4b51c5))
* **language-runner:** LanguageAdapter with Python eval SDK ([#380](https://github.com/invertase/reeval/issues/380)) ([a15d9cb](https://github.com/invertase/reeval/commit/a15d9cb917843532c3a127f2f8c024eba59fa966))
* **mcp:** add a failures tool and point debugging agents at it ([#371](https://github.com/invertase/reeval/issues/371)) ([349f940](https://github.com/invertase/reeval/commit/349f940962c972af0e1953e40b9877ed7d5e0473))
* **sandbox:** add podman() sandbox support ([#381](https://github.com/invertase/reeval/issues/381)) ([6e3d349](https://github.com/invertase/reeval/commit/6e3d3495ffa86165aba140e18d133bdd66e95372))
* **sdk:** start the sandbox on first use and remove c.sandbox() ([#344](https://github.com/invertase/reeval/issues/344)) ([7005df7](https://github.com/invertase/reeval/commit/7005df7f8b5dc61fb1c810a0bf1d1c95284db336))


### Bug Fixes

* **capture:** wait for the network to go quiet on a journey's idle beat ([#322](https://github.com/invertase/reeval/issues/322)) ([bfd4756](https://github.com/invertase/reeval/commit/bfd4756281ca8768268795eaeffcb14b3c615097))
* clearer error messages ([#355](https://github.com/invertase/reeval/issues/355)) ([acc63a7](https://github.com/invertase/reeval/commit/acc63a72c1de333c2b63f8ddf5ba3916690f02bf))
* **exec:** group background commands before redirecting ([#362](https://github.com/invertase/reeval/issues/362)) ([ec4720a](https://github.com/invertase/reeval/commit/ec4720a84112a24e1017db9cd1d98a81d2ac1ef8))
* **exec:** stop compound background commands on windows ([#365](https://github.com/invertase/reeval/issues/365)) ([d296c33](https://github.com/invertase/reeval/commit/d296c3333240dbe272456df8c23bad6cfe975a06))
* friction-log fixes for image inspect, doctor images, eval marks, fake brokering and skill.git ([#383](https://github.com/invertase/reeval/issues/383)) ([70e96fe](https://github.com/invertase/reeval/commit/70e96fe31cbbb1ecd073cecba12e7cabd690dfbe))
* **history:** read glob words with an unbalanced [ literally in tool-call classes ([#375](https://github.com/invertase/reeval/issues/375)) ([21726d1](https://github.com/invertase/reeval/commit/21726d1984fc7f95590d2db9e7f976a5eeb7a807))
* papercuts from the Genkit friction log, and move the reeval skill to skills/ ([#382](https://github.com/invertase/reeval/issues/382)) ([a77755e](https://github.com/invertase/reeval/commit/a77755e237bcbae8afc743e1059dcd61987d4e23))
* **plan:** resolve relative paths in declaration trees ([#360](https://github.com/invertase/reeval/issues/360)) ([6117fb9](https://github.com/invertase/reeval/commit/6117fb9eaa2782995aee04cc724f4725f16bd615))
* **test:** normalise windows paths in refusal goldens ([#357](https://github.com/invertase/reeval/issues/357)) ([434e3af](https://github.com/invertase/reeval/commit/434e3af5f7d12604cffb28c2d80fa4a1e37f0a98))


### Code Refactoring

* drop leftover es names ([#332](https://github.com/invertase/reeval/issues/332)) ([0999c19](https://github.com/invertase/reeval/commit/0999c190e380e2f8046b5b285b3c99753a513f04))

## [0.9.0](https://github.com/invertase/reeval/compare/v0.8.0...v0.9.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* rename evaluate.for to evaluate.each and pool results across cases ([#318](https://github.com/invertase/reeval/issues/318))

### Features

* add c.writeFile for files placed after the agent's turn ([#317](https://github.com/invertase/reeval/issues/317)) ([8792175](https://github.com/invertase/reeval/commit/8792175405ca0e872c70ff08ec9e707882e73441))
* **assert:** add toHaveChanged, a matcher on the workspace diff ([#314](https://github.com/invertase/reeval/issues/314)) ([206276c](https://github.com/invertase/reeval/commit/206276c60f95b16a40f4feeeadeb80fed0a8f12a))
* **checks:** record named check results and flag checks that don't discriminate ([#319](https://github.com/invertase/reeval/issues/319)) ([1f41ecb](https://github.com/invertase/reeval/commit/1f41ecba4794389ccee966afa476dac6046b7ce3))
* **history:** name pass@1 in the summary, query and studio, and pass^k for gate 'all' ([#315](https://github.com/invertase/reeval/issues/315)) ([e16095b](https://github.com/invertase/reeval/commit/e16095b1bc9926fb130024b527e8bc1f2d98eb1a))
* **query:** label the harness effort option as reasoning effort ([#316](https://github.com/invertase/reeval/issues/316)) ([0f2aa59](https://github.com/invertase/reeval/commit/0f2aa59778b6bcb10739bed90ab961256832fe06))
* rename evaluate.for to evaluate.each and pool results across cases ([#318](https://github.com/invertase/reeval/issues/318)) ([c5679e5](https://github.com/invertase/reeval/commit/c5679e51195e9a6f2e28febd10542d831f90dfe2))
* **sandbox:** give docker sandboxes swap headroom above the memory limit ([#310](https://github.com/invertase/reeval/issues/310)) ([937ccbe](https://github.com/invertase/reeval/commit/937ccbecf30ac149dc315cf7009e1ef358ea505f))
* **sandbox:** make an OOM kill during an attempt an infra error ([#312](https://github.com/invertase/reeval/issues/312)) ([1473ae3](https://github.com/invertase/reeval/commit/1473ae3381395296e6c997ec741b623ee9d0a356))


### Bug Fixes

* **cli:** require a config to run ([#309](https://github.com/invertase/reeval/issues/309)) ([c5399ed](https://github.com/invertase/reeval/commit/c5399ed3728e5ea42218cb4ec0f55b3cef627abd))
* **transcript:** record a refused web search as a web-search event ([#304](https://github.com/invertase/reeval/issues/304)) ([c08018e](https://github.com/invertase/reeval/commit/c08018e24681b8ecea7476928593c3ab8130bff1))

## [0.8.0](https://github.com/invertase/reeval/compare/v0.7.0...v0.8.0) (2026-10-14)


### Features

* **analyze:** add --vs none for a single-run write-up ([#287](https://github.com/invertase/reeval/issues/287)) ([4830182](https://github.com/invertase/reeval/commit/4830182eace0a938964ccd84439b3fc464333945))
* **analyze:** include compare-question answers in the digest ([#290](https://github.com/invertase/reeval/issues/290)) ([674612c](https://github.com/invertase/reeval/commit/674612cf09c162f99118ba3584c370a280103bc5))
* **capture:** run a vision journey before the saved shot ([#296](https://github.com/invertase/reeval/issues/296)) ([0a78555](https://github.com/invertase/reeval/commit/0a78555b8b52861942ec20989bfcdfb917354a67))
* **capture:** wait for load or networkAlmostIdle ([5612081](https://github.com/invertase/reeval/commit/5612081a8d2bbf44cc1a0e05bff5e1e5c0286978))
* **compare:** record a reason on each paired-question vote ([#291](https://github.com/invertase/reeval/issues/291)) ([230b3be](https://github.com/invertase/reeval/commit/230b3bec57ce76e6e1373ad95f1a517503b90bdb))
* **compare:** vary a named factor when pairing questions ([#289](https://github.com/invertase/reeval/issues/289)) ([2091421](https://github.com/invertase/reeval/commit/2091421da0b9a29d25a97e8e359d4e5b6695f582))
* **effort:** compare tokens with the same rank test ([#292](https://github.com/invertase/reeval/issues/292)) ([e161d95](https://github.com/invertase/reeval/commit/e161d95573dc5fbbe19e240ea55e0bff6d170b10))
* **harness:** add optional effort on every factory ([#297](https://github.com/invertase/reeval/issues/297)) ([418ec93](https://github.com/invertase/reeval/commit/418ec931fd3a06c41cb51a46de8958cd2bb77979))
* **judge:** send captures as decide file parts ([#298](https://github.com/invertase/reeval/issues/298)) ([8b7a202](https://github.com/invertase/reeval/commit/8b7a202ed41b63ab346e732ba87f0860b819a3e7))


### Bug Fixes

* **analyze:** drop anomalies that quote a wrong judge score ([#285](https://github.com/invertase/reeval/issues/285)) ([8351bab](https://github.com/invertase/reeval/commit/8351babbee2d5cbec0cdea72ffd844273766775d))
* **analyze:** drop mixed pass-rate when the eval changed ([#284](https://github.com/invertase/reeval/issues/284)) ([99117b1](https://github.com/invertase/reeval/commit/99117b167e01c9b6225247f95f8ae64201f5c1cf))
* **analyze:** drop rejected verifies instead of rewriting --tag ([bdfa03e](https://github.com/invertase/reeval/commit/bdfa03e4631e6e5f1c63cf63980f465ed56a72ec))
* **sandbox:** keep captures when chrome profile cleanup races ([#282](https://github.com/invertase/reeval/issues/282)) ([ff2e909](https://github.com/invertase/reeval/commit/ff2e909a759908cb05ada8c28a646a18aabe30ae))
* **ui:** uniquify colliding per-check judge labels ([#283](https://github.com/invertase/reeval/issues/283)) ([47ef183](https://github.com/invertase/reeval/commit/47ef1837de6b17d896e2d535034edd478ddcf30a))

## [0.7.0](https://github.com/invertase/reeval/compare/v0.6.3...v0.7.0) (2026-10-13)


### Features

* **assert:** transcript matchers on expect ([#236](https://github.com/invertase/reeval/issues/236)) ([13b06e3](https://github.com/invertase/reeval/commit/13b06e346db5906633abd362c5bed045c75048ae))
* **cli:** resume a stopped run with --resume ([6b70bcd](https://github.com/invertase/reeval/commit/6b70bcd910a158e18316935fea31d7804c0169e7))


### Bug Fixes

* **reeval:** ship the repo-root readme in the npm package ([#264](https://github.com/invertase/reeval/issues/264)) ([94ce2b5](https://github.com/invertase/reeval/commit/94ce2b575862761637288067a64235580acde1d9))

## [0.6.3](https://github.com/invertase/reeval/compare/v0.6.2...v0.6.3) (2026-10-11)


### Bug Fixes

* **studio:** make live.json whole-replace reliable on Windows ([#259](https://github.com/invertase/reeval/issues/259)) ([f0c55b5](https://github.com/invertase/reeval/commit/f0c55b506932205c1177398ff824cc1784aa8b0f))

## [0.6.2](https://github.com/invertase/reeval/compare/v0.6.1...v0.6.2) (2026-10-11)


### Bug Fixes

* **sandbox:** keep the Claude Code broker check after the CLI unsets the key ([#254](https://github.com/invertase/reeval/issues/254)) ([977b289](https://github.com/invertase/reeval/commit/977b2895773454cca83824ceedc31d3a8ca3863e))

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
