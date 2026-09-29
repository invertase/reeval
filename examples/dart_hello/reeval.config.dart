// Runs with no credentials or Docker: a fake agent writes canned Dart files into a temp directory,
// the checks run there on the host, and the judge returns a canned verdict.
import 'package:reeval/reeval.dart';

import 'evals/fake_agent.dart';

ReevalConfig main() => defineConfig(
  harness: fakeAgent,
  sandbox: fakeSandbox(),
  judge: Judge.fake(score: 0.92),
  timeout: const Duration(minutes: 2),
  profiles: {'nightly': const Profile(runs: 3)},
);
