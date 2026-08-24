@echo off
rem Initialize a Windows cmd.exe session for UTF-8 repository work.
chcp 65001 >NUL
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "LANG=C.UTF-8"
set "LC_ALL=C.UTF-8"
echo UTF-8 environment enabled: code page 65001, Python UTF-8 mode enabled.
