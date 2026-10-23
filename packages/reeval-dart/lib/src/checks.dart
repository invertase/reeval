// Checks the eval's own Dart makes (`expect`, `c.check`, `assert`, package:checks):
// each is a `record` call, so reeval names, counts and compares it like its
// own matchers. A pass is recorded at once; a failure travels on its error and
// is recorded only if that escapes the body, so a failure the body catches
// isn't a failed check.
import 'package:test_api/hooks.dart' show TestFailure;

import 'source.dart';

final _unrecorded = Expando<Map<String, Object?>>('reeval record');
final _recorded = Expando<bool>('reeval recorded');

/// A failure to throw, whose [record] call is made if it escapes the body.
TestFailure failure(String message, Map<String, Object?> record) {
  final error = TestFailure(message);
  _unrecorded[error] = record;
  return error;
}

/// A failure reeval recorded already (a matcher it ran).
TestFailure recordedFailure(String message) {
  final error = TestFailure(message);
  _recorded[error] = true;
  return error;
}

/// The `record` call for [error] escaping the body, or null when there's none
/// to make. [frame] names a check another library failed.
Map<String, Object?>? escapedRecord(Object error, StackTrace stack) {
  if (error is TestFailure) {
    if (_recorded[error] == true) return null;
    if (_unrecorded[error] case final record?) return record;
    final frame = evalFrame(stack);
    final checks = stack.toString().contains('package:checks/');
    return {
      'op': 'record',
      'matcher': checks ? 'check' : 'expect',
      'subject': ?statementAt(frame),
      'status': 'fail',
      'message': error.message ?? 'TestFailure',
    };
  }
  if (error is AssertionError) {
    final (subject, message) = assertionParts(error);
    return {
      'op': 'record',
      'matcher': 'assert',
      'subject': subject,
      'status': 'fail',
      'message': message,
    };
  }
  return null;
}

final _failedAssertion = RegExp(
  r"Failed assertion: line \d+ pos \d+: '([\s\S]*)': ([\s\S]*)$",
);

/// A Dart `assert`'s condition as written, and its failure's message.
(String subject, String message) assertionParts(AssertionError error) {
  final reason = error.message?.toString();
  final match = _failedAssertion.firstMatch(error.toString());
  if (match == null) {
    return ('AssertionError', reason ?? error.toString());
  }
  final subject = oneLine(match[1]!);
  final detail = 'assert $subject';
  return (subject, reason == null ? detail : '$reason: $detail');
}
