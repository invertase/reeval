// The Dart side of a reeval run. The binary generates a bootstrap that imports the config and
// every eval file and calls `runReeval`; it starts the compiled bootstrap for the config and for
// each eval file's worker, and this answers over the socket: the config, a file's declaration
// tree, and each attempt's body, whose `t.*` calls go back to the binary.
import 'dart:async';
import 'dart:io';

import 'package:stack_trace/stack_trace.dart';

import 'config.dart';
import 'context.dart';
import 'declare.dart';
import 'expect.dart';
import 'options.dart';
import 'protocol.dart';

const sdkVersion = '0.1.0';

typedef ConfigMain = FutureOr<ReevalConfig> Function();

/// Serves the binary until it closes the connection. `files` maps each eval file's path, relative
/// to the project root with `/`, to its `main`.
Future<void> runReeval(
  List<String> args, {
  ConfigMain? config,
  required Map<String, void Function()> files,
}) async {
  final (host, port, token) = switch ((
    Platform.environment['REEVAL_RUNNER']?.split(':'),
    Platform.environment['REEVAL_RUNNER_TOKEN'],
  )) {
    ([final host, final port], final String token) => (host, int.parse(port), token),
    _ => throw StateError(
      "This is reeval's Dart runner, which the reeval binary starts. Run your evals with reeval run.",
    ),
  };
  final socket = await Socket.connect(host, port);
  socket.setOption(SocketOption.tcpNoDelay, true);
  await _Runner(Connection(socket), config, files).serve(token);
  exit(0);
}

final class _Runner implements Calls {
  _Runner(this._conn, this._config, this._files);

  final Connection _conn;
  final ConfigMain? _config;
  final Map<String, void Function()> _files;
  Declarer? _declarer;
  final Map<int, Completer<Object?>> _pending = {};
  final Map<String, EvalContext> _attempts = {};
  int _calls = 0;

  Future<void> serve(String token) async {
    _conn.send({
      't': 'hello',
      'protocol': runnerProtocol,
      'token': token,
      'sdk': 'dart',
      'version': sdkVersion,
      'runtime': Platform.version.split(' ').first,
    });
    await for (final message in _conn.messages) {
      switch (message) {
        case LoadConfig(:final context):
          await _loadConfig(context);
        case Collect(:final file):
          _collect(file);
        case Run(:final attempt, :final body, :final info):
          unawaited(_run(attempt, body, info));
        case Reply(:final id, :final error?):
          _pending.remove(id)?.completeError(error);
        case Reply(:final id, :final result):
          _pending.remove(id)?.complete(result);
        case Abort(:final attempt, :final reason):
          _attempts[attempt]?.abort(reason);
      }
    }
  }

  Future<void> _loadConfig(ConfigContext context) async {
    configContext = context;
    try {
      final config = _config == null ? defineConfig() : await _config();
      _conn.send({'t': 'config', 'config': toData(config)});
    } catch (error, stack) {
      _conn.send({'t': 'load-error', 'error': _serialize(error, stack)});
    }
  }

  void _collect(String file) {
    final main = _files[file];
    if (main == null) {
      _conn.send({
        't': 'load-error',
        'error': {
          'name': 'UsageError',
          'message':
              "$file isn't one of the project's eval files. Dart eval files end in _eval.dart.",
        },
      });
      return;
    }
    try {
      final declarer = _declarer = declare(main);
      _conn.send({'t': 'declared', 'file': file, 'tree': declarer.tree});
    } catch (error, stack) {
      _conn.send({'t': 'load-error', 'error': _serialize(error, stack)});
    }
  }

  /// `t.*` for one attempt: the call names its attempt so the binary answers on the right `t`.
  @override
  Future<Object?> call(String method, Map<String, Object?> params) {
    final id = ++_calls;
    final reply = _pending[id] = Completer<Object?>();
    _conn.send({
      't': 'call',
      'id': id,
      'attempt': Zone.current[#reeval.attempt],
      'method': method,
      'params': params,
    });
    return reply.future;
  }

  Future<void> _run(String attempt, String bodyId, AttemptInfo info) async {
    final body = _declarer?.bodies[bodyId];
    final t = _attempts[attempt] = EvalContext(this, info);
    final outcome = Completer<Map<String, Object?>?>();
    void log(String stream, String text) =>
        _conn.send({'t': 'log', 'attempt': attempt, 'stream': stream, 'text': text});
    Future<void> start() async {
      if (body == null) throw StateError('No eval body $bodyId: was the file changed mid-run?');
      await body(t);
      if (!outcome.isCompleted) outcome.complete(null);
    }

    runZonedGuarded(
      () => unawaited(start()),
      (error, stack) {
        if (!outcome.isCompleted) return outcome.complete(_serialize(error, stack));
        log('stderr', 'An error after the eval finished: $error\n');
      },
      zoneValues: {#reeval.attempt: attempt},
      zoneSpecification: ZoneSpecification(
        print: (self, parent, zone, line) => log('stdout', '$line\n'),
      ),
    );
    final error = await outcome.future;
    _attempts.remove(attempt);
    _conn.send({
      't': 'done',
      'attempt': attempt,
      'state': error == null ? 'passed' : 'failed',
      'error': ?error,
    });
  }
}

/// An error as the binary's error printer takes it: V8-style frames, so it shows the eval's line.
Map<String, Object?> _serialize(Object error, StackTrace stack) {
  final frames = Trace.from(stack).frames
      .where((f) => f.uri.scheme == 'file' || (f.package != null && f.package != 'reeval'));
  final (name, message) = switch (error) {
    ReevalAssertion(:final message) => ('AssertionError', message),
    ReevalCallError(:final name, :final message) => (name, message),
    AbortedError(:final reason) => ('AbortError', reason),
    ArgumentError(:final message) => ('ArgumentError', '$message'),
    StateError(:final message) => ('StateError', message),
    _ => (error.runtimeType.toString(), error.toString()),
  };
  return {
    'name': name,
    'message': message,
    'stack': [
      '$name: $message',
      for (final f in frames)
        '    at ${f.member ?? '<fn>'} (${f.uri.scheme == 'file' ? f.uri.toFilePath() : f.uri}:${f.line ?? 1}:${f.column ?? 1})',
    ].join('\n'),
    if (error case ReevalAssertion(diffable: true, :final expected, :final actual)) ...{
      'expected': expected,
      'actual': actual,
    },
    if (error case ReevalCallError(:final call)) 'call': call,
  };
}
