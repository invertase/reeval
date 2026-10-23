import 'package:reeval/reeval.dart';

import 'envs.dart';

void main() {
  evaluate(
    'one question',
    (c) {},
    compare: Compare(
      baseline: base,
      variants: [skilled],
      questions: [Question('Which handles state more cleanly?')],
    ),
  );
  evaluate(
    'two questions, one with its own model',
    (c) {},
    compare: Compare(
      baseline: base,
      variants: [skilled, terse],
      questions: [
        Question('Which handles state more cleanly?'),
        Question(
          'Which follows the house style more closely?',
          model: 'google/gemini-3.8-flash',
        ),
      ],
    ),
  );
  evaluate(
    'pinned',
    (c) {},
    compare: Compare(
      baseline: base,
      variants: [skilled],
      questions: [Question('Which is shorter?')],
    ),
    pin: ['compare'],
  );
}
