import 'package:reeval/reeval.dart';

void main() {
  group('parked', skip: true, () {
    evaluate('inside', (c) {});
    group('nested', () {
      evaluate('deeper', (c) {});
    });
  });
  todo('someday');
}
