// reeval-python's `reeval` console script, installed from packages/reeval-python into a venv of
// its own (a regular install, not editable), as `uv add reeval-python` would.
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Facts, Picked, Runner } from '../runner.ts'

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../reeval-python')
const windows = process.platform === 'win32'

let python = ''
let pkg = ''

// cli.target() with its detection replaced by each row's facts, and the machine named as
// platform.machine() names it on that OS.
const PICK = `
import json, sys
from reeval_python import cli
out = []
for f in json.load(sys.stdin):
    machine = {
        "x64": "AMD64" if f["os"] == "windows" else "x86_64",
        "arm64": {"windows": "ARM64", "darwin": "arm64"}.get(f["os"], "aarch64"),
        "ia32": "i686",
        "riscv64": "riscv64",
    }[f["arch"]]
    system = {"windows": "win32", "freebsd": "freebsd14"}.get(f["os"], f["os"])
    cli.musl = lambda f=f: f["libc"] == "musl"
    cli.avx2 = lambda _system, f=f: f["avx2"]
    try:
        out.append({"target": cli.target(system, machine)})
    except cli.ShimError as error:
        out.append({"exit": error.code, "stderr": str(error)})
print(json.dumps(out))
`

const runner: Runner = {
  name: 'python',
  interpreterEnv: 'REEVAL_PYTHON',
  sidecars: ['.sha256'],
  async setup(work) {
    const venv = join(work, 'venv')
    execFileSync('uv', ['venv', '--quiet', '--python', '>=3.11', venv], { stdio: 'inherit' })
    python = join(venv, windows ? 'Scripts/python.exe' : 'bin/python')
    execFileSync('uv', ['pip', 'install', '--quiet', '--python', python, '--reinstall', sdk], {
      stdio: 'inherit',
    })
    pkg = execFileSync(
      python,
      ['-c', 'import reeval_python, os; print(os.path.dirname(reeval_python.__file__))'],
      {
        encoding: 'utf8',
      },
    ).trim()
    const script = join(venv, windows ? 'Scripts/reeval.exe' : 'bin/reeval')
    return { command: [script], file: script }
  },
  trust: (caFile) => ({ SSL_CERT_FILE: caFile }),
  async record(released) {
    if (!pkg) return
    const file = join(pkg, 'binaries.json')
    if (released) writeFileSync(file, JSON.stringify(released))
    else rmSync(file, { force: true })
  },
  async pickTargets(facts: Facts[]): Promise<Picked[]> {
    return JSON.parse(
      execFileSync(python, ['-c', PICK], { input: JSON.stringify(facts), encoding: 'utf8' }),
    )
  },
}

export default runner
