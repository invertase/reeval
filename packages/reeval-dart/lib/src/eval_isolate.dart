// An eval file's isolate. The runner spawns one per file, with the file's
// `main`, and relays reeval's messages to it: collect the file's declarations,
// then run its bodies, each in a zone of its own.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:stack_trace/stack_trace.dart';
import 'package:test_api/hooks.dart' show TestFailure;

import 'attempt.dart';
import 'checks.dart';
import 'context.dart';
import 'declare.dart';
import 'errors.dart';

/// Serves the runner (`runner.dart`) from an eval file's isolate.
void serveEvalFile(Object? host, Function main) {
  final runner = host as SendPort;
  final inbox = ReceivePort();
  runner.send(inbox.sendPort);
  final attempts = <String, Attempt>{};
  void send(Map<String, Object?> message) => runner.send(message);

  inbox.listen((message) async {
    final msg = (message as Map).cast<String, Object?>();
    switch (msg) {
      case {'t': 'collect', 'file': final String file}:
        try {
          final tree = await Declarer.collect(main);
          send({'t': 'declared', 'file': file, 'tree': tree});
        } on Object catch (error, stack) {
          send({'t': 'load-error', 'error': wireError(error, stack)});
        }
      case {'type': 'start', 'key': final String key}:
        final attempt = attempts[key] = Attempt(
          key,
          attemptInfo(msg['attempt'] as Map<String, Object?>? ?? const {}),
          send,
        );
        await _run(attempt, Declarer.lastBodies['${msg['body']}']);
        attempts.remove(key);
      case {'type': 'abort', 'key': final String key}:
        attempts
            .remove(key)
            ?.abort(
              msg['reason'] == 'timeout' ? 'TimeoutError' : 'AbortError',
              '${msg['message'] ?? ''}',
            );
      case {'id': _, 'ok': _, 'key': final String key}:
        attempts[key]?.reply(msg);
    }
  });
}

Future<void> _run(Attempt attempt, EvalBody? body) {
  final finished = Completer<void>();
  void end(Object? error, StackTrace? stack) {
    if (attempt.done) {
      if (error != null && error is! AttemptAborted) {
        attempt.log('stderr', 'An error after the eval finished: $error\n');
      }
    } else {
      attempt.finish(
        error == null
            ? null
            : _doneError(attempt, error, stack ?? StackTrace.empty),
      );
    }
    if (!finished.isCompleted) finished.complete();
  }

  final realOut = stdout, realErr = stderr;
  final running = runZonedGuarded<Future<void>>(
    () => IOOverrides.runZoned(
      () async {
        try {
          if (body == null) {
            throw StateError(
              "reeval started a body this file doesn't declare: "
              'did the file change during the run?',
            );
          }
          await body(AttemptContext(attempt));
          if (attempt.inflight.isNotEmpty) {
            await Future.wait([
              for (final check in [...attempt.inflight])
                check.then<void>((_) {}, onError: (Object _) {}),
            ]);
            throw const UsageError(
              "an expectLater(…) wasn't awaited, so the body ended before it "
              'checked anything: await each one',
            );
          }
          end(null, null);
        } on Object catch (error, stack) {
          end(error, stack);
        }
      },
      stdout: () => _RoutedStdout(attempt, 'stdout', realOut),
      stderr: () => _RoutedStdout(attempt, 'stderr', realErr),
    ),
    end,
    zoneValues: {Attempt.zoneKey: attempt},
    zoneSpecification: ZoneSpecification(
      print: (self, parent, zone, line) => attempt.log('stdout', '$line\n'),
    ),
  );
  if (running != null) unawaited(running);
  return finished.future;
}

Map<String, Object?> _doneError(
  Attempt attempt,
  Object error,
  StackTrace stack,
) {
  if (escapedRecord(error, stack) case final record?) {
    try {
      attempt.record(record);
    } on AttemptAborted {
      // reeval has already been told the body is done.
    }
    return {
      'name': 'AssertionError',
      'message': record['message'],
      'stack': stackText('AssertionError', '${record['message']}', stack),
    };
  }
  if (error is TestFailure) {
    final message = error.message ?? 'expect failed';
    return {
      'name': 'AssertionError',
      'message': message,
      'stack': stackText('AssertionError', message, stack),
    };
  }
  return wireError(error, stack);
}

/// An error as reeval prints it: V8-style frames, so it shows the eval's line.
Map<String, Object?> wireError(Object error, StackTrace stack) {
  final (name, message) = switch (error) {
    ReevalCallError(:final name, :final message) => (name, message),
    AttemptAborted(:final name, :final message) => (name, message),
    UsageError(:final message) => ('UsageError', message),
    IsolateSpawnException(:final message) => ('CompileError', message),
    StateError(:final message) => ('StateError', message),
    ArgumentError(:final message) => ('ArgumentError', '$message'),
    _ => (error.runtimeType.toString(), error.toString()),
  };
  return {
    'name': name,
    'message': message,
    'stack': stackText(name, message, stack),
  };
}

String stackText(String name, String message, StackTrace stack) {
  final frames = Trace.from(stack).frames.where(
    (f) => !f.isCore && f.package != 'reeval' && f.uri.scheme != 'data',
  );
  return [
    '$name: $message',
    for (final f in frames)
      '    at ${f.member ?? '<fn>'} '
          '(${f.uri.scheme == 'file' ? f.uri.toFilePath() : f.uri}'
          ':${f.line ?? 1}:${f.column ?? 1})',
  ].join('\n');
}

/// `stdout` and `stderr` in a body: what it writes goes to its attempt's log.
final class _RoutedStdout implements Stdout {
  _RoutedStdout(this._attempt, this._stream, this._real);

  final Attempt _attempt;
  final String _stream;
  final Stdout _real;
  final _decoder = const Utf8Decoder(allowMalformed: true);

  @override
  Encoding encoding = utf8;

  @override
  String lineTerminator = '\n';

  @override
  void write(Object? object) => _attempt.log(_stream, '$object');

  @override
  void writeln([Object? object = '']) => write('$object$lineTerminator');

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) =>
      write(objects.join(separator));

  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));

  @override
  void add(List<int> data) => write(_decoder.convert(data));

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      write('$error\n${stackTrace ?? ''}');

  @override
  Future<void> addStream(Stream<List<int>> stream) => stream.forEach(add);

  @override
  Future<void> flush() async {}

  @override
  Future<void> close() async {}

  @override
  Future<void> get done => _real.done;

  @override
  bool get hasTerminal => false;

  @override
  bool get supportsAnsiEscapes => false;

  @override
  int get terminalColumns =>
      throw const StdoutException('the eval body has no terminal');

  @override
  int get terminalLines =>
      throw const StdoutException('the eval body has no terminal');

  @override
  IOSink get nonBlocking => this;
}
