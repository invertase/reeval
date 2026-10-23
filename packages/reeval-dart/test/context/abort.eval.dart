import 'package:reeval/reeval.dart';

void main() {
  evaluate('abort', (c) async {
    await c.exec('sleep 20');
  }, timeout: const Duration(seconds: 1));
}
