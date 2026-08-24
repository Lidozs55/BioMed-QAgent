# BioMed-QAgent UTF-8 environment for the current PowerShell session.
# Usage: . .\scripts\utf8-init.ps1
$utf8 = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:LANG = "C.UTF-8"
$env:LC_ALL = "C.UTF-8"
chcp 65001 | Out-Null
Write-Host "UTF-8 environment enabled (code page 65001, Python UTF-8 mode)."
