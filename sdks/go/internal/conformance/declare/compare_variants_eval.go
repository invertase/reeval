package declare

import "github.com/invertase/reeval/sdks/go/reeval"

func EvalCompareVariants(e *reeval.E) {
	e.Run("control and two variants", nothing, reeval.Options{Compare: &reeval.Compare{
		Baseline: base,
		Variants: []*reeval.Environment{skilled, terse},
	}})
	e.Run("every cell gated, with a minimum lift", nothing, reeval.Options{
		Runs: 2,
		Compare: &reeval.Compare{
			Baseline: base,
			Variants: []*reeval.Environment{skilled},
			Gate:     "all",
			MinLift:  0.2,
		},
	})
}
