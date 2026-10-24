// package:reeval's `dart run reeval` launcher (packages/reeval-dart/bin/reeval.dart), compiled with
// `dart compile exe` from a copy of the package, whose generated binaries.g.dart holds a record.
import { execFileSync } from 'node:child_process'
import { cpSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Facts, Picked, Released, Runner } from '../runner.ts'

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../reeval-dart')
const windows = process.platform === 'win32'

let copy = ''
let exe = ''
let built: string | undefined

// pickTarget() for each row's facts, with the OS named as Dart's Abi names it.
const PICK = `
import 'dart:convert';
import 'dart:io';
import 'package:reeval/src/launcher.dart';

void main() {
  final rows = jsonDecode(stdin.readLineSync()!) as List<dynamic>;
  final out = [
    for (final f in rows.cast<Map<String, dynamic>>())
      () {
        final os = const {'darwin': 'macos'}[f['os']] ?? f['os'] as String;
        try {
          return {
            'target': pickTarget(os, f['arch'] as String,
                musl: f['libc'] == 'musl', avx2: f['avx2'] as bool),
          };
        } on LaunchError catch (e) {
          return {'exit': e.code, 'stderr': e.message};
        }
      }(),
  ];
  print(jsonEncode(out));
}
`

// Compiling takes seconds, so only a changed record recompiles.
function build(released: Released | null) {
  const key = JSON.stringify(released)
  if (key === built) return
  built = key
  const entries = Object.entries(released?.binaries ?? {})
    .map(
      ([target, b]) =>
        `  ${JSON.stringify(target)}: (sha256: ${JSON.stringify(b.sha256)}, size: ${b.size}),\n`,
    )
    .join('')
  writeFileSync(
    join(copy, 'lib/src/binaries.g.dart'),
    `const binariesVersion = ${JSON.stringify(released?.version ?? '')};\n\nconst releasedBinaries = <String, ({String sha256, int size})>{\n${entries}};\n`,
  )
  execFileSync('dart', ['compile', 'exe', '--verbosity', 'error', 'bin/reeval.dart', '-o', exe], {
    cwd: copy,
    stdio: 'inherit',
    shell: windows,
  })
}

const runner: Runner = {
  name: 'dart',
  interpreterEnv: 'REEVAL_DART',
  sidecars: ['.sha256'],
  async setup(work) {
    copy = join(work, 'reeval-dart')
    exe = join(work, windows ? 'reeval.exe' : 'reeval')
    cpSync(sdk, copy, { recursive: true, filter: (src) => !src.includes('.dart_tool') })
    execFileSync('dart', ['pub', 'get'], { cwd: copy, stdio: 'ignore', shell: windows })
    writeFileSync(join(copy, 'bin/pick.dart'), PICK)
    build(null)
    return { command: [exe], file: exe }
  },
  trust: (caFile) => ({ SSL_CERT_FILE: caFile }),
  async record(released) {
    build(released)
  },
  async pickTargets(facts: Facts[]): Promise<Picked[]> {
    return JSON.parse(
      execFileSync('dart', ['bin/pick.dart'], {
        cwd: copy,
        input: `${JSON.stringify(facts)}\n`,
        encoding: 'utf8',
        shell: windows,
      }),
    )
  },
}

export default runner
