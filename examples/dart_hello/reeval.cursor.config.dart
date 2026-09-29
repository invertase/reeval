// Cursor's agent in a Docker sandbox built from the official Dart image, judged by Gemini. Needs
// CURSOR_API_KEY and GOOGLE_GENERATIVE_AI_API_KEY, and the image:
// reeval image build --config reeval.cursor.config.dart
import 'package:reeval/reeval.dart';

ReevalConfig main() => defineConfig(
  harness: cursor(model: 'composer-2.5'),
  sandbox: docker(from: 'dart:stable'),
  judge: Judge.model('google/gemini-3.8-flash', threshold: 0.8),
  timeout: const Duration(minutes: 10),
);
