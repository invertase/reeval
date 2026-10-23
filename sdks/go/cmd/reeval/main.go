// Command reeval runs the reeval binary made for this module's version, with its arguments.
// Add it to a project as a tool and run it with go tool:
//
//	go get -tool github.com/invertase/reeval/sdks/go/cmd/reeval@latest
//	go tool reeval run
//
// The binary for version V and target T is reeval-V-T (.exe on Windows) in the GitHub release
// vV, and is cached at <cache>/reeval/bin/V/. A released module carries each target's sha256
// (sums.go), so go.sum pins the binary too; another version is checked against its release's
// SHA256SUMS. Every language SDK's launcher finds it the same way: REEVAL_BINARY, then the cache,
// then a download, which REEVAL_OFFLINE turns off. REEVAL_VERSION runs another version, and
// REEVAL_DOWNLOAD names a mirror (https:// or file://).
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"debug/elf"
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
	"strconv"
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
	// launcherPID is the launcher's pid in the binary's environment, which tells a launcher that
	// REEVAL_BINARY started from another launcher.
	launcherPID = "REEVAL_LAUNCHER_PID"
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
	env := append(os.Environ(), launcherPID+"="+strconv.Itoa(os.Getpid()))
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

// musl is whether the host's programs run on musl. This launcher is static, so it reads the
// dynamic loader a system program asks for, then ldd's banner. A musl loader merely being on disk
// says nothing: Debian's musl package installs one beside glibc.
func musl() bool {
	for _, program := range []string{"/bin/sh", "/usr/bin/env"} {
		if interp, ok := interpreter(program); ok {
			return muslLoader(interp)
		}
	}
	out, _ := exec.Command("ldd", "--version").CombinedOutput()
	return strings.Contains(strings.ToLower(string(out)), "musl")
}

// interpreter is an ELF program's PT_INTERP, the loader it runs on.
func interpreter(program string) (string, bool) {
	f, err := elf.Open(program)
	if err != nil {
		return "", false
	}
	defer f.Close()
	for _, p := range f.Progs {
		if p.Type == elf.PT_INTERP {
			data, err := io.ReadAll(p.Open())
			if err != nil {
				return "", false
			}
			return strings.TrimRight(string(data), "\x00"), true
		}
	}
	return "", false
}

func muslLoader(interp string) bool { return strings.Contains(filepath.Base(interp), "musl") }

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
		return checkOverride(override)
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

// checkOverride refuses a REEVAL_BINARY that isn't a file, or that is a launcher: this one, or
// another that started this one, which would run each other forever.
func checkOverride(override string) (string, error) {
	info, err := os.Stat(override)
	if err != nil || !info.Mode().IsRegular() {
		return "", fail(exitUsage, "REEVAL_BINARY is %s, which isn't a file.", override)
	}
	self, err := os.Executable()
	if err == nil {
		if mine, err := os.Stat(self); err == nil && os.SameFile(info, mine) {
			return "", fail(exitUsage, "REEVAL_BINARY is %s, which is this launcher, not the reeval binary.", override)
		}
	}
	if pid := os.Getenv(launcherPID); pid != "" {
		// POSIX launchers exec, keeping their pid; Windows ones start the binary as a child.
		if pid == strconv.Itoa(os.Getpid()) || pid == strconv.Itoa(os.Getppid()) {
			return "", fail(exitUsage, "REEVAL_BINARY is %s, which is a reeval launcher, not the reeval binary.", override)
		}
	}
	return override, nil
}

// expected is the binary's sha256: this module's own for its release, else the release's
// SHA256SUMS.
func expected(base, version, name string) (string, error) {
	if version == sumsVersion {
		if sum, ok := releaseSums[name]; ok {
			return sum, nil
		}
		return "", fail(exitInfra, "reeval %s has no binary %s.", version, name)
	}
	sums, err := fetch(base + "/SHA256SUMS")
	if err != nil {
		return "", err
	}
	scanner := bufio.NewScanner(bytes.NewReader(sums))
	for scanner.Scan() {
		f := strings.Fields(scanner.Text())
		if len(f) == 2 && (f[1] == name || f[1] == "*"+name) {
			return strings.ToLower(f[0]), nil
		}
	}
	return "", fail(exitInfra, "%s/SHA256SUMS doesn't list %s.", base, name)
}

func download(version, name, dest string) error {
	base := os.Getenv("REEVAL_DOWNLOAD")
	if base == "" {
		base = "https://github.com/" + repo + "/releases/download/v" + version
	}
	base = strings.TrimRight(base, "/")
	want, err := expected(base, version, name)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "reeval: downloading", name)
	data, err := fetch(base + "/" + name)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != want {
		return fail(exitInfra, "%s/%s doesn't match its sha256 (got %s, expected %s).", base, name, got, want)
	}
	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fail(exitInfra, "can't create %s: %v", dir, err)
	}
	// Random, not the pid: launchers in separate containers sharing the cache are all pid 1.
	partial, err := os.CreateTemp(dir, name+".*.partial")
	if err != nil {
		return fail(exitInfra, "can't write in %s: %v", dir, err)
	}
	defer os.Remove(partial.Name())
	_, err = partial.Write(data)
	if cerr := partial.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(partial.Name(), 0o755)
	}
	if err == nil {
		err = os.Rename(partial.Name(), dest)
	}
	if err != nil {
		return fail(exitInfra, "can't write %s: %v", dest, err)
	}
	return nil
}

var client = &http.Client{Timeout: timeout, CheckRedirect: noDowngrade}

// noDowngrade follows redirects, but not from https to anything else.
func noDowngrade(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	if via[0].URL.Scheme == "https" && req.URL.Scheme != "https" {
		return fmt.Errorf("refusing the redirect from https to %s", req.URL.Redacted())
	}
	return nil
}

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
