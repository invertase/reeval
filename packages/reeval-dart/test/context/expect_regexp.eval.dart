import 'package:reeval/reeval.dart';

void main() {
  evaluate('expect-regexp', (c) async {
    final turn = await c.send('Write greet.js exporting greet(name).');
    await expectLater(
      c,
      hasFile('greet.js', RegExp(r'hello, \$\{name\}', caseSensitive: false)),
      reason: 'greets by name',
    );
    await expectLater(turn, isNot(hasRun(RegExp(r'^npm (test|t)$'))));
  });
}
