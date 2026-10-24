# Common mistakes (and the fix)

Each row is a mistake, what reeval says and the fix.

| Mistake | reeval says | Fix |
|---|---|---|
| No `reeval.config.*` | `No reeval.config.ts … here or above. Run reeval init.` | `reeval init`, or pass `--config` |
| `compare` in `reeval.config.ts` | `compare can't be set in reeval.config.ts` | Put it on the group or eval |
| `environment: [a, b]` | `environment takes one environment, not a list` | `compare: { baseline: a, variants: [b] }` |
| `compare: [b]` | `compare must be an object` | `compare: { baseline, variants: [b] }` |
| `compare: { strategy: 'peer' }` | `Unknown compare option "strategy"` | Drop it. Variants already run on their own |
| `environment` and `compare: { baseline, … }` together | `environment and compare.baseline can't both be set` | Drop `environment`, or drop `baseline` to make it the control |
| `compare: false` on an eval or group | `compare: false can't be set` | Use a profile's `limit.compare: false` |
| A question and no language model | `questions "…" (…) needs a language model` (exit 2) | Set `analysis.model`, give the question its own `model`, or set `question: { model }` |
| `import { baseline }` | `reeval has no baseline` | `baseline` is a field of `compare`, not an export |
| `repeat: 3` / `times` | `Unknown option "repeat" … Did you mean "runs"?` | `runs: 3` |
| Judge model `'gemini-3.8-flash'` | needs a provider prefix | `'google/gemini-3.8-flash'` |
| `opencode({ model: 'gemini-3.8-flash' })` | `an OpenCode model id names its provider` (exit 2) | `'google/gemini-3.8-flash'` |
| No `judge.model` anywhere | `c.judge() has no model` | Set one, or `fakeJudge()` |
| The judge's provider refuses a big input | The provider's message, then `The judge's input was ~…k tokens (estimated): diff …, of which …` | Add a `.gitignore` to the environment, or `state: { diff: ['src/'] }` |
| `diff` or `contents` on a judge, outside `state` | `Unknown judge option "diff" … Did you mean "state.diff"?` | `state: { diff: […] }`, `state: { contents: […] }` |
| `cursor()` with `fakeSandbox()` | real harnesses need `docker()` | Use `fakeHarness()` or `docker()` |
| Forgetting `await` on `toHaveFile`/`toSucceed` | ``… wasn't awaited. Its check is async: write `await …` `` (the eval fails) | `await expect(...)` |
| Secret as a string literal | refused | `secret.fromEnv('NAME')` in a callback |
| `workspace: 'https://…'` | `must come from the git helper` | `({ git }) => ({ workspace: git('https://…', { ref }) })` |
| `async` environment callback | returned a Promise | Return synchronously; fetch in a `setup` step |
| Test file named `*.test.ts` | `No eval files in … match include: …` (exit 2) | `*.eval.ts` under `evals/` |
| `.env.local` outside the config's directory | `Missing credentials: …` | Put it next to `reeval.config.ts` |
