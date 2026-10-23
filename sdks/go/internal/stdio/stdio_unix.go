//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package stdio

import (
	"io"
	"os"
	"syscall"
)

// Private keeps private copies of fd 0 and fd 1 for reeval's messages, then points fd 1 at
// stderr and fd 0 at /dev/null, so a command the eval starts, a fmt.Println or a C library can
// neither write into a message nor read one.
func Private() (io.Reader, io.Writer, error) {
	in, err := syscall.Dup(0)
	if err != nil {
		return nil, nil, err
	}
	out, err := syscall.Dup(1)
	if err != nil {
		return nil, nil, err
	}
	syscall.CloseOnExec(in)
	syscall.CloseOnExec(out)
	if err := dup2(2, 1); err != nil {
		return nil, nil, err
	}
	null, err := os.Open(os.DevNull)
	if err != nil {
		return nil, nil, err
	}
	defer null.Close()
	if err := dup2(int(null.Fd()), 0); err != nil {
		return nil, nil, err
	}
	return os.NewFile(uintptr(in), "reeval-in"), os.NewFile(uintptr(out), "reeval-out"), nil
}
