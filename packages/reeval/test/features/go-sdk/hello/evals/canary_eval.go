package evals

import (
	"context"

	"github.com/invertase/reeval/sdks/go/reeval"
)

func EvalCanary(e *reeval.E) {
	e.Run("canary", func(ctx context.Context, c *reeval.C) error {
		c.Log("looking for missing-greet.go")
		missing, err := c.Exec(ctx, "test -f missing-greet.go")
		if err != nil {
			return err
		}
		c.Expect(ctx, missing).ToSucceed()
		return nil
	})
}
