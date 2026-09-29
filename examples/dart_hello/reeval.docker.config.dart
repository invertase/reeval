// The fake agent in a Docker sandbox built from the official Dart image, so `t.exec('dart ...')`
// runs in the container. Build it once: reeval image build --config reeval.docker.config.dart
import 'package:reeval/reeval.dart';

import 'evals/fake_agent.dart';

ReevalConfig main() => defineConfig(
  harness: fakeAgent,
  sandbox: docker(from: 'dart:stable'),
  judge: Judge.fake(score: 0.92),
  timeout: const Duration(minutes: 5),
);
