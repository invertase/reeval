import 'package:reeval/reeval.dart';

import 'envs.dart';

void main() {
  evaluate(
    'control and two variants',
    (c) {},
    compare: Compare(baseline: base, variants: [skilled, terse]),
  );
  evaluate(
    'every cell gated, with a minimum lift',
    (c) {},
    compare: Compare(
      baseline: base,
      variants: [skilled],
      gate: CompareGate.all,
      minLift: 0.2,
    ),
    runs: 2,
  );
}
