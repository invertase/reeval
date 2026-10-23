import 'package:reeval/reeval.dart';

void main() {
  evaluate('judge', (c) async {
    final first = await c.send('Write greet.js exporting greet(name).');
    await c.send('Now add a test.');
    await c.judge('Does greet.js export greet?');
    await c.judge(
      'Is the greeting polite?',
      model: fakeJudge(score: 0.2),
      on: 'Hello, Ada!',
    );
    await c.judge(
      'Did the first turn write greet.js?',
      on: first,
      threshold: 0.95,
    );
  });
}
