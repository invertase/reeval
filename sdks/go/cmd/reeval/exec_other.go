//go:build !unix

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"sync/atomic"
)

// run starts the binary and waits for it, forwarding its exit code; Ctrl-C, which the binary
// gets too, exits 130.
func run(binary string, args, env []string) int {
	var interrupted atomic.Bool
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt)
	go func() {
		for range signals {
			interrupted.Store(true)
		}
	}()
	cmd := exec.Command(binary, args...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	if interrupted.Load() {
		return 130
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "reeval: can't run %s: %v\n", binary, err)
		return exitInfra
	}
	return 0
}
