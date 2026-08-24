#!/usr/bin/env bash
# BioMed-QAgent UTF-8 environment for the current POSIX/Git Bash session.
# Usage: source scripts/utf8-init.sh
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
if command -v chcp.exe >/dev/null 2>&1; then
  chcp.exe 65001 >/dev/null
fi
printf '%s\n' 'UTF-8 environment enabled (Python UTF-8 mode).'
