import 'package:reeval/reeval.dart';
// Typed matchers can't name one reeval doesn't have; the internal one can.
import 'package:reeval/src/expect.dart' show reevalMatcher;

void main() {
  evaluate('expect-fail', (c) async {
    try {
      await expectLater(1, reevalMatcher('toBeShiny'));
    } on ReevalCallError {
      // reeval refuses it, and the body goes on.
    }
    await expectLater(1, same(2), reason: 'one is two');
  });
}
