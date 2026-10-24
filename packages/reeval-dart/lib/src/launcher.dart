import 'dart:async';
import 'dart:convert';
import 'dart:ffi'
    show Abi, DynamicLibrary, DynamicLibraryExtension, Int32, Uint32;
import 'dart:io';
import 'dart:math';
import 'dart:typed_data' show BytesBuilder;

import 'package:crypto/crypto.dart';

import 'binaries.g.dart';
import 'version.dart';

/// reeval's own exit codes for what the launcher refuses or can't fetch.
const _usage = 2;
const _infra = 3;

/// Set on the binary's environment to the binary the launcher ran, so a
/// `REEVAL_BINARY` that is this launcher again stops instead of looping.
const _launched = 'REEVAL_LAUNCHER_BINARY';

/// The sha256 and size of each target's binary for one reeval version.
typedef ReleasedBinaries = ({
  String version,
  Map<String, ({String sha256, int size})> binaries,
});

/// The binaries this package was published with.
const ReleasedBinaries publishedBinaries = (
  version: binariesVersion,
  binaries: releasedBinaries,
);

final class LaunchError implements Exception {
  LaunchError(this.code, this.message);
  final int code;
  final String message;
}

/// Finds the reeval binary for this package's version (fetching, checking and
/// caching it on first use), runs it with [args] and returns its exit code.
Future<int> launch(
  List<String> args, {
  Map<String, String>? environment,
}) async {
  final env = environment ?? Platform.environment;
  try {
    final binary = await locateBinary(env);
    return await _run(binary, args, env);
  } on LaunchError catch (error) {
    stderr.writeln('reeval: ${error.message}');
    return error.code;
  }
}

/// The lookup order: `REEVAL_BINARY`, the cache, then a download unless
/// `REEVAL_OFFLINE=1`. pub can't ship a per-platform binary, so there's no
/// bundled copy.
///
/// A download of the version this package was published with must match the
/// sha256 published in it ([released]), and the release's `SHA256SUMS` must
/// agree. Another version (`REEVAL_VERSION`), or a package that wasn't
/// published (a git or path dependency, whose [released] is empty), is checked
/// against `SHA256SUMS` alone.
Future<String> locateBinary(
  Map<String, String> env, {
  ReleasedBinaries released = publishedBinaries,
}) async {
  final override = env['REEVAL_BINARY'];
  if (override != null && override.isNotEmpty) {
    final binary = File(override).absolute.path;
    if (!File(binary).existsSync()) {
      throw LaunchError(
        _usage,
        'REEVAL_BINARY is $override, which is not a file',
      );
    }
    if (env[_launched] == binary) {
      throw LaunchError(
        _usage,
        'REEVAL_BINARY is $override, which runs this launcher again rather '
        'than reeval. Point it at a reeval binary',
      );
    }
    return binary;
  }
  final version = env['REEVAL_VERSION']?.trim().replaceFirst(RegExp('^v'), '');
  final v = version == null || version.isEmpty ? packageVersion : version;
  final platform = target();
  final asset = 'reeval-$v-$platform${Platform.isWindows ? '.exe' : ''}';
  final cached = File(_join([cacheRoot(env), 'bin', v, asset]));
  final recorded = v == released.version;
  final want = recorded ? released.binaries[platform] : null;
  final size = cached.existsSync() ? cached.lengthSync() : null;
  if (size != null && size > 0 && (want == null || size == want.size)) {
    if (_isProgram(cached)) return cached.path;
    _remove(cached);
    throw LaunchError(
      _infra,
      '${cached.path} is not a program this machine can run, so it was '
      'removed from the cache and the next run downloads it again. Set '
      'REEVAL_BINARY to a reeval binary to run instead',
    );
  }
  if (size != null) _remove(cached);
  if (env['REEVAL_OFFLINE'] == '1') {
    throw LaunchError(
      _usage,
      'REEVAL_OFFLINE is set and reeval $v is not cached. Put the binary at '
      '${cached.path}, or set REEVAL_BINARY',
    );
  }
  final base = _trimSlash(
    env['REEVAL_DOWNLOAD'] ??
        'https://github.com/invertase/reeval/releases/download/v$v',
  );
  if (base.startsWith('http:')) {
    stderr.writeln(
      "reeval: warning: REEVAL_DOWNLOAD is $base, which isn't https",
    );
  }
  if (recorded && want == null) {
    throw LaunchError(
      _infra,
      'package:reeval $v was published with no reeval binary for '
      '$platform. Set REEVAL_BINARY to a reeval binary',
    );
  }
  final client = base.startsWith('file:') ? null : _client(env);
  try {
    final sums = latin1.decode(await _fetch(client, '$base/SHA256SUMS'));
    final listed = _sumFor(sums, asset);
    final String expected;
    final String source;
    if (want == null) {
      final why = released.version.isEmpty
          ? 'records no binary hashes'
          : 'was published with reeval ${released.version}, not $v';
      stderr.writeln(
        'reeval: this package:reeval $why, so $asset is checked against '
        '$base/SHA256SUMS only',
      );
      expected =
          listed ??
          (throw LaunchError(
            _infra,
            '$base/SHA256SUMS has no entry for $asset',
          ));
      source = 'SHA256SUMS says';
    } else {
      expected = want.sha256;
      if (listed != null && listed != expected) {
        throw LaunchError(
          _infra,
          '$base/SHA256SUMS lists $asset as $listed, but package:reeval $v '
          "was published with $expected. The release has changed; don't run "
          'it',
        );
      }
      source = 'package:reeval $v was published with';
    }
    stderr.writeln('reeval: downloading $asset');
    final bytes = await _fetch(client, '$base/$asset');
    final actual = sha256.convert(bytes).toString();
    if (actual != expected) {
      throw LaunchError(
        _infra,
        '$base/$asset has sha256 $actual, but $source $expected',
      );
    }
    _store(bytes, cached);
  } finally {
    client?.close(force: true);
  }
  await _checkStarts(cached, asset);
  return cached.path;
}

/// Writes [bytes] to [cached] whole or not at all, so a crash or a full disk
/// leaves no binary behind.
void _store(List<int> bytes, File cached) {
  // Containers each have their own PID 1, so a PID alone could name another
  // machine's write to a shared cache.
  final partial = File('${cached.path}.$pid-${_nonce()}.partial');
  try {
    cached.parent.createSync(recursive: true);
    partial.writeAsBytesSync(bytes, flush: true);
    if (!Platform.isWindows) {
      final chmod = Process.runSync('chmod', ['755', partial.path]);
      if (chmod.exitCode != 0) {
        throw LaunchError(_infra, 'could not make ${partial.path} executable');
      }
    }
    try {
      partial.renameSync(cached.path);
    } on FileSystemException {
      // Windows won't rename over a binary a concurrent first run cached.
      if (!cached.existsSync() || cached.lengthSync() != bytes.length) rethrow;
    }
  } on FileSystemException catch (error) {
    throw LaunchError(
      _infra,
      'could not write ${cached.path} (${error.osError?.message ?? error.message}). '
      'Free some space or set XDG_CACHE_HOME to a writable directory, or set '
      'REEVAL_BINARY to a reeval binary',
    );
  } finally {
    if (partial.existsSync()) partial.deleteSync();
  }
}

/// Runs the cached binary with `--version`, and drops it from the cache unless
/// it starts: a CPU without an instruction the build needs kills it outright,
/// before reeval can say why.
Future<void> _checkStarts(File binary, String asset) async {
  String why;
  try {
    final process = await Process.start(binary.path, ['--version']);
    final said = process.stderr
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .firstWhere((line) => line.trim().isNotEmpty, orElse: () => '');
    unawaited(process.stdout.drain<void>());
    final code = await process.exitCode
        .then<int?>((code) => code)
        .timeout(const Duration(seconds: 60), onTimeout: () => null);
    if (code == 0) return;
    if (code == null) {
      process.kill(ProcessSignal.sigkill);
      why = 'no answer to --version in 60 s';
    } else {
      final first = await said.timeout(
        const Duration(seconds: 1),
        onTimeout: () => '',
      );
      why = _describeExit(code) + (first.isEmpty ? '' : ': ${first.trim()}');
    }
  } on ProcessException catch (error) {
    why = error.message;
  }
  _remove(binary);
  throw LaunchError(
    _infra,
    "$asset doesn't start on this machine ($why), so it wasn't kept. Set "
    'REEVAL_BINARY to a reeval binary to run instead',
  );
}

String _describeExit(int code) {
  // STATUS_ILLEGAL_INSTRUCTION, as a Windows exit code.
  if (code == 0xC000001D || code == -1073741795) {
    return 'an illegal instruction';
  }
  if (code < 0 && !Platform.isWindows) return 'killed by signal ${-code}';
  return 'exit $code';
}

/// Whether [file] starts as a program does: ELF, Mach-O, PE or a `#!` script.
/// Anything else would be handed to `/bin/sh` by `execvp`, which exits 126 or
/// 127 as though reeval had.
bool _isProgram(File file) {
  final List<int> head;
  try {
    final open = file.openSync();
    try {
      head = open.readSync(4);
    } finally {
      open.closeSync();
    }
  } on FileSystemException {
    return false;
  }
  bool starts(List<int> magic) =>
      head.length >= magic.length &&
      Iterable<int>.generate(magic.length).every((i) => head[i] == magic[i]);
  return [
    [0x7f, 0x45, 0x4c, 0x46], // ELF
    [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], // Mach-O
    [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe], // universal Mach-O
    [0x4d, 0x5a], // PE
    [0x23, 0x21], // #!
  ].any(starts);
}

void _remove(File file) {
  try {
    if (file.existsSync()) file.deleteSync();
  } on FileSystemException {
    // A running binary can't be removed on Windows; the next run tries again.
  }
}

String _nonce() {
  final random = Random.secure();
  return [
    for (var i = 0; i < 8; i++) random.nextInt(256).toRadixString(16),
  ].map((b) => b.padLeft(2, '0')).join();
}

/// The release target for this machine: `linux-x64-musl`, `darwin-arm64`, ….
String target() {
  // Abi names read `<os>_<arch>`: linux_x64, macos_arm64, windows_ia32, ….
  final [os, arch] = Abi.current().toString().split('_');
  return pickTarget(os, arch, musl: os == 'linux' && _musl(), avx2: _avx2(os));
}

/// The release target for [os] and [arch], as [Abi] names them, on a machine
/// whose libc is [musl] and whose CPU has [avx2] or not. An x64 CPU without
/// AVX2 gets the `-baseline` build on Linux and Windows, as the install scripts
/// pick; there is no macOS one. Windows on ARM runs the x64 binary.
String pickTarget(
  String os,
  String arch, {
  required bool musl,
  required bool avx2,
}) {
  final cpu = const {'x64': 'x64', 'arm64': 'arm64'}[arch];
  if (cpu == null || !const {'linux', 'macos', 'windows'}.contains(os)) {
    throw LaunchError(
      _usage,
      "there's no reeval binary for $os $arch. Set REEVAL_BINARY to one you "
      'built, or use the npm package',
    );
  }
  if (os == 'macos') return 'darwin-$cpu';
  var name = os == 'windows'
      ? 'windows-x64'
      : 'linux-$cpu${musl ? '-musl' : ''}';
  if ((os == 'windows' || cpu == 'x64') && !avx2) name += '-baseline';
  return name;
}

/// Whether the CPU has AVX2, which the default x64 builds need.
bool _avx2(String os) {
  if (os == 'windows') {
    try {
      final present = DynamicLibrary.open('kernel32.dll')
          .lookupFunction<Int32 Function(Uint32), int Function(int)>(
            'IsProcessorFeaturePresent',
          );
      return present(40) != 0; // PF_AVX2_INSTRUCTIONS_AVAILABLE
    } on Object {
      return false;
    }
  }
  if (os != 'linux') return false;
  try {
    return RegExp(
      r'\bavx2\b',
    ).hasMatch(File('/proc/cpuinfo').readAsStringSync());
  } on FileSystemException {
    return false;
  }
}

/// Whether this process runs on musl, from the libc it has loaded: a musl
/// loader on disk proves nothing (Debian's `musl` package installs one beside
/// glibc).
bool _musl() {
  try {
    return mapsMusl(File('/proc/self/maps').readAsStringSync());
  } on FileSystemException {
    return !DynamicLibrary.process().providesSymbol('gnu_get_libc_version');
  }
}

/// Whether the libraries mapped in [maps], as `/proc/self/maps` lists them,
/// include musl's libc.
bool mapsMusl(String maps) => RegExp(
  r'/(ld-musl-[^/\s]*|libc\.musl-[^/\s]*)$',
  multiLine: true,
).hasMatch(maps);

/// The reeval binary's own cache directory, so both share one cache.
String cacheRoot(Map<String, String> env) {
  String? set(String name) {
    final value = env[name];
    return value == null || value.isEmpty ? null : value;
  }

  if (set('XDG_CACHE_HOME') case final xdg?) return _join([xdg, 'reeval']);
  if (Platform.isWindows) {
    final local =
        set('LOCALAPPDATA') ??
        _join([set('USERPROFILE') ?? '.', 'AppData', 'Local']);
    return _join([local, 'reeval']);
  }
  final home = set('HOME') ?? '.';
  return Platform.isMacOS
      ? _join([home, 'Library', 'Caches', 'reeval'])
      : _join([home, '.cache', 'reeval']);
}

String? _sumFor(String sums, String asset) {
  for (final line in sums.split('\n')) {
    final match = RegExp(r'^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$').firstMatch(line);
    if (match != null && match[2] == asset) return match[1]!.toLowerCase();
  }
  return null;
}

/// The HTTP client downloads from an HTTP mirror use. It trusts the
/// certificates in `SSL_CERT_FILE` instead of the system's when that is set,
/// as OpenSSL, Python and Go do.
HttpClient _client(Map<String, String> env) {
  SecurityContext? context;
  final certs = env['SSL_CERT_FILE'];
  if (certs != null && certs.isNotEmpty) {
    context = SecurityContext(withTrustedRoots: false);
    try {
      context.setTrustedCertificates(certs);
    } on Exception catch (error) {
      throw LaunchError(
        _usage,
        'SSL_CERT_FILE is $certs, which has no certificates Dart can read '
        '($error)',
      );
    }
  }
  return HttpClient(context: context)
    ..findProxy = HttpClient.findProxyFromEnvironment
    ..connectionTimeout = const Duration(seconds: 60);
}

Future<List<int>> _fetch(HttpClient? client, String url) async {
  final uri = Uri.parse(url);
  if (uri.scheme == 'file') {
    final file = File.fromUri(uri);
    if (!file.existsSync()) throw _downloadFailed(url, 'no such file');
    return file.readAsBytesSync();
  }
  if (client == null) throw _downloadFailed(url, 'no HTTP client');
  try {
    return await () async {
      var current = uri;
      for (var hops = 0; ; hops++) {
        final request = await client.getUrl(current);
        request.followRedirects = false;
        final response = await request.close();
        if (response.isRedirect) {
          final location = response.headers.value(HttpHeaders.locationHeader);
          await response.drain<void>();
          if (location == null || hops == 10) {
            throw _downloadFailed(url, 'too many redirects');
          }
          current = redirect(current, location);
          continue;
        }
        if (response.statusCode != HttpStatus.ok) {
          await response.drain<void>();
          throw _downloadFailed(url, 'HTTP ${response.statusCode}');
        }
        final bytes = BytesBuilder(copy: false);
        await response.forEach(bytes.add);
        return bytes.takeBytes();
      }
    }().timeout(const Duration(seconds: 60));
  } on LaunchError {
    rethrow;
  } on TimeoutException {
    throw _downloadFailed(url, 'timed out after 60 s');
  } on Exception catch (error) {
    throw _downloadFailed(url, '$error');
  }
}

/// Where a redirect from [from] to [location] goes. One from HTTPS must stay on
/// HTTPS, and none may leave HTTP for another scheme.
Uri redirect(Uri from, String location) {
  final to = from.resolve(location);
  final downgrade = from.scheme == 'https' && to.scheme != 'https';
  if (downgrade || (to.scheme != 'https' && to.scheme != 'http')) {
    throw LaunchError(
      _infra,
      'refusing the redirect from $from to $to, which leaves HTTPS',
    );
  }
  return to;
}

LaunchError _downloadFailed(String url, String why) => LaunchError(
  _infra,
  'could not download $url ($why). Set REEVAL_DOWNLOAD to a mirror of the '
  'release, or REEVAL_BINARY to a reeval binary',
);

/// Dart can't replace its process, so the binary runs as a child with this
/// process's stdio. A Ctrl-C reaches the child too (one process group, or one
/// Windows console), so the launcher ignores it and waits for reeval to clean
/// up and exit, then exits with its code; SIGTERM and SIGHUP are passed on.
Future<int> _run(
  String binary,
  List<String> args,
  Map<String, String> env,
) async {
  final childEnv = {
    ...env,
    _launched: binary,
    if ((env['REEVAL_DART'] ?? '').isEmpty)
      'REEVAL_DART': Platform.resolvedExecutable,
  };
  final Process child;
  try {
    child = await Process.start(
      binary,
      args,
      environment: childEnv,
      includeParentEnvironment: false,
      mode: ProcessStartMode.inheritStdio,
    );
  } on ProcessException catch (error) {
    var message = 'could not run $binary: ${error.message}.';
    if (binary.startsWith('${cacheRoot(env)}${Platform.pathSeparator}')) {
      _remove(File(binary));
      message +=
          " It's been removed from the cache, so the next run downloads "
          'it again.';
    }
    throw LaunchError(
      _infra,
      '$message Set REEVAL_BINARY to a reeval binary to run instead',
    );
  }
  final subscriptions = <StreamSubscription<ProcessSignal>>[
    ProcessSignal.sigint.watch().listen((_) {}),
    if (!Platform.isWindows)
      for (final signal in [ProcessSignal.sigterm, ProcessSignal.sighup])
        signal.watch().listen(child.kill),
  ];
  final code = await child.exitCode;
  for (final subscription in subscriptions) {
    await subscription.cancel();
  }
  return code < 0 && !Platform.isWindows ? 128 - code : code;
}

String _join(List<String> parts) => parts.join(Platform.pathSeparator);

String _trimSlash(String s) =>
    s.endsWith('/') ? s.substring(0, s.length - 1) : s;
