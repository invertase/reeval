import 'package:reeval/reeval.dart';

const _greet = '''
String greet(String name) => 'Hello, \$name!';
''';

const _main = '''
import '../lib/greet.dart';

void main(List<String> args) => print(greet(args.firstOrNull ?? 'Dart'));
''';

/// A fake agent that writes the files the evals ask for, for runs without credentials.
final fakeAgent = fakeHarness(
  files: {'lib/greet.dart': _greet, 'bin/main.dart': _main},
  text: 'I created lib/greet.dart with greet(name), and bin/main.dart, which prints it.',
);
