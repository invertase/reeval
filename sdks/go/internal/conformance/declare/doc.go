// Package declare mirrors reeval's declare/ conformance goldens: each file declares what its
// golden's TypeScript eval file does.
package declare

import (
	"context"

	"github.com/invertase/reeval/sdks/go/reeval"
)

func nothing(context.Context, *reeval.C) error { return nil }

var (
	base    = reeval.DefineEnvironment("base", reeval.Spec{Env: map[string]string{"MODE": "base"}})
	skilled = base.Extend("skilled", reeval.Spec{Env: map[string]string{"MODE": "skilled"}})
	terse   = base.Extend("terse", reeval.Spec{Env: map[string]string{"MODE": "terse"}})
)
