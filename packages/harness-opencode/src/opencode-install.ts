// The pinned @opencode/cli install the bootstrap runs, from a lockfile. pnpm runs only its
// postinstall, which links the platform binary. The musl builds are left out: reeval images are
// glibc, and the package marks none of its builds with a libc, so pnpm would install all four
// (about 200 MB each). On a bump, regenerate the lockfile with `pnpm install --lockfile-only`
// from these files; a test checks the versions agree.

export const OPENCODE_PACKAGE_JSON = `{
  "name": "harness-acp-implementation",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@opencode/cli": "2.0.23"
  }
}
`

export const OPENCODE_PNPM_WORKSPACE = `allowBuilds:
  '@opencode/cli@2.0.23': true
ignoredOptionalDependencies:
  - '@opencode/cli-linux-arm64-musl'
  - '@opencode/cli-linux-x64-baseline-musl'
  - '@opencode/cli-linux-x64-musl'
`

export const OPENCODE_PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@opencode/cli':
        specifier: 2.0.23
        version: 2.0.23

packages:

  '@opencode/cli-darwin-arm64@2.0.23':
    resolution: {integrity: sha512-5qZx8IqfCKdymb711qBxkjBtNJZ9H2JIkrqIUiLwsrxmIyDMKu8tPTxKKMH91sC5fElZbrBP9M8Jq6LckDnxUw==}
    cpu: [arm64]
    os: [darwin]

  '@opencode/cli-darwin-x64-baseline@2.0.23':
    resolution: {integrity: sha512-woTCvgSI4E6QrLr7UtewE5nMv0FGv5YXYA29JncgSVr0kY5AtptYnHcYujazKcRZ6mOVloXnCeovCkOSiIyApw==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-darwin-x64@2.0.23':
    resolution: {integrity: sha512-gsNPdmJ8AbWBJTEB8Qtun00E0IOLw4zCK6dMyZi3N63Th33b33p3//AeZvrdDMY61WxCX1sl18foFfApU6rSCA==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-linux-arm64@2.0.23':
    resolution: {integrity: sha512-kuLDSOpFFGCdCS/fdaHZ2yMqXsP4jwYfS0yV4ilYxaB7c0PJ84eY1b/bl2N9JXELXU13I2OFDI+NWzXhyXrxOQ==}
    cpu: [arm64]
    os: [linux]

  '@opencode/cli-linux-x64-baseline@2.0.23':
    resolution: {integrity: sha512-1z3iy2bNnCjUvHeMtOQ2oZSkxys/hk6mE+wme31lYpf4TCqe6HZw3oO0usd7C5dS/gnnVMY9tnyteklGpdejjg==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-linux-x64@2.0.23':
    resolution: {integrity: sha512-5CQisdKXLDXVjUZYF1ROqIH/HS5YUwo4SjEBJ3DndATJL2vFgbvN0pqZQkKQqBjUrZ19jNXDHvp+LP/uGIECAQ==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-windows-arm64@2.0.23':
    resolution: {integrity: sha512-bRbbgS893ExKFUGvrosHJqxaq+fuGeFmMtE2Bk4DfFq+NfkCbBEvzMf+m9dB/Ooij/qf+Sgi68YgbeLo1BNl2Q==}
    cpu: [arm64]
    os: [win32]

  '@opencode/cli-windows-x64-baseline@2.0.23':
    resolution: {integrity: sha512-2bXl72/7sH8LdhSNMY68PNF5APlMiq+33QerXGB1qOYYmSVdv0ES3dtBF1JaojhMXm2F5toH+ZRK4igIZjjesw==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli-windows-x64@2.0.23':
    resolution: {integrity: sha512-X9yJUAfk5fS2ZR6ZTsOv3ycBP7Q9+5Bq1oTMtNnCOydgY+RUdU6/3fzsx0zbP4a59VR7ZJvAYMMDU+c75s97Ww==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli@2.0.23':
    resolution: {integrity: sha512-/a6FNuG/LN2GmYmsBrFucWlIJjN4LARCqT9j1jT4Vi2Dx9MereLAMnAqSY0ldGEUo55PKYOGM4rztW2rZpHAoQ==}
    cpu: [arm64, x64]
    os: [darwin, linux, win32]
    hasBin: true

ignoredOptionalDependencies:
  - '@opencode/cli-linux-arm64-musl'
  - '@opencode/cli-linux-x64-baseline-musl'
  - '@opencode/cli-linux-x64-musl'

snapshots:

  '@opencode/cli-darwin-arm64@2.0.23':
    optional: true

  '@opencode/cli-darwin-x64-baseline@2.0.23':
    optional: true

  '@opencode/cli-darwin-x64@2.0.23':
    optional: true

  '@opencode/cli-linux-arm64@2.0.23':
    optional: true

  '@opencode/cli-linux-x64-baseline@2.0.23':
    optional: true

  '@opencode/cli-linux-x64@2.0.23':
    optional: true

  '@opencode/cli-windows-arm64@2.0.23':
    optional: true

  '@opencode/cli-windows-x64-baseline@2.0.23':
    optional: true

  '@opencode/cli-windows-x64@2.0.23':
    optional: true

  '@opencode/cli@2.0.23':
    optionalDependencies:
      '@opencode/cli-darwin-arm64': 2.0.23
      '@opencode/cli-darwin-x64': 2.0.23
      '@opencode/cli-darwin-x64-baseline': 2.0.23
      '@opencode/cli-linux-arm64': 2.0.23
      '@opencode/cli-linux-x64': 2.0.23
      '@opencode/cli-linux-x64-baseline': 2.0.23
      '@opencode/cli-windows-arm64': 2.0.23
      '@opencode/cli-windows-x64': 2.0.23
      '@opencode/cli-windows-x64-baseline': 2.0.23
`
