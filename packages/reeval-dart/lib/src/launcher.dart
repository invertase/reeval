import 'dart:async';
import 'dart:ffi' show Abi;
import 'dart:io';
import 'dart:typed_data' show BytesBuilder;

import 'package:crypto/crypto.dart';

import 'version.dart';

/// reeval's own exit codes for what the launcher refuses or can't fetch.
const _usage = 2;
const _infra = 3;

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
Future<String> locateBinary(Map<String, String> env) async {
  final override = env['REEVAL_BINARY'];
  if (override != null && override.isNotEmpty) {
    if (!File(override).existsSync()) {
      throw LaunchError(
        _usage,
        'REEVAL_BINARY is $override, which is not a file',
      );
    }
    return override;
  }
  final version = env['REEVAL_VERSION']?.trim().replaceFirst(RegExp('^v'), '');
  final v = version == null || version.isEmpty ? packageVersion : version;
  final asset = 'reeval-$v-${target(env)}${Platform.isWindows ? '.exe' : ''}';
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
  final sums = String.fromCharCodes(await _fetch('$base/SHA256SUMS'));
  final expected = _sumFor(sums, asset);
  if (expected == null) {
    throw LaunchError(_infra, '$base/SHA256SUMS has no entry for $asset');
  }
  final bytes = await _fetch('$base/$asset');
  final actual = sha256.convert(bytes).toString();
  if (actual != expected) {
    throw LaunchError(
      _infra,
      '$base/$asset has sha256 $actual, but SHA256SUMS says $expected',
    );
  }
  cached.parent.createSync(recursive: true);
  final partial = File('${cached.path}.$pid.partial');
  partial.writeAsBytesSync(bytes, flush: true);
  if (!Platform.isWindows) {
    final chmod = Process.runSync('chmod', ['755', partial.path]);
    if (chmod.exitCode != 0) {
      partial.deleteSync();
      throw LaunchError(_infra, 'could not make ${partial.path} executable');
    }
  }
  partial.renameSync(cached.path);
  return cached.path;
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

bool _musl() {
  if (File('/etc/alpine-release').existsSync()) return true;
  final lib = Directory('/lib');
  return lib.existsSync() &&
      lib.listSync().any((e) => _base(e.path).startsWith('ld-musl-'));
}

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
      final request = await client.getUrl(uri);
      final response = await request.close();
      if (response.statusCode != HttpStatus.ok) {
        await response.drain<void>();
        throw _downloadFailed(url, 'HTTP ${response.statusCode}');
      }
      final bytes = BytesBuilder(copy: false);
      await response.forEach(bytes.add);
      return bytes.takeBytes();
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

LaunchError _downloadFailed(String url, String why) => LaunchError(
  _infra,
  'could not download $url ($why). Set REEVAL_DOWNLOAD to a mirror of the '
  'release, or REEVAL_BINARY to a reeval binary',
);

/// Dart can't replace its process, so the binary runs as a child with this
/// process's stdio. A terminal's Ctrl-C reaches the child too (one process
/// group), so the launcher only outlives it; SIGTERM is passed on.
Future<int> _run(
  String binary,
  List<String> args,
  Map<String, String> env,
) async {
  final childEnv = {
    ...env,
    if ((env['REEVAL_DART'] ?? '').isEmpty)
      'REEVAL_DART': Platform.resolvedExecutable,
  };
  final child = await Process.start(
    binary,
    args,
    environment: childEnv,
    includeParentEnvironment: false,
    mode: ProcessStartMode.inheritStdio,
  );
  var interrupted = false;
  final subscriptions = <StreamSubscription<ProcessSignal>>[
    ProcessSignal.sigint.watch().listen((_) => interrupted = true),
    if (!Platform.isWindows)
      ProcessSignal.sigterm.watch().listen((_) => child.kill()),
  ];
  final code = await child.exitCode;
  for (final subscription in subscriptions) {
    await subscription.cancel();
  }
  if (Platform.isWindows && interrupted) return 130;
  return code < 0 ? 128 - code : code;
}

String _join(List<String> parts) => parts.join(Platform.pathSeparator);

String _base(String path) => path.split(Platform.pathSeparator).last;

String _trimSlash(String s) =>
    s.endsWith('/') ? s.substring(0, s.length - 1) : s;
