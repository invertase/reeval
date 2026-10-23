import 'package:reeval/reeval.dart';

final fetched = Environment(
  'fetched',
  plugins: [
    Plugin.git(
      'github:acme/agent-plugins',
      ref: 'v1.2.0',
      path: 'plugins/review',
    ),
    Plugin.npm('@acme/review-plugin@1.2.0', only: ['skills']),
  ],
);
final pinned = fetched.extend(
  'pinned',
  plugins: [
    Plugin.git(
      'github:acme/agent-plugins',
      ref: 'v1.3.0',
      path: 'plugins/review',
      build: PluginBuild([
        'pnpm install --frozen-lockfile',
        'pnpm build',
      ], cwd: '.'),
    ),
  ],
);

void main() {
  group('remote plugins', environment: fetched, () {
    evaluate('git and npm read at the attempt', (c) {});
    evaluate('a child adds another', (c) {}, environment: pinned);
  });
}
