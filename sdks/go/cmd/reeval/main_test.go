package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const fakeBinary = "#!/bin/sh\necho \"ran $*\"\nexit 7\n"

// mirror is a release directory on disk, served as REEVAL_DOWNLOAD=file://…
func mirror(t *testing.T, version string, sums func(name, sum string) string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	tgt, err := target()
	if err != nil {
		t.Skip(err)
	}
	name := asset(version, tgt)
	if err := os.WriteFile(filepath.Join(dir, name), []byte(fakeBinary), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(fakeBinary))
	listing := sums(name, hex.EncodeToString(sum[:]))
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS"), []byte(listing), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REEVAL_DOWNLOAD", "file://"+filepath.ToSlash(dir))
	t.Setenv("REEVAL_VERSION", version)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("REEVAL_BINARY", "")
	t.Setenv("REEVAL_OFFLINE", "")
	return dir, name
}

func listed(name, sum string) string { return fmt.Sprintf("%s  other\n%s  %s\n", sum, sum, name) }

func code(t *testing.T, err error) int {
	t.Helper()
	var le *launchError
	if !errors.As(err, &le) {
		t.Fatalf("err = %v, not a launch error", err)
	}
	return le.code
}

func TestDownloadsChecksAndCaches(t *testing.T) {
	_, name := mirror(t, "9.9.9", listed)
	got, err := resolve()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(os.Getenv("XDG_CACHE_HOME"), "reeval", "bin", "9.9.9", name)
	if got != want {
		t.Fatalf("resolve() = %s, want %s", got, want)
	}
	if info, err := os.Stat(got); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o755) {
		t.Fatalf("cached binary: %v %v", info, err)
	}
	if partial, _ := filepath.Glob(filepath.Join(filepath.Dir(got), "*.partial")); len(partial) > 0 {
		t.Errorf("left %v", partial)
	}
	t.Setenv("REEVAL_OFFLINE", "1")
	t.Setenv("REEVAL_DOWNLOAD", "file:///nowhere")
	if again, err := resolve(); err != nil || again != got {
		t.Errorf("offline from the cache: %s %v", again, err)
	}
}

func TestChecksumMismatchCachesNothing(t *testing.T) {
	mirror(t, "9.9.9", func(name, _ string) string { return strings.Repeat("0", 64) + "  *" + name + "\n" })
	_, err := resolve()
	if code(t, err) != exitInfra || !strings.Contains(err.Error(), "doesn't match SHA256SUMS") {
		t.Fatalf("err = %v", err)
	}
	if found, _ := filepath.Glob(filepath.Join(os.Getenv("XDG_CACHE_HOME"), "reeval", "bin", "9.9.9", "*")); len(found) > 0 {
		t.Errorf("cached %v", found)
	}
}

func TestReleaseWithoutTheBinary(t *testing.T) {
	mirror(t, "9.9.9", func(_, sum string) string { return sum + "  reeval-9.9.9-plan9-mips\n" })
	if _, err := resolve(); code(t, err) != exitInfra || !strings.Contains(err.Error(), "doesn't list") {
		t.Fatalf("err = %v", err)
	}
}

func TestOfflineWithNothingCached(t *testing.T) {
	_, name := mirror(t, "9.9.9", listed)
	t.Setenv("REEVAL_OFFLINE", "1")
	if _, err := resolve(); code(t, err) != exitUsage || !strings.Contains(err.Error(), name) {
		t.Fatalf("err = %v", err)
	}
}

func TestDownloadFailureNamesTheWayOut(t *testing.T) {
	mirror(t, "9.9.9", listed)
	t.Setenv("REEVAL_DOWNLOAD", "file://"+filepath.ToSlash(t.TempDir()))
	_, err := resolve()
	if code(t, err) != exitInfra || !strings.Contains(err.Error(), "REEVAL_DOWNLOAD") || !strings.Contains(err.Error(), "REEVAL_BINARY") {
		t.Fatalf("err = %v", err)
	}
}

func TestReevalBinaryComesFirst(t *testing.T) {
	mirror(t, "9.9.9", listed)
	own := filepath.Join(t.TempDir(), "reeval")
	if err := os.WriteFile(own, []byte(fakeBinary), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REEVAL_BINARY", own)
	if got, err := resolve(); err != nil || got != own {
		t.Errorf("resolve() = %s %v", got, err)
	}
	t.Setenv("REEVAL_BINARY", filepath.Dir(own))
	if _, err := resolve(); code(t, err) != exitUsage {
		t.Errorf("a directory: %v", err)
	}
}

func TestUnreleasedModuleNeedsAVersion(t *testing.T) {
	t.Setenv("REEVAL_VERSION", "")
	t.Setenv("REEVAL_BINARY", "")
	if _, err := version(); code(t, err) != exitUsage || !strings.Contains(err.Error(), "REEVAL_VERSION") {
		t.Errorf("err = %v", err)
	}
	t.Setenv("REEVAL_VERSION", "v0.13.0")
	if v, err := version(); err != nil || v != "0.13.0" {
		t.Errorf("version() = %s %v", v, err)
	}
}

// The launcher as go tool runs it: arguments verbatim, the binary's output and exit code.
func TestExecsTheBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake binary is a shell script")
	}
	mirror(t, "9.9.9", listed)
	launcher := filepath.Join(t.TempDir(), "reeval")
	if out, err := exec.Command("go", "build", "-o", launcher, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	cmd := exec.Command(launcher, "run", "--tag", "two words")
	out, err := cmd.Output()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 7 {
		t.Fatalf("exit: %v", err)
	}
	if string(out) != "ran run --tag two words\n" {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(string(exit.Stderr), "reeval: downloading reeval-9.9.9-") {
		t.Errorf("stderr = %q", exit.Stderr)
	}
}
