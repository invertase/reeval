import 'package:reeval/reeval.dart';

void main() {
  group('slow things', tags: ['slow'], () {
    evaluate('big', (c) {});
    evaluate('bigger', (c) {}, tags: ['flaky']);
  });
  evaluate('quick', (c) {});
  evaluate.each(
    [
      {'n': 1},
      {'n': 2},
    ],
    r'case $n',
    (c, n) {},
    tags: ['slow'],
  );
}
