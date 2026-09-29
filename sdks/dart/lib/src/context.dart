// What an eval body gets as `t`. Each method is a call to the reeval binary, which does the work
// (the harness, the sandbox, the judge) exactly as it does for a TypeScript eval.
import 'dart:async';

/// A `t.*` call the binary answered with an error; rethrown there as the original error, so an
/// infrastructure failure is still recorded as one.
final class ReevalCallError implements Exception {
  const ReevalCallError(this.call, this.name, this.message);
  final int call;
  final String name;
  final String message;

  @override
  String toString() => '$name: $message';
}

/// The attempt was aborted (timeout or Ctrl-C); every later call throws this.
final class AbortedError implements Exception {
  const AbortedError(this.reason);
  final String reason;

  @override
  String toString() => 'Aborted: $reason';
}

/// How a context reaches the binary; the runner implements it over its socket.
abstract interface class Calls {
  Future<Object?> call(String method, Map<String, Object?> params);
}

/// A command's result in the sandbox.
extension type const ExecResult(Map<String, Object?> json) {
  int get exitCode => json['exitCode'] as int;
  String get stdout => json['stdout'] as String;
  String get stderr => json['stderr'] as String;
  bool get ok => exitCode == 0;
}

/// The judge's answer to a yes/no question.
extension type const Verdict(Map<String, Object?> json) {
  bool get passed => json['verdict'] == 'pass';
  double get score => (json['score'] as num).toDouble();
  double get threshold => (json['threshold'] as num).toDouble();
  String get question => json['question'] as String;
  String get model => json['model'] as String;
}

/// Tokens one turn used, as its harness reported them.
typedef TokenUsage = ({int input, int output, int cacheRead, int cacheWrite, int? reasoning});

/// Which cell of the matrix this attempt is, and its run number (from 1).
typedef AttemptInfo = ({String id, int n, String cell, Map<String, Object?> cellData});

/// One agent turn, as the binary recorded it.
final class Turn {
  Turn._(this.index, this.data, this._t);

  /// Its place in `t.turns`.
  final int index;
  final Map<String, Object?> data;
  final EvalContext _t;

  String get prompt => data['prompt'] as String;
  String get text => data['text'] as String;
  String get status => data['status'] as String;
  String? get model => data['model'] as String?;
  List<Map<String, Object?>> get transcript => (data['transcript'] as List).cast();

  /// The workspace files changed since the eval started, as of this turn.
  List<String> get changedFiles => [
    for (final {'path': String path} in ((data['diff'] as Map)['files'] as List).cast<Map>()) path,
  ];

  TokenUsage? get usage => switch (data['usage']) {
    {
      'input': int input,
      'output': int output,
      'cacheRead': int cacheRead,
      'cacheWrite': int cacheWrite,
      'reasoning': final int? reasoning,
    } =>
      (
        input: input,
        output: output,
        cacheRead: cacheRead,
        cacheWrite: cacheWrite,
        reasoning: reasoning,
      ),
    _ => null,
  };

  /// The tools the agent called this turn, by name.
  Iterable<String> get tools sync* {
    for (final event in transcript) {
      if (event case {'type': 'tool', 'tool': final String tool}) yield tool;
    }
  }

  Future<ExecResult> exec(String command) => _t.exec(command);
  Future<String?> readFile(String path) => _t.readFile(path);
}

/// The sandbox's checks, without a turn.
typedef Checks = ({
  Future<ExecResult> Function(String command) exec,
  Future<String?> Function(String path) readFile,
});

final class EvalContext {
  EvalContext(this._calls, this.attempt);

  final Calls _calls;
  final AttemptInfo attempt;
  final List<Turn> _turns = [];
  final Completer<String> _aborted = Completer();

  /// Every turn so far, oldest first.
  List<Turn> get turns => List.unmodifiable(_turns);

  bool get aborted => _aborted.isCompleted;

  /// Completes with the reason when the attempt is aborted (timeout or Ctrl-C).
  Future<String> get whenAborted => _aborted.future;

  void abort(String reason) {
    if (!_aborted.isCompleted) _aborted.complete(reason);
  }

  Future<Object?> _call(String method, Map<String, Object?> params) async {
    if (_aborted.isCompleted) throw AbortedError(await _aborted.future);
    return _calls.call(method, params);
  }

  /// Sends the next turn of this eval's agent session, starting the sandbox on first use.
  Future<Turn> send(String prompt) async {
    final data = await _call('send', {'prompt': prompt}) as Map<String, Object?>;
    final turn = Turn._(_turns.length, data, this);
    _turns.add(turn);
    return turn;
  }

  Future<ExecResult> exec(String command) async =>
      ExecResult(await _call('exec', {'command': command}) as Map<String, Object?>);

  /// Workspace-relative, or `~/` for the home directory; null when there's no such file.
  Future<String?> readFile(String path) async => await _call('readFile', {'path': path}) as String?;

  /// Asks the judge a yes/no question about the latest turn, or `on` (a turn or a JSON value).
  Future<Verdict> judge(String question, {Object? on, String? model, double? threshold}) async =>
      Verdict(
        await _call('judge', {
          'question': question,
          if (on != null) 'on': on is Turn ? {r'$turn': on.index} : on,
          'model': ?model,
          'threshold': ?threshold,
        }) as Map<String, Object?>,
      );

  /// Starts the sandbox and agent session without a turn.
  Future<Checks> sandbox() async {
    await _call('sandbox', const {});
    return (exec: exec, readFile: readFile);
  }
}
