#!/usr/bin/env bash
exec 3<>/dev/tcp/github.com/22
head -n 1 <&3
