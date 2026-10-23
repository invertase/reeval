// `expect` and `expectLater`, as in package:test, over package:matcher.
//
// `expect` checks here, now, with any matcher, and records the check. Awaited,
// `expectLater` runs reeval's own matchers (`hasFile`, `hasRun`, `succeeds`,
// `equals`, …) in reeval, on the attempt, a turn, a command or a value, as a
// TypeScript eval's `expect` does; any other matcher it checks here.
import 'dart:async';

import 'package:matcher/matcher.dart' as m;
import 'package:test_api/hooks.dart' show TestFailure;

import 'attempt.dart';
import 'checks.dart';
import 'context.dart';
import 'source.dart';

/// One of reeval's matchers. [expectLater] has reeval run it; [expect] checks
/// it here when it can, and refuses the ones that read the sandbox.
final class ReevalMatcher extends m.Matcher {
  const ReevalMatcher._(this.name, this.args, this._local, {this.not = false});

  /// reeval's name for it, e.g. `toHaveFile`.
  final String name;
  final List<Object?> args;

  /// Whether it passes when the matcher fails.
  final bool not;

  final m.Matcher? _local;

  /// Whether [expect] can check it here, without reeval.
  bool get isLocal => _local != null;

  ReevalMatcher get _negated => ReevalMatcher._(name, args, _local, not: !not);

  @override
  bool matches(Object? item, Map<Object?, Object?> matchState) {
    final local = _local;
    if (local == null) throw StateError(_readsTheSandbox(this));
    return local.matches(item, matchState) != not;
  }

  @override
  m.Description describe(m.Description description) {
    if (not) description.add('not ');
    final local = _local;
    if (local != null) return local.describe(description);
    return description.add('$name(${args.join(', ')})');
  }

  @override
  m.Description describeMismatch(
    Object? item,
    m.Description mismatchDescription,
    Map<Object?, Object?> matchState,
    bool verbose,
  ) =>
      _local?.describeMismatch(
        item,
        mismatchDescription,
        matchState,
        verbose,
      ) ??
      mismatchDescription;
}

/// One of reeval's matchers by name, for one this package has no function for
/// yet. Only [expectLater] can run it.
ReevalMatcher reevalMatcher(String name, [List<Object?> args = const []]) =>
    ReevalMatcher._(name, args, null);

String _readsTheSandbox(ReevalMatcher matcher) =>
    '${matcher.name} is checked by reeval: '
    'use await expectLater(…, ${matcher.name}…) instead of expect';

/// The arguments given, up to the first one left out.
List<Object?> _given(List<Object?> args) => [
  ...args.takeWhile((a) => a != _no),
];

const _no = Object();

/// Matches a value deeply equal to [expected] (reeval's `toEqual`).
ReevalMatcher equals(Object? expected) =>
    ReevalMatcher._('toEqual', [expected], m.equals(expected));

/// Matches [expected] itself: the same value for a string, number, bool or
/// null, the same object otherwise (reeval's `toBe`).
ReevalMatcher same(Object? expected) =>
    ReevalMatcher._('toBe', [expected], _Same(expected));

/// Matches null (reeval's `toBeNull`).
const ReevalMatcher isNull = ReevalMatcher._('toBeNull', [], m.isNull);

/// Matches anything but null.
const ReevalMatcher isNotNull = ReevalMatcher._(
  'toBeNull',
  [],
  m.isNull,
  not: true,
);

/// Matches `true`.
const ReevalMatcher isTrue = ReevalMatcher._('toBe', [true], m.isTrue);

/// Matches `false`.
const ReevalMatcher isFalse = ReevalMatcher._('toBe', [false], m.isFalse);

/// Matches a value that isn't null, false, 0 or empty text (reeval's
/// `toBeTruthy`).
const ReevalMatcher isTruthy = ReevalMatcher._('toBeTruthy', [], _Truthy());

/// Matches text containing [expected], or a list or map with it (reeval's
/// `toContain`).
ReevalMatcher contains(Object? expected) =>
    ReevalMatcher._('toContain', [expected], m.contains(expected));

/// Matches a command that exited 0: an [ExecResult], or `c.poll.exec(…)`.
const ReevalMatcher succeeds = ReevalMatcher._('toSucceed', [], _Succeeds());

/// Matches a judge's [Verdict] that passed.
const ReevalMatcher passes = ReevalMatcher._('toPass', [], _Passes());

/// Matches an attempt or turn whose workspace has the file [path], with
/// [contents] (a string it contains, or a [RegExp] it matches) when given.
ReevalMatcher hasFile(String path, [Pattern? contents]) =>
    reevalMatcher('toHaveFile', [path, ?contents]);

/// Matches an attempt or turn in which the agent ran a command, or one
/// matching [command].
ReevalMatcher hasRun([Object? command = _no]) =>
    reevalMatcher('toHaveRun', _given([command]));

/// Matches an attempt or turn in which the agent edited a file, or [path].
ReevalMatcher hasEdited([Object? path = _no]) =>
    reevalMatcher('toHaveEdited', _given([path]));

/// Matches an attempt or turn that changed the workspace, or [paths] (a
/// pattern or a list of them).
ReevalMatcher hasChanged([Object? paths = _no]) =>
    reevalMatcher('toHaveChanged', _given([paths]));

/// Matches an attempt or turn in which the agent searched the web, or for
/// [query].
ReevalMatcher hasSearched([Object? query = _no]) =>
    reevalMatcher('toHaveSearched', _given([query]));

/// Matches an attempt or turn in which the agent fetched a URL, or [url].
ReevalMatcher hasFetched([Object? url = _no]) =>
    reevalMatcher('toHaveFetched', _given([url]));

/// Matches an attempt or turn in which the agent used the skill [name].
ReevalMatcher hasCalledSkill(String name) =>
    reevalMatcher('toHaveCalledSkill', [name]);

/// Matches an attempt or turn in which the agent called [tool] on the MCP
/// server [server], with [input] when given.
ReevalMatcher hasCalledMcp(String server, String tool, [Object? input = _no]) =>
    reevalMatcher('toHaveCalledMcp', _given([server, tool, input]));

/// Matches an attempt or turn in which the agent called the tool [name] (a
/// string or [RegExp]), with [input] when given.
ReevalMatcher hasCalledTool(Pattern name, [Object? input = _no]) =>
    reevalMatcher('toHaveCalledTool', _given([name, input]));

/// Matches what [matcher] doesn't.
m.Matcher isNot(Object? matcher) =>
    matcher is ReevalMatcher ? matcher._negated : m.isNot(matcher);

final class _Same extends m.Matcher {
  const _Same(this.expected);
  final Object? expected;

  @override
  bool matches(Object? item, Map<Object?, Object?> matchState) =>
      switch (expected) {
        null || bool() || num() || String() => item == expected,
        _ => identical(item, expected),
      };

  @override
  m.Description describe(m.Description description) =>
      description.add('the same as ').addDescriptionOf(expected);
}

final class _Truthy extends m.Matcher {
  const _Truthy();

  @override
  bool matches(Object? item, Map<Object?, Object?> matchState) =>
      !(item == null || item == false || item == 0 || item == '');

  @override
  m.Description describe(m.Description description) =>
      description.add('a truthy value');
}

final class _Succeeds extends m.Matcher {
  const _Succeeds();

  @override
  bool matches(Object? item, Map<Object?, Object?> matchState) =>
      item is ExecResult && item.ok;

  @override
  m.Description describe(m.Description description) =>
      description.add('a command that exits 0');

  @override
  m.Description describeMismatch(
    Object? item,
    m.Description mismatch,
    Map<Object?, Object?> matchState,
    bool verbose,
  ) => item is ExecResult
      ? mismatch.add(
          'exited ${item.exitCode}'
          '${item.stderr.trim().isEmpty ? '' : ': ${item.stderr.trim()}'}',
        )
      : mismatch.add('is not an ExecResult');
}

final class _Passes extends m.Matcher {
  const _Passes();

  @override
  bool matches(Object? item, Map<Object?, Object?> matchState) =>
      item is Verdict && item.passed;

  @override
  m.Description describe(m.Description description) =>
      description.add('a passing verdict');

  @override
  m.Description describeMismatch(
    Object? item,
    m.Description mismatch,
    Map<Object?, Object?> matchState,
    bool verbose,
  ) => item is Verdict
      ? mismatch.add(
          'the judge scored ${item.score} (threshold ${item.threshold})',
        )
      : mismatch.add('is not a Verdict');
}

/// Checks [actual] against [matcher] now, as package:test's `expect` does,
/// and records the check, named by what the eval wrote as [actual].
///
/// [reason] names the check. A failure throws, ending the body, unless
/// [soft]: then it fails the attempt once the body is done. Matchers that
/// read the sandbox (`hasFile`, …) need `await expectLater`.
void expect(
  Object? actual,
  Object? matcher, {
  String? reason,
  bool soft = false,
}) {
  if (actual is Future) {
    throw ArgumentError.value(
      actual,
      'actual',
      'expect() got a Future: await it, or use await expectLater(…)',
    );
  }
  if (actual is Polled) {
    throw ArgumentError.value(
      actual,
      'actual',
      'c.poll is retried by reeval: use await expectLater(…)',
    );
  }
  if (matcher is ReevalMatcher && !matcher.isLocal) {
    throw ArgumentError.value(matcher, 'matcher', _readsTheSandbox(matcher));
  }
  final subject = firstArgument(evalFrame(StackTrace.current));
  _checkHere(actual, matcher, reason, soft, subject);
}

/// Awaits [actual] when it's a Future, then checks it: reeval runs its own
/// matchers ([hasFile], [hasRun], [succeeds], [equals], …), and any other
/// matcher is checked here. A plain value means [equals].
///
/// The subject is the attempt (`c`), a [Turn], an [ExecResult], a
/// `c.poll…` subject reeval retries, or a JSON value. [reason] names the
/// check. A failure throws, unless [soft]: then it fails the attempt once
/// the body is done. Always await it.
Future<void> expectLater(
  Object? actual,
  Object? matcher, {
  String? reason,
  bool soft = false,
}) {
  final subject = firstArgument(evalFrame(StackTrace.current));
  final attempt = Attempt.current;
  final check = _expectLater(actual, matcher, reason, soft, subject, attempt);
  if (attempt == null) return check;
  attempt.inflight.add(check);
  return check.whenComplete(() => attempt.inflight.remove(check));
}

Future<void> _expectLater(
  Object? actual,
  Object? matcher,
  String? reason,
  bool soft,
  String? written,
  Attempt? attempt,
) async {
  final value = actual is Future ? await actual : actual;
  final wrapped = matcher is m.Matcher ? matcher : equals(matcher);
  if (wrapped is! ReevalMatcher) {
    return _checkHere(value, wrapped, reason, soft, written);
  }
  if (attempt == null) {
    if (wrapped.isLocal && value is! Polled && value is! AttemptContext) {
      return _checkHere(value, wrapped, reason, soft, written);
    }
    throw StateError('expectLater with ${wrapped.name} runs in an eval body');
  }
  final reply = await attempt.request({
    'op': 'expect',
    'subject': _subject(value),
    'matcher': wrapped.name,
    'args': _args(wrapped.args),
    'not': wrapped.not,
    'soft': soft,
    'label': ?reason,
    if (value is Polled) 'poll': value.poll,
  });
  final assertion = reply['assertion'] as Map<String, Object?>? ?? const {};
  if (assertion['status'] == 'fail' && !soft) {
    throw recordedFailure(assertion['message'] as String? ?? 'expect failed');
  }
}

Map<String, Object?> _subject(Object? actual) => switch (actual) {
  AttemptContext() => const {'attempt': true},
  Polled(:final subject) => subject,
  Turn(:final index) => {'turn': index},
  ExecResult() => {'exec': actual.command, 'result': actual.toJson()},
  _ => {'value': jsonValue(actual)},
};

/// A matcher's arguments as reeval reads them: a [RegExp] as JavaScript's
/// (Dart's patterns are JavaScript's), at any depth.
List<Object?> _args(List<Object?> args) {
  Object? arg(Object? value) => switch (value) {
    RegExp() => {
      'regexp': value.pattern,
      if (_flags(value) case final flags when flags.isNotEmpty) 'flags': flags,
    },
    List() => [for (final item in value) arg(item)],
    Map() => {
      for (final MapEntry(:key, :value) in value.entries) '$key': arg(value),
    },
    _ => jsonValue(value),
  };
  return [for (final value in args) arg(value)];
}

String _flags(RegExp pattern) => [
  if (!pattern.isCaseSensitive) 'i',
  if (pattern.isMultiLine) 'm',
  if (pattern.isDotAll) 's',
  if (pattern.isUnicode) 'u',
].join();

void _checkHere(
  Object? actual,
  Object? matcher,
  String? reason,
  bool soft,
  String? subject,
) {
  final wrapped = m.wrapMatcher(matcher);
  final state = <Object?, Object?>{};
  final attempt = Attempt.current;
  final record = <String, Object?>{
    'op': 'record',
    'matcher': 'expect',
    'subject': ?subject,
    'label': ?reason,
    'status': 'pass',
    if (soft) 'soft': true,
  };
  bool passed;
  try {
    passed = wrapped.matches(actual, state);
  } on TestFailure {
    rethrow;
  } on Object catch (error) {
    passed = false;
    state['reeval.threw'] = error;
  }
  if (passed) {
    attempt?.record(record);
    return;
  }
  final message = _describe(actual, wrapped, state, reason);
  record
    ..['status'] = 'fail'
    ..['message'] = message;
  if (soft && attempt != null) return attempt.record(record);
  throw failure(message, record);
}

String _describe(
  Object? actual,
  m.Matcher matcher,
  Map<Object?, Object?> state,
  String? reason,
) {
  final expected = m.StringDescription();
  matcher.describe(expected);
  final which = m.StringDescription();
  if (state['reeval.threw'] case final error?) {
    which.add('threw $error');
  } else {
    matcher.describeMismatch(actual, which, state, false);
  }
  final text = [
    'Expected: $expected',
    '  Actual: ${m.StringDescription().addDescriptionOf(actual)}',
    if (which.length > 0) '   Which: $which',
  ].join('\n');
  return reason == null ? text : '$reason: $text';
}
