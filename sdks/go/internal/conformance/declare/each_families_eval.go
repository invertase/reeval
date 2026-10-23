package declare

import (
	"context"

	"github.com/invertase/reeval/sdks/go/reeval"
)

func EvalEachFamilies(e *reeval.E) {
	people := []string{"ada", "grace", "linus"}
	greets := func(context.Context, *reeval.C, string) error { return nil }
	reeval.Each(e, "pooled across %s", people, greets, reeval.Options{Compare: &reeval.Compare{
		Baseline: base, Variants: []*reeval.Environment{skilled}, MinLift: 0.2,
	}})
	reeval.Each(e, "each on its own for %s", people[:2], greets, reeval.Unpooled(), reeval.Options{
		Compare: &reeval.Compare{Baseline: base, Variants: []*reeval.Environment{skilled}},
	})
	reeval.Each(e, "one case is not a family: %s", []string{"only"}, greets)
}
