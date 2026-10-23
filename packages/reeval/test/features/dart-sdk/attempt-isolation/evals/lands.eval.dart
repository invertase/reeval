import 'package:reeval/reeval.dart';

void main() {
  // Runs first and times out. Its body wakes while "lands" (same file, same
  // cell, so the same attempt id) is running, and tries to run a command there.
  evaluate('times out', (c) async {
    await Future<void>.delayed(const Duration(seconds: 2));
    await expectLater(await c.exec('touch zombie.txt'), succeeds);
  }, timeout: const Duration(seconds: 1));

  evaluate('lands', (c) async {
    await Future<void>.delayed(const Duration(seconds: 3));
    await expectLater(await c.exec('test ! -f zombie.txt'), succeeds);
  });
}
