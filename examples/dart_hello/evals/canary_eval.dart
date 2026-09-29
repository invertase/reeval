import 'package:reeval/reeval.dart';

// Fails on purpose, to show how a Dart failure prints: the matcher's message, the binary's diff,
// and a code frame at this file's line. Run it with: reeval run canary
void main() {
  evaluate('greets in the house style', tags: ['canary'], (t) async {
    await t.send('Create lib/greet.dart and bin/main.dart that greet in the house style.');
    final run = await t.exec('dart bin/main.dart Ada');
    expect(run.stdout, 'Ahoy, Ada!\nWelcome aboard.\n');
  });
}
