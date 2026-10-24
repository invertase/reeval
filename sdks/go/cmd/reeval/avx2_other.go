//go:build !windows

package main

import (
	"os"
	"regexp"
)

var avx2Flag = regexp.MustCompile(`\bavx2\b`)

// avx2 is whether the CPU has AVX2, which the default x64 builds need; Linux lists it in
// /proc/cpuinfo.
func avx2() bool {
	cpuinfo, err := os.ReadFile("/proc/cpuinfo")
	return err == nil && avx2Flag.Match(cpuinfo)
}
