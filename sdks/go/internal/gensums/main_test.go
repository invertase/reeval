package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// release writes a release directory: each target's binary (its index+1 bytes of 'x') and a
// SHA256SUMS listing every one but skip's, with change's sum altered.
func release(t *testing.T, version, skip, change string) string {
	dir := t.TempDir()
	var b strings.Builder
	for i, target := range targets {
		name := "reeval-" + version + "-" + target
		if strings.HasPrefix(target, "windows") {
			name += ".exe"
		}
		data := []byte(strings.Repeat("x", i+1))
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		if target == change {
			sum[0] ^= 1
		}
		if target != skip {
			fmt.Fprintf(&b, "%x  %s\n", sum, name)
		}
	}
	b.WriteString(strings.Repeat("f", 64) + "  install.sh\n")
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRendersEveryTarget(t *testing.T) {
	out, err := render("1.2.3", release(t, "1.2.3", "", ""))
	if err != nil {
		t.Fatal(err)
	}
	exe := sha256.Sum256([]byte(strings.Repeat("x", 9)))
	for _, want := range []string{
		`var sumsVersion = "1.2.3"`,
		fmt.Sprintf(`"reeval-1.2.3-windows-x64.exe":          {sha256: "%x", size: 9},`, exe),
		`"reeval-1.2.3-linux-x64-musl-baseline":`,
		`"reeval-1.2.3-windows-x64-baseline.exe":`,
	} {
		if !strings.Contains(string(out), want) {
			t.Errorf("sums.go lacks %s:\n%s", want, out)
		}
	}
}

func TestRefusesAMissingTarget(t *testing.T) {
	if _, err := render("1.2.3", release(t, "1.2.3", "darwin-x64", "")); err == nil ||
		!strings.Contains(err.Error(), "reeval-1.2.3-darwin-x64") {
		t.Errorf("err = %v", err)
	}
}

func TestRefusesABinaryThatIsntWhatSHA256SUMSLists(t *testing.T) {
	if _, err := render("1.2.3", release(t, "1.2.3", "", "linux-arm64")); err == nil ||
		!strings.Contains(err.Error(), "reeval-1.2.3-linux-arm64's sha256") {
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
