import 'package:reeval/reeval.dart';

void main() {
  evaluate('record', (c) {
    const exists = true;
    c.check(exists, reason: 'greet.dart exists');
    final result = (ok: true);
    c.check(result.ok);
    c.check(result.ok);
    c.check(1 == 2, reason: 'one is two', subject: 'one == 2');
  });
}
