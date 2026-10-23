// Command reeval runs the reeval binary made for this module's version, with its arguments.
// Add it to a project as a tool and run it with go tool:
//
//	go get -tool github.com/invertase/reeval/sdks/go/cmd/reeval@latest
//	go tool reeval run
//
// The binary for version V and target T is reeval-V-T (.exe on Windows) in the GitHub release
// vV, listed in that release's SHA256SUMS, and is cached at <cache>/reeval/bin/V/. Every language
// SDK's launcher finds it the same way: REEVAL_BINARY, then the cache, then a download, which
// REEVAL_OFFLINE turns off. REEVAL_VERSION runs another version, and REEVAL_DOWNLOAD names a
// mirror (https:// or file://).
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/invertase/reeval/sdks/go/reeval"
)

const (
	repo    = "invertase/reeval"
	timeout = 60 * time.Second
	// reeval's own exit codes.
	exitUsage = 2
	exitInfra = 3
)

type launchError struct {
	message string
	code    int
}

func (e *launchError) Error() string { return e.message }

func fail(code int, format string, args ...any) error {
	return &launchError{fmt.Sprintf(format, args...), code}
}

func main() {
	binary, err := resolve()
	if err != nil {
		fmt.Fprintln(os.Stderr, "reeval:", err)
		code := exitInfra
		var le *launchError
		if errors.As(err, &le) {
			code = le.code
		}
		os.Exit(code)
	}
	env := os.Environ()
	// The evals build with this go, which has this module in its go.mod.
	if os.Getenv("REEVAL_GO") == "" {
		if gobin, err := exec.LookPath("go"); err == nil {
			env = append(env, "REEVAL_GO="+gobin)
		}
	}
	os.Exit(run(binary, os.Args[1:], env))
}

var (
	release = regexp.MustCompile(`^v(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$`)
	pseudo  = regexp.MustCompile(`\d{14}-[0-9a-f]{12}$`)
)

// version is the reeval to run: REEVAL_VERSION, else this module's own version.
func version() (string, error) {
	if v := strings.TrimPrefix(strings.TrimSpace(os.Getenv("REEVAL_VERSION")), "v"); v != "" {
		return v, nil
	}
	v := reeval.Version()
	// A pseudo-version (a commit, not a release) has no binary.
	if m := release.FindStringSubmatch(v); m != nil && !pseudo.MatchString(v) {
		return m[1], nil
	}
	return "", fail(exitUsage, "this github.com/invertase/reeval/sdks/go is %s, not a release, so it can't "+
		"tell which reeval to run. Set REEVAL_VERSION, or REEVAL_BINARY to a reeval binary.", v)
}

func target() (string, error) {
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	system := map[string]string{"linux": "linux", "darwin": "darwin", "windows": "windows"}[runtime.GOOS]
	if arch == "" || system == "" || (system == "windows" && arch != "x64") {
		return "", fail(exitUsage, "there's no reeval binary for %s %s. Set REEVAL_BINARY to one you "+
			"built, or use the npm package.", runtime.GOOS, runtime.GOARCH)
	}
	if system == "linux" && musl() {
		return "linux-" + arch + "-musl", nil
	}
	return system + "-" + arch, nil
}

func musl() bool {
	if _, err := os.Stat("/etc/alpine-release"); err == nil {
		return true
	}
	found, _ := filepath.Glob("/lib/ld-musl-*")
	return len(found) > 0
}

func asset(version, target string) string {
	name := "reeval-" + version + "-" + target
	if strings.HasPrefix(target, "windows") {
		name += ".exe"
	}
	return name
}

// cacheDir is reeval's own cache directory, as the binary computes it.
func cacheDir() string {
	if base := os.Getenv("XDG_CACHE_HOME"); base != "" {
		return filepath.Join(base, "reeval")
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(local, "reeval")
	case "darwin":
		return filepath.Join(home, "Library", "Caches", "reeval")
	}
	return filepath.Join(home, ".cache", "reeval")
}

func offline() bool {
	switch os.Getenv("REEVAL_OFFLINE") {
	case "", "0", "false":
		return false
	}
	return true
}

// resolve is the binary to run: REEVAL_BINARY, or the cached one, downloaded the first time.
func resolve() (string, error) {
	if override := os.Getenv("REEVAL_BINARY"); override != "" {
		if info, err := os.Stat(override); err != nil || !info.Mode().IsRegular() {
			return "", fail(exitUsage, "REEVAL_BINARY is %s, which isn't a file.", override)
		}
		return override, nil
	}
	v, err := version()
	if err != nil {
		return "", err
	}
	t, err := target()
	if err != nil {
		return "", err
	}
	name := asset(v, t)
	cached := filepath.Join(cacheDir(), "bin", v, name)
	if info, err := os.Stat(cached); err == nil && info.Mode().IsRegular() {
		return cached, nil
	}
	if offline() {
		return "", fail(exitUsage, "reeval %s isn't in the cache and REEVAL_OFFLINE is set. Put %s at "+
			"%s, or set REEVAL_BINARY.", v, name, cached)
	}
	return cached, download(v, name, cached)
}

func download(version, name, dest string) error {
	base := os.Getenv("REEVAL_DOWNLOAD")
	if base == "" {
		base = "https://github.com/" + repo + "/releases/download/v" + version
	}
	base = strings.TrimRight(base, "/")
	sums, err := fetch(base + "/SHA256SUMS")
	if err != nil {
		return err
	}
	want := ""
	scanner := bufio.NewScanner(bytes.NewReader(sums))
	for scanner.Scan() {
		f := strings.Fields(scanner.Text())
		if len(f) == 2 && (f[1] == name || f[1] == "*"+name) {
			want = strings.ToLower(f[0])
			break
		}
	}
	if want == "" {
		return fail(exitInfra, "%s/SHA256SUMS doesn't list %s.", base, name)
	}
	fmt.Fprintln(os.Stderr, "reeval: downloading", name)
	data, err := fetch(base + "/" + name)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != want {
		return fail(exitInfra, "%s/%s doesn't match SHA256SUMS (got %s, expected %s).", base, name, got, want)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return fail(exitInfra, "can't create %s: %v", filepath.Dir(dest), err)
	}
	partial := filepath.Join(filepath.Dir(dest), fmt.Sprintf("%s.%d.partial", name, os.Getpid()))
	if err := os.WriteFile(partial, data, 0o755); err != nil {
		return fail(exitInfra, "can't write %s: %v", partial, err)
	}
	if err := os.Rename(partial, dest); err != nil {
		_ = os.Remove(partial)
		return fail(exitInfra, "can't write %s: %v", dest, err)
	}
	return nil
}

var client = &http.Client{Timeout: timeout}

func fetch(raw string) ([]byte, error) {
	failed := func(reason any) error {
		return fail(exitInfra, "couldn't download %s: %v. REEVAL_DOWNLOAD names a mirror, and "+
			"REEVAL_BINARY a binary to run instead.", raw, reason)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, failed(err)
	}
	if u.Scheme == "file" {
		data, err := os.ReadFile(filepath.FromSlash(fileURLPath(u)))
		if err != nil {
			return nil, failed(err)
		}
		return data, nil
	}
	resp, err := client.Get(raw)
	if err != nil {
		return nil, failed(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, failed(resp.Status)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, failed(err)
	}
	return data, nil
}

// fileURLPath is a file:// URL's path, with Windows' drive letter (file:///C:/x) as C:/x.
func fileURLPath(u *url.URL) string {
	p := u.Path
	if runtime.GOOS == "windows" && len(p) > 2 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	return p
}
