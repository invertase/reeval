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
    "@opencode/cli": "2.0.22"
  }
}
`

export const OPENCODE_PNPM_WORKSPACE = `allowBuilds:
  '@opencode/cli@2.0.22': true
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
        specifier: 2.0.22
        version: 2.0.22

packages:

  '@opencode/cli-darwin-arm64@2.0.22':
    resolution: {integrity: sha512-NNg1VCCTWSfLlNKpRb4RA6IE7H67ZBLBYmfIWjP3CxR9NPtdROQFCL8lpPf+Tz2Qje4Bb27sQOLWanYyNT/9dQ==}
    cpu: [arm64]
    os: [darwin]

  '@opencode/cli-darwin-x64-baseline@2.0.22':
    resolution: {integrity: sha512-q5TO4/gETPehcivXDT8JHriFfRz/4iMhpFguRIehu+b0qZmwhBR5TccNKIDDGX98l1z8ku6N4SPbsDrpypl6Rw==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-darwin-x64@2.0.22':
    resolution: {integrity: sha512-R/o6HCCHdcDlmXSqveuYBBTB3mrGjMvG4H2AO3PpUJ2X1VEaHhei0BQ0nckGjJh6JXe7J/zJZqpxuBsVJbHfOw==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-linux-arm64@2.0.22':
    resolution: {integrity: sha512-t/yuu9Dqd/M44dFH95bphu7ikO6FATMQuVk/91QBnCMzsP8zVrXU7zAxD1wVLpYYUDqIonEmi80XETlFqx7chw==}
    cpu: [arm64]
    os: [linux]

  '@opencode/cli-linux-x64-baseline@2.0.22':
    resolution: {integrity: sha512-nwVyjnug68v1A0emkDf28GUM37m5PjiFgu2Xbn3ujNHdnSd0v43Yr5G7TD1XTvAbXg+Zv46hX0CvINJorLuOFA==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-linux-x64@2.0.22':
    resolution: {integrity: sha512-DlV1qgEDDnVqpTWMPqv7tCHCcXodzZBFaMcxjsiYdY6E5gHH2Q68JfasVksyQ1nu6m1887WQKGhOsepE+oKyYw==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-windows-arm64@2.0.22':
    resolution: {integrity: sha512-eVGgsYQmMPpb6Be28yFjgQiMXSojxypQ949xHbKH0Gg7rhv4hMxeBkOik4gb0jW/NqEZhRBQwHPKuMEGOhBgSw==}
    cpu: [arm64]
    os: [win32]

  '@opencode/cli-windows-x64-baseline@2.0.22':
    resolution: {integrity: sha512-o7gQWmvckjnLjYTCjsHiztfLfhNZMHpPdRwM/Y/TsYaQsSqAiM3l65OaHBH6q4cEClnOYlpWqU2Jpb+iLwqvIQ==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli-windows-x64@2.0.22':
    resolution: {integrity: sha512-n7eg3FwlHtRSZY5SV00XYh5c/TV7V0GIDqgygv9c5UEzPfbBfdk6d9mvGbZqn/Po/gmOPFyxU6SjmjWdGDF3ag==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli@2.0.22':
    resolution: {integrity: sha512-BJzGgplZ3owjPh4Cq5vbe7zMSgYXugOMJmrdlRriUl/9/rKitvK/F+ruk5JJOlIe4fw0bQ+UBAvN8+XGbUqTPw==}
    cpu: [arm64, x64]
    os: [darwin, linux, win32]
    hasBin: true

ignoredOptionalDependencies:
  - '@opencode/cli-linux-arm64-musl'
  - '@opencode/cli-linux-x64-baseline-musl'
  - '@opencode/cli-linux-x64-musl'

snapshots:

  '@opencode/cli-darwin-arm64@2.0.22':
    optional: true

  '@opencode/cli-darwin-x64-baseline@2.0.22':
    optional: true

  '@opencode/cli-darwin-x64@2.0.22':
    optional: true

  '@opencode/cli-linux-arm64@2.0.22':
    optional: true

  '@opencode/cli-linux-x64-baseline@2.0.22':
    optional: true

  '@opencode/cli-linux-x64@2.0.22':
    optional: true

  '@opencode/cli-windows-arm64@2.0.22':
    optional: true

  '@opencode/cli-windows-x64-baseline@2.0.22':
    optional: true

  '@opencode/cli-windows-x64@2.0.22':
    optional: true

  '@opencode/cli@2.0.22':
    optionalDependencies:
      '@opencode/cli-darwin-arm64': 2.0.22
      '@opencode/cli-darwin-x64': 2.0.22
      '@opencode/cli-darwin-x64-baseline': 2.0.22
      '@opencode/cli-linux-arm64': 2.0.22
      '@opencode/cli-linux-x64': 2.0.22
      '@opencode/cli-linux-x64-baseline': 2.0.22
      '@opencode/cli-windows-arm64': 2.0.22
      '@opencode/cli-windows-x64': 2.0.22
      '@opencode/cli-windows-x64-baseline': 2.0.22
`
