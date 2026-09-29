// Runs with no credentials or Docker: a fake agent writes canned Dart files into a temp directory,
// the checks run there on the host, and the judge returns a canned verdict.
import 'package:reeval/reeval.dart';

const _greet = '''
String greet(String name) => 'Hello, \$name!';
''';

const _main = '''
import '../lib/greet.dart';

void main(List<String> args) => print(greet(args.firstOrNull ?? 'Dart'));
''';

ReevalConfig main() => defineConfig(
  harness: fakeHarness(
    files: {'lib/greet.dart': _greet, 'bin/main.dart': _main},
    text: 'I created lib/greet.dart with greet(name), and bin/main.dart, which prints it.',
  ),
  sandbox: fakeSandbox(),
  judge: Judge.fake(score: 0.92),
  timeout: const Duration(minutes: 2),
  profiles: {'nightly': const Profile(runs: 3)},
);
