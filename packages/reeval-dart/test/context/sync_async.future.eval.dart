import 'package:reeval/reeval.dart';

// A body that returns the Future instead of awaiting it sends the same calls.
void main() {
  evaluate(
    'sync-async',
    (c) => expectLater(c.exec('echo sync-async-ok'), succeeds),
  );
}
