import 'package:reeval/reeval.dart';

void main() {
  evaluate('sync-async', (c) async {
    await expectLater(await c.exec('echo sync-async-ok'), succeeds);
  });
}
