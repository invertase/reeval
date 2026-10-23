import 'dart:async';
import 'dart:ffi' show Abi, DynamicLibrary;
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

/// The sha256 of each target's binary for one reeval version.
typedef BinaryHashes = ({String version, Map<String, String> sha256});

/// The hashes this package was published with.
const BinaryHashes publishedHashes = (
  version: binariesVersion,
  sha256: binarySha256,
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
/// A download of the version this package was published with is checked
/// against the hashes published in it ([hashes]), so the release's own
/// `SHA256SUMS` isn't trusted. Another version (`REEVAL_VERSION`), or a
/// package that wasn't published (a git or path dependency, whose [hashes] are
/// empty), is checked against `SHA256SUMS`.
Future<String> locateBinary(
  Map<String, String> env, {
  BinaryHashes hashes = publishedHashes,
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
  final platform = target(env);
  final asset = 'reeval-$v-$platform${Platform.isWindows ? '.exe' : ''}';
  final cached = File(_join([cacheRoot(env), 'bin', v, asset]));
  if (cached.existsSync()) return cached.path;
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
  stderr.writeln('reeval: downloading $asset');
  final published = v == hashes.version && hashes.sha256.isNotEmpty;
  final String expected;
  final String source;
  if (published) {
    expected =
        hashes.sha256[platform] ??
        (throw LaunchError(
          _infra,
          'package:reeval $v was published with no reeval binary for '
          '$platform. Set REEVAL_BINARY to a reeval binary',
        ));
    source = 'package:reeval $v was published with';
  } else {
    final sums = String.fromCharCodes(await _fetch('$base/SHA256SUMS'));
    expected =
        _sumFor(sums, asset) ??
        (throw LaunchError(_infra, '$base/SHA256SUMS has no entry for $asset'));
    source = 'SHA256SUMS says';
  }
  final bytes = await _fetch('$base/$asset');
  final actual = sha256.convert(bytes).toString();
  if (actual != expected) {
    throw LaunchError(
      _infra,
      '$base/$asset has sha256 $actual, but $source $expected',
    );
  }
  cached.parent.createSync(recursive: true);
  // Containers each have their own PID 1, so a PID alone could name another
  // machine's write to a shared cache.
  final partial = File('${cached.path}.$pid-${_nonce()}.partial');
  try {
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
      if (!cached.existsSync()) rethrow;
    }
  } finally {
    if (partial.existsSync()) partial.deleteSync();
  }
  return cached.path;
}

String _nonce() {
  final random = Random.secure();
  return [
    for (var i = 0; i < 8; i++) random.nextInt(256).toRadixString(16),
  ].map((b) => b.padLeft(2, '0')).join();
}

/// The release target for this machine: `linux-x64-musl`, `darwin-arm64`, ….
String target(Map<String, String> env) {
  final abi = Abi.current();
  final name = switch (abi) {
    Abi.linuxX64 => 'linux-x64',
    Abi.linuxArm64 => 'linux-arm64',
    Abi.macosX64 => 'darwin-x64',
    Abi.macosArm64 => 'darwin-arm64',
    Abi.windowsX64 => 'windows-x64',
    _ => throw LaunchError(_usage, 'reeval has no binary for $abi'),
  };
  return Platform.isLinux && _musl() ? '$name-musl' : name;
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

Future<List<int>> _fetch(String url) async {
  final uri = Uri.parse(url);
  if (uri.scheme == 'file') {
    final file = File.fromUri(uri);
    if (!file.existsSync()) throw _downloadFailed(url, 'no such file');
    return file.readAsBytesSync();
  }
  final client = HttpClient()
    ..findProxy = HttpClient.findProxyFromEnvironment
    ..connectionTimeout = const Duration(seconds: 60);
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
  } finally {
    client.close(force: true);
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
    throw LaunchError(_usage, 'could not run $binary: ${error.message}');
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
  return code < 0 ? 128 - code : code;
}

String _join(List<String> parts) => parts.join(Platform.pathSeparator);

String _trimSlash(String s) =>
    s.endsWith('/') ? s.substring(0, s.length - 1) : s;
