// Package runnerenv checks that a Go runner was started by a reeval it can serve.
package runnerenv

import (
	"fmt"
	"strconv"
)

const sdk = "github.com/invertase/reeval/sdks/go"

// Mismatch is why a runner speaking protocol can't serve the reeval that started it, or "" when
// it can. reeval sets REEVAL_RUNNER=stdio and REEVAL_RUNNER_PROTOCOL; the runner says this
// instead of hello, so a mismatch names both versions rather than failing mid-session.
func Mismatch(lookup func(string) (string, bool), version string, protocol int) string {
	startedBy, ok := lookup("REEVAL_RUNNER")
	if !ok {
		return "This is reeval's Go runner; run evals with go tool reeval run."
	}
	ours := fmt.Sprintf("%s %s speaks runner protocol %d", sdk, version, protocol)
	if startedBy != "stdio" {
		return ours + ", but the reeval that started it is older: use the reeval that matches it."
	}
	theirs, _ := lookup("REEVAL_RUNNER_PROTOCOL")
	if theirs == strconv.Itoa(protocol) {
		return ""
	}
	if theirs == "" {
		theirs = "an older one"
	}
	return fmt.Sprintf("%s, but the reeval that started it speaks %s: use the %s version that "+
		"matches reeval (go get -tool %s/cmd/reeval@v<reeval's version>).", ours, theirs, sdk, sdk)
}
