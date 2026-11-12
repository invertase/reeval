import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The Codex release the bootstrap installs, checked against npm's published sha512s. */
export const CODEX_CLI_VERSION = '0.167.2'
/**
 * The `dist.integrity` of `@openai/codex@<version>-<platform>`, its native builds: Linux's for
 * each arch, and macOS's for Apple Silicon (a Tart VM).
 */
export const CODEX_CLI_INTEGRITY = {
  x64: 'sha512-2Rw3VkWonMxwCSgOw+NkiKLOuOzyoQNWmxU7x8GniesdMfhKc4asNqOzTgQwJLKCrSlPc4/6fYTaH7fYcuGWGQ==',
  arm64:
    'sha512-x/PhPRq0X+hBZDqXKE0YIm4NZoSyCF99KcJJWRn0B2WNdmYk3eBDtjNO5+wl7zWMCBwjTOev5Tz2ZZ6+Y14YQA==',
  'darwin-arm64':
    'sha512-JB6L+L2jefDIaNgoHi7ePZKK1u2riDhlbwgm6zK57ZWpMGAYAwKgDYDb7l+xie7oUkRZuCVx307wsB/k4VsMKw==',
} as const
/** Relative to the harness state directory, `$HOME/.ai-sdk-harness`. */
export const CODEX_BOOTSTRAP_DIR = '.harness-bootstrap/codex'
/**
 * The CLI and the `rg` it searches with, relative to the bootstrap directory; the directory goes
 * first on the turn's `PATH`, as the npm package's launcher puts it.
 */
export const CODEX_BIN_DIR = 'bin'

/**
 * Downloads the pinned native build for the sandbox's OS and arch from npm, checks its sha512, and links
 * `codex` and `rg` into `bin/`. The npm package's Node launcher only picks this build and adds its
 * `rg` to `PATH`, so the adapter runs the binary itself.
 */
export const CODEX_INSTALL_COMMAND = `set -eu
case "$(uname -s) $(uname -m)" in
  "Linux x86_64"|"Linux amd64") arch=linux-x64 triple=x86_64-unknown-linux-musl sri=${CODEX_CLI_INTEGRITY.x64} ;;
  "Linux aarch64"|"Linux arm64") arch=linux-arm64 triple=aarch64-unknown-linux-musl sri=${CODEX_CLI_INTEGRITY.arm64} ;;
  "Darwin arm64") arch=darwin-arm64 triple=aarch64-apple-darwin sri=${CODEX_CLI_INTEGRITY['darwin-arm64']} ;;
  "Darwin "*) echo "reeval runs Codex on macOS on Apple Silicon only, not $(uname -m)" >&2; exit 1 ;;
  *) echo "Codex has no build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o codex.tgz "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-$arch.tgz"
node -e 'const h = "sha512-" + require("crypto").createHash("sha512").update(require("fs").readFileSync("codex.tgz")).digest("base64"); if (h !== process.argv[1]) { console.error("codex.tgz does not match its sha512"); process.exit(1) }' "$sri"
rm -rf package && tar -xzf codex.tgz && rm codex.tgz
mkdir -p ${CODEX_BIN_DIR}
ln -sf "$PWD/package/vendor/$triple/bin/codex" ${CODEX_BIN_DIR}/codex
ln -sf "$PWD/package/vendor/$triple/codex-path/rg" ${CODEX_BIN_DIR}/rg
${CODEX_BIN_DIR}/codex --version`

export async function getCodexBootstrap(): Promise<HarnessV1Bootstrap> {
  return {
    harnessId: 'codex',
    bootstrapDir: CODEX_BOOTSTRAP_DIR,
    files: [],
    commands: [{ command: CODEX_INSTALL_COMMAND }],
  }
}
