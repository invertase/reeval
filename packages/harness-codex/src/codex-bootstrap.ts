import type { HarnessV1Bootstrap } from '@ai-sdk/harness'

/** The Codex release the bootstrap installs, checked against npm's published sha512s. */
export const CODEX_CLI_VERSION = '0.160.0'
/** The `dist.integrity` of `@openai/codex@<version>-linux-<arch>`, its native build for Linux. */
export const CODEX_CLI_INTEGRITY = {
  x64: 'sha512-KI/73OqGrHmR18s7ya7E1NqV6rT0y3lxr0s8S1qR2m6zU6QRF/HlR529jALLh5vjdUnsRT4Ahoxt0axb4kY99g==',
  arm64:
    'sha512-VnVdsS06YlDsL8OwaJjQ3xdqdJNG4i+eBJBV3LytddknzSaF/urijLzVg3ptkwvoj8C7Gn7iWpVE+y8WEaPiCg==',
} as const
/** Relative to the harness state directory, `$HOME/.ai-sdk-harness`. */
export const CODEX_BOOTSTRAP_DIR = '.harness-bootstrap/codex'
/**
 * The CLI and the `rg` it searches with, relative to the bootstrap directory; the directory goes
 * first on the turn's `PATH`, as the npm package's launcher puts it.
 */
export const CODEX_BIN_DIR = 'bin'

/**
 * Downloads the pinned native build for the sandbox's arch from npm, checks its sha512, and links
 * `codex` and `rg` into `bin/`. The npm package's Node launcher only picks this build and adds its
 * `rg` to `PATH`, so the adapter runs the binary itself.
 */
export const CODEX_INSTALL_COMMAND = `set -eu
case "$(uname -m)" in
  x86_64|amd64) arch=x64 triple=x86_64-unknown-linux-musl sri=${CODEX_CLI_INTEGRITY.x64} ;;
  aarch64|arm64) arch=arm64 triple=aarch64-unknown-linux-musl sri=${CODEX_CLI_INTEGRITY.arm64} ;;
  *) echo "Codex has no Linux build for $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o codex.tgz "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-linux-$arch.tgz"
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
