import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The CLI build the bootstrap installs. Bump it with both checksums from the release. */
export const ANTIGRAVITY_CLI_VERSION = '1.4.0'

export const ANTIGRAVITY_CLI_SHA256 = {
  x64: 'fd96967583c1eed94733c039638fa59b71ddbd823c75ebc8dd0e677463565aad',
  arm64: 'cf953adcc69f87d00d71f97c3f35dc723a8669a350accf9a199df781f0523f56',
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
