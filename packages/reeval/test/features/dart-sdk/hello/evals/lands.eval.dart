import 'package:reeval/reeval.dart';

void main() {
  evaluate('lands', (c) async {
    await c.send(
      'Create a file named greet.dart in the workspace root whose entire '
      "content is exactly: void main() => print('hi');",
    );
    final exists = await c.exec('test -f greet.dart');
    c.check(exists.ok);
    final source = await c.readFile('greet.dart');
    expect(source, contains("print('hi')"), reason: 'greet.dart prints hi');
    final verdict = await c.judge('Does greet.dart print hi when run?');
    expect(verdict, passes);
  });
}
