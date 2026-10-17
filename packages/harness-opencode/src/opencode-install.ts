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
    "@opencode/cli": "2.0.32"
  }
}
`

export const OPENCODE_PNPM_WORKSPACE = `allowBuilds:
  '@opencode/cli@2.0.32': true
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
        specifier: 2.0.32
        version: 2.0.32

packages:

  '@opencode/cli-darwin-arm64@2.0.32':
    resolution: {integrity: sha512-wASwXBsWaOAYcZrh4ZLl4oaVxPCUAGVb7zZvXBBF8TjWE4uWgY0D2tj6gn80JfcO3b/s9woM6dP/gKqYKK2EdQ==}
    cpu: [arm64]
    os: [darwin]

  '@opencode/cli-darwin-x64-baseline@2.0.32':
    resolution: {integrity: sha512-r/T6QeDkYqzDHdI6VclvlJXqU6j0tbBmsP1+a1S+AyZxqEsY4vm9veFaoT5WQ/ekGH4TsAp3x0XtyF/m8eLFoQ==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-darwin-x64@2.0.32':
    resolution: {integrity: sha512-sDtaUjCuG9Bcu2SEIRM0RMVheyZC0IWIyz+esmTAf6b7FZ4+ARI/Ze09VWHDuwns5Pi5eW47Njkw3xlHOimE5Q==}
    cpu: [x64]
    os: [darwin]

  '@opencode/cli-linux-arm64@2.0.32':
    resolution: {integrity: sha512-YR5O03irvmot/G0f8W49ehvhn5uqCFN3vf9JTsChvf47W6ldjKCNvsaCSXS2SP26dPOUMQBn7WqbKnyHzrNR5w==}
    cpu: [arm64]
    os: [linux]

  '@opencode/cli-linux-x64-baseline@2.0.32':
    resolution: {integrity: sha512-NrB4iglJb7vGZWJ6B0qVH1EMHhWBZ4ADsAG9W0xLanzgxJ6eLEEsGBvxRX0cm/KPag5E/N0yZGsDVDZYcnz/OQ==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-linux-x64@2.0.32':
    resolution: {integrity: sha512-Q50ofBQ3gdwjD6ZQhrVR8fVlm8D2xPMshy4dynY6l6b+qLdKgBSJ9WpoaDyrQX1YWmf2s7IN4RbXmoXXdJitDA==}
    cpu: [x64]
    os: [linux]

  '@opencode/cli-windows-arm64@2.0.32':
    resolution: {integrity: sha512-T1UGNtrcgDoovpRD3nLqpfZoUh8+pDPlEewALD3QIUOLvuHyy4kUAFra6lLl5kitzqHN5Lm+2iQKX5F81A5hGw==}
    cpu: [arm64]
    os: [win32]

  '@opencode/cli-windows-x64-baseline@2.0.32':
    resolution: {integrity: sha512-8vim3HxOdy5VaL686BvwozryJCaiet5PiMIC/Ir9rP6h9m+qtd9KBV/2Hd2yuXvpq8ykNlFgHziAqwfsbkyrQg==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli-windows-x64@2.0.32':
    resolution: {integrity: sha512-5VdKolj2/NkSk3BuM4qeiYpnNnGRT7szmd2RIv3+aSDPMwD9yRySYkJ2f1WIM7dTDfO5lZHAXVoipt6+i6AD4A==}
    cpu: [x64]
    os: [win32]

  '@opencode/cli@2.0.32':
    resolution: {integrity: sha512-nhRlQGFLMoqx50VtIvUmCV/43W6dR8Y+OXzXq17zstSjzLIUdwfBZG6zP3Mpzo0cmLQ2hvXW4/PbhvlLyhwGGg==}
    cpu: [arm64, x64]
    os: [darwin, linux, win32]
    hasBin: true

ignoredOptionalDependencies:
  - '@opencode/cli-linux-arm64-musl'
  - '@opencode/cli-linux-x64-baseline-musl'
  - '@opencode/cli-linux-x64-musl'

snapshots:

  '@opencode/cli-darwin-arm64@2.0.32':
    optional: true

  '@opencode/cli-darwin-x64-baseline@2.0.32':
    optional: true

  '@opencode/cli-darwin-x64@2.0.32':
    optional: true

  '@opencode/cli-linux-arm64@2.0.32':
    optional: true

  '@opencode/cli-linux-x64-baseline@2.0.32':
    optional: true

  '@opencode/cli-linux-x64@2.0.32':
    optional: true

  '@opencode/cli-windows-arm64@2.0.32':
    optional: true

  '@opencode/cli-windows-x64-baseline@2.0.32':
    optional: true

  '@opencode/cli-windows-x64@2.0.32':
    optional: true

  '@opencode/cli@2.0.32':
    optionalDependencies:
      '@opencode/cli-darwin-arm64': 2.0.32
      '@opencode/cli-darwin-x64': 2.0.32
      '@opencode/cli-darwin-x64-baseline': 2.0.32
      '@opencode/cli-linux-arm64': 2.0.32
      '@opencode/cli-linux-x64': 2.0.32
      '@opencode/cli-linux-x64-baseline': 2.0.32
      '@opencode/cli-windows-arm64': 2.0.32
      '@opencode/cli-windows-x64': 2.0.32
      '@opencode/cli-windows-x64-baseline': 2.0.32
`
