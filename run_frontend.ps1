$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
python -m http.server 5500 --bind 127.0.0.1
