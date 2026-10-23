import 'package:reeval/reeval.dart';

void main() {
  // The mistake: expects the timed-out body's file, which never lands anywhere.
  evaluate('canary', (c) async {
    await expectLater(await c.exec('test -f zombie.txt'), succeeds);
  });
}
