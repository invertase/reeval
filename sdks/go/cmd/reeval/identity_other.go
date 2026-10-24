//go:build !linux && !darwin

package main

import (
	"fmt"
	"os"
)

// identity is what changes when a file is rewritten.
func identity(info os.FileInfo) string { return fmt.Sprint(info.Size(), info.ModTime().UnixNano()) }
