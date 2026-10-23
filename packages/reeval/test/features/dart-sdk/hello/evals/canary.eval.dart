import 'package:reeval/reeval.dart';

void main() {
  evaluate('canary', (c) async {
    print('looking for missing-greet.dart');
    await expectLater(await c.exec('test -f missing-greet.dart'), succeeds);
  });
}
