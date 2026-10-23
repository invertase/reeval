import 'package:reeval/reeval.dart';

final parent = Environment('parent', sandbox: docker(from: 'node:22-bookworm'));
final child = parent.extend('child', sandbox: docker(from: 'node:24-bookworm'));
final kept = parent.extend('kept', env: {'MODE': 'x'});

void main() {
  evaluate('parent image', (c) {}, environment: parent);
  evaluate('child replaces sandbox', (c) {}, environment: child);
  evaluate('child keeps parent sandbox', (c) {}, environment: kept);
}
