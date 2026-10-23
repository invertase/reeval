package evals

import (
	"context"

	"github.com/invertase/reeval/sdks/go/reeval"
)

func EvalFromGo(e *reeval.E) {
	e.Run("from go", func(context.Context, *reeval.C) error { return nil })
}
