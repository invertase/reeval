// The runner protocol: NDJSON lines between the reeval binary and the host process, over a
// loopback TCP socket the binary opens and names in REEVAL_RUNNER. Not stdio, which the eval's
// own prints and tools write to. The host relays each line to and from the eval file's isolate.
// Keep in step with packages/reeval/src/dart/protocol.ts.
import 'context.dart';

export 'version.dart' show runnerProtocol;

/// A message from the binary.
sealed class ToRunner {
  const ToRunner();

  static ToRunner decode(Object? json) => switch (json) {
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

final class Collect(final String file) extends ToRunner;

final class Run(final String attempt, final String body, final AttemptInfo info) extends ToRunner;

final class Reply(final int id, {final Object? result, final ReevalCallError? error})
    extends ToRunner;

final class Abort(final String attempt, final String reason) extends ToRunner;
