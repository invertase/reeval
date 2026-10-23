package runnerenv

import (
	"strings"
	"testing"
)

func TestMismatch(t *testing.T) {
	for _, c := range []struct {
		env  map[string]string
		says string
	}{
		{map[string]string{}, "run evals with go tool reeval run"},
		{map[string]string{"REEVAL_RUNNER": "127.0.0.1:4000"}, "the reeval that started it is older"},
		{map[string]string{"REEVAL_RUNNER": "stdio"}, "v1.2.3 speaks runner protocol 3, but the reeval that started it speaks an older one"},
		{map[string]string{"REEVAL_RUNNER": "stdio", "REEVAL_RUNNER_PROTOCOL": "4"}, "protocol 3, but the reeval that started it speaks 4"},
		{map[string]string{"REEVAL_RUNNER": "stdio", "REEVAL_RUNNER_PROTOCOL": "3"}, ""},
	} {
		got := Mismatch(func(k string) (string, bool) { v, ok := c.env[k]; return v, ok }, "v1.2.3", 3)
		if (c.says == "") != (got == "") || !strings.Contains(got, c.says) {
			t.Errorf("%v: %q", c.env, got)
		}
	}
}
