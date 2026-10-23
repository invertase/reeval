/// reeval refused a call or couldn't make it. [name] is reeval's name for why,
/// such as `UsageError` or `InfraError`.
final class ReevalCallError implements Exception {
  const ReevalCallError(this.name, this.message);

  final String name;
  final String message;

  @override
  String toString() => '$name: $message';
}

/// reeval aborted the attempt: its timeout ran out, or the run was stopped.
/// Every call the body makes from then on throws this.
final class AttemptAborted implements Exception {
  const AttemptAborted(this.name, this.message);

  /// `TimeoutError` or `AbortError`.
  final String name;
  final String message;

  @override
  String toString() => '$name: $message';
}

/// The eval used the API in a way it can't work, such as an `expectLater`
/// it never awaited.
final class UsageError implements Exception {
  const UsageError(this.message);

  final String message;

  @override
  String toString() => 'UsageError: $message';
}
