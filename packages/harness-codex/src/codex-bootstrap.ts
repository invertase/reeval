import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The Codex release the bootstrap installs, checked against npm's published sha512s. */
export const CODEX_CLI_VERSION = '0.164.0'
/**
 * The `dist.integrity` of `@openai/codex@<version>-<platform>`, its native builds: Linux's for
 * each arch, and macOS's for Apple Silicon (a Tart VM).
 */
export const CODEX_CLI_INTEGRITY = {
  x64: 'sha512-XLAoaWsGOT2khzl+P4FYDPTkzAr9W0VFXFaVkqlFdkM0soa1gH/4S0wSD57Ek3HHwkirAEGz2/Mwehseh+l5Mg==',
  arm64:
    'sha512-LL5iTQjyDL4YRX44EWqhIfEQ5uGnmgxkQBJSxjZSeJ8L1Og83pdlzUJW/PRJ76oaVwOVgh6HXwuPEiBNEHU4lg==',
  'darwin-arm64':
    'sha512-pDizgOUAtq3/k3AbUFHbaU19WpYKCja+oFpNSTLKrDQj4lTUNSDuTPJip4uQVn2/1EipQdpQrGMOQBVuI1znAA==',
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
  "Darwin "*) echo "reeval runs Codex on macOS in tart(), which needs Apple Silicon, not $(uname -m)" >&2; exit 1 ;;
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
