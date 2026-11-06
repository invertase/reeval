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

/** A `.env` file the run loads, which the bundle leaves out. */
export type BundleEnvFile = {
  /** Relative to the bundle root, with `/`. */
  path: string
  /** The variables it defines, sorted; never their values. */
  variables: string[]
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
  /** The commit the project was at, and whether it had uncommitted changes; null outside git. */
  git: { commit: string; dirty: boolean } | null
  /**
   * The `reeval run --dry-run --json` document the bundle was made from. Its shape is the reeval
   * version's that wrote it, so it's kept as data: `reeval run --bundle` compares it with its own
   * dry run.
   */
  plan: Record<string, unknown>
  /** Every file in the archive but `manifest.json`, sorted by path. */
  files: BundleFile[]
  /** The `.env` files the run loads, left out of the archive. */
  envFiles: BundleEnvFile[]
  /** The host variables the run reads secrets from, as the dry run's `secrets`; never values. */
  secrets: string[]
}
