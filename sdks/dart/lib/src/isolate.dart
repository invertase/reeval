// An eval file's isolate, spawned by the host (host.dart) with the file's `main`. It answers the
// binary's lines, which the host relays: the file's declaration tree, and each attempt's body,
// whose `t.*` calls go back to the binary.
import 'dart:async';
import 'dart:convert';
import 'dart:isolate';

import 'package:stack_trace/stack_trace.dart';

import 'context.dart';
import 'declare.dart';
import 'expect.dart';
import 'protocol.dart';

/// Serves the binary, through the host, until the host process exits.
Future<void> serveIsolate(SendPort host, void Function() main) async {
  final inbox = ReceivePort();
  host.send(inbox.sendPort);
  await _Runner((message) => host.send(jsonEncode(message)), main).serve(inbox);
}

final class _Runner implements Calls {
  _Runner(this._send, this._main);

  final void Function(Map<String, Object?> message) _send;
  final void Function() _main;
  Declarer? _declarer;
  final Map<int, Completer<Object?>> _pending = {};
  final Map<String, EvalContext> _attempts = {};
  int _calls = 0;

  Future<void> serve(ReceivePort inbox) async {
    await for (final line in inbox.cast<String>()) {
      switch (ToRunner.decode(jsonDecode(line))) {
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

  void _collect(String file) {
    try {
      final declarer = _declarer = declare(_main);
      _send({'t': 'declared', 'file': file, 'tree': declarer.tree});
    } catch (error, stack) {
      _send({'t': 'load-error', 'error': _serialize(error, stack)});
    }
  }

  /// `t.*` for one attempt: the call names its attempt so the binary answers on the right `t`.
  @override
  Future<Object?> call(String method, Map<String, Object?> params) {
    final id = ++_calls;
    final reply = _pending[id] = Completer<Object?>();
    _send({
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
        _send({'t': 'log', 'attempt': attempt, 'stream': stream, 'text': text});
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
    _send({
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
