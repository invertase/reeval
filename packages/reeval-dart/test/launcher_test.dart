@TestOn('linux || mac-os')
library;

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

  const script = '#!/bin/sh\necho "fake reeval \$*"\nexit 7\n';

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
    asset = 'reeval-$packageVersion-${target(base)}';
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
      expect(result.stderr, 'reeval: downloading $asset\n');
      expect(result.exitCode, 7);
      final cached = File(
        p.join(cache, 'reeval', 'bin', packageVersion, asset),
      );
      expect(cached.existsSync(), isTrue);
      expect(Directory(cached.parent.path).listSync(), hasLength(1));
    },
  );

  test('runs from the cache offline, without downloading', () async {
    publish();
    await launcher([]);
    File(p.join(release, asset)).deleteSync();
    env['REEVAL_OFFLINE'] = '1';
    final result = await launcher(['--version']);
    expect(result.stdout, 'fake reeval --version\n');
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
    asset = 'reeval-9.9.9-${target(env)}';
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

  test('the cache root follows the binary', () {
    expect(cacheRoot({'XDG_CACHE_HOME': '/x'}), '/x/reeval');
    expect(
      cacheRoot({'HOME': '/h'}),
      Platform.isMacOS ? '/h/Library/Caches/reeval' : '/h/.cache/reeval',
    );
  });
}
