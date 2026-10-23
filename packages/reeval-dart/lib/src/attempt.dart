// One run of an eval body: its calls to reeval, keyed so that reeval answers
// the right body when several run at once.
import 'dart:async';

import 'errors.dart';

/// Which cell of the matrix an attempt is, and its run number (from 1).
typedef AttemptInfo = ({
  String id,
  int n,
  String cell,
  String harness,
  String environment,
  String sandbox,
  String role,
});

/// [AttemptInfo] from a start message's `attempt`.
AttemptInfo attemptInfo(Map<String, Object?> json) {
  final cell = json['cell'] as Map<String, Object?>? ?? const {};
  String text(Object? v) => v is String ? v : '';
  return (
    id: text(json['id']),
    n: json['n'] is int ? json['n'] as int : 1,
    cell: text(cell['key']),
    harness: text(cell['harness']),
    environment: text(cell['environment']),
    sandbox: text(cell['sandbox']),
    role: text(cell['role']),
  );
}

final class Attempt {
  Attempt(this.key, this.info, this._send);

  /// The `key` reeval gave this run of the body.
  final String key;
  final AttemptInfo info;
  final void Function(Map<String, Object?> message) _send;

  /// One numbering for the body's requests and records.
  var _ids = 0;
  final _pending = <String, Completer<Map<String, Object?>>>{};
  final _records = <String>{};
  final _partial = <String, String>{};
  AttemptAborted? _aborted;
  var _done = false;

  /// `expectLater` calls still waiting on reeval.
  final inflight = <Future<void>>{};

  static const zoneKey = #reeval.attempt;

  /// The attempt whose body is running, if any.
  static Attempt? get current => Zone.current[zoneKey] as Attempt?;

  bool get aborted => _aborted != null;
  bool get done => _done;

  void _alive() {
    if (_aborted case final aborted?) throw aborted;
  }

  /// Makes [call] and returns reeval's reply; throws [ReevalCallError] when
  /// reeval refuses it.
  Future<Map<String, Object?>> request(Map<String, Object?> call) async {
    _alive();
    final id = '${++_ids}';
    final reply = _pending[id] = Completer();
    _send({'id': id, 'call': call, 'key': key});
    final answer = await reply.future;
    if (answer['ok'] != true) {
      final error = answer['error'] as Map<String, Object?>? ?? const {};
      throw ReevalCallError(
        error['name'] as String? ?? 'Error',
        error['message'] as String? ?? '',
      );
    }
    return answer;
  }

  /// Sends a check without waiting: only a refusal of it is shown.
  void record(Map<String, Object?> call) {
    _alive();
    final id = '${++_ids}';
    _records.add(id);
    _send({'id': id, 'call': call, 'key': key});
  }

  void reply(Map<String, Object?> message) {
    final id = '${message['id']}';
    if (_records.remove(id)) {
      if (message['ok'] != true) {
        final error = message['error'] as Map<String, Object?>? ?? const {};
        log(
          'stderr',
          'reeval refused a check: ${error['name']}: ${error['message']}\n',
        );
      }
      return;
    }
    _pending.remove(id)?.complete(message);
  }

  /// reeval gave up on the body: its calls in flight and every later one
  /// throw, and reeval hears it's done now, whatever the body does next.
  void abort(String name, String message) {
    final aborted = _aborted = AttemptAborted(name, message);
    final pending = [..._pending.values];
    _pending.clear();
    for (final reply in pending) {
      reply.completeError(aborted);
    }
    finish({'name': name, 'message': message});
  }

  /// Tells reeval the body is done, once.
  void finish(Map<String, Object?>? error) {
    if (_done) return;
    _done = true;
    for (final stream in [..._partial.keys]) {
      _emit(stream, _partial.remove(stream)!);
    }
    _send({'type': 'done', 'key': key, 'error': ?error});
  }

  /// Output the body wrote, a line a message.
  void log(String stream, String text) {
    final lines = ((_partial.remove(stream) ?? '') + text).split('\n');
    final rest = lines.removeLast();
    if (rest.isNotEmpty) _partial[stream] = rest;
    for (final line in lines) {
      _emit(
        stream,
        line.endsWith('\r') ? line.substring(0, line.length - 1) : line,
      );
    }
  }

  void _emit(String stream, String line) =>
      _send({'t': 'log', 'key': key, 'stream': stream, 'text': line});
}
