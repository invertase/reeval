import 'package:reeval/reeval.dart';

const _task =
    'Create lib/greet.dart exporting String greet(String name) that returns "Hello, <name>!", '
    'and bin/main.dart that prints greet() of its first argument, or of "Dart" without one. '
    'Import lib/greet.dart with a relative import. No dependencies.';

void main() {
  group('greet library', tags: ['smoke'], () {
    evaluate('writes a greet function', (t) async {
      final turn = await t.send(_task);

      await expectLater(turn, hasFile('lib/greet.dart', contains('String greet(')));
      final run = await t.exec('dart bin/main.dart');
      expect(run, succeeds);
      expect(run.stdout.trim(), 'Hello, Dart!');
      print('the agent changed ${turn.changedFiles.join(', ')}');

      expect(await t.judge('Does the final message describe the files it created?'), passes);
    });

    for (final (name, greeting) in [('Ada', 'Hello, Ada!'), ('Grace', 'Hello, Grace!')]) {
      evaluate('greets $name', (t) async {
        await t.send(_task);
        final run = await t.exec('dart bin/main.dart $name');
        expect(run.stdout.trim(), greeting);
      });
    }
  });

  todo('handles names with emoji');
}
