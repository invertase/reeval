# Environments, sandboxes, secrets and egress

## Contents

- Environments: skills, files, rules, MCP, setup
- Fixture directories and `git()` workspaces
- Skills and composition
- Sandboxes
- Secrets and egress

## Environments: skills, files, rules, MCP, setup

What the agent runs *in*, per attempt: the code the workspace starts as, skills, MCP servers,
files, rules, env vars, secrets and setup steps. Pass a spec, or a synchronous callback that
destructures the helpers it needs:

```ts
// evals/envs.ts
import { defineEnvironment } from 'reeval'

export const houseStyle = defineEnvironment('house-style', ({ skill }) => ({
  // a dir with SKILL.md, relative to this file
  skills: [skill.local('../skills/house-style')],
}))

export const withDocs = houseStyle.extendEnvironment(
  'with-docs',
  ({ file, mcp }) => ({
    // written into the workspace
    files: { 'docs/api.md': file('../docs/api.md') },
    // AGENTS.md (CLAUDE.md for Claude Code)
    rules: file('../rules/house.md'),
    // or mcp.http(url) / mcp.sse(url) (not on OpenCode, Goose, pi or Codex)
    mcp: { docs: mcp.stdio('npx', ['-y', '@acme/docs-mcp@1.0.0']) },
    // every attempt, before the agent
    setup: [{ run: 'npm ci', timeout: '5m' }],
  }),
)

// Start from existing code: a repo, or one directory of it, at a pinned ref
export const app = defineEnvironment('acme-app', ({ git }) => ({
  workspace: git('https://github.com/acme/app', {
    ref: 'v2.3.0',
    path: 'examples/basic',
  }),
  setup: ['npm ci'],
}))

// Or seed a fixture directory: a plain object of file() entries, so spread
// and override it
export const notes = defineEnvironment('acme-notes', ({ directory }) => ({
  files: { ...directory('../fixture'), 'README.md': 'something' },
  setup: [{ run: 'npm ci --no-audit --no-fund', timeout: '5m' }],
}))
```

## Fixture directories and `git()` workspaces

Use `directory(path, { into?, glob?, defaultIgnores? })` for a fixture directory instead of
mapping a file list through `file()`. It skips `.git`, `node_modules/`, `dist/`, top-level
`build/`, caches and editor folders (`DEFAULT_DIRECTORY_IGNORES`; `defaultIgnores: false` keeps
them, except `.git`). `glob` is ordered gitignore-style patterns where the last match wins and
`!` excludes: `glob: ['src/**', 'package.json', '!**/*.test.ts']`.

Executable files stay executable; empty directories aren't seeded.

`workspace: git(repo, { ref, path })` takes a URL, `github:owner/repo`, a GitHub `/tree/` URL or
a local path (relative to the file). reeval fetches it on the host before any attempt, with the
host's git credentials or `token: 'GITHUB_TOKEN'` (a host variable's name; never a token in the
URL or the eval). It copies the tree in before `files` (which win) and `setup`, and records the
commit and tree hash.

`init: true` adds a `.git` with one commit of the tree (no remote), for agents that expect a
repo. Pin `ref` to a tag or full SHA; a branch warns. The agent's diff starts after setup, so the
repo never counts as its change.

A bad ref, path, URL or token fails only the attempts that use it (infra error, exit 3).
Submodules and LFS files aren't fetched.

## Skills and composition

Skills: `skill.local | git | npm | registry | inline` (pin git refs; `placement: 'workspace'`
writes them into the repo's skill directory). `extendEnvironment` is the only composition; the
child wins on shared keys and **replaces** `sandbox` entirely when it sets one (install is not
merged onto the parent image).

A skill is a directory whose `SKILL.md` has YAML frontmatter
(`name`, `description`; quote values containing `: `). Baking (`from`, `install`, `dockerfile`)
is `sandbox: docker({ … })` on the environment.

Plugins: `plugins: [plugin.local('../plugins/review', { only: ['skills', 'mcp'] })]` (also
`plugin.git(repo, { ref, path })` and `plugin.npm(spec)`). A plugin is Claude Code's layout:
`.claude-plugin/plugin.json` plus `skills/`, `agents/`, `commands/`, `hooks/hooks.json`,
`.mcp.json`, `rules/`. Its MCP servers join `mcp` as `<plugin>:<server>` (call them from the
fake agent as `{ mcp: 'review:docs/<tool>' }`), and it lands in `~/.reeval/plugins/<name>/`.
Claude Code and Grok Build load every part but `rules` (narrow with `only`), namespaced
(`review:reviewer`), and start the plugin's MCP servers themselves, so a plugin server reading a
host variable is refused there: declare it in `mcp`. Antigravity loads every part with
`agy plugin install`, and refuses such a server too. Cursor loads every part flat: rules,
subagents, commands and hooks unpacked into the workspace's `.cursor/` (left out of the diff),
skills into `~/.agents/skills`, so two items with one name clash. A hook event the harness doesn't
run is refused at plan time. Other real harnesses refuse plugins
(`--dry-run` exits 2 naming the harness), so keep plugins off their cells. `build` is refused for now; a server run with `npx`/`uvx` needs
its registry in `egress`, or install it in the image.

A named env is a total override: no skills, files or sandbox inherit from the config
environment.

## Sandboxes

```ts
// reeval's Node image with the agent CLI
docker()
// baked once as a cached layer; no secrets
docker({ install: ['npm i -g firebase-tools@14'] })
// a Debian or Ubuntu base; reeval adds Node and the agent
docker({ from: 'python:3.12-slim' })
// ARG REEVAL_BASE and FROM ${REEVAL_BASE} to layer on reeval's image
docker({ dockerfile: './sandbox/Dockerfile' })
// limits; defaults 4g, 2 and 1024
docker({ memory: '8g', cpus: 4, pids: 4096 })
// swap on top; default the same as memory, 0 for none
docker({ memory: '4g', swap: 0 })
// opt in to apt-get at run time (default: user reeval)
docker({ root: true })
// the same sandbox and options on rootless Podman 4+ (cell id `podman`)
podman({ from: 'python:3.12-slim' })
```

Use `podman()` only where the user runs Podman instead of Docker: it takes every `docker()`
option and confines the container the same way (bridge network, Docker's seccomp profile).

The agent, setup and `c.exec` run as `reeval` (home `/home/reeval`) with no capabilities; builds
run as root. `root: true` or `capabilities` print a warning at the start of every run, so prefer
`install`. A process killed at the memory limit makes the attempt an infra error
(`error.resource.cause: 'oom'`), not a failed check: raise `memory` rather than loosening it.

Put a specific machine on `defineEnvironment`, or `sandbox` on `defineConfig`, a profile, group
or eval as the default when the resolved env omits one. A list is an error. `npx reeval image
build` builds every image the plan needs.

The cell key includes the image (`from`, `dockerfile`, `install`), so Node 22 and 24 can't share
a cell. Environments that share an image still share one preflight build.

## Secrets and egress

Secrets come from a `defineConfig` or `defineEnvironment` callback, never literals:

```ts
defineEnvironment('gemini', ({ secret }) => ({
  env: {
    GEMINI_API_KEY: secret.fromEnv('GEMINI_API_KEY', {
      hosts: secret.hosts.gemini,
    }),
  },
}))
```

With `hosts`, the sandbox only sees a placeholder and reeval's gateway swaps in the real value on
HTTPS requests to those hosts. `{ to: 'checks' }` keeps it from the agent.

`egress: 'allow-all' | 'deny-all' | { allow: [hosts] }` limits where the sandbox may connect (the
harness's API, brokered hosts and MCP hosts are always allowed; `DEFAULT_EGRESS_ALLOW` is npm,
Yarn, PyPI and GitHub). A blocked request doesn't fail the attempt; it's recorded, and your checks decide.
