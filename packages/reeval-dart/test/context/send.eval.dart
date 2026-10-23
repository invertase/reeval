import 'package:reeval/reeval.dart';

void main() {
  evaluate('send', (c) async {
    await c.send('Write greet.js exporting greet(name).');
    await c.readFile('greet.js');
    await c.send('Now add a test.');
  });
}
