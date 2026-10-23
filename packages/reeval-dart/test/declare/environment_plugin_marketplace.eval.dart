import 'package:reeval/reeval.dart';

final listed = Environment(
  'listed',
  plugins: [
    Plugin.marketplace(
      'lint@github:acme/agent-plugins',
      ref: 'v3',
      only: ['skills'],
    ),
    Plugin.marketplace('format@npm:@acme/plugins@2.0.0'),
  ],
);

void main() {
  group('marketplace plugins', environment: listed, () {
    evaluate('entries read at the attempt', (c) {});
  });
}
