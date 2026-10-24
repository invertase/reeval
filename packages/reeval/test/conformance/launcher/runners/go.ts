// The Go SDK's `go tool reeval` launcher (sdks/go/cmd/reeval), built with `go build`. A record is
// compiled in by overlaying its generated sums.go, and the target pick runs pickTarget in a test
// file overlaid the same way.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Facts, Picked, Runner } from '../runner.ts'

const module = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../sdks/go')
const windows = process.platform === 'win32'

let work = ''
let exe = ''

function overlay(file: string, source: string): string {
  const path = join(work, file)
  writeFileSync(path, source)
  const json = join(work, `${file}.overlay.json`)
  writeFileSync(json, JSON.stringify({ Replace: { [join(module, 'cmd/reeval', file)]: path } }))
  return json
}

function build(overlayFile?: string) {
  execFileSync(
    'go',
    ['build', ...(overlayFile ? ['-overlay', overlayFile] : []), '-o', exe, './cmd/reeval'],
    { cwd: module, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit' },
  )
}

// pickTarget for each row of facts, with the architecture as GOARCH names it.
const PICK = `package main

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func TestConformancePick(t *testing.T) {
	var facts []struct {
		OS, Arch, Libc string
		AVX2           bool
	}
	data, err := os.ReadFile(os.Getenv("REEVAL_PICK_IN"))
	if err == nil {
		err = json.Unmarshal(data, &facts)
	}
	if err != nil {
		t.Fatal(err)
	}
	arch := map[string]string{"x64": "amd64", "arm64": "arm64", "ia32": "386", "riscv64": "riscv64"}
	out := []map[string]any{}
	for _, f := range facts {
		target, err := pickTarget(f.OS, arch[f.Arch], f.Libc == "musl", f.AVX2)
		var le *launchError
		if errors.As(err, &le) {
			out = append(out, map[string]any{"exit": le.code, "stderr": le.message})
		} else if err != nil {
			t.Fatal(err)
		} else {
			out = append(out, map[string]any{"target": target})
		}
	}
	data, _ = json.Marshal(out)
	if err := os.WriteFile(os.Getenv("REEVAL_PICK_OUT"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}
`

const runner: Runner = {
  name: 'go',
  interpreterEnv: 'REEVAL_GO',
  sidecars: ['.sha256'],
  async setup(dir) {
    work = dir
    exe = join(dir, windows ? 'reeval.exe' : 'reeval')
    build()
    return { command: [exe], file: exe }
  },
  // Go reads SSL_CERT_FILE on Linux only; macOS and Windows verify with the OS.
  trust: process.platform === 'linux' ? (caFile) => ({ SSL_CERT_FILE: caFile }) : undefined,
  async record(released) {
    if (!released) return build()
    const binaries = Object.values(released.binaries)
      .map(
        (b) =>
          `\t${JSON.stringify(b.name)}: {sha256: ${JSON.stringify(b.sha256)}, size: ${b.size}},\n`,
      )
      .join('')
    build(
      overlay(
        'sums.go',
        `package main\n\nvar sumsVersion = ${JSON.stringify(released.version)}\n\nvar releaseBinaries = map[string]binary{\n${binaries}}\n`,
      ),
    )
  },
  async pickTargets(facts: Facts[]): Promise<Picked[]> {
    const input = join(work, 'pick-in.json')
    const output = join(work, 'pick-out.json')
    writeFileSync(input, JSON.stringify(facts))
    execFileSync(
      'go',
      [
        'test',
        '-overlay',
        overlay('pick_conformance_test.go', PICK),
        '-count=1',
        '-run',
        '^TestConformancePick$',
        './cmd/reeval',
      ],
      {
        cwd: module,
        env: { ...process.env, CGO_ENABLED: '0', REEVAL_PICK_IN: input, REEVAL_PICK_OUT: output },
        // go test's own "ok" line on stdout would read as a TAP result.
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    )
    return JSON.parse(readFileSync(output, 'utf8'))
  },
}

export default runner
