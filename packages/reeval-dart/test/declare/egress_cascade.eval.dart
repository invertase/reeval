import 'package:reeval/reeval.dart';

final closed = Environment('closed', egress: Egress.denyAll);
final reopened = closed.extend('reopened', egress: Egress.allowAll);
final installs = Environment(
  'installs',
  egress: Egress.allow([...defaultEgressAllow, 'api.example.com']),
);
final plain = Environment('plain');

void body(AttemptContext c) {}

void main() {
  evaluate('the config policy', body);
  evaluate('an environment replaces it', body, environment: closed);
  evaluate('an extend child replaces its parent', body, environment: reopened);
  evaluate('the default list spreads', body, environment: installs);
  evaluate(
    'the eval replaces the environment',
    body,
    environment: closed,
    egress: Egress.allow(['eval.example.com']),
  );
  group('a group', egress: Egress.allow(['group.example.com']), () {
    evaluate('replaces the environment too', body, environment: closed);
  });
  evaluate(
    'a variant runs under its own policy',
    body,
    compare: Compare(baseline: plain, variants: [closed]),
  );
  evaluate(
    "a fake agent with a layout gets that agent's hosts",
    body,
    environment: closed,
    harness: fakeHarness(layout: 'claude-code'),
  );
}
