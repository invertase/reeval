// The runner as reeval starts it, with the test as reeval: messages on its
// stdin and stdout.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:reeval/src/version.dart';

/// The goldens reeval keeps for SDKs in other languages.
final conformance = p.join(_repoPackages(), 'reeval', 'test', 'conformance');

String _repoPackages() {
  var dir = Directory.current.absolute.path;
  while (!File(p.join(dir, 'pubspec.yaml')).existsSync() ||
      p.basename(dir) != 'reeval-dart') {
    final parent = p.dirname(dir);
    if (parent == dir) {
      throw StateError('run the tests in packages/reeval-dart');
    }
    dir = parent;
  }
  return p.dirname(dir);
}

const attempt = {
  'id': 'fake/-/fake#1',
  'cell': {
    'key': 'fake/-/fake',
    'harness': 'fake',
    'environment': '-',
    'sandbox': 'fake',
    'role': 'control',
  },
  'n': 1,
};

final class Runner {
  Runner._(this.process) {
    process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(_lines.add, onDone: _lines.close);
    process.stderr.transform(utf8.decoder).listen(_stderr.write);
  }

  final Process process;
  final _lines = StreamController<String>();
  late final _queue = StreamIterator(_lines.stream);
  final _stderr = StringBuffer();

  /// The log messages read so far.
  final logs = <Map<String, Object?>>[];

  String get stderr => _stderr.toString();

  /// Starts the runner for the project at [root].
  static Future<Runner> start(String root, {Map<String, String>? env}) async {
    final process = await Process.start(
      Platform.resolvedExecutable,
      ['--enable-asserts', p.join(_packageDir(), 'bin', 'runner.dart')],
      workingDirectory: _packageDir(),
      environment: {
        'REEVAL_RUNNER': 'stdio',
        'REEVAL_RUNNER_PROTOCOL': '$runnerProtocol',
        'REEVAL_PROJECT_ROOT': root,
        ...?env,
      },
    );
    final runner = Runner._(process);
    final hello = await runner.read();
    if (hello['t'] != 'hello') throw StateError('expected hello, got $hello');
    runner.hello = hello;
    return runner;
  }

  late final Map<String, Object?> hello;

  static String _packageDir() => p.join(_repoPackages(), 'reeval-dart');

  void send(Map<String, Object?> message) =>
      process.stdin.writeln(jsonEncode(message));

  /// The next line the runner wrote on its stdout, as written.
  Future<String> readLine({
    Duration timeout = const Duration(seconds: 60),
  }) async {
    final more = await _queue.moveNext().timeout(timeout);
    if (!more) throw StateError('the runner closed its stdout:\n$stderr');
    return _queue.current;
  }

  /// The next message that isn't a log line (those are kept in [logs]).
  Future<Map<String, Object?>> read({
    Duration timeout = const Duration(seconds: 60),
  }) async {
    while (true) {
      final message =
          jsonDecode(await readLine(timeout: timeout)) as Map<String, Object?>;
      if (message['t'] != 'log') return message;
      logs.add(message);
    }
  }

  Future<Map<String, Object?>> collect(String file) async {
    send({'t': 'collect', 'file': file});
    return read();
  }

  /// Closes stdin as reeval does when it exits; the messages the runner sent
  /// after that.
  Future<List<Map<String, Object?>>> finish() async {
    await process.stdin.close();
    final rest = <Map<String, Object?>>[];
    while (await _queue.moveNext().timeout(const Duration(seconds: 30))) {
      final message = jsonDecode(_queue.current) as Map<String, Object?>;
      if (message['t'] == 'log') {
        logs.add(message);
      } else {
        rest.add(message);
      }
    }
    await process.exitCode.timeout(const Duration(seconds: 30));
    return rest;
  }

  void kill() => process.kill();
}

/// A project with [files] (path to contents) in a temporary directory.
Future<String> project(Map<String, String> files) async {
  final dir = await Directory.systemTemp.createTemp('reeval-dart-');
  for (final MapEntry(:key, :value) in files.entries) {
    final file = File(p.join(dir.path, key));
    await file.parent.create(recursive: true);
    await file.writeAsString(value);
  }
  return dir.path;
}
