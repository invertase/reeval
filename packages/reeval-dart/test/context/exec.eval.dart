import 'package:reeval/reeval.dart';

void main() {
  evaluate('exec', (c) async {
    await c.exec('echo hello');
    await c.exec('echo oops >&2; exit 3');
    final server = await c.background('sleep 30');
    await server.kill();
    await server.kill();
  });
}
