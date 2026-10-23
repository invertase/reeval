package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
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
	if code(t, err) != exitInfra || !strings.Contains(err.Error(), "doesn't match its sha256") {
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

// embed makes this launcher the one released as version, carrying sums.
func embed(t *testing.T, version string, sums map[string]string) {
	t.Helper()
	oldVersion, oldSums := sumsVersion, releaseSums
	sumsVersion, releaseSums = version, sums
	t.Cleanup(func() { sumsVersion, releaseSums = oldVersion, oldSums })
}

func fakeSum() string {
	sum := sha256.Sum256([]byte(fakeBinary))
	return hex.EncodeToString(sum[:])
}

func TestReleasedLauncherTrustsOnlyItsOwnSums(t *testing.T) {
	dir, name := mirror(t, "9.9.9", listed)
	// The mirror's SHA256SUMS isn't read: it could be as wrong as the binary beside it.
	if err := os.Remove(filepath.Join(dir, "SHA256SUMS")); err != nil {
		t.Fatal(err)
	}
	embed(t, "9.9.9", map[string]string{name: fakeSum()})
	if _, err := resolve(); err != nil {
		t.Fatal(err)
	}
}

func TestEmbeddedSumOutranksTheMirrors(t *testing.T) {
	_, name := mirror(t, "9.9.9", listed)
	embed(t, "9.9.9", map[string]string{name: strings.Repeat("0", 64)})
	_, err := resolve()
	if code(t, err) != exitInfra || !strings.Contains(err.Error(), "doesn't match its sha256") {
		t.Fatalf("err = %v", err)
	}
	if found, _ := filepath.Glob(filepath.Join(os.Getenv("XDG_CACHE_HOME"), "reeval", "bin", "9.9.9", "*")); len(found) > 0 {
		t.Errorf("cached %v", found)
	}
}

func TestReleasedLauncherWithoutThisTarget(t *testing.T) {
	mirror(t, "9.9.9", listed)
	embed(t, "9.9.9", map[string]string{"reeval-9.9.9-plan9-mips": fakeSum()})
	if _, err := resolve(); code(t, err) != exitInfra || !strings.Contains(err.Error(), "has no binary") {
		t.Fatalf("err = %v", err)
	}
}

func TestAnotherVersionReadsItsSHA256SUMS(t *testing.T) {
	mirror(t, "9.9.9", listed)
	embed(t, "1.0.0", map[string]string{})
	if _, err := resolve(); err != nil {
		t.Fatal(err)
	}
}

func TestMuslIsTheLoaderNotAFileOnDisk(t *testing.T) {
	for interp, want := range map[string]bool{
		"/lib/ld-musl-x86_64.so.1":      true,
		"/lib/ld-musl-aarch64.so.1":     true,
		"/lib64/ld-linux-x86-64.so.2":   false,
		"/lib/ld-linux-aarch64.so.1":    false,
		"/usr/lib/musl/lib/ld-linux.so": false,
	} {
		if got := muslLoader(interp); got != want {
			t.Errorf("muslLoader(%s) = %v", interp, got)
		}
	}
	if runtime.GOOS != "linux" {
		return
	}
	interp, ok := interpreter("/bin/sh")
	if !ok {
		t.Skip("/bin/sh isn't a dynamic ELF program")
	}
	if musl() != muslLoader(interp) {
		t.Errorf("musl() = %v, but /bin/sh runs on %s", musl(), interp)
	}
}

func TestRefusesARedirectFromHTTPS(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("downgraded"))
	}))
	defer plain.Close()
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/down" {
			http.Redirect(w, r, plain.URL+"/x", http.StatusFound)
			return
		}
		if r.URL.Path == "/across" {
			http.Redirect(w, r, "/x", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("secure"))
	}))
	defer secure.Close()
	old := client.Transport
	client.Transport = secure.Client().Transport
	t.Cleanup(func() { client.Transport = old })

	if _, err := fetch(secure.URL + "/down"); code(t, err) != exitInfra || !strings.Contains(err.Error(), "refusing the redirect") {
		t.Errorf("https to http: %v", err)
	}
	if data, err := fetch(secure.URL + "/across"); err != nil || string(data) != "secure" {
		t.Errorf("https to https: %q %v", data, err)
	}
}

// Launchers in containers that share the cache all have pid 1; goroutines share one pid too.
func TestConcurrentFirstRunsShareAPid(t *testing.T) {
	mirror(t, "9.9.9", listed)
	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = resolve()
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	got, _ := resolve()
	if data, _ := os.ReadFile(got); string(data) != fakeBinary {
		t.Errorf("cached binary is %q", data)
	}
	if partial, _ := filepath.Glob(filepath.Join(filepath.Dir(got), "*.partial")); len(partial) > 0 {
		t.Errorf("left %v", partial)
	}
}

func TestReevalBinaryIsntALauncher(t *testing.T) {
	mirror(t, "9.9.9", listed)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("REEVAL_BINARY", self)
	if _, err := resolve(); code(t, err) != exitUsage || !strings.Contains(err.Error(), "this launcher") {
		t.Errorf("itself: %v", err)
	}
	other := filepath.Join(t.TempDir(), "reeval")
	if err := os.WriteFile(other, []byte(fakeBinary), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REEVAL_BINARY", other)
	for _, pid := range []int{os.Getpid(), os.Getppid()} {
		t.Setenv(launcherPID, strconv.Itoa(pid))
		if _, err := resolve(); code(t, err) != exitUsage || !strings.Contains(err.Error(), "a reeval launcher") {
			t.Errorf("started by launcher %d: %v", pid, err)
		}
	}
	t.Setenv(launcherPID, "1")
	if os.Getpid() != 1 && os.Getppid() != 1 {
		if got, err := resolve(); err != nil || got != other {
			t.Errorf("a launcher further up: %s %v", got, err)
		}
	}
}

// A launcher pointed at another launcher stops instead of starting it forever.
func TestLauncherLoopStops(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered by the pid check above")
	}
	launcher := filepath.Join(t.TempDir(), "reeval")
	if out, err := exec.Command("go", "build", "-o", launcher, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	twin := filepath.Join(t.TempDir(), "reeval")
	data, _ := os.ReadFile(launcher)
	if err := os.WriteFile(twin, data, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(launcher, "run")
	cmd.Env = append(os.Environ(), "REEVAL_BINARY="+twin, launcherPID+"=")
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != exitUsage || !strings.Contains(string(out), "launcher, not the reeval binary") {
		t.Errorf("exit %v: %s", err, out)
	}
}
