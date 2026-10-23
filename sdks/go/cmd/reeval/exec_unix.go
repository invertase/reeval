//go:build unix

package main

import (
	"fmt"
	"os"
	"syscall"
)

// run replaces this process with the binary, so its signals and exit code are reeval's own.
func run(binary string, args, env []string) int {
	err := syscall.Exec(binary, append([]string{binary}, args...), env)
	fmt.Fprintf(os.Stderr, "reeval: can't run %s: %v\n", binary, err)
	return exitInfra
}
