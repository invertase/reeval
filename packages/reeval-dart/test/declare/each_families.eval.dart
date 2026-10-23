import 'package:reeval/reeval.dart';

import 'envs.dart';

void main() {
  evaluate.each(
    ['ada', 'grace', 'linus'],
    'pooled across %s',
    (c, who) {},
    compare: Compare(baseline: base, variants: [skilled], minLift: 0.2),
  );
  evaluate.each(
    [
      {'who': 'ada'},
      {'who': 'grace'},
    ],
    r'each on its own for $who',
    (c, person) {},
    pool: false,
    compare: Compare(baseline: base, variants: [skilled]),
  );
  evaluate.each(['only'], 'one case is not a family: %s', (c, only) {});
}
