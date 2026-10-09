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
    "@opencode/cli": "2.0.26"
  }
}
`

export const OPENCODE_PNPM_WORKSPACE = `allowBuilds:
  '@opencode/cli@2.0.26': true
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
        specifier: 2.0.26
        version: 2.0.26

packages:

  '@opencode/cli-darwin-arm64@2.0.26':
    resolution: {integrity: sha512-XklldeO6eWgG8vkPNLcdlBPEm1Y+/tyhEXGZvXbk8uytpPP7SEVV2R9oZ98NMSSPH9kBAO/+Xo4sKfvD6CHAsw==}
    cpu: [arm64]
    os: [darwin]

  '@opencode/cli-darwin-x64-baseline@2.0.26':
    resolution: {integrity: sha512-A4t57iwRo8gh4bKX/tyn/zTmVCdPZMPLNsoJeR+TbskpC1idpjc7qZsdYRPIBBTgzK++LjWhe9vyxqWOFglCXQ==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-darwin-x64@2.0.26':
    resolution: {integrity: sha512-051fIryTH4FK4Ml63TH+IP3s7Mi+jYfVyEXSBh9aGDJUS2VZfD+AwNJ9Ew9nBPTBKYvhMGhqHcudHagRL8SBbQ==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-linux-arm64@2.0.26':
    resolution: {integrity: sha512-IG316I8wVqndohzFAoWNeH83eMA8sKQFRtMeuk2Wfg4DU1haCSgzAJz3/gbytjwh6bXdWR7V3FCSrfjoraKDgw==}
    cpu: [arm64]
    os: [linux]

  '@opencode/cli-linux-x64-baseline@2.0.26':
    resolution: {integrity: sha512-A+OonlFxNQh4xh/dI/YcDQlG+iiRhnIMTakSsavIyUuHvKo0hIrTUuwGSzSmspS+22QYrxqKTQ7bmF7jJvGwGQ==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-linux-x64@2.0.26':
    resolution: {integrity: sha512-UIA2/1Ik8HaN54C4xp7H+OHgRfq995XUixrX+kLmFs8EPn1fAcmn3OoiN+3c3Vc3jEV/LHmj0Cy1SL6nW4wdGw==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-windows-arm64@2.0.26':
    resolution: {integrity: sha512-LF8ighj9IVFTrSC+Qvfh7ld3HtB6EMh1t4Jc+Bc4sBCxwKxaCg6ku59rT99G6yG+dSfmxiFdtBgZZkG5odm41w==}
    cpu: [arm64]
    os: [win32]

  '@opencode/cli-windows-x64-baseline@2.0.26':
    resolution: {integrity: sha512-+8TifOb0CAenFBU496K0mQYWb6Xhtadd0wLjHzPam4NsmaTgnkSPIhbP0++3BLn7UYt/fdZzFwwJxzdLTV5bXw==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli-windows-x64@2.0.26':
    resolution: {integrity: sha512-SnM0HxXr+UB1yV/7JcLx2kpFkMktTmuECyylxkwtkUzWRE2Kc9F58+/BrJRyVrY6cSg4Zt3uPZFUwZaLix652w==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli@2.0.26':
    resolution: {integrity: sha512-d1UjPf053y2KR1sQx9+7M8tMRkYD3qjAt9VTfBjZwHLWBzbvwI1+cP8+HTSWSi4Z1WQFnS3vaktKgnDPFkj5IQ==}
    cpu: [arm64, x64]
    os: [darwin, linux, win32]
    hasBin: true

ignoredOptionalDependencies:
  - '@opencode/cli-linux-arm64-musl'
  - '@opencode/cli-linux-x64-baseline-musl'
  - '@opencode/cli-linux-x64-musl'

snapshots:

  '@opencode/cli-darwin-arm64@2.0.26':
    optional: true

  '@opencode/cli-darwin-x64-baseline@2.0.26':
    optional: true

  '@opencode/cli-darwin-x64@2.0.26':
    optional: true

  '@opencode/cli-linux-arm64@2.0.26':
    optional: true

  '@opencode/cli-linux-x64-baseline@2.0.26':
    optional: true

  '@opencode/cli-linux-x64@2.0.26':
    optional: true

  '@opencode/cli-windows-arm64@2.0.26':
    optional: true

  '@opencode/cli-windows-x64-baseline@2.0.26':
    optional: true

  '@opencode/cli-windows-x64@2.0.26':
    optional: true

  '@opencode/cli@2.0.26':
    optionalDependencies:
      '@opencode/cli-darwin-arm64': 2.0.26
      '@opencode/cli-darwin-x64': 2.0.26
      '@opencode/cli-darwin-x64-baseline': 2.0.26
      '@opencode/cli-linux-arm64': 2.0.26
      '@opencode/cli-linux-x64': 2.0.26
      '@opencode/cli-linux-x64-baseline': 2.0.26
      '@opencode/cli-windows-arm64': 2.0.26
      '@opencode/cli-windows-x64': 2.0.26
      '@opencode/cli-windows-x64-baseline': 2.0.26
`
