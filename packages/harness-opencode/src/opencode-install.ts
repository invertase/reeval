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
    "@opencode/cli": "2.0.20"
  }
}
`

export const OPENCODE_PNPM_WORKSPACE = `allowBuilds:
  '@opencode/cli@2.0.20': true
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
        specifier: 2.0.20
        version: 2.0.20

packages:

  '@opencode/cli-darwin-arm64@2.0.20':
    resolution: {integrity: sha512-haK35da6HYSnDu8pMdh47SvSWRQKXi5OBU5qostb4QlRe3xZgqr7P47irrvdRzBCHD/m5luh3AkjRWx+9P9BIg==}
    cpu: [arm64]
    os: [darwin]

  '@opencode/cli-darwin-x64-baseline@2.0.20':
    resolution: {integrity: sha512-XWSfsyktcJ7y9MF3DyJXlCGC/NXxobrPmVZAwd26BrzPsNEGZv1RtiOab2ch2O2XnRRsEDAQHbmpFX8Yvlqdqg==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-darwin-x64@2.0.20':
    resolution: {integrity: sha512-KfJx11eKM2A9Ed8oDyIim3IsBBhHW+kQP7h7s2Y4sPrVpkObhciTJg87LiEKnIyFBh1QgunGuNddjdz8FuhwqQ==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-linux-arm64@2.0.20':
    resolution: {integrity: sha512-JLHDgEPmThZjbQEIwZNBdwLddvxYFIssDaDbDb/nF7aw4D5xt9xGUa1o6nF1IW1Ck+px8kV465W2AuThKRU3sg==}
    cpu: [arm64]
    os: [linux]

  '@opencode/cli-linux-x64-baseline@2.0.20':
    resolution: {integrity: sha512-WrvrLyMRVLl0ioD/j8zrCny0TWrlgbZ50R5X3d4y9joe+b9t15ovNsbHJaXiL1UHBq1OeA5mIGDluF5amD2peA==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-linux-x64@2.0.20':
    resolution: {integrity: sha512-C47hADWv2MD6OzwMhn2iBXcQVjvwDTkzpB7kKlL8J+vJQxLzws580vfgpTRYB7JItFG1VUt6IHqqi00VCmrPRg==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-windows-arm64@2.0.20':
    resolution: {integrity: sha512-KGBhcKG+o5ENbWXsGm1A02C5nxE8jdmqhRObDjMEcwHEpY4Gj8jSCLAsX3ioQT/aRCt3yde4vM/a8MGKo4eo3Q==}
    cpu: [arm64]
    os: [win32]

  '@opencode/cli-windows-x64-baseline@2.0.20':
    resolution: {integrity: sha512-Es06oDHo26aFem8AF7cHe6IUtNp7p31sUX9Ikt5LpuYjj4fzIDpz9R1o3XkrV/da2JbhX5Ft3/VBDVBZCTLZ+A==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli-windows-x64@2.0.20':
    resolution: {integrity: sha512-JomkE7e4++aQCVnwgAXwhsTgDdV0DiQZSZDzJUJbSfwKcTq9CR54xIfovBa+57S+yRVlw0JgKHh4TBpGvf8IlQ==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli@2.0.20':
    resolution: {integrity: sha512-y2dtcv2UCIw+1/9xDmPZ3UNcdLX5TLQYNnqhdO1Vc+Tw7o7oajvIyEBX7Okrh1GqDhZk7PPhrQe7QIEPCCefXw==}
    cpu: [arm64, x64]
    os: [darwin, linux, win32]
    hasBin: true

ignoredOptionalDependencies:
  - '@opencode/cli-linux-arm64-musl'
  - '@opencode/cli-linux-x64-baseline-musl'
  - '@opencode/cli-linux-x64-musl'

snapshots:

  '@opencode/cli-darwin-arm64@2.0.20':
    optional: true

  '@opencode/cli-darwin-x64-baseline@2.0.20':
    optional: true

  '@opencode/cli-darwin-x64@2.0.20':
    optional: true

  '@opencode/cli-linux-arm64@2.0.20':
    optional: true

  '@opencode/cli-linux-x64-baseline@2.0.20':
    optional: true

  '@opencode/cli-linux-x64@2.0.20':
    optional: true

  '@opencode/cli-windows-arm64@2.0.20':
    optional: true

  '@opencode/cli-windows-x64-baseline@2.0.20':
    optional: true

  '@opencode/cli-windows-x64@2.0.20':
    optional: true

  '@opencode/cli@2.0.20':
    optionalDependencies:
      '@opencode/cli-darwin-arm64': 2.0.20
      '@opencode/cli-darwin-x64': 2.0.20
      '@opencode/cli-darwin-x64-baseline': 2.0.20
      '@opencode/cli-linux-arm64': 2.0.20
      '@opencode/cli-linux-x64': 2.0.20
      '@opencode/cli-linux-x64-baseline': 2.0.20
      '@opencode/cli-windows-arm64': 2.0.20
      '@opencode/cli-windows-x64': 2.0.20
      '@opencode/cli-windows-x64-baseline': 2.0.20
`
