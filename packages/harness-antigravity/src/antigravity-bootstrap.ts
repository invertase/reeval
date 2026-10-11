import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The CLI build the bootstrap installs. Bump it with both checksums from the release. */
export const ANTIGRAVITY_CLI_VERSION = '1.3.3'

export const ANTIGRAVITY_CLI_SHA256 = {
  x64: '8ee3ca32574c431285efbf4d4732f7f8d53e959370bc4a61646e4fa496f7f2b6',
  arm64: 'a9d23fe1d7e5c8471881ab37723571a8d3f24e6ecace8fe082f8c0c8d90f41ca',
} as const

/** Relative to the harness state directory, `$HOME/.ai-sdk-harness`. */
export const ANTIGRAVITY_BOOTSTRAP_DIR = '.harness-bootstrap/antigravity'
/** The CLI's path relative to the bootstrap directory. */
export const ANTIGRAVITY_CLI_PATH = 'bin/agy'

const RELEASES = 'https://github.com/google-antigravity/antigravity-cli/releases/download'

/**
 * Downloads the pinned release for the sandbox's architecture, checks its sha256 and unpacks
 * the single `antigravity` binary as `bin/agy`. The binary needs glibc (Debian, Ubuntu).
 */
export function antigravityInstallScript(version = ANTIGRAVITY_CLI_VERSION): string {
  return `set -eu
case "$(uname -m)" in
  x86_64|amd64) arch=x64; sha=${ANTIGRAVITY_CLI_SHA256.x64} ;;
  aarch64|arm64) arch=arm64; sha=${ANTIGRAVITY_CLI_SHA256.arm64} ;;
  *) echo "The Antigravity CLI has no Linux build for $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o agy.tar.gz "${RELEASES}/${version}/agy_cli_linux_$arch.tar.gz"
echo "$sha  agy.tar.gz" | sha256sum -c - >/dev/null
rm -rf bin && mkdir bin
tar -xzf agy.tar.gz -C bin
mv bin/antigravity bin/agy
chmod 755 bin/agy
rm agy.tar.gz
`
}

export async function getAntigravityBootstrap(): Promise<HarnessV1Bootstrap> {
  return {
    harnessId: 'antigravity',
    bootstrapDir: ANTIGRAVITY_BOOTSTRAP_DIR,
    files: [
      { path: `${ANTIGRAVITY_BOOTSTRAP_DIR}/install.sh`, content: antigravityInstallScript() },
    ],
    commands: [{ command: 'sh install.sh' }],
  }
}
