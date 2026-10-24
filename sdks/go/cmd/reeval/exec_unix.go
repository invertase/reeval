//go:build unix

package main

import "syscall"

// run replaces this process with the binary, so its signals and exit code are reeval's own.
func run(binary string, args, env []string) int {
	return runFailed(binary, syscall.Exec(binary, append([]string{binary}, args...), env))
}
