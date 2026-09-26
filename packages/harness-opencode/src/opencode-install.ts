// The pinned opencode-ai install the bootstrap runs, from a lockfile. pnpm runs only its
// postinstall, which links the platform binary. On a bump, regenerate the lockfile with
// `pnpm install --lockfile-only` from these files; a test checks the versions agree.

export const OPENCODE_PACKAGE_JSON = `{
  "name": "harness-acp-implementation",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "opencode-ai": "1.18.32"
  }
}
`

export const OPENCODE_PNPM_WORKSPACE = `allowBuilds:
  'opencode-ai@1.18.32': true
`

export const OPENCODE_PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      opencode-ai:
        specifier: 1.18.32
        version: 1.18.32

packages:

  opencode-ai@1.18.32:
    resolution: {integrity: sha512-SCrZWdq44y/EoH2+fE4HLcXS+DzpVqHPzmXk3p2RrufYy8LWvpfhRhKtijb5ktvx8r94ScqToqwHxR0BwS65OQ==}
    cpu: [arm64, x64]
    os: [darwin, linux, win32]
    hasBin: true

  opencode-darwin-arm64@1.18.32:
    resolution: {integrity: sha512-sDsHk/A6FNqeN5NuAiII6AAhi4pJIFcIY0S2yjG9gToIIVaqrQRaHQ6g0kpoVqTiMci8tvaND6tWD4eDT3ahFw==}
    cpu: [arm64]
    os: [darwin]

  opencode-darwin-x64-baseline@1.18.32:
    resolution: {integrity: sha512-xXcVF+98Dk5bm3HXFu7R0xjc6zZSbC5LI7AcTWsnwFZIzOmYMjtCg0MwhEs/FPeMY6aGpl0n6IOS4WlQRXAAcw==}
    cpu: [x64]
    os: [darwin]

  opencode-darwin-x64@1.18.32:
    resolution: {integrity: sha512-ZO/4GTJV/q2jlZ8apN1OfgTdD4m9bkdgLsEWYYDK6O8eTljIFgwhRMrJw1ozucU/D6lLQsA3CX/sS56UtlsTjQ==}
    cpu: [x64]
    os: [darwin]

  opencode-linux-arm64-musl@1.18.32:
    resolution: {integrity: sha512-G0fHTfilpeJu5VyvBp0H2fl9KnHayePYEibMW1vC0455hQDny+VkFMRKpu6yLYzGbAfjeTqKtRkejrQJD4mLUQ==}
    cpu: [arm64]
    os: [linux]
    libc: [musl]

  opencode-linux-arm64@1.18.32:
    resolution: {integrity: sha512-SDMw716oYxxJ9CWDO5roCpziw98ANwPZSz6L8evUOHkFCq6OU31xZGQwv/T1ROJnoPNJKWODmm1vzS6s6uEgUA==}
    cpu: [arm64]
    os: [linux]

  opencode-linux-x64-baseline-musl@1.18.32:
    resolution: {integrity: sha512-HGa9YBUBdc+qAyC9U8zXUht5qbTufOABOfSwmhukmzl9uMtuGoUovCzilwxytH0mTr/prUT/LAqWcXXoPXjRoA==}
    cpu: [x64]
    os: [linux]
    libc: [musl]

  opencode-linux-x64-baseline@1.18.32:
    resolution: {integrity: sha512-XXO4htNdJEoj935NGMYNGjD1M8ZiJPo2u2cQzIyeBjinoClI7iXOHBPw+Twm/ZuzFHKtmI2594bt0GWIwTetkw==}
    cpu: [x64]
    os: [linux]

  opencode-linux-x64-musl@1.18.32:
    resolution: {integrity: sha512-ktS7x5Ms+sVMCAb2oRpPKGk10isRjHkwBz6ordNOlx0epx6JQPsTydzJmpLBSdsiFAkfmZoBiYayKDXXU+rwXA==}
    cpu: [x64]
    os: [linux]
    libc: [musl]

  opencode-linux-x64@1.18.32:
    resolution: {integrity: sha512-CIatvoyi8V5a56xyw6ZUnsKxB9wqYIZqfNeqUNWhBBY4aENAm907LP0xXAwL6tR0cYbqNl2+Dvx8mOqXIxbDeQ==}
    cpu: [x64]
    os: [linux]

  opencode-windows-arm64@1.18.32:
    resolution: {integrity: sha512-AFXHn/kYnbsR/5N7Bm5ysv1vjDkQMaJQxPxJeF1OgGoQV48yBXPLIzhTijbt6IsipNBQxdb6xC0yANefpDSD9Q==}
    cpu: [arm64]
    os: [win32]

  opencode-windows-x64-baseline@1.18.32:
    resolution: {integrity: sha512-pXhJumlv2/g/ubgbfW5VtCnLEfdXw2RZO0j1uVhYVtCCYNjioJUPeLT1oMRF06VbkCo1UuLRfwEFqeFXD59N+A==}
    cpu: [x64]
    os: [win32]

  opencode-windows-x64@1.18.32:
    resolution: {integrity: sha512-9uy0owugtP9nkuylzN9+O9zWUIxt4X+KYwsREVk4G27PCfxccj+xIT7yxO9hCVtrF+DVgiJ59xDpiANE9UZrrQ==}
    cpu: [x64]
    os: [win32]

snapshots:

  opencode-ai@1.18.32:
    optionalDependencies:
      opencode-darwin-arm64: 1.18.32
      opencode-darwin-x64: 1.18.32
      opencode-darwin-x64-baseline: 1.18.32
      opencode-linux-arm64: 1.18.32
      opencode-linux-arm64-musl: 1.18.32
      opencode-linux-x64: 1.18.32
      opencode-linux-x64-baseline: 1.18.32
      opencode-linux-x64-baseline-musl: 1.18.32
      opencode-linux-x64-musl: 1.18.32
      opencode-windows-arm64: 1.18.32
      opencode-windows-x64: 1.18.32
      opencode-windows-x64-baseline: 1.18.32

  opencode-darwin-arm64@1.18.32:
    optional: true

  opencode-darwin-x64-baseline@1.18.32:
    optional: true

  opencode-darwin-x64@1.18.32:
    optional: true

  opencode-linux-arm64-musl@1.18.32:
    optional: true

  opencode-linux-arm64@1.18.32:
    optional: true

  opencode-linux-x64-baseline-musl@1.18.32:
    optional: true

  opencode-linux-x64-baseline@1.18.32:
    optional: true

  opencode-linux-x64-musl@1.18.32:
    optional: true

  opencode-linux-x64@1.18.32:
    optional: true

  opencode-windows-arm64@1.18.32:
    optional: true

  opencode-windows-x64-baseline@1.18.32:
    optional: true

  opencode-windows-x64@1.18.32:
    optional: true
`
