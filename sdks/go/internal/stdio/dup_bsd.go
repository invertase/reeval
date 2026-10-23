//go:build darwin || freebsd || netbsd || openbsd || dragonfly

package stdio

import "syscall"

func dup2(from, to int) error { return syscall.Dup2(from, to) }
