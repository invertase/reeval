// Command fake-reeval stands in for the reeval binary in the launcher conformance suite. It's a
// real executable on every platform, so a launcher execs or spawns it exactly as it would reeval.
//
//	fake-reeval --version        prints a version and exits 0 (launchers check a download starts)
//	fake-reeval exit <n> [...]   prints its report and exits n
//	fake-reeval wait <file>      prints its report, creates <file>, then waits for a signal:
//	                             Ctrl-C (SIGINT) exits 130, SIGTERM exits 143, 60 s exits 99
//	fake-reeval [...]            prints its report and exits 0
//
// The report is one JSON line on stdout: its arguments, and every REEVAL_* variable it was given.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	args := os.Args[1:]
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println("0.0.0-fake")
		return
	}
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok && strings.HasPrefix(k, "REEVAL_") {
			env[k] = v
		}
	}
	report, _ := json.Marshal(map[string]any{"fake": "reeval", "argv": args, "env": env})
	fmt.Println(string(report))
	if len(args) >= 2 && args[0] == "exit" {
		code, err := strconv.Atoi(args[1])
		if err != nil {
			code = 98
		}
		os.Exit(code)
	}
	if len(args) >= 2 && args[0] == "wait" {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
		if err := os.WriteFile(args[1], nil, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "fake-reeval:", err)
			os.Exit(97)
		}
		select {
		case got := <-signals:
			if got == syscall.SIGTERM {
				fmt.Println("fake-reeval: terminated")
				os.Exit(143)
			}
			fmt.Println("fake-reeval: interrupted")
			os.Exit(130)
		case <-time.After(60 * time.Second):
			os.Exit(99)
		}
	}
}
