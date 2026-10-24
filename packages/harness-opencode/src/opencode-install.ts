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
    "@opencode/cli": "2.1.4"
  }
}
`

export const OPENCODE_PNPM_WORKSPACE = `allowBuilds:
  '@opencode/cli@2.1.4': true
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
        specifier: 2.1.4
        version: 2.1.4

packages:

  '@opencode/cli-darwin-arm64@2.1.4':
    resolution: {integrity: sha512-QwjyvovTdT0gFi5rxUyPVlYePIe3ELduR9olu+KJWe089XVIDOTMhxylBe/ZGIpvoXHYo6bp2NskIiqCFAEXsw==}
    cpu: [arm64]
    os: [darwin]

  '@opencode/cli-darwin-x64-baseline@2.1.4':
    resolution: {integrity: sha512-htb+MYexlbFPc/da+jXePmclbXuMMX4m8kSIe24wbgy/npTC8wv1VHj0QTDt9YttTnnas+Yr1kNmJ7j/86yt+Q==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-darwin-x64@2.1.4':
    resolution: {integrity: sha512-pdx0Iyl+IK1SdSQOhvz8JE4Rk0PGyacZ55FaxmyowYe9h0aFZNs3UAj7wNYod6Hsu4qsAeSVkdfQLr4SI8G1oA==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-linux-arm64@2.1.4':
    resolution: {integrity: sha512-drw0LWMG0niaE94ePXm1h7qjFBZZRcSZD3gact3hx3OYPXesp7xrOt0bn3sicYNUN6fojERrDKR6jYrXmZX+rA==}
    cpu: [arm64]
    os: [linux]

  '@opencode/cli-linux-x64-baseline@2.1.4':
    resolution: {integrity: sha512-0/H4wRDAW4hA5IWN440XwDrRATbvT3cno+UUsqFynTu0TeGXNADjK2AZfvhNTfyJaVyCa+v7VhB+r7ghuMa5EQ==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-linux-x64@2.1.4':
    resolution: {integrity: sha512-o8EJ0ZsT4dzDKN+0mpG2EKbNGzJyp+F1++Av28UReRVfiEv+N34eZEnN/unkiMoerKHad6W6Ii7k4ukTnPNmNQ==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-windows-arm64@2.1.4':
    resolution: {integrity: sha512-ZDKG+2rhCYb2ngl1B/H8Lx2ll9NjNLhghj10/War9eK5ASYysWvR+26+Bdv+/J29eZdzeXViJnOwf3tZBdMakA==}
    cpu: [arm64]
    os: [win32]

  '@opencode/cli-windows-x64-baseline@2.1.4':
    resolution: {integrity: sha512-76bsf2uQK/vj2CI0p6dhten9ZD8HmGLeC4B1XfwEaD1xmWHB+8hwTGy5VVvHsoqH+flRQeq3Xfk0VCyQ9zA9+g==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli-windows-x64@2.1.4':
    resolution: {integrity: sha512-9h0Nb/3g6HxnFY6lawSqNSCxek0K3zUPjOAoF20pyPBaLMq65sXfWLVwgyS/21AM0NrUw77S9CeP0tPM+XrbGQ==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli@2.1.4':
    resolution: {integrity: sha512-vtHFa/1frSylpx1cZRuzmM2ecHWn6YB8cNvhw8eWKPvSFvDnckZXugDbi3LJYD9TGjRx2U6JRo725qwqtwMUfQ==}
    cpu: [arm64, x64]
    os: [darwin, linux, win32]
    hasBin: true

ignoredOptionalDependencies:
  - '@opencode/cli-linux-arm64-musl'
  - '@opencode/cli-linux-x64-baseline-musl'
  - '@opencode/cli-linux-x64-musl'

snapshots:

  '@opencode/cli-darwin-arm64@2.1.4':
    optional: true

  '@opencode/cli-darwin-x64-baseline@2.1.4':
    optional: true

  '@opencode/cli-darwin-x64@2.1.4':
    optional: true

  '@opencode/cli-linux-arm64@2.1.4':
    optional: true

  '@opencode/cli-linux-x64-baseline@2.1.4':
    optional: true

  '@opencode/cli-linux-x64@2.1.4':
    optional: true

  '@opencode/cli-windows-arm64@2.1.4':
    optional: true

  '@opencode/cli-windows-x64-baseline@2.1.4':
    optional: true

  '@opencode/cli-windows-x64@2.1.4':
    optional: true

  '@opencode/cli@2.1.4':
    optionalDependencies:
      '@opencode/cli-darwin-arm64': 2.1.4
      '@opencode/cli-darwin-x64': 2.1.4
      '@opencode/cli-darwin-x64-baseline': 2.1.4
      '@opencode/cli-linux-arm64': 2.1.4
      '@opencode/cli-linux-x64': 2.1.4
      '@opencode/cli-linux-x64-baseline': 2.1.4
      '@opencode/cli-windows-arm64': 2.1.4
      '@opencode/cli-windows-x64': 2.1.4
      '@opencode/cli-windows-x64-baseline': 2.1.4
`
