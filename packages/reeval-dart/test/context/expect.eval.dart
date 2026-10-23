import 'package:reeval/reeval.dart';

void main() {
  evaluate('expect', (c) async {
    final turn = await c.send('Write greet.js exporting greet(name).');
    await expectLater(turn, hasEdited('greet.js'));
    await expectLater(
      {
        'a': 1,
        'b': [2, 3],
      },
      equals({
        'a': 1,
        'b': [2, 3],
      }),
    );
    await expectLater(await c.exec('test -f greet.js'), succeeds);
    await expectLater(await c.readFile('README.md'), isNull);
    await c.background("sh -c 'sleep 0.3; echo ready > ready.txt'");
    await expectLater(
      c.poll.readFile(
        'ready.txt',
        interval: const Duration(milliseconds: 50),
        timeout: const Duration(seconds: 10),
      ),
      same('ready\n'),
    );
    await expectLater(
      c.poll(timeout: const Duration(seconds: 10)),
      hasFile('ready.txt'),
      reason: 'the server is ready',
    );
    await expectLater(
      'draft',
      same('final'),
      reason: 'the copy is final',
      soft: true,
    );
  });
}
