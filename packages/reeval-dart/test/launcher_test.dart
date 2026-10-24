@TestOn('linux || mac-os')
library;

import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:reeval/src/launcher.dart';
import 'package:reeval/src/version.dart';
import 'package:test/test.dart';

void main() {
  late Directory temp;
  late String release;
  late String cache;
  late String asset;
  late Map<String, String> env;

  const script =
      '#!/bin/sh\n[ "\$*" = --version ] && exit 0\n'
      'echo "fake reeval \$*"\nexit 7\n';

  void publish({String? sum}) {
    File(p.join(release, asset)).writeAsStringSync(script);
    final hash = sum ?? sha256.convert(script.codeUnits).toString();
    File(
      p.join(release, 'SHA256SUMS'),
    ).writeAsStringSync('$hash  other-file\n$hash *$asset\n');
  }

  Future<ProcessResult> launcher(List<String> args) => Process.run(
    Platform.resolvedExecutable,
    ['run', 'bin/reeval.dart', ...args],
    environment: env,
    includeParentEnvironment: false,
  );

  setUp(() {
    temp = Directory.systemTemp.createTempSync('reeval-launcher-');
    release = p.join(temp.path, 'release');
    cache = p.join(temp.path, 'cache');
    Directory(release).createSync();
    final base = {'PATH': Platform.environment['PATH'] ?? ''};
    asset = 'reeval-$packageVersion-${target()}';
    env = {
      ...base,
      'HOME': temp.path,
      'XDG_CACHE_HOME': cache,
      'REEVAL_DOWNLOAD': Uri.directory(release).toString(),
      'PUB_CACHE': ?Platform.environment['PUB_CACHE'],
    };
  });

  tearDown(() => temp.deleteSync(recursive: true));

  test(
    'downloads, checks, caches and runs the binary with its arguments',
    () async {
      publish();
      final result = await launcher(['run', '--dry-run']);
      expect(result.stdout, 'fake reeval run --dry-run\n');
      expect(result.stderr, contains('records no binary hashes'));
      expect(result.stderr, endsWith('reeval: downloading $asset\n'));
      expect(result.exitCode, 7);
      final cached = File(
        p.join(cache, 'reeval', 'bin', packageVersion, asset),
      );
      expect(cached.existsSync(), isTrue);
      expect(
        Directory(cached.parent.path).listSync().map((e) => e.path),
        unorderedEquals([cached.path, '${cached.path}.sha256']),
      );
    },
  );

  test('runs from the cache offline, without downloading', () async {
    publish();
    await launcher([]);
    File(p.join(release, asset)).deleteSync();
    env['REEVAL_OFFLINE'] = '1';
    final result = await launcher(['status']);
    expect(result.stdout, 'fake reeval status\n');
    expect(result.stderr, isEmpty);
  });

  test('refuses a checksum mismatch with exit 3 and caches nothing', () async {
    publish(sum: '0' * 64);
    final result = await launcher([]);
    expect(result.exitCode, 3);
    expect(result.stderr, contains('but SHA256SUMS says ${'0' * 64}'));
    expect(Directory(p.join(cache, 'reeval')).existsSync(), isFalse);
  });

  test(
    'a release without the binary is exit 3, naming the escape hatches',
    () async {
      File(p.join(release, 'SHA256SUMS')).writeAsStringSync('');
      final result = await launcher([]);
      expect(result.exitCode, 3);
      expect(result.stderr, contains('no entry for $asset'));
      File(p.join(release, 'SHA256SUMS')).deleteSync();
      final missing = await launcher([]);
      expect(missing.exitCode, 3);
      expect(missing.stderr, contains('REEVAL_DOWNLOAD'));
      expect(missing.stderr, contains('REEVAL_BINARY'));
    },
  );

  test(
    'offline with nothing cached is exit 2, naming the path to pre-seed',
    () async {
      env['REEVAL_OFFLINE'] = '1';
      final result = await launcher([]);
      expect(result.exitCode, 2);
      expect(
        result.stderr,
        contains(p.join(cache, 'reeval', 'bin', packageVersion, asset)),
      );
    },
  );

  test('REEVAL_BINARY wins, and must be a file', () async {
    final binary = File(p.join(temp.path, 'mine'))..writeAsStringSync(script);
    Process.runSync('chmod', ['755', binary.path]);
    env['REEVAL_BINARY'] = binary.path;
    final result = await launcher(['x']);
    expect(result.stdout, 'fake reeval x\n');
    env['REEVAL_BINARY'] = p.join(temp.path, 'missing');
    final bad = await launcher([]);
    expect(bad.exitCode, 2);
    expect(bad.stderr, contains('not a file'));
  });

  test('REEVAL_VERSION picks another release', () async {
    env['REEVAL_VERSION'] = 'v9.9.9';
    asset = 'reeval-9.9.9-${target()}';
    publish();
    final result = await launcher([]);
    expect(result.exitCode, 7);
    expect(
      File(p.join(cache, 'reeval', 'bin', '9.9.9', asset)).existsSync(),
      isTrue,
    );
  });

  test('the binary sees REEVAL_DART, the Dart that ran the launcher', () async {
    final binary = File(p.join(temp.path, 'env'))
      ..writeAsStringSync('#!/bin/sh\necho "\$REEVAL_DART"\n');
    Process.runSync('chmod', ['755', binary.path]);
    env['REEVAL_BINARY'] = binary.path;
    final result = await launcher([]);
    expect(result.stdout, '${Platform.resolvedExecutable}\n');
  });

  group('a download of the published version', () {
    late String hash;
    late String platform;

    ReleasedBinaries record(Map<String, String> sums, {int? size}) => (
      version: packageVersion,
      binaries: {
        for (final MapEntry(:key, :value) in sums.entries)
          key: (sha256: value, size: size ?? script.length),
      },
    );

    setUp(() {
      platform = target();
      hash = sha256.convert(script.codeUnits).toString();
      publish();
    });

    Matcher refused(String message) => throwsA(
      isA<LaunchError>()
          .having((e) => e.code, 'code', 3)
          .having((e) => e.message, 'message', contains(message)),
    );

    test('is checked against the hashes published in the package', () async {
      final binary = await locateBinary(
        env,
        released: record({platform: hash}),
      );
      expect(File(binary).readAsStringSync(), script);
    });

    test('refuses an asset other than the published one, with exit 3', () {
      publish(sum: '0' * 64);
      expect(
        locateBinary(env, released: record({platform: '0' * 64})),
        refused(
          'package:reeval $packageVersion was published with ${'0' * 64}',
        ),
      );
    });

    test('refuses a SHA256SUMS that disagrees with the package', () {
      expect(
        locateBinary(env, released: record({platform: '0' * 64})),
        refused('SHA256SUMS lists $asset as $hash'),
      );
    });

    test('refuses a target the package was published without', () {
      expect(
        locateBinary(env, released: record({'other': hash})),
        refused(platform),
      );
    });

    test('downloads a cached file of another size again', () async {
      final cached = File(p.join(cache, 'reeval', 'bin', packageVersion, asset))
        ..createSync(recursive: true)
        ..writeAsStringSync('#!/bin/sh\n');
      await locateBinary(env, released: record({platform: hash}));
      expect(cached.readAsStringSync(), script);
    });

    test('uses SHA256SUMS for a version the package has no hashes for', () {
      expect(
        locateBinary(
          env,
          released: (
            version: '0.0.1',
            binaries: {platform: (sha256: '0' * 64, size: 1)},
          ),
        ),
        completes,
      );
    });
  });

  test(
    'a cached binary rewritten since its download is fetched again',
    () async {
      publish();
      final cached = File(
        p.join(cache, 'reeval', 'bin', packageVersion, asset),
      );
      await locateBinary(env);
      expect(
        File('${cached.path}.sha256').readAsStringSync(),
        startsWith(sha256.convert(script.codeUnits).toString()),
      );
      final mtime = cached.lastModifiedSync();
      cached.writeAsStringSync(script.replaceFirst('exit 7', 'exit 8'));
      cached.setLastModifiedSync(mtime);
      await locateBinary(env);
      expect(cached.readAsStringSync(), script);
    },
  );

  test('a cached file that is no program is removed, with exit 3', () async {
    final cached = File(p.join(cache, 'reeval', 'bin', packageVersion, asset))
      ..createSync(recursive: true)
      ..writeAsBytesSync([0, 1, 2, 3]);
    final result = await launcher([]);
    expect(result.exitCode, 3);
    expect(result.stderr, contains(cached.path));
    expect(cached.existsSync(), isFalse);
  });

  test("a download that doesn't start isn't kept", () async {
    const broken = '#!/bin/sh\necho "Illegal instruction" >&2\nexit 132\n';
    File(p.join(release, asset)).writeAsStringSync(broken);
    final hash = sha256.convert(broken.codeUnits).toString();
    File(p.join(release, 'SHA256SUMS')).writeAsStringSync('$hash  $asset\n');
    final result = await launcher([]);
    expect(result.exitCode, 3);
    expect(result.stderr, contains("doesn't start on this machine (exit 132"));
    expect(
      Directory(p.join(cache, 'reeval', 'bin')).listSync(recursive: true),
      everyElement(isA<Directory>()),
    );
  });

  test('picks the baseline build on an x64 CPU without AVX2', () {
    String pick(
      String os,
      String arch, {
      bool musl = false,
      bool avx2 = true,
    }) => pickTarget(os, arch, musl: musl, avx2: avx2);
    expect(pick('linux', 'x64'), 'linux-x64');
    expect(pick('linux', 'x64', avx2: false), 'linux-x64-baseline');
    expect(
      pick('linux', 'x64', musl: true, avx2: false),
      'linux-x64-musl-baseline',
    );
    expect(pick('linux', 'arm64', avx2: false), 'linux-arm64');
    expect(pick('macos', 'x64', avx2: false), 'darwin-x64');
    expect(pick('windows', 'x64', avx2: false), 'windows-x64-baseline');
    expect(pick('windows', 'arm64'), 'windows-x64');
    expect(
      () => pick('linux', 'riscv64'),
      throwsA(isA<LaunchError>().having((e) => e.code, 'code', 2)),
    );
  });

  test('trusts SSL_CERT_FILE, and refuses one it cannot read', () {
    env['REEVAL_DOWNLOAD'] = 'https://127.0.0.1:1/r';
    env['SSL_CERT_FILE'] = p.join(temp.path, 'missing.pem');
    expect(
      locateBinary(env),
      throwsA(
        isA<LaunchError>()
            .having((e) => e.code, 'code', 2)
            .having((e) => e.message, 'message', contains('SSL_CERT_FILE')),
      ),
    );
  });

  test('follows redirects, but never from HTTPS to HTTP', () async {
    publish();
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    server.listen((request) async {
      final path = request.uri.path;
      if (path.startsWith('/moved/')) {
        await request.response.redirect(
          Uri.parse('/release/${p.basename(path)}'),
        );
        return;
      }
      final file = File(p.join(release, p.basename(path)));
      request.response.add(file.readAsBytesSync());
      await request.response.close();
    });
    env['REEVAL_DOWNLOAD'] = 'http://127.0.0.1:${server.port}/moved';
    expect(File(await locateBinary(env)).readAsStringSync(), script);

    final https = Uri.parse('https://github.com/a/b');
    expect(redirect(https, '/c'), Uri.parse('https://github.com/c'));
    expect(
      redirect(Uri.parse('http://mirror/a'), 'https://cdn/b'),
      Uri.parse('https://cdn/b'),
    );
    for (final to in ['http://github.com/c', 'file:///etc/passwd']) {
      expect(
        () => redirect(https, to),
        throwsA(isA<LaunchError>().having((e) => e.code, 'code', 3)),
      );
    }
  });

  test("a cache write isn't named by the PID alone", () async {
    publish();
    final cached = p.join(cache, 'reeval', 'bin', packageVersion, asset);
    // What another container's process with this PID left mid-write.
    final other = Directory('$cached.$pid.partial')
      ..createSync(recursive: true);
    expect(await locateBinary(env), cached);
    expect(Directory(p.dirname(cached)).listSync().map((e) => e.path), {
      cached,
      '$cached.sha256',
      other.path,
    });
  });

  test('a REEVAL_BINARY that runs the launcher again is exit 2', () async {
    final again = File(p.join(temp.path, 'again'))
      ..writeAsStringSync(
        '#!/bin/sh\ncd "${Directory.current.path}"\n'
        'exec "${Platform.resolvedExecutable}" bin/reeval.dart "\$@"\n',
      );
    Process.runSync('chmod', ['755', again.path]);
    env['REEVAL_BINARY'] = again.path;
    final result = await launcher(['run']).timeout(const Duration(minutes: 1));
    expect(result.exitCode, 2);
    expect(result.stderr, contains('runs this launcher again'));
  });

  test('a Ctrl-C waits for reeval and exits with its code', () async {
    final binary = File(p.join(temp.path, 'slow'))
      ..writeAsStringSync(
        '#!/bin/sh\nsleep 0.5\necho ready\nsleep 1\necho done\nexit 7\n',
      );
    Process.runSync('chmod', ['755', binary.path]);
    env['REEVAL_BINARY'] = binary.path;
    final process = await Process.start(
      Platform.resolvedExecutable,
      ['bin/reeval.dart'],
      environment: env,
      includeParentEnvironment: false,
    );
    final lines = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter());
    final out = <String>[];
    await for (final line in lines) {
      out.add(line);
      if (line == 'ready') process.kill(ProcessSignal.sigint);
    }
    expect(out, ['ready', 'done']);
    expect(await process.exitCode, 7);
  });

  test('musl is the libc this process loaded, not one on disk', () {
    expect(
      mapsMusl('7f00-7f01 r-xp 00000000 08:01 1 /lib/ld-musl-x86_64.so.1\n'),
      isTrue,
    );
    expect(
      mapsMusl(
        '7f00-7f01 r-xp 00000000 08:01 1 /usr/lib/libc.musl-aarch64.so.1\n',
      ),
      isTrue,
    );
    expect(
      mapsMusl(
        '7f00-7f01 r-xp 00000000 08:01 1 '
        '/usr/lib/x86_64-linux-gnu/libc.so.6\n'
        '7f02-7f03 r--p 00000000 08:01 2 /usr/share/doc/ld-musl-x86_64.so.1/x\n',
      ),
      isFalse,
    );
  });

  test('the cache root follows the binary', () {
    expect(cacheRoot({'XDG_CACHE_HOME': '/x'}), '/x/reeval');
    expect(
      cacheRoot({'HOME': '/h'}),
      Platform.isMacOS ? '/h/Library/Caches/reeval' : '/h/.cache/reeval',
    );
  });
}
