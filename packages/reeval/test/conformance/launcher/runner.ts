// What a language plugs into the launcher conformance suite: how to install its launcher, and the
// few hooks the cases need. See README.md.

/** The binaries an SDK records at release: Python's binaries.json shape. */
export type Released = {
  version: string
  binaries: { [target: string]: { name: string; sha256: string; size: number } }
}

export type Facts = {
  os: 'linux' | 'darwin' | 'windows' | 'freebsd'
  arch: 'x64' | 'arm64' | 'ia32' | 'riscv64'
  libc: 'glibc' | 'musl' | 'none'
  avx2: boolean
}

/** The target a launcher picked, or how it refused. */
export type Picked = { target: string } | { exit: number; stderr: string }

export type Launcher = {
  /** The argv that runs the launcher, as a user's `reeval` would. */
  command: string[]
  /** The launcher's own file, which REEVAL_BINARY must not be allowed to name. */
  file: string
}

export type Runner = {
  name: string
  /** Installs the launcher under `work` (a directory of its own). */
  setup(work: string): Promise<Launcher>
  /** The variable the launcher sets for the binary to find the language, e.g. REEVAL_PYTHON. */
  interpreterEnv?: string
  /** Files the launcher may keep beside a cached binary, as suffixes of its name. */
  sidecars?: string[]
  /** The environment that makes the launcher trust `caFile` for HTTPS; without it, HTTPS cases skip. */
  trust?(caFile: string): { [name: string]: string }
  /** Makes the launcher hold `record` as the hashes it was released with; `null` removes them. */
  record?(released: Released | null): Promise<void>
  /** The launcher's target choice for each row of facts, with its own detection stubbed out. */
  pickTargets?(facts: Facts[]): Promise<Picked[]>
  /** Cases this launcher is known to fail, with why. Each must fail: one that passes is an error. */
  divergences?: { [caseId: string]: string }
}
