// `expect` and `expectLater` as in package:test, over package:matcher, so every standard matcher
// works, plus reeval's own: `succeeds`, `exitsWith`, `passes`, `usedTool` and `hasFile`. A failure
// carries `expected` and `actual` when they're plain values, and the binary prints the diff.
import 'package:matcher/matcher.dart';

import 'context.dart';

/// An expectation that failed; the attempt fails as an assertion.
final class ReevalAssertion implements Exception {
  const ReevalAssertion(this.message, {this.expected, this.actual, this.diffable = false});
  final String message;
  final Object? expected;
  final Object? actual;

  /// Whether `expected` and `actual` are plain values worth a diff.
  final bool diffable;

  @override
  String toString() => message;
}

/// A matcher that reads the sandbox, so it needs `await expectLater(...)`.
abstract base class AsyncMatcher {
  const AsyncMatcher();

  String get description;

  /// Why `actual` doesn't match, or null when it does.
  Future<String?> mismatch(Object? actual);
}

/// Checks `actual` now. For a Future or an [AsyncMatcher], use `await expectLater(...)`.
void expect(Object? actual, Object? matcher, {String? reason}) {
  if (actual is Future) {
    throw ArgumentError(
      'expect() got a Future. Await it first, or use await expectLater(future, matcher).',
    );
  }
  if (matcher is AsyncMatcher) {
    throw ArgumentError('${matcher.description} reads the sandbox: use await expectLater(...).');
  }
  _check(actual, matcher, reason);
}

/// Awaits `actual` if it's a Future, then checks it; the only way to use an [AsyncMatcher].
Future<void> expectLater(Object? actual, Object? matcher, {String? reason}) async {
  final value = actual is Future ? await actual : actual;
  if (matcher is AsyncMatcher) {
    final why = await matcher.mismatch(value);
    if (why == null) return;
    throw ReevalAssertion(_format(matcher.description, _show(value), why, reason));
  }
  _check(value, matcher, reason);
}

bool _plain(Object? value) => switch (value) {
  null || bool() || num() || String() => true,
  List() => value.every(_plain),
  Map() => value.keys.every((k) => k is String) && value.values.every(_plain),
  _ => false,
};

String _show(Object? value) => StringDescription().addDescriptionOf(value).toString();

String _oneLine(Object? value) {
  final shown = value is String ? "'${value.replaceAll('\n', r'\n')}'" : _show(value);
  return shown.length > 60 ? '${shown.substring(0, 57)}...' : shown;
}

String _format(String expected, String actual, String which, String? reason) => [
  'Expected: $expected',
  '  Actual: $actual',
  if (which.isNotEmpty) '   Which: $which',
  ?reason,
].join('\n');

void _check(Object? actual, Object? expected, String? reason) {
  final matcher = wrapMatcher(expected);
  final state = <Object?, Object?>{};
  if (matcher.matches(actual, state)) return;
  final description = StringDescription();
  matcher.describe(description);
  // Plain values get the binary's diff, so the message stays one line, as `expect(a).toBe(b)` does.
  if (expected is! Matcher && _plain(expected) && _plain(actual)) {
    throw ReevalAssertion(
      [
        'expected ${_oneLine(actual)} to equal ${_oneLine(expected)}',
        ?reason,
      ].join('\n'),
      expected: expected,
      actual: actual,
      diffable: true,
    );
  }
  final which = StringDescription();
  matcher.describeMismatch(actual, which, state, false);
  throw ReevalAssertion(
    _format(description.toString(), _show(actual), which.toString(), reason),
  );
}

final class _ExitsWith extends Matcher {
  const _ExitsWith(this.code);
  final int code;

  @override
  bool matches(Object? item, Map<Object?, Object?> matchState) => switch (item) {
    {'exitCode': final int exitCode} => exitCode == code,
    _ => false,
  };

  @override
  Description describe(Description description) =>
      description.add(code == 0 ? 'a command that succeeds' : 'a command that exits with $code');

  @override
  Description describeMismatch(
    Object? item,
    Description mismatch,
    Map<Object?, Object?> matchState,
    bool verbose,
  ) => switch (item) {
    {'exitCode': final int exitCode, 'stderr': final String stderr} => mismatch.add(
      'exited with $exitCode${stderr.trim().isEmpty ? '' : '; stderr:\n${_tail(stderr)}'}',
    ),
    _ => mismatch.add('is not an ExecResult'),
  };
}

String _tail(String text, [int lines = 20]) {
  final all = text.trimRight().split('\n');
  return all.skip(all.length > lines ? all.length - lines : 0).join('\n');
}

/// Matches an [ExecResult] that exited 0.
const Matcher succeeds = _ExitsWith(0);

/// Matches an [ExecResult] that exited with `code`.
Matcher exitsWith(int code) => _ExitsWith(code);

final class _Passes extends Matcher {
  const _Passes();

  @override
  bool matches(Object? item, Map<Object?, Object?> matchState) => switch (item) {
    {'verdict': 'pass'} => true,
    _ => false,
  };

  @override
  Description describe(Description description) => description.add('a passing verdict');

  @override
  Description describeMismatch(
    Object? item,
    Description mismatch,
    Map<Object?, Object?> matchState,
    bool verbose,
  ) => switch (item) {
    {'score': final num score, 'threshold': final num threshold, 'question': final String q} =>
      mismatch.add('the judge scored $score (threshold $threshold) on "$q"'),
    _ => mismatch.add('is not a Verdict'),
  };
}

/// Matches a [Verdict] whose score reached its threshold.
const Matcher passes = _Passes();

final class _UsedTool extends Matcher {
  const _UsedTool(this.tool);
  final String tool;

  @override
  bool matches(Object? item, Map<Object?, Object?> matchState) =>
      item is Turn && item.tools.contains(tool);

  @override
  Description describe(Description description) => description.add('a turn that used $tool');

  @override
  Description describeMismatch(
    Object? item,
    Description mismatch,
    Map<Object?, Object?> matchState,
    bool verbose,
  ) => item is Turn
      ? mismatch.add('used ${item.tools.isEmpty ? 'no tools' : item.tools.toSet().join(', ')}')
      : mismatch.add('is not a Turn');
}

/// Matches a [Turn] whose transcript has a call to `tool`.
Matcher usedTool(String tool) => _UsedTool(tool);

final class _HasFile extends AsyncMatcher {
  const _HasFile(this.path, this.content);
  final String path;
  final Object? content;

  @override
  String get description =>
      content == null ? 'a workspace with $path' : 'a workspace whose $path matches';

  @override
  Future<String?> mismatch(Object? actual) async {
    final read = switch (actual) {
      Turn(:final readFile) || EvalContext(:final readFile) => readFile,
      _ => null,
    };
    if (read == null) return 'is not a Turn or EvalContext';
    final text = await read(path);
    if (text == null) return 'has no $path';
    if (content == null) return null;
    final matcher = wrapMatcher(content);
    final state = <Object?, Object?>{};
    if (matcher.matches(text, state)) return null;
    final why = StringDescription()
      ..add('$path is ')
      ..addDescriptionOf(text)
      ..add(', which ');
    matcher.describeMismatch(text, why, state, false);
    return why.toString();
  }
}

/// Matches a [Turn] or [EvalContext] whose workspace has `path`, optionally matching `content`
/// (a string, a [RegExp] via `matches(...)`, or any matcher). Use with `await expectLater`.
AsyncMatcher hasFile(String path, [Object? content]) => _HasFile(path, content);
