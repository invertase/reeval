//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package stdio

import (
	"io"
	"os"
)

// Private keeps the process's stdin and stdout for reeval's messages and points os.Stdout
// at stderr, so a fmt.Println can't write into a message. (A command os/exec starts gets no
// stdout unless the eval hands it one.)
func Private() (io.Reader, io.Writer, error) {
	in, out := os.Stdin, os.Stdout
	os.Stdout = os.Stderr
	if null, err := os.Open(os.DevNull); err == nil {
		os.Stdin = null
	}
	return in, out, nil
}
