import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The CLI build the bootstrap installs. Bump it with every checksum from the release. */
export const ANTIGRAVITY_CLI_VERSION = '1.4.7'

/**
 * The sha256 of each release asset the bootstrap installs: Linux's for each arch, and macOS's
 * for Apple Silicon (a Tart VM), from the release assets' `digest`.
 */
export const ANTIGRAVITY_CLI_SHA256 = {
  x64: '67fd4e70be739b1f8b18f90b511da8cd2a7aef24e888e5837402e025bf7fdbfc',
  arm64: 'b273c791b7647f680598fa1dbdf9c8086bdc42374b2276fa70e900bf8120e1d5',
  'darwin-arm64': '9fed7bfe90cb158ac00b5b2da64dd54af732f7c062259e68ebd060b827fd0d88',
} as const

/** Relative to the harness state directory, `$HOME/.ai-sdk-harness`. */
export const ANTIGRAVITY_BOOTSTRAP_DIR = '.harness-bootstrap/antigravity'
/** The CLI's path relative to the bootstrap directory. */
export const ANTIGRAVITY_CLI_PATH = 'bin/agy'

const RELEASES = 'https://github.com/google-antigravity/antigravity-cli/releases/download'

/**
 * Downloads the pinned release for the sandbox's OS and architecture, checks its sha256 and
 * unpacks the single `antigravity` binary as `bin/agy`. The Linux builds need glibc (Debian,
 * Ubuntu).
 */
export function antigravityInstallScript(version = ANTIGRAVITY_CLI_VERSION): string {
  return `set -eu
case "$(uname -s) $(uname -m)" in
  "Linux x86_64"|"Linux amd64") build=linux_x64; sha=${ANTIGRAVITY_CLI_SHA256.x64} ;;
  "Linux aarch64"|"Linux arm64") build=linux_arm64; sha=${ANTIGRAVITY_CLI_SHA256.arm64} ;;
  "Darwin arm64") build=mac_arm64; sha=${ANTIGRAVITY_CLI_SHA256['darwin-arm64']} ;;
  *) echo "The Antigravity CLI has no build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o agy.tar.gz "${RELEASES}/${version}/agy_cli_$build.tar.gz"
node -e 'const h = require("crypto").createHash("sha256").update(require("fs").readFileSync("agy.tar.gz")).digest("hex"); if (h !== process.argv[1]) { console.error("agy.tar.gz does not match its sha256"); process.exit(1) }' "$sha"
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
