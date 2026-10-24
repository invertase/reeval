//go:build !unix

package main

import (
	"errors"
	"os"
	"os/exec"
	"os/signal"
)

// run starts the binary and waits for it, forwarding its exit code. The console sends Ctrl-C
// to both; the launcher swallows it, so reeval stops its attempts and cleans up before either exits.
// On Windows only Notify keeps Ctrl-C from ending the process: Ignore leaves the default handler,
// which exits.
func run(binary string, args, env []string) int {
	signal.Notify(make(chan os.Signal, 1), os.Interrupt)
	cmd := exec.Command(binary, args...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	if err != nil {
		return runFailed(binary, err)
	}
	return 0
}
