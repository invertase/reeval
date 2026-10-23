package declare

import "github.com/invertase/reeval/sdks/go/reeval"

func EvalCompareQuestions(e *reeval.E) {
	e.Run("one question", nothing, reeval.Options{Compare: &reeval.Compare{
		Baseline:  base,
		Variants:  []*reeval.Environment{skilled},
		Questions: []reeval.Question{{Text: "Which handles state more cleanly?"}},
	}})
	e.Run("two questions, one with its own model", nothing, reeval.Options{Compare: &reeval.Compare{
		Baseline: base,
		Variants: []*reeval.Environment{skilled, terse},
		Questions: []reeval.Question{
			{Text: "Which handles state more cleanly?"},
			{Text: "Which follows the house style more closely?", Model: "google/gemini-3.8-flash"},
		},
	}})
	e.Run("pinned", nothing, reeval.Options{
		Compare: &reeval.Compare{
			Baseline:  base,
			Variants:  []*reeval.Environment{skilled},
			Questions: []reeval.Question{{Text: "Which is shorter?"}},
		},
		Pin: []string{"compare"},
	})
}
