// The runner protocol: NDJSON over a loopback TCP socket the reeval binary opens and names in
// REEVAL_RUNNER. Not stdio, which the eval's own prints and tools write to. Keep in step with
// packages/reeval/src/dart/protocol.ts.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'config.dart';
import 'context.dart';

/// Bumped whenever a message changes shape or meaning, in step with the binary.
const runnerProtocol = 1;

/// A message from the binary.
sealed class ToRunner {
  const ToRunner();

  static ToRunner decode(Object? json) => switch (json) {
    {'t': 'config', 'context': {'ci': bool ci, 'command': String command} && final context} =>
      LoadConfig((
        ci: ci,
        command: command,
        profile: context['profile'] as String?,
        hostEnv: Platform.environment,
      )),
    {'t': 'collect', 'file': String file} => Collect(file),
    {
      't': 'run',
      'attempt': String attempt,
      'body': String body,
      'info': {'id': String id, 'n': int n, 'cell': Map<String, Object?> cell},
    } =>
      Run(attempt, body, (id: id, n: n, cell: cell['key'] as String, cellData: cell)),
    {'t': 'reply', 'id': int id, 'error': {'name': String name, 'message': String message}} =>
      Reply(id, error: ReevalCallError(id, name, message)),
    {'t': 'reply', 'id': int id} => Reply(id, result: (json as Map)['result']),
    {'t': 'abort', 'attempt': String attempt, 'reason': String reason} => Abort(attempt, reason),
    _ => throw FormatException('Not a runner message: $json'),
  };
}

final class LoadConfig(final ConfigContext context) extends ToRunner;

final class Collect(final String file) extends ToRunner;

final class Run(final String attempt, final String body, final AttemptInfo info) extends ToRunner;

final class Reply(final int id, {final Object? result, final ReevalCallError? error})
    extends ToRunner;

final class Abort(final String attempt, final String reason) extends ToRunner;

/// One NDJSON connection to the binary.
final class Connection {
  Connection(this._socket);

  final Socket _socket;

  Stream<ToRunner> get messages => _socket
      .cast<List<int>>()
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .where((line) => line.isNotEmpty)
      .map((line) => ToRunner.decode(jsonDecode(line)));

  void send(Map<String, Object?> message) => _socket.write('${jsonEncode(message)}\n');

  Future<void> close() async {
    await _socket.flush();
    await _socket.close();
  }
}
