package declare

import (
	"context"

	"github.com/invertase/reeval/sdks/go/reeval"
)

func EvalTags(e *reeval.E) {
	e.Group("slow things", func(e *reeval.E) {
		e.Run("big", nothing)
		e.Run("bigger", nothing, reeval.Options{Tags: []string{"flaky"}})
	}, reeval.Options{Tags: []string{"slow"}})
	e.Run("quick", nothing)
	type sized struct{ N int }
	reeval.Each(e, "case $n", []sized{{1}, {2}}, func(context.Context, *reeval.C, sized) error { return nil },
		reeval.Options{Tags: []string{"slow"}})
}
