// What an eval body gets as `c`. Each call goes to reeval, which does the work
// (the agent, the sandbox, the judge) as it does for a TypeScript eval.
import 'dart:convert';
import 'dart:core' as core show Duration;
import 'dart:core' hide Duration;

import 'attempt.dart';
import 'checks.dart';
import 'options.dart';
import 'source.dart';
import 'wire.g.dart' as wire;

export 'attempt.dart' show AttemptInfo;

/// A command's result in the sandbox.
final class ExecResult {
  const ExecResult(this.command, this.exitCode, this.stdout, this.stderr);

  factory ExecResult._fromJson(String command, Map<String, Object?> json) =>
      ExecResult(
        command,
        json['exitCode'] as int,
        json['stdout'] as String? ?? '',
        json['stderr'] as String? ?? '',
      );

  /// The command, as run.
  final String command;
  final int exitCode;
  final String stdout;
  final String stderr;

  /// Whether it exited 0.
  bool get ok => exitCode == 0;

  /// The result as reeval reads it.
  Map<String, Object?> toJson() => {
    'exitCode': exitCode,
    'stdout': stdout,
    'stderr': stderr,
  };

  @override
  String toString() => 'ExecResult($command, exit $exitCode)';
}

/// A command left running in the sandbox by [AttemptContext.background].
final class BackgroundProcess {
  BackgroundProcess._(this._c, this.handle);

  final AttemptContext _c;

  /// reeval's name for it.
  final String handle;

  /// Stops it. Killing one that's gone is fine.
  Future<void> kill() async {
    await _c._request(wire.AttemptCallKill(handle: handle));
  }
}

/// One turn of the agent session.
final class Turn {
  Turn._(this.index, this.json);

  /// Its place in `c.turns`, from 0.
  final int index;

  /// The turn as reeval recorded it.
  final Map<String, Object?> json;

  String get prompt => json['prompt'] as String? ?? '';

  /// The agent's last reply.
  String get text => json['text'] as String? ?? '';

  /// `completed`, or why it stopped.
  String get status => json['status'] as String? ?? '';

  /// The model that served it, when the harness reports it.
  String? get model => json['model'] as String?;

  /// The workspace's files changed since the attempt started, as of this turn.
  List<String> get changedFiles => [
    if (json['diff'] case {'files': final List<Object?> files})
      for (final file in files)
        if (file case {'path': final String path}) path,
  ];

  /// What the agent did, event by event.
  List<Map<String, Object?>> get transcript => [
    if (json['transcript'] case final List<Object?> events)
      for (final event in events)
        if (event case final Map<String, Object?> e) e,
  ];

  @override
  String toString() => 'Turn($index, $status)';
}

/// The judge's answer to a yes/no question.
final class Verdict {
  Verdict._(this.json);

  final Map<String, Object?> json;

  /// `pass`, `fail` or `error`.
  String get verdict => json['verdict'] as String? ?? 'fail';
  bool get passed => verdict == 'pass';
  double get score => (json['score'] as num? ?? 0).toDouble();
  double get threshold => (json['threshold'] as num? ?? 0).toDouble();
  String get question => json['question'] as String? ?? '';
  String get model => json['model'] as String? ?? '';

  /// The judge's reasoning, when it gave one.
  String? get reason => switch (json) {
    {'reason': final String r} when r.isNotEmpty => r,
    {'explanation': final String r} when r.isNotEmpty => r,
    _ => null,
  };

  @override
  String toString() => 'Verdict($verdict, $score/$threshold)';
}

/// A subject reeval reads again on each try: see [AttemptContext.poll].
final class Polled {
  const Polled._(this.subject, this.poll);

  final Map<String, Object?> subject;
  final Map<String, Object?> poll;
}

/// `c.poll`: subjects reeval reads again until a matcher passes or the time
/// runs out, for `await expectLater(c.poll.readFile('ready.txt'), …)`.
final class Poll {
  const Poll._();

  static Map<String, Object?> _options(
    core.Duration? interval,
    core.Duration? timeout,
  ) => {
    'interval': ?interval?.inMilliseconds,
    'timeout': ?timeout?.inMilliseconds,
  };

  /// The attempt itself, for matchers such as `hasFile`.
  Polled call({core.Duration? interval, core.Duration? timeout}) =>
      Polled._(const {'attempt': true}, _options(interval, timeout));

  /// A file's contents (null while there's no such file).
  Polled readFile(
    String path, {
    core.Duration? interval,
    core.Duration? timeout,
  }) => Polled._({'readFile': path}, _options(interval, timeout));

  /// A command's result.
  Polled exec(
    String command, {
    core.Duration? interval,
    core.Duration? timeout,
  }) => Polled._({'exec': command}, _options(interval, timeout));
}

const _unset = Object();

/// An attempt: one run of an eval's body, on one cell of the matrix.
final class AttemptContext {
  AttemptContext(this._attempt);

  final Attempt _attempt;
  final List<Turn> _turns = [];

  /// Which cell this attempt is, and its run number.
  AttemptInfo get attempt => _attempt.info;

  /// Every turn so far, oldest first.
  List<Turn> get turns => List.unmodifiable(_turns);

  /// Whether reeval has given up on this attempt (its timeout ran out, or the
  /// run was stopped). Every call throws once it has.
  bool get aborted => _attempt.aborted;

  /// Subjects that `expectLater` retries: `c.poll()`, `c.poll.readFile(…)`.
  Poll get poll => const Poll._();

  Future<Map<String, Object?>> _request(Object call) =>
      _attempt.request(call as Map<String, Object?>);

  /// Sends the next turn of the agent session. The sandbox and the session
  /// start on the first call that needs them.
  Future<Turn> send(String prompt) async {
    final reply = await _request(wire.AttemptCallSend(prompt: prompt));
    final turn = Turn._(_turns.length, reply['turn'] as Map<String, Object?>);
    _turns.add(turn);
    return turn;
  }

  /// Runs [command] in the sandbox's workspace and waits for it.
  Future<ExecResult> exec(String command) async {
    final reply = await _request(wire.AttemptCallExec(command: command));
    return ExecResult._fromJson(
      command,
      reply['result'] as Map<String, Object?>,
    );
  }

  /// Starts [command] in the sandbox and leaves it running.
  Future<BackgroundProcess> background(String command) async {
    final reply = await _request(
      wire.AttemptCallExec(command: command, background: true),
    );
    final result = reply['result'] as Map<String, Object?>;
    return BackgroundProcess._(this, result['handle'] as String);
  }

  /// A file's contents, workspace-relative or `~/…`; null when there's none.
  Future<String?> readFile(String path) async {
    final reply = await _request(wire.AttemptCallReadFile(path: path));
    return reply['contents'] as String?;
  }

  /// Writes a file, creating its directories.
  Future<void> writeFile(String path, String contents) async {
    await _request(wire.AttemptCallWriteFile(path: path, contents: contents));
  }

  /// Writes bytes to a file, creating its directories.
  Future<void> writeBytes(String path, List<int> bytes) async {
    await _request(
      wire.AttemptCallWriteFile(
        path: path,
        contents: base64.encode(bytes),
        encoding: 'base64',
      ),
    );
  }

  /// Asks the judge a yes/no question about the latest turn, or [on] another:
  /// a [Turn], an [ExecResult], a [Verdict] or any JSON value, null included.
  Future<Verdict> judge(
    String question, {
    Object? on = _unset,
    JudgeModel? model,
    double? threshold,
    Map<String, Object?>? state,
  }) async {
    final options = <String, Object?>{
      'model': ?toWire(model),
      'threshold': ?threshold,
      'state': ?state,
      if (!identical(on, _unset))
        'on': on is Turn ? {'turn': on.index} : {'value': jsonValue(on)},
    };
    final reply = await _request(
      wire.AttemptCallJudge(
        question: question,
        options: options.isEmpty ? null : wire.JudgeCallData.fromJson(options),
      ),
    );
    return Verdict._(reply['verdict'] as Map<String, Object?>);
  }

  /// A check: passes when [passed] is true. Like Dart's `assert`, it's named
  /// by its condition as written (or [subject]), and it's recorded passing
  /// too. A failure ends the body, with [reason] in its message, unless
  /// [soft]: then it fails the attempt once the body is done.
  void check(
    bool passed, {
    String? reason,
    String? subject,
    bool soft = false,
  }) {
    final written =
        firstArgument(evalFrame(StackTrace.current)) ?? 'c.check(…)';
    final record = <String, Object?>{
      'op': 'record',
      'matcher': 'assert',
      'subject': subject ?? written,
      'status': passed ? 'pass' : 'fail',
      if (soft) 'soft': true,
    };
    if (passed) return _attempt.record(record);
    final detail = 'assert $written';
    final message = reason == null ? detail : '$reason: $detail';
    record['message'] = message;
    if (soft) return _attempt.record(record);
    throw failure(message, record);
  }
}

/// [value] as JSON reeval reads: an [ExecResult] or [Verdict] as its data,
/// and anything else that isn't JSON refused here, where the eval passed it.
Object? jsonValue(Object? value) => switch (value) {
  null || bool() || num() || String() => value,
  ExecResult() => value.toJson(),
  Verdict() => value.json,
  Turn() => value.json,
  List() => [for (final item in value) jsonValue(item)],
  Map() when value.keys.every((k) => k is String) => {
    for (final MapEntry(:key, :value) in value.entries)
      key as String: jsonValue(value),
  },
  _ => throw ArgumentError.value(
    value,
    'value',
    'reeval reads a turn, an ExecResult, a Verdict or a JSON value '
        '(null, bool, num, String, List, Map<String, …>), not a '
        '${value.runtimeType}',
  ),
};
