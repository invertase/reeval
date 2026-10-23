package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func listing(version string, skip string) string {
	var b strings.Builder
	for i, t := range targets {
		name := "reeval-" + version + "-" + t
		if strings.HasPrefix(t, "windows") {
			name += ".exe"
		}
		if t != skip {
			fmt.Fprintf(&b, "%064x  %s\n", i+1, name)
		}
	}
	b.WriteString(strings.Repeat("f", 64) + "  install.sh\n")
	return b.String()
}

func TestRendersEveryTarget(t *testing.T) {
	out, err := render("1.2.3", []byte(listing("1.2.3", "")))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`var sumsVersion = "1.2.3"`,
		`"reeval-1.2.3-windows-x64.exe":  "` + fmt.Sprintf("%064x", 7) + `",`,
		`"reeval-1.2.3-linux-x64-musl":`,
	} {
		if !strings.Contains(string(out), want) {
			t.Errorf("sums.go lacks %s:\n%s", want, out)
		}
	}
}

func TestRefusesAMissingTarget(t *testing.T) {
	if _, err := render("1.2.3", []byte(listing("1.2.3", "darwin-x64"))); err == nil ||
		!strings.Contains(err.Error(), "reeval-1.2.3-darwin-x64") {
		t.Errorf("err = %v", err)
	}
}

// The checked-in sums.go is what a commit between releases carries.
func TestCheckedInIsEmpty(t *testing.T) {
	data, err := os.ReadFile("../../cmd/reeval/sums.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `var sumsVersion = ""`) {
		t.Error("cmd/reeval/sums.go names a release; only a release's tag carries one")
	}
}
