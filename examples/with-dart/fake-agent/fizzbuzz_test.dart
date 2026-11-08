import 'dart:io';

import 'fizzbuzz.dart';

void main() {
  const want = {3: 'Fizz', 5: 'Buzz', 15: 'FizzBuzz', 7: '7'};
  for (final MapEntry(:key, :value) in want.entries) {
    final got = fizzbuzz(key);
    if (got != value) {
      stderr.writeln('fizzbuzz($key) is $got, want $value');
      exit(1);
    }
  }
  print('ok: ${want.length} cases');
}
