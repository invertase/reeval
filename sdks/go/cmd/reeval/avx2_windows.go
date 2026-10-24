package main

import "syscall"

// pfAVX2InstructionsAvailable is PF_AVX2_INSTRUCTIONS_AVAILABLE.
const pfAVX2InstructionsAvailable = 40

// avx2 is whether the CPU has AVX2, which the default x64 builds need.
func avx2() bool {
	present, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("IsProcessorFeaturePresent").
		Call(pfAVX2InstructionsAvailable)
	return present != 0
}
