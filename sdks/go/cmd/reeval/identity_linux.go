package main

import (
	"fmt"
	"os"
	"syscall"
)

// identity is what changes when a file is rewritten: the ctime too, which setting the mtime back
// after a rewrite moves on.
func identity(info os.FileInfo) string {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Sprint(info.Size(), info.ModTime().UnixNano())
	}
	return fmt.Sprint(info.Size(), info.ModTime().UnixNano(), st.Ctim.Nano(), st.Ino)
}
