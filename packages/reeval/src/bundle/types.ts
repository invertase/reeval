// The manifest of a `reeval bundle` archive: `manifest.json` at the archive's root. Browser-safe.

/** The `reeval run` arguments a bundle replays: what shapes its plan. */
export type BundleArgs = {
  /** The command line `reeval bundle` was given, after `bundle`. */
  argv: string[]
  /** Its filters, a path one relative to the project directory. */
  filters: string[]
  /** The profile the plan ran under, which `--profile`, `REEVAL_PROFILE` or `defaultProfile` picked. */
  profile?: string
  tags: string[]
  traits: string[]
  runs?: string
}

/** One file in the bundle, by its path in the archive. */
export type BundleFile = {
  /** Relative to the bundle root, with `/`. */
  path: string
  /**
   * What it is to the run: a kind from the dry run's `inputs` (`eval`, `skill`, `lockfile`, …),
   * or `install` for a file the install from the lockfile reads (`package.json`,
   * `pnpm-workspace.yaml`, …).
   */
  kind: string
  sha256: string
  size: number
}

/** A symbolic link in a skill or plugin folder, carried as a link to a file or folder in the bundle. */
export type BundleLink = {
  /** Relative to the bundle root, with `/`. */
  path: string
  /** What it links to, relative to its own folder, with `/`; always inside the bundle. */
  target: string
}

/** A `.env` file the run loads, which the bundle leaves out. */
export type BundleEnvFile = {
  /** Relative to the bundle root, with `/`. */
  path: string
  /** The variables it defines, sorted; never their values. */
  variables: string[]
}

/** The project's git state when it was bundled, as the run record's `git` keeps it. */
export type BundleGit = {
  /** HEAD's commit. */
  commit: string
  /** Uncommitted changes outside `.reeval/`; the bundle carries the changed files. */
  dirty: boolean
  branch?: string | null
  /** sha256 of the uncommitted changes as a binary patch, when dirty. */
  diffHash?: string | null
  commitTime?: string
  shallow?: boolean
  /** The `origin` URL with any credentials removed. */
  remote?: string | null
}

export type BundleManifest = {
  schemaVersion: 1
  /** The reeval that wrote it. */
  reeval: string
  createdAt: string
  args: BundleArgs
  /**
   * The project directory, relative to the bundle root (`''` when they're the same): the root is
   * the project's, or its git repository's when the project reads files outside its own directory
   * or its lockfile is the repository's, as in a monorepo.
   */
  project: string
  /** The config file, relative to the bundle root. */
  config: string
  /**
   * The project's git state when it was bundled, which a run from the bundle records as its own
   * (the extracted copy has no history); null outside git.
   */
  git: BundleGit | null
  /** Who the run belongs to, as the bundling machine named it: its git user, or `ci` in CI. */
  author?: string
  /**
   * The `reeval run --dry-run --json` document the bundle was made from. Its shape is the reeval
   * version's that wrote it, so it's kept as data: `reeval run --bundle` compares it with its own
   * dry run.
   */
  plan: Record<string, unknown>
  /** Every file in the archive but `manifest.json`, sorted by path. */
  files: BundleFile[]
  /** The symbolic links in the archive, sorted by path; absent when it has none. */
  links?: BundleLink[]
  /** The `.env` files the run loads, left out of the archive. */
  envFiles: BundleEnvFile[]
  /** The host variables the run reads secrets from, as the dry run's `secrets`; never values. */
  secrets: string[]
  /**
   * What the reeval that wrote it supports that a runner must know of before it starts the run:
   * `secrets-file`, reading `REEVAL_SECRETS_FILE` and keeping its brokered and sandbox values from
   * the eval code; `vm-waits`, its `cloud()` waiting on a refused machine start for as long as the
   * service asks and stopping its attempts only when the service ends the run; `vm-layout`, its
   * `cloud()` starting the machine type and attempts per machine the service gives, giving back a
   * machine the service reclaims, and ending its attempts when the service ends the run;
   * `heartbeat`, its event stream's heartbeat lines naming the attempts in progress and the machines
   * it holds (`REEVAL_EVENTS_HEARTBEAT`). Another reeval may list others.
   */
  features?: string[]
}

/** The features this reeval writes in every bundle's manifest. */
export const BUNDLE_FEATURES = ['heartbeat', 'secrets-file', 'vm-layout', 'vm-waits']
